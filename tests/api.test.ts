import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../server/app";

const config = {
  asr: {
    baseUrl: "https://models.example/v1",
    key: "private-asr-key",
    model: "Qwen3-ASR-1.7B-bf16",
  },
  llm: {
    baseUrl: "https://models.example/v1",
    key: "private-llm-key",
    model: "Qwen3.5-35B-A3B-4bit",
  },
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
describe("model API", () => {
  it("exposes model labels without credentials or upstream addresses", async () => {
    const response = await request(createApp(config)).get("/api/config");
    expect(response.body).toEqual({
      asrModel: config.asr.model,
      llmModel: config.llm.model,
      configured: true,
      desktop: false,
    });
    expect(response.text).not.toContain("private");
  });
  it("forwards a single ASR language and WAV with server credentials", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ text: " Hello. ", language: "English" }));
    const response = await request(createApp(config, upstream))
      .post("/api/transcribe")
      .field("languages", '["en"]')
      .attach("audio", Buffer.from("RIFF"), {
        filename: "speech.wav",
        contentType: "audio/wav",
      });
    expect(response.status).toBe(200);
    expect(response.headers["server-timing"]).toMatch(/^provider;dur=\d+\.\d$/);
    expect(response.body.text).toBe("Hello.");
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe("https://models.example/v1/audio/transcriptions");
    expect((init!.body as FormData).get("language")).toBe("en");
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      "Bearer private-asr-key",
    );
  });
  it("uses detection plus hints for multiple languages, never invalid comma-separated language codes", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ text: "Hello 你好" }));
    await request(createApp(config, upstream))
      .post("/api/transcribe")
      .field("languages", '["en","yue"]')
      .attach("audio", Buffer.from("RIFF"), {
        filename: "speech.wav",
        contentType: "audio/wav",
      });
    const body = upstream.mock.calls[0][1]!.body as FormData;
    expect(body.has("language")).toBe(false);
    expect(body.get("prompt")).toContain("English, Cantonese");
  });
  it("validates languages and audio before contacting providers", async () => {
    const upstream = vi.fn<typeof fetch>();
    const app = createApp(config, upstream);
    expect(
      (
        await request(app)
          .post("/api/translate")
          .send({ text: "hello", targets: ["invalid"] })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/translate")
          .send({ text: "hello", targets: [] })
      ).status,
    ).toBe(400);
    expect((await request(app).post("/api/transcribe")).status).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/transcribe")
          .field("languages", "bad")
          .attach("audio", Buffer.from("RIFF"), {
            filename: "speech.wav",
            contentType: "audio/wav",
          })
      ).status,
    ).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("preserves successful target translations when another fails and redacts upstream errors", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          choices: [{ message: { content: "<think>hidden</think>你好。" } }],
        }),
      )
      .mockResolvedValueOnce(new Response("private-llm-key", { status: 503 }));
    const response = await request(createApp(config, upstream))
      .post("/api/translate")
      .send({ text: "Hello.", targets: ["zh-Hant", "ja"] });
    expect(response.body.translations[0]).toEqual({
      language: "zh-Hant",
      text: "你好。",
    });
    expect(response.body.translations[1].error).toContain("HTTP 503");
    expect(response.text).not.toContain("private-llm-key");
    expect(JSON.parse(upstream.mock.calls[0][1]!.body as string).model).toBe(
      config.llm.model,
    );
  });
  it("rejects truncated output instead of presenting it as complete", async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        choices: [{ finish_reason: "length", message: { content: "partial" } }],
      }),
    );
    const response = await request(createApp(config, upstream))
      .post("/api/translate")
      .send({ text: "Hello.", targets: ["ja"] });
    expect(response.body.translations[0].error).toContain("response limit");
  });
  it("rejects cross-origin calls", async () => {
    expect(
      (
        await request(createApp(config))
          .post("/api/translate")
          .set("Origin", "https://other.example")
          .send({ text: "hello", targets: ["en"] })
      ).status,
    ).toBe(403);
  });
});
