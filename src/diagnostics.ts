import { useSyncExternalStore } from "react";

export interface CaptureHealth {
  state: "idle" | "speech" | "waiting for pause" | "stopped";
  rms: number;
  bufferedMs: number;
  quietMs: number;
  packetMs: number;
  maxPacketGapMs: number;
  contextState: string;
  sampleRate: number;
}
export interface SegmentTrace {
  id: string;
  reason: "silence" | "limit" | "stop";
  durationMs: number;
  voicedMs: number;
  quietMs: number;
  encodeMs: number;
  emittedAt: number;
  queuedAt?: number;
  speechEndedAt: number;
  status: string;
  asrStartedAt?: number;
  asrFinishedAt?: number;
  asrMs?: number;
  providerMs?: number;
  characters?: number;
  heldCharacters?: number;
  error?: string;
}
export interface TranslationTrace {
  id: string;
  rowId: string;
  segmentId?: string;
  startedAt: number;
  finishedAt?: number;
  requestMs?: number;
  providerMs?: number;
  characters: number;
  targets: string[];
  status: string;
}
export interface DiagnosticSnapshot {
  startedAt?: string;
  startupMs?: number;
  firstPacketMs?: number;
  settings?: Record<string, unknown>;
  health?: CaptureHealth;
  segments: SegmentTrace[];
  translations: TranslationTrace[];
}

let snapshot: DiagnosticSnapshot = { segments: [], translations: [] };
const listeners = new Set<() => void>();
const publish = (next: DiagnosticSnapshot) => {
  snapshot = next;
  listeners.forEach((listener) => listener());
};
export const diagnostics = {
  begin(settings: Record<string, unknown>) {
    publish({
      startedAt: new Date().toISOString(),
      settings,
      segments: [],
      translations: [],
    });
  },
  capture(
    patch: Partial<
      Pick<DiagnosticSnapshot, "startupMs" | "firstPacketMs" | "health">
    >,
  ) {
    publish({ ...snapshot, ...patch });
  },
  segment(trace: Omit<SegmentTrace, "id" | "status">, captureOnly: boolean) {
    const id = crypto.randomUUID();
    publish({
      ...snapshot,
      segments: [
        ...snapshot.segments,
        { ...trace, id, status: captureOnly ? "capture only" : "queued" },
      ].slice(-200),
    });
    return id;
  },
  updateSegment(id: string | undefined, patch: Partial<SegmentTrace>) {
    if (!id) return;
    publish({
      ...snapshot,
      segments: snapshot.segments.map((trace) =>
        trace.id === id ? { ...trace, ...patch } : trace,
      ),
    });
  },
  translation(trace: Omit<TranslationTrace, "id" | "status" | "startedAt">) {
    const id = crypto.randomUUID();
    publish({
      ...snapshot,
      translations: [
        ...snapshot.translations,
        { ...trace, id, startedAt: performance.now(), status: "translating" },
      ].slice(-500),
    });
    return id;
  },
  updateTranslation(id: string, patch: Partial<TranslationTrace>) {
    publish({
      ...snapshot,
      translations: snapshot.translations.map((trace) =>
        trace.id === id ? { ...trace, ...patch } : trace,
      ),
    });
  },
  export() {
    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      notes:
        "Browser timestamps use performance.now(). Speech end is estimated from the last above-threshold PCM packet. Provider time includes remote network, model queue/loading, and inference; it is not pure inference time. Capture-only mode sends no model requests. Only the latest 200 segments / 500 translations are retained. No audio or transcript text is included.",
      ...snapshot,
      segments: snapshot.segments.map((trace) => ({
        ...trace,
        queueMs:
          trace.asrStartedAt === undefined || trace.queuedAt === undefined
            ? undefined
            : trace.asrStartedAt - trace.queuedAt,
      })),
      translations: snapshot.translations.map((trace) => {
        const segment = snapshot.segments.find(
          (segment) => segment.id === trace.segmentId,
        );
        return {
          ...trace,
          afterAsrMs:
            segment?.asrFinishedAt === undefined
              ? undefined
              : trace.startedAt - segment.asrFinishedAt,
          afterSpeechMs:
            !segment || trace.finishedAt === undefined
              ? undefined
              : trace.finishedAt - segment.speechEndedAt,
        };
      }),
    };
  },
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const useDiagnostics = () =>
  useSyncExternalStore(subscribe, () => snapshot);
