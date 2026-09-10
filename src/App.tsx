import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Card,
  Empty,
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
  SoundOutlined,
  StopFilled,
  TranslationOutlined,
} from "@ant-design/icons";
import {
  languageName,
  sourceLanguages,
  targetLanguages,
} from "../shared/languages";
import { useLiveTranslation } from "./useLiveTranslation";
import DiagnosticsPanel from "./DiagnosticsPanel";
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
  const session = useLiveTranslation();
  const reducedMotion = useReducedMotion();
  const [captureOnly, setCaptureOnly] = useState(false);
  const [source, setSource] = useState<AudioSource>("microphone");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>();
  const [languages, setLanguages] = useState<string[]>([]);
  const [targets, setTargets] = useState<string[]>(["en", "zh-Hant"]);
  const [silenceMs, setSilenceMs] = useState(800);
  const [threshold, setThreshold] = useState(0.012);
  const [advanced, setAdvanced] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [models, setModels] = useState<{
    asrModel: string;
    llmModel: string;
  }>();
  const [configError, setConfigError] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const locked =
    session.recording ||
    session.starting ||
    session.pending > 0 ||
    session.retrying > 0;

  const refreshConfig = () => {
    setConfigError(false);
    fetch("/api/config")
      .then((response) => {
        if (!response.ok) throw new Error();
        return response.json();
      })
      .then(setModels)
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
  }, [session.rows, autoScroll, reducedMotion]);

  const transcript = () =>
    session.rows
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
        <a className="brand" href="/" aria-label="Maritime home">
          <span className="brand-mark">
            <SoundOutlined />
          </span>
          <span>
            maritime<span className="brand-divider">/</span>
            <span className="brand-product">live translate</span>
          </span>
        </a>
        <div className="topbar-status">
          <span className="local-dot" /> Local workspace{" "}
          <span className="poc-label">POC</span>
        </div>
      </header>

      <main>
        <div className="page-heading">
          <div>
            <div className="eyebrow">REAL-TIME COMMUNICATION</div>
            <h1>Every voice. Understood.</h1>
            <p>Listen in one language. Follow along in many.</p>
          </div>
          <Tag className="sentence-tag" icon={<TranslationOutlined />}>
            Sentence-by-sentence translation
          </Tag>
        </div>

        {configError && (
          <Alert
            type="error"
            showIcon
            title="Cannot connect to the local API"
            description="Start the app with npm run dev to run both the frontend and API."
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

        <DiagnosticsPanel
          captureOnly={captureOnly}
          setCaptureOnly={setCaptureOnly}
          locked={locked}
        />

        <div className="workspace">
          <aside className="settings-panel">
            <Card
              className="setup-card"
              title={
                <span>
                  <SettingOutlined /> Session setup
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
                      label: "Browser tab",
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
                    Choose a tab and enable <strong>Share tab audio</strong> in
                    the browser dialog. Chrome or Edge is recommended.
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
                  Leave empty for auto-detection. One language fixes the ASR
                  language; multiple languages provide hints while
                  auto-detecting.
                </p>
              </div>
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
                <p className="field-hint">
                  Follow up to 5 translations side by side.
                </p>
              </div>

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
                    Pause between sentences{" "}
                    <strong>{(silenceMs / 1000).toFixed(1)}s</strong>
                  </label>
                  <Slider
                    aria-label="Pause between sentences"
                    min={400}
                    max={1600}
                    step={100}
                    value={silenceMs}
                    onChange={setSilenceMs}
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
                    (!targets.length || !models || configError)) ||
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
                        silenceMs,
                        threshold,
                        captureOnly,
                        models,
                      })
                }
              >
                {session.recording
                  ? "Stop listening"
                  : session.pending > 0
                    ? "Finishing translations…"
                    : "Start listening"}
              </Button>
              <p className="capture-hint">
                {session.recording
                  ? "Stop anytime. Remaining speech will finish translating."
                  : "Audio is captured only while listening."}
              </p>
            </Card>

            <div className="model-card">
              <div className="eyebrow">POWERED BY YOUR MODELS</div>
              <div className="model-row">
                <span className="model-icon">
                  <AudioOutlined />
                </span>
                <div>
                  <span>Speech recognition</span>
                  <strong>
                    {models?.asrModel ?? "Loading configuration…"}
                  </strong>
                </div>
              </div>
              <div className="model-row">
                <span className="model-icon">
                  <TranslationOutlined />
                </span>
                <div>
                  <span>Translation</span>
                  <strong>
                    {models?.llmModel ?? "Loading configuration…"}
                  </strong>
                </div>
              </div>
              <p>
                Audio and text are sent to your configured model server. API
                keys stay on the local API server.
              </p>
            </div>
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
                          : "Ready when you are"}
                  </strong>
                  <span>
                    {session.recording
                      ? "Speak naturally. Pause briefly between sentences."
                      : session.pending
                        ? `${session.pending} audio segment${session.pending === 1 ? "" : "s"} remaining`
                        : "Set your languages and start a conversation."}
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

            <div className="transcript-toolbar">
              <div>
                <h2>Live transcript</h2>
                <Badge
                  count={session.rows.length}
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
                    disabled={!session.rows.length}
                    onClick={() => void copy()}
                  />
                </Tooltip>
                <Button
                  type="text"
                  aria-label="Export transcript"
                  icon={<DownloadOutlined />}
                  disabled={!session.rows.length}
                  onClick={download}
                >
                  Export
                </Button>
                <Popconfirm
                  title="Clear the transcript?"
                  description="Export first if you want to keep a copy."
                  onConfirm={session.clear}
                  disabled={locked || !session.rows.length}
                >
                  <Button
                    type="text"
                    aria-label="Clear transcript"
                    icon={<DeleteOutlined />}
                    disabled={locked || !session.rows.length}
                  />
                </Popconfirm>
              </Space>
            </div>
            <div
              className="transcript-scroll"
              aria-live="polite"
              aria-relevant="additions text"
            >
              {!session.rows.length ? (
                <div className="empty-state">
                  <div
                    className={`empty-visual ${session.recording ? "pulsing" : ""}`}
                  >
                    <span className="orbit orbit-one" />
                    <span className="orbit orbit-two" />
                    <span className="empty-mic">
                      <AudioOutlined />
                    </span>
                    <span className="language-bubble bubble-one">Hello</span>
                    <span className="language-bubble bubble-two">你好</span>
                    <span className="language-bubble bubble-three">
                      こんにちは
                    </span>
                  </div>
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    imageStyle={{ display: "none" }}
                    description={
                      <>
                        <h3>
                          {session.recording
                            ? "Your conversation starts here"
                            : "A space for every language"}
                        </h3>
                        <p>
                          {session.recording
                            ? "Listening for speech. Your first sentence will appear after a short pause."
                            : "Your words and their translations will appear here, one sentence at a time."}
                        </p>
                      </>
                    }
                  />
                  <div className="empty-steps">
                    <span>
                      <AudioOutlined /> Listen
                    </span>
                    <span className="step-line" />
                    <span>
                      <SoundOutlined /> Transcribe
                    </span>
                    <span className="step-line" />
                    <span>
                      <TranslationOutlined /> Translate
                    </span>
                  </div>
                </div>
              ) : (
                session.rows.map((row, index) => (
                  <article className="sentence-card" key={row.id}>
                    <div className="sentence-meta">
                      <span className="sentence-index">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span>{clock(row.offset)}</span>
                      <Tag>
                        {row.language ? languageName(row.language) : "Original"}
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
                          <span className="error-text">Needs attention</span>
                        ) : (
                          <>
                            <CheckOutlined /> Translated
                          </>
                        )}
                      </span>
                    </div>
                    <p className="original-text" dir="auto">
                      {row.text || "Audio segment could not be transcribed."}
                    </p>
                    <div className="translations-grid">
                      {row.translations.map((translation) => (
                        <div className="translation" key={translation.language}>
                          <div className="translation-label">
                            {languageName(translation.language)}
                          </div>
                          <p
                            dir="auto"
                            className={translation.error ? "error-text" : ""}
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
                        onClick={() => void session.retry(row)}
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
          </section>
        </div>
        <footer className="page-footer">
          <span>
            MARITIME <span className="footer-slash">/</span> LIVE TRANSLATE
          </span>
          <span>Speech connects us.</span>
        </footer>
      </main>
    </div>
  );
}
