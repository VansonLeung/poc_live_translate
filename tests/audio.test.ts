import { describe, expect, it } from "vitest";
import {
  encodeWav,
  SentenceBuffer,
  SpeechSegmenter,
  type AudioSegment,
} from "../src/audio/segments";

describe("speech segmentation", () => {
  it("ignores silence and captures speech with pre-roll through a sentence pause", () => {
    const chunks: AudioSegment[] = [];
    const segmenter = new SpeechSegmenter(16000, 800, 0.01, (chunk) =>
      chunks.push(chunk),
    );
    for (let i = 0; i < 50; i++) segmenter.push(new Float32Array(1600));
    expect(chunks).toHaveLength(0);
    for (let i = 0; i < 10; i++)
      segmenter.push(new Float32Array(1600).fill(0.1));
    for (let i = 0; i < 8; i++) segmenter.push(new Float32Array(1600));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].final).toBe(true);
    expect(chunks[0].reason).toBe("silence");
    expect(chunks[0].quietMs).toBe(800);
    expect(chunks[0].offset).toBeCloseTo(4.9);
    expect(chunks[0].samples.filter((value) => value > 0)).toHaveLength(16000);
  });
  it("bounds continuous speech and flushes remaining samples on stop", () => {
    const chunks: AudioSegment[] = [];
    const segmenter = new SpeechSegmenter(16000, 800, 0.01, (chunk) =>
      chunks.push(chunk),
    );
    for (let i = 0; i < 125; i++)
      segmenter.push(new Float32Array(1600).fill(0.1));
    segmenter.flush();
    expect(chunks.map((chunk) => chunk.final)).toEqual([false, true]);
    expect(chunks.map((chunk) => chunk.reason)).toEqual(["limit", "stop"]);
    expect(chunks.reduce((sum, chunk) => sum + chunk.samples.length, 0)).toBe(
      200000,
    );
  });
  it("keeps a silence boundary after a maximum-duration chunk", () => {
    const chunks: AudioSegment[] = [];
    const segmenter = new SpeechSegmenter(16000, 800, 0.01, (chunk) =>
      chunks.push(chunk),
    );
    for (let i = 0; i < 120; i++)
      segmenter.push(new Float32Array(1600).fill(0.1));
    for (let i = 0; i < 8; i++) segmenter.push(new Float32Array(1600));
    expect(chunks.map((chunk) => chunk.final)).toEqual([false, true]);
  });
  it("encodes independently decodable mono 16 kHz PCM WAV chunks", async () => {
    const wav = await encodeWav(
      new Float32Array(48000).fill(0.5),
      48000,
    ).arrayBuffer();
    const view = new DataView(wav);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(32000);
    expect(view.getInt16(44, true)).toBe(16383);
  });
  it("ends a sentence within one worklet packet of the configured 800 ms pause", () => {
    const chunks: AudioSegment[] = [];
    const segmenter = new SpeechSegmenter(48000, 800, 0.012, (chunk) =>
      chunks.push(chunk),
    );
    for (let i = 0; i < 24; i++)
      segmenter.push(new Float32Array(2048).fill(0.1));
    for (let i = 0; i < 19; i++) segmenter.push(new Float32Array(2048));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].reason).toBe("silence");
    expect(chunks[0].quietMs).toBeGreaterThanOrEqual(800);
    expect(chunks[0].quietMs).toBeLessThan(800 + (2048 / 48000) * 1000);
  });
  it("diagnoses an above-threshold noise floor as a 12 second limit cut", () => {
    const chunks: AudioSegment[] = [];
    const segmenter = new SpeechSegmenter(48000, 800, 0.012, (chunk) =>
      chunks.push(chunk),
    );
    for (let i = 0; i < 282; i++)
      segmenter.push(new Float32Array(2048).fill(0.02));
    expect(chunks[0].reason).toBe("limit");
    expect(chunks[0].quietMs).toBe(0);
    expect(chunks[0].samples.length / 48000).toBeGreaterThanOrEqual(12);
  });
});

describe("sentence buffering", () => {
  it("holds incomplete sentences across forced audio boundaries", () => {
    const buffer = new SentenceBuffer();
    expect(buffer.append("Hello there. The vessel is", false)).toEqual([
      "Hello there.",
    ]);
    expect(
      buffer.append("approaching the harbour. Please wait.", true),
    ).toEqual(["The vessel is approaching the harbour.", "Please wait."]);
    expect(buffer.append("", true)).toEqual([]);
  });
  it("supports Chinese punctuation and flushes unfinished speech at stop", () => {
    const buffer = new SentenceBuffer();
    expect(buffer.append("你好。船舶正在", false)).toEqual(["你好。"]);
    expect(buffer.append("進港", true)).toEqual(["船舶正在進港"]);
  });
});
