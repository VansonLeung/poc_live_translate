import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { SettingsStore, environmentConfiguration } from "../server/settings";

const defaults = {
  asr: {
    baseUrl: "http://localhost:8000/v1",
    model: "asr-original",
    key: "private-asr-key",
  },
  llm: {
    baseUrl: "https://example.test/v1",
    model: "llm-original",
    key: "private-llm-key",
  },
};
const input = () => ({
  asr: { baseUrl: defaults.asr.baseUrl, model: "asr-new", apiKey: "" },
  llm: { baseUrl: defaults.llm.baseUrl, model: "llm-new", apiKey: "" },
});
describe("connection settings", () => {
  it("starts without .env and never returns stored secrets", async () => {
    const app = createApp(environmentConfiguration({}));
    expect((await request(app).get("/api/config")).body.configured).toBe(false);
    const settings = await request(createApp(defaults)).get("/api/settings");
    expect(settings.body.asr.hasKey).toBe(true);
    expect(settings.text).not.toContain("private-asr-key");
  });
  it("persists settings, retains blank same-endpoint keys, and does not resurrect removed keys from env", () => {
    const directory = mkdtempSync(join(tmpdir(), "live-translate-settings-"));
    const path = join(directory, "settings.json");
    try {
      const store = new SettingsStore(defaults, { path });
      store.save(input());
      expect(new SettingsStore(defaults, { path }).get().asr).toEqual({
        ...defaults.asr,
        model: "asr-new",
      });
      store.save({ ...input(), asr: { ...input().asr, clearApiKey: true } });
      expect(new SettingsStore(defaults, { path }).get().asr.key).toBe("");
      expect(readFileSync(path, "utf8")).not.toContain("private-asr-key");
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
  it("does not send the previous endpoint's key when testing or saving a different URL", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "asr-new" }] })),
      );
    const store = new SettingsStore(defaults);
    const app = createApp(store, upstream);
    const provider = { ...input().asr, baseUrl: "https://new.example/v1/" };
    const check = await request(app)
      .post("/api/settings/test")
      .send({ kind: "asr", provider });
    expect(check.body.modelFound).toBe(true);
    expect(upstream.mock.calls[0][0]).toBe("https://new.example/v1/models");
    expect(upstream.mock.calls[0][1]?.headers).toEqual({});
    expect(store.get().asr.model).toBe("asr-original");
    await request(app)
      .put("/api/settings")
      .send({ ...input(), asr: provider });
    expect(store.get().asr.key).toBe("");
  });
  it("applies saved endpoints and models to subsequent requests without restarting", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ text: "Speech." })));
    const app = createApp(defaults, upstream);
    const updated = {
      ...input(),
      asr: {
        baseUrl: "http://127.0.0.1:8008/v1",
        model: "new-asr",
        apiKey: "new-key",
      },
    };
    expect((await request(app).put("/api/settings").send(updated)).status).toBe(
      200,
    );
    const response = await request(app)
      .post("/api/transcribe")
      .field("languages", "[]")
      .attach("audio", Buffer.from("RIFF"), {
        filename: "audio.wav",
        contentType: "audio/wav",
      });
    expect(response.status).toBe(200);
    expect(upstream.mock.calls[0][0]).toBe(
      "http://127.0.0.1:8008/v1/audio/transcriptions",
    );
    expect((upstream.mock.calls[0][1]?.body as FormData).get("model")).toBe(
      "new-asr",
    );
    expect(upstream.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: "Bearer new-key",
    });
  });
  it("rejects invalid URLs atomically and restricts desktop API access", async () => {
    const store = new SettingsStore(defaults);
    const app = createApp(store);
    expect(
      (
        await request(app)
          .put("/api/settings")
          .send({
            ...input(),
            llm: { model: "x", baseUrl: "file:///etc/passwd" },
          })
      ).status,
    ).toBe(400);
    expect(store.get()).toEqual(defaults);
    expect(
      (
        await request(app)
          .put("/api/settings")
          .set("Origin", "https://other.example")
          .send(input())
      ).status,
    ).toBe(403);
    expect(
      (await request(app).get("/api/settings").set("Host", "other.example"))
        .status,
    ).toBe(403);
    const desktop = createApp(store, fetch, {
      token: "desktop-secret",
      origin: () => "http://127.0.0.1:55555",
    });
    expect((await request(desktop).get("/api/settings")).status).toBe(401);
    expect(
      (
        await request(desktop)
          .get("/api/settings")
          .set("X-Desktop-Token", "desktop-secret")
      ).status,
    ).toBe(200);
  });
});
