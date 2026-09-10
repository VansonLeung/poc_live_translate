import "dotenv/config";
import express from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createApp, type Provider } from "./app";

function provider(prefix: "ASR" | "LLM", defaultModel: string): Provider {
  const baseUrl = process.env[`${prefix}_BASE_URL`];
  if (!baseUrl)
    throw new Error(`Set ${prefix}_BASE_URL in .env before starting.`);
  if (!["http:", "https:"].includes(new URL(baseUrl).protocol))
    throw new Error(`${prefix}_BASE_URL must use HTTP or HTTPS.`);
  const configuredProvider = process.env[`${prefix}_PROVIDER`];
  if (configuredProvider && configuredProvider !== "openai-compatible")
    throw new Error(`${prefix}_PROVIDER must be openai-compatible.`);
  return {
    baseUrl,
    key: process.env[`${prefix}_API_KEY`] ?? "",
    model: process.env[`${prefix}_MODEL`] ?? defaultModel,
  };
}

const app = createApp({
  asr: provider("ASR", "Qwen3-ASR-1.7B-bf16"),
  llm: provider("LLM", "Qwen3.5-35B-A3B-4bit"),
});
const dist = resolve("dist");
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get("/{*path}", (_req, res) => {
    res.sendFile(resolve(dist, "index.html"));
  });
}
app.listen(6006, "127.0.0.1", () =>
  console.log("Live Translate API: http://127.0.0.1:6006"),
);
