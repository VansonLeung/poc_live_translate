import { useCallback, useEffect, useRef, useState } from "react";
import {
  startCapture,
  type AudioSource,
  type CapturedChunk,
} from "./audio/capture";
import { SentenceBuffer } from "./audio/segments";
import { diagnostics } from "./diagnostics";

export interface Translation {
  language: string;
  text?: string;
  error?: string;
}
export interface TranscriptRow {
  id: string;
  text: string;
  language: string | null;
  offset: number;
  translations: Translation[];
  status: "translating" | "complete" | "error";
  error?: string;
  audio?: CapturedChunk;
  asrLanguages?: string[];
  segmentId?: string;
}
export interface SessionOptions {
  source: AudioSource;
  deviceId?: string;
  languages: string[];
  targets: string[];
  silenceMs: number;
  threshold: number;
  captureOnly?: boolean;
  models?: { asrModel: string; llmModel: string };
}
type Job =
  | { chunk: CapturedChunk; options: SessionOptions }
  | { flush: true; options: SessionOptions };

async function api<T>(
  path: string,
  init: RequestInit,
  signal: AbortSignal,
  onTiming?: (timing: { requestMs: number; providerMs?: number }) => void,
): Promise<T> {
  const startedAt = performance.now();
  let providerMs: number | undefined;
  try {
    const response = await fetch(`/api/${path}`, {
      ...init,
      signal: AbortSignal.any([signal, AbortSignal.timeout(125_000)]),
    });
    const providerTiming = response.headers
      .get("server-timing")
      ?.match(/provider;dur=([\d.]+)/);
    providerMs = providerTiming ? Number(providerTiming[1]) : undefined;
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error || `Request failed (${response.status}).`);
    return result;
  } finally {
    onTiming?.({ requestMs: performance.now() - startedAt, providerMs });
  }
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "An unexpected error occurred.";

