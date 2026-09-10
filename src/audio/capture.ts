import workletUrl from "./pcm-worklet.js?url";
import { SpeechSegmenter, encodeWav } from "./segments";
import { diagnostics } from "../diagnostics";

export type AudioSource = "microphone" | "browser";
export interface CapturedChunk {
  audio: Blob;
  final: boolean;
  offset: number;
  traceId: string;
}
export interface CaptureOptions {
  source: AudioSource;
  deviceId?: string;
  silenceMs: number;
  threshold: number;
  captureOnly?: boolean;
  onChunk: (chunk: CapturedChunk) => void;
  onLevel: (value: number) => void;
  onEnded: () => void;
}

export async function startCapture(options: CaptureOptions) {
  const requestedAt = performance.now();
  if (!navigator.mediaDevices || !window.isSecureContext)
    throw new Error("Audio capture needs localhost or an HTTPS connection.");
  if (options.source === "browser" && !navigator.mediaDevices.getDisplayMedia)
    throw new Error(
      "Browser audio sharing is unavailable. Use Chrome or Edge, or choose a microphone.",
    );
  const stream =
    options.source === "browser"
      ? await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        })
      : await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: options.deviceId
              ? { exact: options.deviceId }
              : undefined,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
  let context: AudioContext | undefined;
  let stopped = false;
  try {
    if (!stream.getAudioTracks().length)
      throw new Error(
        "No shared audio was received. Select a browser tab and enable “Share tab audio”, or choose a microphone.",
      );
    context = new AudioContext();
    await context.audioWorklet.addModule(workletUrl);
    await context.resume();
    const readyAt = performance.now();
    diagnostics.capture({ startupMs: readyAt - requestedAt });
    const segmenter = new SpeechSegmenter(
      context.sampleRate,
      options.silenceMs,
      options.threshold,
      (chunk) => {
        const emittedAt = performance.now();
        const audio = encodeWav(chunk.samples, context!.sampleRate);
        const traceId = diagnostics.segment(
          {
            reason: chunk.reason,
            durationMs: (chunk.samples.length / context!.sampleRate) * 1000,
            voicedMs: chunk.voicedMs,
            quietMs: chunk.quietMs,
            emittedAt,
            speechEndedAt: emittedAt - chunk.quietMs,
            encodeMs: performance.now() - emittedAt,
          },
          options.captureOnly ?? false,
        );
        options.onChunk({
          final: chunk.final,
          offset: chunk.offset,
          audio,
          traceId,
        });
      },
    );
    const source = context.createMediaStreamSource(
      new MediaStream(stream.getAudioTracks()),
    );
    const node = new AudioWorkletNode(context, "pcm-capture");
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(node).connect(mute).connect(context.destination);
    let previousPacket = 0,
      maxPacketGapMs = 0,
      lastHealthUpdate = 0;
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const now = performance.now();
      if (!previousPacket)
        diagnostics.capture({ firstPacketMs: now - readyAt });
      else maxPacketGapMs = Math.max(maxPacketGapMs, now - previousPacket);
      previousPacket = now;
      const rms = segmenter.push(event.data);
      options.onLevel(rms);
      // Keep diagnostics at 5 Hz so instrumentation does not dominate render work.
      if (now - lastHealthUpdate >= 200) {
        lastHealthUpdate = now;
        diagnostics.capture({
          health: {
            ...segmenter.state,
            rms,
            sampleRate: context!.sampleRate,
            packetMs: (event.data.length / context!.sampleRate) * 1000,
            maxPacketGapMs,
            contextState: context!.state,
            state:
              rms >= options.threshold
                ? "speech"
                : segmenter.state.bufferedMs
                  ? "waiting for pause"
                  : "idle",
          },
        });
      }
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      node.port.onmessage = null;
      segmenter.flush();
      stream.getTracks().forEach((track) => track.stop());
      source.disconnect();
      node.disconnect();
      mute.disconnect();
      void context!.close();
      options.onLevel(0);
      diagnostics.capture({
        health: {
          ...segmenter.state,
          rms: 0,
          sampleRate: context!.sampleRate,
          packetMs: (2048 / context!.sampleRate) * 1000,
          maxPacketGapMs,
          contextState: "closed",
          state: "stopped",
        },
      });
    };
    for (const track of stream.getTracks())
      track.addEventListener("ended", options.onEnded, { once: true });
    return { stop };
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    await context?.close();
    throw error;
  }
}
