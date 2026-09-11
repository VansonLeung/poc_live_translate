import { useCallback, useEffect, useRef, useState } from "react";
import { startCapture, type CapturedChunk } from "./audio/capture";
import type { SessionOptions } from "./useLiveTranslation";
import { diagnostics } from "./diagnostics";
import {
  conversationHistory,
  MAX_QUESTION,
  streamLines,
  type AnswerEvent,
  type QATurn,
} from "../shared/qa";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "An unexpected error occurred.";
export function useLiveQA(preferences: {
  autoAnswer: boolean;
  answerLanguage: string;
  enabled: boolean;
  captureOnly: boolean;
}) {
  const [turns, setTurns] = useState<QATurn[]>([]);
  const [draft, setDraftState] = useState("");
  const [answering, setAnswering] = useState(false);
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const [pending, setPending] = useState(0);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const turnsRef = useRef<QATurn[]>([]);
  const draftRef = useRef("");
  const prefs = useRef(preferences);
  prefs.current = preferences;
  const capture = useRef<Awaited<ReturnType<typeof startCapture>> | null>(null);
  const queue = useRef<CapturedChunk[]>([]);
  const busy = useRef(false);
  const startingRef = useRef(false);
  const answerAbort = useRef<AbortController | null>(null);
  const asrAbort = useRef(new AbortController());
  const optionsRef = useRef<SessionOptions | undefined>(undefined);
  const mounted = useRef(true);
  const startedAt = useRef(0);
  const elapsedBase = useRef(0);
  const ready = useRef(false);
  const flushRequested = useRef(false);
  const blocked = useRef(false);
  const manualRequested = useRef(false);
  const maybeAnswer = useRef(() => {});
  const stopRef = useRef(() => {});

  const setDraft = useCallback((text: string) => {
    draftRef.current = text;
    setDraftState(text);
  }, []);
  const updateTurns = useCallback((fn: (current: QATurn[]) => QATurn[]) => {
    turnsRef.current = fn(turnsRef.current);
    if (mounted.current) setTurns(turnsRef.current);
  }, []);

  const submit = useCallback(async () => {
    const question = draftRef.current.trim();
    if (
      !question ||
      answerAbort.current ||
      !prefs.current.enabled ||
      prefs.current.captureOnly
    )
      return;
    if (question.length > MAX_QUESTION) {
      setError("Shorten the question to 8,000 characters before asking.");
      blocked.current = true;
      return;
    }
    const history = conversationHistory(turnsRef.current);
    const id = crypto.randomUUID();
    const controller = new AbortController();
    answerAbort.current = controller;
    ready.current = false;
    blocked.current = false;
    setDraft("");
    setAnswering(true);
    setError("");
    updateTurns((current) => [
      ...current,
      { id, question, answer: "", status: "answering" },
    ]);
    const patch = (value: Partial<QATurn>) =>
      updateTurns((current) =>
        current.map((t) => (t.id === id ? { ...t, ...value } : t)),
      );
    let answer = "";
    try {
      const response = await fetch("/api/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          history,
          language: prefs.current.answerLanguage,
        }),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(125000),
        ]),
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error || `Answer failed (${response.status}).`);
      }
      if (!response.body) throw new Error("No answer stream received.");
      let complete = false;
      for await (const line of streamLines(response.body)) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as AnswerEvent;
        if (event.type === "delta") {
          answer += event.text;
          patch({ answer });
        } else if (event.type === "error") throw new Error(event.error);
        else if (event.type === "done") {
          complete = true;
          break;
        }
      }
      if (!complete || !answer.trim())
        throw new Error("The answer stream ended early. Please retry.");
      patch({ status: "complete" });
    } catch (error) {
      patch({
        status: controller.signal.aborted ? "stopped" : "error",
        error: controller.signal.aborted ? undefined : errorText(error),
      });
      // A failed or stopped answer must not trigger another automatic model call.
      blocked.current = true;
      if (
        mounted.current &&
        prefs.current.autoAnswer &&
        !controller.signal.aborted
      )
        setError(
          "Automatic answers are paused after a failed answer. Review the draft and click Ask now, or start listening again.",
        );
    } finally {
      if (answerAbort.current === controller) answerAbort.current = null;
      if (mounted.current) {
        setAnswering(false);
        maybeAnswer.current();
      }
    }
  }, [setDraft, updateTurns]);

  maybeAnswer.current = () => {
    if (
      !mounted.current ||
      busy.current ||
      queue.current.length ||
      answerAbort.current ||
      !prefs.current.enabled ||
      prefs.current.captureOnly
    )
      return;
    if (manualRequested.current) {
      manualRequested.current = false;
      if (!blocked.current) {
        if (draftRef.current.trim()) void submit();
        else
          setError(
            "No question was captured. Speak again or type your question.",
          );
      }
    } else if (prefs.current.autoAnswer && ready.current && !blocked.current)
      void submit();
  };

  const drain = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    while (queue.current.length && !asrAbort.current.signal.aborted) {
      const chunk = queue.current.shift()!;
      setPending(queue.current.length + 1);
      const start = performance.now();
      diagnostics.updateSegment(chunk.traceId, {
        status: "ASR",
        asrStartedAt: start,
      });
      try {
        const form = new FormData();
        form.append("audio", chunk.audio, "speech.wav");
        form.append(
          "languages",
          JSON.stringify(optionsRef.current?.languages ?? []),
        );
        const response = await fetch("/api/transcribe", {
          method: "POST",
          body: form,
          signal: AbortSignal.any([
            asrAbort.current.signal,
            AbortSignal.timeout(125000),
          ]),
        });
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error || "Transcription failed.");
        if (typeof result.text !== "string")
          throw new Error("Invalid transcription response.");
        if (!mounted.current) break;
        const text = result.text.trim();
        if (text) setDraft([draftRef.current, text].filter(Boolean).join(" "));
        ready.current = chunk.final;
        const providerMs = response.headers
          .get("server-timing")
          ?.match(/provider;dur=([\d.]+)/)?.[1];
        diagnostics.updateSegment(chunk.traceId, {
          status: chunk.final ? "question ready" : "collecting question",
          asrFinishedAt: performance.now(),
          asrMs: performance.now() - start,
          providerMs: providerMs ? Number(providerMs) : undefined,
          characters: text.length,
        });
        if (draftRef.current.length > MAX_QUESTION) {
          blocked.current = true;
          setError(
            "Question is too long. Capture stopped; edit it to 8,000 characters before asking.",
          );
          queueMicrotask(() => stopRef.current());
        }
      } catch (error) {
        if (mounted.current) {
          blocked.current = true;
          setError(
            `${errorText(error)} Some speech may be missing. Review the question before asking. Automatic answers are paused.`,
          );
          diagnostics.updateSegment(chunk.traceId, {
            status: "error",
            error: errorText(error),
            asrFinishedAt: performance.now(),
          });
        }
      }
    }
    busy.current = false;
    if (flushRequested.current) {
      ready.current = true;
      flushRequested.current = false;
    }
    if (mounted.current) {
      setPending(0);
      maybeAnswer.current();
    }
  }, [setDraft]);

  const stop = useCallback(() => {
    if (!capture.current) return;
    const current = capture.current;
    capture.current = null;
    flushRequested.current = true;
    current.stop();
    setRecording(false);
    setElapsed(elapsedBase.current + (Date.now() - startedAt.current) / 1000);
    // A forced 12-second boundary can leave no final audio packet to flush.
    if (!busy.current && !queue.current.length) {
      ready.current = true;
      maybeAnswer.current();
    }
  }, []);
  stopRef.current = stop;

  const start = useCallback(
    async (options: SessionOptions) => {
      if (capture.current || startingRef.current || busy.current) return;
      startingRef.current = true;
      setStarting(true);
      setError("");
      blocked.current = false;
      ready.current = false;
      flushRequested.current = false;
      optionsRef.current = structuredClone(options);
      elapsedBase.current = elapsed;
      diagnostics.begin({
        source: options.source,
        languages: options.languages,
        targets: [],
        silenceMs: options.silenceMs,
        threshold: options.threshold,
        captureOnly: options.captureOnly ?? false,
        models: options.models,
      });
      try {
        const active = await startCapture({
          ...options,
          onLevel: (value) => {
            if (mounted.current) setLevel(value);
          },
          onEnded: stop,
          onChunk: (chunk) => {
            if (!mounted.current || options.captureOnly) return;
            ready.current = false;
            diagnostics.updateSegment(chunk.traceId, {
              queuedAt: performance.now(),
            });
            queue.current.push(chunk);
            setPending(queue.current.length + (busy.current ? 1 : 0));
            void drain();
            if (queue.current.length >= 12) {
              setError(
                "Transcription is falling behind. Capture stopped to finish queued speech.",
              );
              queueMicrotask(stop);
            }
          },
        });
        if (!mounted.current) {
          active.stop();
          return;
        }
        capture.current = active;
        startedAt.current = Date.now();
        setRecording(true);
      } catch (error) {
        if (mounted.current) setError(errorText(error));
      } finally {
        startingRef.current = false;
        if (mounted.current) setStarting(false);
      }
    },
    [drain, elapsed, stop],
  );

  const ask = () => {
    if (answerAbort.current || startingRef.current || prefs.current.captureOnly)
      return;
    blocked.current = false;
    manualRequested.current = true;
    stop();
    maybeAnswer.current();
  };
  const stopGenerating = () => {
    blocked.current = true;
    answerAbort.current?.abort();
  };
  const clear = () => {
    if (
      capture.current ||
      startingRef.current ||
      busy.current ||
      answerAbort.current
    )
      return;
    updateTurns(() => []);
    setDraft("");
    setError("");
    setElapsed(0);
    ready.current = false;
    blocked.current = false;
    manualRequested.current = false;
  };
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(
      () =>
        setElapsed(
          elapsedBase.current + (Date.now() - startedAt.current) / 1000,
        ),
      250,
    );
    return () => clearInterval(timer);
  }, [recording]);
  useEffect(() => {
    mounted.current = true;
    asrAbort.current = new AbortController();
    return () => {
      mounted.current = false;
      asrAbort.current.abort();
      answerAbort.current?.abort();
      capture.current?.stop();
      queue.current = [];
    };
  }, []);
  return {
    turns,
    draft,
    setDraft,
    answering,
    recording,
    starting,
    pending,
    retrying: 0,
    level,
    elapsed,
    error,
    start,
    stop,
    ask,
    stopGenerating,
    clear,
    dismissError: () => setError(""),
  };
}