export function useLiveTranslation() {
  const [rows, setRows] = useState<TranscriptRow[]>([]);
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const [pending, setPending] = useState(0);
  const [retrying, setRetrying] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const capture = useRef<Awaited<ReturnType<typeof startCapture>> | null>(null);
  const queue = useRef<Job[]>([]);
  const busy = useRef(false);
  const cancelled = useRef(new AbortController());
  const sentenceBuffer = useRef(new SentenceBuffer());
  const optionsRef = useRef<SessionOptions | null>(null);
  const startedAt = useRef(0);
  const sessionBase = useRef(0);
  const lastOffset = useRef(0);
  const mounted = useRef(true);
  const startingRef = useRef(false);
  const retryIds = useRef(new Set<string>());
  const heldSegmentId = useRef<string | undefined>(undefined);

  const update = useCallback(
    (id: string, patch: Partial<TranscriptRow>) =>
      setRows((current) =>
        current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
      ),
    [],
  );

  const translate = useCallback(
    async (id: string, text: string, targets: string[], segmentId?: string) => {
      const traceId = diagnostics.translation({
        rowId: id,
        segmentId,
        characters: text.length,
        targets,
      });
      try {
        const result = await api<{ translations: Translation[] }>(
          "translate",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, targets }),
          },
          cancelled.current.signal,
          (timing) =>
            diagnostics.updateTranslation(traceId, {
              requestMs: timing.requestMs,
              providerMs: timing.providerMs,
            }),
        );
        diagnostics.updateTranslation(traceId, {
          finishedAt: performance.now(),
          status: result.translations.some((t) => t.error)
            ? "error"
            : "complete",
        });
        if (mounted.current)
          update(id, {
            translations: result.translations,
            status: result.translations.some((t) => t.error)
              ? "error"
              : "complete",
          });
      } catch (error) {
        diagnostics.updateTranslation(traceId, {
          finishedAt: performance.now(),
          status: "error",
        });
        if (mounted.current)
          update(id, { status: "error", error: errorText(error) });
      }
    },
    [update],
  );

  const addSentences = useCallback(
    async (
      sentences: string[],
      language: string | null,
      offset: number,
      targets: string[],
      segmentId?: string,
    ) => {
      for (const text of sentences) {
        if (cancelled.current.signal.aborted) break;
        const id = crypto.randomUUID();
        setRows((current) => [
          ...current,
          {
            id,
            text,
            language,
            offset,
            translations: targets.map((language) => ({ language })),
            status: "translating",
            segmentId,
          },
        ]);
        await translate(id, text, targets, segmentId);
      }
    },
    [translate],
  );

  const drain = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    while (queue.current.length && !cancelled.current.signal.aborted) {
      const job = queue.current.shift()!;
      if ("flush" in job) {
        await addSentences(
          sentenceBuffer.current.append("", true),
          null,
          lastOffset.current,
          job.options.targets,
          heldSegmentId.current,
        );
        diagnostics.updateSegment(heldSegmentId.current, {
          status: "finished",
          heldCharacters: 0,
        });
        heldSegmentId.current = undefined;
      } else {
        const { chunk, options } = job;
        const form = new FormData();
        form.append("audio", chunk.audio, "speech.wav");
        form.append("languages", JSON.stringify(options.languages));
        diagnostics.updateSegment(chunk.traceId, {
          status: "ASR",
          asrStartedAt: performance.now(),
        });
        try {
          const result = await api<{ text: string; language: string | null }>(
            "transcribe",
            { method: "POST", body: form },
            cancelled.current.signal,
            (timing) =>
              diagnostics.updateSegment(chunk.traceId, {
                asrMs: timing.requestMs,
                providerMs: timing.providerMs,
              }),
          );
          diagnostics.updateSegment(chunk.traceId, {
            asrFinishedAt: performance.now(),
            characters: result.text.length,
          });
          const segmentId = sentenceBuffer.current.hasPending
            ? heldSegmentId.current
            : chunk.traceId;
          const offset = sentenceBuffer.current.hasPending
            ? lastOffset.current
            : chunk.offset;
          const sentences = sentenceBuffer.current.append(
            result.text,
            chunk.final,
          );
          if (sentences.length && segmentId !== chunk.traceId)
            diagnostics.updateSegment(segmentId, {
              status: "sentence released",
              heldCharacters: 0,
            });
          heldSegmentId.current = sentenceBuffer.current.hasPending
            ? sentences.length
              ? chunk.traceId
              : segmentId
            : undefined;
          diagnostics.updateSegment(chunk.traceId, {
            status: sentenceBuffer.current.hasPending
              ? "waiting for sentence"
              : sentences.length
                ? "translating"
                : "no speech",
            heldCharacters: sentenceBuffer.current.pendingCharacters,
          });
          lastOffset.current = sentences.length ? chunk.offset : offset;
          await addSentences(
            sentences,
            result.language,
            offset,
            options.targets,
            segmentId,
          );
          diagnostics.updateSegment(chunk.traceId, {
            status: sentenceBuffer.current.hasPending
              ? "waiting for sentence"
              : sentences.length
                ? "finished"
                : "no speech",
          });
        } catch (error) {
          diagnostics.updateSegment(chunk.traceId, {
            status: "error",
            error: errorText(error),
            asrFinishedAt: performance.now(),
          });
          if (mounted.current) {
            // Keep failed audio in memory for an explicit retry; do not silently discard speech.
            await addSentences(
              sentenceBuffer.current.append("", true),
              null,
              lastOffset.current,
              options.targets,
              heldSegmentId.current,
            );
            heldSegmentId.current = undefined;
            setRows((current) => [
              ...current,
              {
                id: crypto.randomUUID(),
                text: "",
                language: null,
                offset: chunk.offset,
                translations: options.targets.map((language) => ({ language })),
                status: "error",
                error: errorText(error),
                audio: chunk,
                asrLanguages: options.languages,
                segmentId: chunk.traceId,
              },
            ]);
          }
        }
      }
      if (mounted.current) setPending(queue.current.length);
    }
    busy.current = false;
  }, [addSentences]);

  const stop = useCallback(() => {
    if (!capture.current) return;
    capture.current.stop();
    capture.current = null;
    setRecording(false);
    const duration =
      sessionBase.current + (Date.now() - startedAt.current) / 1000;
    setElapsed(duration);
    if (optionsRef.current)
      queue.current.push({ flush: true, options: optionsRef.current });
    setPending(queue.current.length + (busy.current ? 1 : 0));
    void drain();
  }, [drain]);

  const start = useCallback(
    async (options: SessionOptions) => {
      if (
        startingRef.current ||
        capture.current ||
        busy.current ||
        retryIds.current.size
      )
        return;
      startingRef.current = true;
      setStarting(true);
      setError("");
      sentenceBuffer.current = new SentenceBuffer();
      heldSegmentId.current = undefined;
      diagnostics.begin({
        source: options.source,
        languages: options.languages,
        targets: options.targets,
        silenceMs: options.silenceMs,
        threshold: options.threshold,
        captureOnly: options.captureOnly ?? false,
        models: options.models,
      });
      optionsRef.current = structuredClone(options);
      sessionBase.current = elapsed;
      lastOffset.current = elapsed;
      try {
        const activeCapture = await startCapture({
          ...options,
          onLevel: (value) => {
            if (mounted.current) setLevel(value);
          },
          onEnded: () => stop(),
          onChunk: (chunk) => {
            if (options.captureOnly) return;
            diagnostics.updateSegment(chunk.traceId, {
              queuedAt: performance.now(),
            });
            queue.current.push({
              chunk: { ...chunk, offset: sessionBase.current + chunk.offset },
              options,
            });
            setPending(queue.current.length + (busy.current ? 1 : 0));
            void drain();
            if (queue.current.length >= 12) {
              setError(
                "The model is falling behind. Capture stopped so queued audio can finish processing.",
              );
              // Avoid stopping inside the segmenter's emit callback.
              queueMicrotask(stop);
            }
          },
        });
        if (!mounted.current) {
          activeCapture.stop();
          return;
        }
        capture.current = activeCapture;
        startedAt.current = Date.now();
        setRecording(true);
      } catch (error) {
        if (mounted.current) setError(errorText(error));
      } finally {
        startingRef.current = false;
        if (mounted.current) setStarting(false);
      }
    },
    [drain, stop, elapsed],
  );

  const retry = useCallback(
    async (row: TranscriptRow) => {
      if (retryIds.current.has(row.id)) return;
      retryIds.current.add(row.id);
      setRetrying(retryIds.current.size);
      update(row.id, { status: "translating", error: undefined });
      try {
        let text = row.text;
        if (row.audio) {
          const form = new FormData();
          form.append("audio", row.audio.audio, "speech.wav");
          form.append("languages", JSON.stringify(row.asrLanguages ?? []));
          const result = await api<{ text: string; language: string | null }>(
            "transcribe",
            { method: "POST", body: form },
            cancelled.current.signal,
          );
          text = result.text;
          update(row.id, { text, language: result.language, audio: undefined });
          if (!text) {
            update(row.id, {
              status: "complete",
              text: "(No speech detected)",
              translations: [],
            });
            return;
          }
        }
        await translate(
          row.id,
          text,
          row.translations.map((t) => t.language),
          row.segmentId,
        );
      } catch (error) {
        update(row.id, { status: "error", error: errorText(error) });
      } finally {
        retryIds.current.delete(row.id);
        if (mounted.current) setRetrying(retryIds.current.size);
      }
    },
    [translate, update],
  );

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(
      () =>
        setElapsed(
          sessionBase.current + (Date.now() - startedAt.current) / 1000,
        ),
      250,
    );
    return () => clearInterval(timer);
  }, [recording]);
  useEffect(() => {
    mounted.current = true;
    cancelled.current = new AbortController();
    return () => {
      mounted.current = false;
      cancelled.current.abort();
      capture.current?.stop();
      queue.current = [];
    };
  }, []);

  const clear = () => {
    if (
      !capture.current &&
      !busy.current &&
      !startingRef.current &&
      !retryIds.current.size
    ) {
      setRows([]);
      setElapsed(0);
      setError("");
    }
  };
  return {
    rows,
    recording,
    starting,
    pending,
    retrying,
    level,
    error,
    elapsed,
    start,
    stop,
    retry,
    clear,
    dismissError: () => setError(""),
  };
}
