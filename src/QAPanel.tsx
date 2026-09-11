import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Popconfirm, Space, Switch, Tag } from "antd";
import {
  CopyOutlined,
  DownloadOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import type { useLiveQA } from "./useLiveQA";
import { MAX_QUESTION } from "../shared/qa";
import { useReducedMotion } from "./useReducedMotion";

export default function QAPanel({
  qa,
  locked,
  available,
  captureOnly,
  onStopGenerating,
}: {
  qa: ReturnType<typeof useLiveQA>;
  locked: boolean;
  available: boolean;
  captureOnly: boolean;
  onStopGenerating: () => void;
}) {
  const [autoScroll, setAutoScroll] = useState(true);
  const [copyError, setCopyError] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    if (autoScroll)
      scroll.current?.scrollTo({
        top: scroll.current.scrollHeight,
        behavior: reducedMotion ? "auto" : "smooth",
      });
  }, [qa.turns, autoScroll, reducedMotion]);
  const transcript = () =>
    qa.turns
      .map(
        (t) =>
          `Question: ${t.question}\nAnswer: ${t.answer || "(no answer)"}${t.status !== "complete" ? `\n[${t.status}] ${t.error ?? ""}` : ""}`,
      )
      .join("\n\n");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(transcript());
      setCopyError("");
    } catch {
      setCopyError("Clipboard unavailable. Use Export instead.");
    }
  };
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([transcript()], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `conversation-${Date.now()}.txt`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <>
      <div className="transcript-toolbar qa-toolbar">
        <h2>Conversation</h2>
        <Space size={4} wrap>
          <Button
            type="text"
            aria-label="Copy conversation"
            icon={<CopyOutlined />}
            disabled={!qa.turns.length}
            onClick={() => void copy()}
          />
          <Button
            type="text"
            aria-label="Export conversation"
            icon={<DownloadOutlined />}
            disabled={!qa.turns.length}
            onClick={download}
          >
            Export
          </Button>
          <Popconfirm
            title="Start a new conversation?"
            description="This clears the questions, answers, and draft. Export first to keep a copy."
            onConfirm={qa.clear}
            disabled={locked || (!qa.turns.length && !qa.draft)}
          >
            <Button disabled={locked || (!qa.turns.length && !qa.draft)}>
              New conversation
            </Button>
          </Popconfirm>
        </Space>
      </div>
      {copyError && <Alert type="error" title={copyError} />}
      <div
        className="transcript-scroll qa-scroll"
        ref={scroll}
        role="log"
        aria-label="Questions and answers"
        aria-live="polite"
      >
        {!qa.turns.length && (
          <div className="empty-state">
            <h3>Ask a question</h3>
            <p>
              Speak or type below. Answers use the recent conversation for
              context.
            </p>
          </div>
        )}
        {qa.turns.map((turn) => (
          <article className="sentence-card" key={turn.id}>
            <div className="sentence-meta">
              <strong>Question</strong>
              <Tag>
                {turn.status === "answering"
                  ? "Answering…"
                  : turn.status === "complete"
                    ? "Answered"
                    : turn.status === "stopped"
                      ? "Stopped"
                      : "Needs attention"}
              </Tag>
            </div>
            <p className="original-text" dir="auto">
              {turn.question}
            </p>
            <div className="translation">
              <div className="translation-label">Answer</div>
              <p dir="auto">
                {turn.answer ||
                  (turn.status === "answering"
                    ? "Waiting for the model…"
                    : "No answer received.")}
              </p>
            </div>
            {turn.error && <p className="error-text">{turn.error}</p>}
            {(turn.status === "error" || turn.status === "stopped") && (
              <Button
                size="small"
                aria-label="Edit and ask again"
                icon={<ReloadOutlined />}
                disabled={locked || Boolean(qa.draft)}
                onClick={() => qa.setDraft(turn.question)}
              >
                Edit and ask again
              </Button>
            )}
          </article>
        ))}
      </div>
      <div className="qa-composer">
        <label htmlFor="question-draft">Your question</label>
        <Input.TextArea
          id="question-draft"
          value={qa.draft}
          onChange={(event) => qa.setDraft(event.target.value)}
          autoSize={{ minRows: 3, maxRows: 8 }}
          placeholder="Speak a question or type here…"
          disabled={captureOnly}
          dir="auto"
        />
        <div className="qa-composer-actions">
          <span className={qa.draft.length > MAX_QUESTION ? "error-text" : ""}>
            {qa.pending
              ? "Transcribing speech…"
              : `${qa.draft.length.toLocaleString()} / 8,000`}
          </span>
          <Space>
            {qa.answering && (
              <Button onClick={onStopGenerating}>Stop generating</Button>
            )}
            <Button
              type="primary"
              onClick={qa.ask}
              disabled={
                !available ||
                captureOnly ||
                qa.answering ||
                qa.starting ||
                qa.draft.length > MAX_QUESTION ||
                (!qa.draft.trim() && !qa.recording && !qa.pending)
              }
            >
              Ask now
            </Button>
          </Space>
        </div>
        <p className="field-hint">
          Ask now finishes listening and transcription before sending. Speech
          captured during an answer collects in the next draft.
        </p>
      </div>
      <div className="transcript-footer">
        <span>Recent completed answers provide context.</span>
        <label>
          Auto-scroll{" "}
          <Switch size="small" checked={autoScroll} onChange={setAutoScroll} />
        </label>
      </div>
    </>
  );
}
