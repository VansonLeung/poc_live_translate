export interface AudioSegment {
  samples: Float32Array;
  final: boolean;
  offset: number;
  reason: "silence" | "limit" | "stop";
  quietMs: number;
  voicedMs: number;
}

/** Silence ends an utterance; long uninterrupted speech is bounded without losing samples. */
export class SpeechSegmenter {
  private frames: Float32Array[] = [];
  private preRoll: Float32Array[] = [];
  private count = 0;
  private quiet = 0;
  private voiced = 0;
  private position = 0;
  private start = 0;
  private continued = false;

  constructor(
    private rate: number,
    private silenceMs: number,
    private threshold: number,
    private emit: (segment: AudioSegment) => void,
  ) {}

  push(samples: Float32Array) {
    const rms = Math.sqrt(
      samples.reduce((sum, value) => sum + value * value, 0) / samples.length,
    );
    this.position += samples.length;
    if (!this.frames.length) {
      this.preRoll.push(samples);
      while (
        this.preRoll.length > 1 &&
        this.preRoll.reduce((sum, frame) => sum + frame.length, 0) >
          this.rate * 0.25
      )
        this.preRoll.shift();
      if (rms < this.threshold && !this.continued) return rms;
      this.frames = this.preRoll;
      this.preRoll = [];
      this.count = this.frames.reduce((sum, frame) => sum + frame.length, 0);
      this.start = (this.position - this.count) / this.rate;
    } else {
      this.frames.push(samples);
      this.count += samples.length;
    }
    if (rms >= this.threshold) {
      this.quiet = 0;
      this.voiced += samples.length;
    } else this.quiet += samples.length;
    if (this.quiet >= (this.rate * this.silenceMs) / 1000)
      this.flush(true, "silence");
    else if (this.count >= this.rate * 12) this.flush(false, "limit");
    return rms;
  }

  get state() {
    return {
      bufferedMs: (this.count / this.rate) * 1000,
      quietMs: (this.quiet / this.rate) * 1000,
    };
  }

  flush(final = true, reason: AudioSegment["reason"] = "stop") {
    if (this.count && (this.voiced >= this.rate * 0.12 || this.continued)) {
      const samples = new Float32Array(this.count);
      let offset = 0;
      for (const frame of this.frames) {
        samples.set(frame, offset);
        offset += frame.length;
      }
      this.emit({
        samples,
        final,
        offset: this.start,
        reason,
        quietMs: (this.quiet / this.rate) * 1000,
        voicedMs: (this.voiced / this.rate) * 1000,
      });
      this.continued = !final;
    } else if (final) this.continued = false;
    this.frames = [];
    this.preRoll = [];
    this.count = 0;
    this.quiet = 0;
    this.voiced = 0;
  }
}

/** Average downsampling to 16 kHz and a self-contained PCM WAV for every request. */
export function encodeWav(input: Float32Array, sampleRate: number): Blob {
  const rate = Math.min(sampleRate, 16000);
  const ratio = sampleRate / rate;
  const length = Math.floor(input.length / ratio);
  const bytes = new ArrayBuffer(44 + length * 2);
  const view = new DataView(bytes);
  const text = (offset: number, value: string) => {
    [...value].forEach((char, i) =>
      view.setUint8(offset + i, char.charCodeAt(0)),
    );
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio),
      end = Math.floor((i + 1) * ratio);
    let total = 0;
    for (let j = start; j < end; j++) total += input[j];
    const sample = Math.max(-1, Math.min(1, total / (end - start)));
    view.setInt16(44 + i * 2, sample * (sample < 0 ? 32768 : 32767), true);
  }
  return new Blob([bytes], { type: "audio/wav" });
}

export class SentenceBuffer {
  private pending = "";
  get hasPending() {
    return this.pending.length > 0;
  }
  get pendingCharacters() {
    return this.pending.length;
  }
  append(text: string, final: boolean): string[] {
    const separator =
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(
        this.pending,
      )
        ? ""
        : " ";
    this.pending = (this.pending + separator + text).trim();
    const segments = Array.from(
      new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(
        this.pending,
      ),
      (item) => item.segment.trim(),
    ).filter(Boolean);
    this.pending = "";
    if (
      !final &&
      segments.length &&
      !/[.!?。！？]["'”’）)]*$/u.test(segments.at(-1)!)
    )
      this.pending = segments.pop()!;
    // Bound latency/memory even when ASR emits no punctuation at all.
    if (this.pending.length > 1200) {
      segments.push(this.pending);
      this.pending = "";
    }
    return segments;
  }
}
