import { Button, Switch, Tag } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import { diagnostics, useDiagnostics } from "./diagnostics";

const ms = (value?: number) =>
  value === undefined ? "—" : `${Math.round(value)} ms`;

export default function DiagnosticsPanel({
  captureOnly,
  setCaptureOnly,
  locked,
}: {
  captureOnly: boolean;
  setCaptureOnly: (value: boolean) => void;
  locked: boolean;
}) {
  const trace = useDiagnostics();
  const exportTimings = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(diagnostics.export(), null, 2)], {
        type: "application/json",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `latency-${Date.now()}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <details className="diagnostics-panel">
      <summary>
        Latency diagnostics
      </summary>
      <div className="diagnostics-body">
        <div className="diagnostics-actions">
          <label>
            <Switch
              checked={captureOnly}
              onChange={setCaptureOnly}
              disabled={locked}
              aria-label="Capture only"
            />{" "}
            Capture only — skip ASR and translation
          </label>
          <Button
            size="small"
            icon={<DownloadOutlined />}
            onClick={exportTimings}
            aria-label="Export timings"
          >
            Export timings
          </Button>
        </div>
        <p>
          Enable capture only, start listening, say a sentence, then pause. A
          segment should appear after the configured pause (normally 800 ms).
          Disable capture only and repeat to compare the model stages. Each
          start resets this trace.
        </p>
        <div className="diagnostic-health">
          <Tag>{trace.health?.state ?? "Not started"}</Tag>
          <span>
            Input RMS: <strong>{trace.health?.rms.toFixed(4) ?? "—"}</strong> /
            threshold {String(trace.settings?.threshold ?? "—")}
          </span>
          <span>
            Buffered: <strong>{ms(trace.health?.bufferedMs)}</strong>
          </span>
          <span>
            Pause: <strong>{ms(trace.health?.quietMs)}</strong> /{" "}
            {String(trace.settings?.silenceMs ?? 800)} ms
          </span>
          <span>
            Startup (incl. permission): <strong>{ms(trace.startupMs)}</strong>
          </span>
          <span>
            First packet: <strong>{ms(trace.firstPacketMs)}</strong>
          </span>
          <span>
            Packet duration / max delivery gap:{" "}
            <strong>
              {ms(trace.health?.packetMs)} / {ms(trace.health?.maxPacketGapMs)}
            </strong>
          </span>
          <span>
            Audio context: <strong>{trace.health?.contextState ?? "—"}</strong>
          </span>
        </div>
        {captureOnly && (
          <p className="diagnostic-notice">
            Capture-only mode is enabled. Audio is measured locally; no
            transcripts or model requests are produced.
          </p>
        )}
        <div className="diagnostic-table">
          <table aria-label="Audio segment timings">
            <thead>
              <tr>
                <th>Segment</th>
                <th>Cut reason</th>
                <th>Audio length</th>
                <th>Pause wait</th>
                <th>WAV encode</th>
                <th>Queue wait</th>
                <th>ASR request</th>
                <th>ASR provider</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {trace.segments.map((segment, index) => (
                <tr key={segment.id}>
                  <td>{index + 1}</td>
                  <td>{segment.reason}</td>
                  <td>{ms(segment.durationMs)}</td>
                  <td>{ms(segment.quietMs)}</td>
                  <td>{ms(segment.encodeMs)}</td>
                  <td>
                    {ms(
                      segment.asrStartedAt === undefined ||
                        segment.queuedAt === undefined
                        ? undefined
                        : segment.asrStartedAt - segment.queuedAt,
                    )}
                  </td>
                  <td>{ms(segment.asrMs)}</td>
                  <td>{ms(segment.providerMs)}</td>
                  <td>
                    {segment.status}
                    {segment.heldCharacters
                      ? ` (${segment.heldCharacters} characters held)`
                      : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="diagnostic-table">
          <table aria-label="Translation timings">
            <thead>
              <tr>
                <th>Request</th>
                <th>Segment</th>
                <th>Targets</th>
                <th>Wait after ASR</th>
                <th>LLM request</th>
                <th>LLM provider</th>
                <th>After speech end</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {trace.translations.map((translation, index) => {
                const segmentIndex = trace.segments.findIndex(
                  (segment) => segment.id === translation.segmentId,
                );
                const segment = trace.segments[segmentIndex];
                return (
                  <tr key={translation.id}>
                    <td>{index + 1}</td>
                    <td>{segmentIndex < 0 ? "—" : segmentIndex + 1}</td>
                    <td>{translation.targets.join(", ")}</td>
                    <td>
                      {ms(
                        segment?.asrFinishedAt === undefined
                          ? undefined
                          : translation.startedAt - segment.asrFinishedAt,
                      )}
                    </td>
                    <td>{ms(translation.requestMs)}</td>
                    <td>{ms(translation.providerMs)}</td>
                    <td>
                      {ms(
                        !segment || translation.finishedAt === undefined
                          ? undefined
                          : translation.finishedAt - segment.speechEndedAt,
                      )}
                    </td>
                    <td>{translation.status}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <ul>
          <li>
            <strong>Repeated “limit” cuts at 12 seconds:</strong> the input is
            not staying below the threshold for long enough. Check noise and the
            pause/threshold settings.
          </li>
          <li>
            <strong>High queue wait:</strong> earlier ASR/LLM work is blocking
            the next audio segment. This is separate from microphone listening.
          </li>
          <li>
            <strong>High ASR/LLM provider time:</strong> time is spent between
            the local API and the model server, including network, model
            loading/queueing, and inference.
          </li>
          <li>
            <strong>Waiting for sentence:</strong> ASR returned an incomplete
            sentence at a forced audio cut; it is held until more speech or
            Stop.
          </li>
        </ul>
        <p>
          Speech end is estimated from the last above-threshold audio packet.
          “After speech end” ends when the translation response is processed,
          before browser painting. Provider timing does not isolate pure
          inference. Timings contain no audio or transcript text and retain the
          latest 200 segments / 500 requests.
        </p>
      </div>
    </details>
  );
}
