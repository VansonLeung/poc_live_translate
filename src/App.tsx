import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Card,
  Popconfirm,
  Segmented,
  Select,
  Slider,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
} from "antd";
import {
  AudioOutlined,
  CheckOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  GlobalOutlined,
  LoadingOutlined,
  PlayCircleFilled,
  ReloadOutlined,
  SettingOutlined,
  StopFilled,
} from "@ant-design/icons";
import {
  languageName,
  sourceLanguages,
  targetLanguages,
} from "../shared/languages";
import { useLiveTranslation } from "./useLiveTranslation";
import { useLiveQA } from "./useLiveQA";
import QAPanel from "./QAPanel";
import DiagnosticsPanel from "./DiagnosticsPanel";
import ConnectionSettings from "./ConnectionSettings";
import type { AppConfiguration } from "../shared/settings";
import { useReducedMotion } from "./useReducedMotion";
import type { AudioSource } from "./audio/capture";

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;

export default function App() {
  const { message } = AntApp.useApp();
  const translation = useLiveTranslation();
  const [mode, setMode] = useState<"translate" | "qa">("translate");
  const [autoAnswer, setAutoAnswer] = useState(false);
  const [answerLanguage, setAnswerLanguage] = useState("auto");
  const [questionPause, setQuestionPause] = useState(1800);
  const reducedMotion = useReducedMotion();
  const [captureOnly, setCaptureOnly] = useState(false);
  const qa = useLiveQA({
    autoAnswer,
    answerLanguage,
    enabled: mode === "qa",
    captureOnly,
  });
  const session = mode === "qa" ? qa : translation;
  const [source, setSource] = useState<AudioSource>("microphone");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>();
  const [languages, setLanguages] = useState<string[]>([]);
  const [targets, setTargets] = useState<string[]>(["en", "zh-Hant"]);
  const [silenceMs, setSilenceMs] = useState(800);
  const [threshold, setThreshold] = useState(0.012);
  const [advanced, setAdvanced] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [models, setModels] = useState<AppConfiguration>();
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [configError, setConfigError] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const locked =
    session.recording ||
    session.starting ||
    session.pending > 0 ||
    session.retrying > 0 ||
    qa.answering;

  const refreshConfig = () => {
    setConfigError(false);
    fetch("/api/config")
      .then((response) => {
        if (!response.ok) throw new Error();
        return response.json();
      })
      .then((config: AppConfiguration) => {
        setModels(config);
        if (config.configured === false) setConnectionsOpen(true);
      })
      .catch(() => setConfigError(true));
  };
  useEffect(refreshConfig, []);
  useEffect(() => {
    const refresh = () => {
      void navigator.mediaDevices
        ?.enumerateDevices()
        .then((all) =>
          setDevices(all.filter((device) => device.kind === "audioinput")),
        )
        .catch(() => {});
    };
    refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () =>
      navigator.mediaDevices?.removeEventListener("devicechange", refresh);
  }, [session.recording]);
  useEffect(() => {
    const container = bottom.current?.parentElement;
    if (autoScroll && container)
      container.scrollTo({
        top: container.scrollHeight,
        behavior: reducedMotion ? "auto" : "smooth",
      });
  }, [translation.rows, autoScroll, reducedMotion]);

  const transcript = () =>
    translation.rows
      .map(
        (row) =>
          `[${clock(row.offset)}] ${row.text || "[Transcription failed]"}\n${row.error ? `Error: ${row.error}\n` : ""}${row.translations.map((t) => `${languageName(t.language)}: ${t.text || t.error || "(pending)"}`).join("\n")}`,
      )
      .join("\n\n");
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([transcript()], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `maritime-transcript-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(transcript());
      message.success("Transcript copied");
    } catch {
      message.error("Clipboard unavailable. Use Export instead.");
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <h1>{mode === "qa" ? "Live Q&A" : "Live Translate"}</h1>
        <Button
          aria-label="Connections"
          icon={<SettingOutlined />}
          disabled={locked}
          onClick={() => setConnectionsOpen(true)}
        >
          Connections
        </Button>
      </header>
      <ConnectionSettings
        open={connectionsOpen && !locked}
        onClose={() => setConnectionsOpen(false)}
        onSaved={() => {
          refreshConfig();
          message.success("Connections saved");
        }}
      />
      <main>
        <Segmented
          className="mode-selector"
          aria-label="App mode"
          disabled={locked}
          value={mode}
          onChange={(value) => setMode(value as "translate" | "qa")}
          options={[
            { label: "Live Translate", value: "translate" },
            { label: "Live Q&A", value: "qa" },
          ]}
        />
        {configError && (
          <Alert
            type="error"
            showIcon
            title="Cannot connect to the local API"
            description="The local service is unavailable. Restart the app or the development server."
            action={<Button onClick={refreshConfig}>Retry</Button>}
          />
        )}
        {session.error && (
          <Alert
            type="error"
            showIcon
            closable
            onClose={session.dismissError}
            title={session.error}
          />
        )}

        <div className="workspace">
          <aside className="settings-panel">
            <Card
              className="setup-card"
              title={
                <span>
                  <SettingOutlined /> Audio and languages
                </span>
              }
            >
              <div className="field">
                <label>Audio source</label>
                <Segmented
                  block
                  disabled={locked}
                  value={source}
                  onChange={(value) => setSource(value as AudioSource)}
                  options={[
                    {
                      label: "Microphone",
                      value: "microphone",
                      icon: <AudioOutlined />,
                    },
                    {
                      label: models?.desktop ? "Desktop audio" : "Browser tab",
                      value: "browser",
                      icon: <GlobalOutlined />,
                    },
                  ]}
                />
              </div>
              {source === "microphone" ? (
                <div className="field">
                  <label htmlFor="microphone">Input device</label>
                  <Select
                    id="microphone"
                    value={deviceId ?? ""}
                    disabled={locked}
                    onChange={(value) => setDeviceId(value || undefined)}
                    options={[
                      { value: "", label: "System default microphone" },
                      ...devices
                        .filter(
                          (device) =>
                            device.deviceId && device.deviceId !== "default",
                        )
                        .map((device, index) => ({
                          value: device.deviceId,
                          label: device.label || `Microphone ${index + 1}`,
                        })),
                    ]}
                  />
                  <p className="field-hint">
                    Allow microphone access when you start listening.
                  </p>
                </div>
              ) : (
                <div className="source-note">
                  <GlobalOutlined />
                  <span>
                    {models?.desktop ? (
                      "Choose a screen to share its audio. Allow screen and system audio recording if prompted."
                    ) : (
                      <>
                        Choose a tab and enable <strong>Share tab audio</strong>
                        . Use Chrome or Edge.
                      </>
                    )}
                  </span>
                </div>
              )}

              <div className="section-divider" />
              <div className="field">
                <label htmlFor="source-languages">
                  <span className="step-number">1</span> Listen for
                </label>
                <Select
                  id="source-languages"
                  mode="multiple"
                  allowClear
                  disabled={locked}
                  value={languages}
                  onChange={setLanguages}
                  options={sourceLanguages}
                  optionFilterProp="label"
                  placeholder="Auto-detect language"
                />
                <p className="field-hint">
                  Empty: auto-detect. One language: fixed. Multiple: detection
                  hints.
                </p>
              </div>
              {mode === "translate" ? (
                <div className="field">
                  <label htmlFor="target-languages">
                    <span className="step-number">2</span> Translate into
                  </label>
                  <Select
                    id="target-languages"
                    mode="multiple"
                    disabled={locked}
                    maxCount={5}
                    value={targets}
                    onChange={setTargets}
                    options={targetLanguages}
                    optionFilterProp="label"
                    placeholder="Select translation languages"
                  />
                  <p className="field-hint">Up to 5 languages.</p>
                </div>
              ) : (
                <>
                  <div className="field">
                    <label htmlFor="answer-language">Answer language</label>
                    <Select
                      id="answer-language"
                      showSearch
                      optionFilterProp="label"
                      disabled={locked}
                      value={answerLanguage}
                      onChange={setAnswerLanguage}
                      options={[
                        { value: "auto", label: "Same as question" },
                        ...targetLanguages,
                      ]}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="auto-answer">
                      Automatic answers{" "}
                      <Switch
                        id="auto-answer"
                        aria-label="Automatic answers"
                        checked={autoAnswer}
                        onChange={setAutoAnswer}
                        disabled={locked || captureOnly}
                      />
                    </label>
                    <p className="field-hint">
                      {autoAnswer
                        ? "Answer each completed speaking turn after a pause. Further speech waits while an answer is generated."
                        : "Review your question, then click Ask now."}
                    </p>
                  </div>
                </>
              )}

              <button
                className="advanced-toggle"
                onClick={() => setAdvanced((value) => !value)}
                aria-expanded={advanced}
              >
                <SettingOutlined /> Audio fine-tuning{" "}
                <span>{advanced ? "−" : "+"}</span>
              </button>
              {advanced && (
                <div className="advanced-settings">
                  <label>
                    {mode === "qa"
                      ? "Pause before answering"
                      : "Pause between sentences"}{" "}
                    <strong>
                      {(
                        (mode === "qa" ? questionPause : silenceMs) / 1000
                      ).toFixed(1)}
                      s
                    </strong>
                  </label>
                  <Slider
                    aria-label={
                      mode === "qa"
                        ? "Pause before answering"
                        : "Pause between sentences"
                    }
                    min={400}
                    max={mode === "qa" ? 4000 : 1600}
                    step={100}
                    value={mode === "qa" ? questionPause : silenceMs}
                    onChange={mode === "qa" ? setQuestionPause : setSilenceMs}
                    disabled={locked}
                  />
                  <label>
                    Speech detection threshold{" "}
                    <strong>{threshold.toFixed(3)}</strong>
                  </label>
                  <Slider
                    aria-label="Speech detection threshold"
                    min={0.003}
                    max={0.05}
                    step={0.001}
                    value={threshold}
                    onChange={setThreshold}
                    disabled={locked}
                  />
                  <p className="field-hint">
                    Lower the threshold for quiet voices. Raise it if background
                    noise triggers transcription.
                  </p>
                </div>
              )}

              <Button
                className="start-button"
                block
                type="primary"
                size="large"
                danger={session.recording}
                loading={session.starting}
                disabled={
                  !session.recording &&
                  ((!captureOnly &&
                    ((mode === "translate" && !targets.length) ||
                      !models ||
                      models.configured === false ||
                      configError)) ||
                    session.pending > 0 ||
                    session.retrying > 0)
                }
                icon={session.recording ? <StopFilled /> : <PlayCircleFilled />}
                onClick={() =>
                  session.recording
                    ? session.stop()
                    : void session.start({
                        source,
                        deviceId,
                        languages,
                        targets,
                        silenceMs: mode === "qa" ? questionPause : silenceMs,
                        threshold,
                        captureOnly,
                        models,
                      })
                }
              >
                {session.recording
                  ? "Stop listening"
                  : session.pending > 0
                    ? mode === "qa"
                      ? "Finishing transcription…"
                      : "Finishing translations…"
                    : "Start listening"}
              </Button>
              <p className="capture-hint">
                {session.recording
                  ? mode === "qa"
                    ? "Stop listening to finish the question."
                    : "Stop anytime. Remaining speech will finish translating."
                  : "Audio is captured only while listening."}
              </p>
            </Card>
          </aside>

          <section className="transcript-panel">
            <div
              className={`session-status ${session.recording ? "is-live" : ""}`}
            >
              <div className="session-status-main">
                <span className="status-symbol">
                  <AudioOutlined />
                </span>
                <div>
                  <strong>
                    {session.recording
                      ? "Listening live"
                      : session.starting
                        ? "Connecting audio…"
                        : session.pending
                          ? "Processing your speech"
                          : "Ready"}
                  </strong>
                  <span>
                    {session.recording
                      ? mode === "qa"
                        ? "Speak your question. Pause when finished."
                        : "Speak naturally. Pause briefly between sentences."
                      : session.pending
                        ? `${session.pending} audio segment${session.pending === 1 ? "" : "s"} remaining`
                        : captureOnly
                          ? "Capture only: no model requests."
                          : "Microphone off"}
                  </span>
                </div>
              </div>
              <div
                className="signal-meter"
                role="meter"
                aria-label="Audio input level"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(
                  Math.min(1, session.level * 12) * 100,
                )}
              >
                {Array.from({ length: 18 }, (_, i) => (
                  <i
                    key={i}
                    style={{
                      height: `${8 + Math.sin(i * 1.7) ** 2 * 24}px`,
                      background:
                        session.level * 220 > i ? "#168a79" : undefined,
                    }}
                  />
                ))}
              </div>
              <span className="session-clock">{clock(session.elapsed)}</span>
            </div>

            {mode === "qa" ? (
              <QAPanel
                qa={qa}
                locked={locked}
                available={Boolean(
                  models && models.configured !== false && !configError,
                )}
                captureOnly={captureOnly}
                onStopGenerating={() => {
                  setAutoAnswer(false);
                  qa.stopGenerating();
                }}
              />
            ) : (
              <>
                <div className="transcript-toolbar">
                  <div>
                    <h2>Live transcript</h2>
                    <Badge
                      count={translation.rows.length}
                      showZero
                      color="#edf2f5"
                      style={{ color: "#516271", boxShadow: "none" }}
                    />
                  </div>
                  <Space size={4}>
                    <Tooltip title="Copy transcript">
                      <Button
                        type="text"
                        aria-label="Copy transcript"
                        icon={<CopyOutlined />}
                        disabled={!translation.rows.length}
                        onClick={() => void copy()}
                      />
                    </Tooltip>
                    <Button
                      type="text"
                      aria-label="Export transcript"
                      icon={<DownloadOutlined />}
                      disabled={!translation.rows.length}
                      onClick={download}
                    >
                      Export
                    </Button>
                    <Popconfirm
                      title="Clear the transcript?"
                      description="Export first if you want to keep a copy."
                      onConfirm={session.clear}
                      disabled={locked || !translation.rows.length}
                    >
                      <Button
                        type="text"
                        aria-label="Clear transcript"
                        icon={<DeleteOutlined />}
                        disabled={locked || !translation.rows.length}
                      />
                    </Popconfirm>
                  </Space>
                </div>
                <div
                  className="transcript-scroll"
                  aria-live="polite"
                  aria-relevant="additions text"
                >
                  {!translation.rows.length ? (
                    <div className="empty-state">
                      <AudioOutlined className="empty-icon" />
                      <h3>
                        {session.recording
                          ? "Listening for speech…"
                          : "No transcript yet"}
                      </h3>
                      <p>
                        {captureOnly
                          ? "Capture-only measurements appear under Latency diagnostics."
                          : session.recording
                            ? "Pause briefly to process the sentence."
                            : "Choose audio and languages, then start listening."}
                      </p>
                    </div>
                  ) : (
                    translation.rows.map((row, index) => (
                      <article className="sentence-card" key={row.id}>
                        <div className="sentence-meta">
                          <span className="sentence-index">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <span>{clock(row.offset)}</span>
                          <Tag>
                            {row.language
                              ? languageName(row.language)
                              : "Original"}
                          </Tag>
                          <span className="sentence-state">
                            {row.status === "translating" ? (
                              <>
                                <Spin
                                  indicator={<LoadingOutlined spin />}
                                  size="small"
                                />{" "}
                                Translating
                              </>
                            ) : row.status === "error" ? (
                              <span className="error-text">
                                Needs attention
                              </span>
                            ) : (
                              <>
                                <CheckOutlined /> Translated
                              </>
                            )}
                          </span>
                        </div>
                        <p className="original-text" dir="auto">
                          {row.text ||
                            "Audio segment could not be transcribed."}
                        </p>
                        <div className="translations-grid">
                          {row.translations.map((translation) => (
                            <div
                              className="translation"
                              key={translation.language}
                            >
                              <div className="translation-label">
                                {languageName(translation.language)}
                              </div>
                              <p
                                dir="auto"
                                className={
                                  translation.error ? "error-text" : ""
                                }
                              >
                                {translation.text ||
                                  translation.error ||
                                  (row.status === "translating"
                                    ? "Translating…"
                                    : "Translation unavailable")}
                              </p>
                            </div>
                          ))}
                        </div>
                        {row.error && (
                          <p className="error-text row-error">{row.error}</p>
                        )}
                        {row.status === "error" && (
                          <Button
                            size="small"
                            icon={<ReloadOutlined />}
                            onClick={() => void translation.retry(row)}
                          >
                            Retry
                          </Button>
                        )}
                      </article>
                    ))
                  )}
                  <div ref={bottom} />
                </div>
                <div className="transcript-footer">
                  <span>
                    <span
                      className={`footer-dot ${session.recording ? "active" : ""}`}
                    />
                    {session.recording
                      ? "Capture active"
                      : session.pending
                        ? "Finishing queued audio"
                        : "Capture off"}
                    {session.pending > 0 && session.recording
                      ? ` · ${session.pending} processing`
                      : ""}
                  </span>
                  <label>
                    Auto-scroll{" "}
                    <Switch
                      size="small"
                      checked={autoScroll}
                      onChange={setAutoScroll}
                    />
                  </label>
                </div>
              </>
            )}
          </section>
        </div>
        <DiagnosticsPanel
          captureOnly={captureOnly}
          setCaptureOnly={setCaptureOnly}
          locked={locked}
        />
      </main>
    </div>
  );
}
