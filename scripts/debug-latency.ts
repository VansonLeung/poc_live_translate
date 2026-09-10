import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { encodeWav } from "../src/audio/segments";
import type { diagnostics } from "../src/diagnostics";

const args = process.argv.slice(2);
const option = (key: string, fallback: string) =>
  args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const mode = option("--mode", "capture");
if (!["capture", "mock", "live"].includes(mode))
  throw new Error("--mode must be capture, mock, or live");
if (mode === "live" && !args.includes("--audio"))
  throw new Error(
    "Live mode requires --audio pointing to a speech WAV; synthetic tones are not useful ASR input.",
  );
const seconds = Number(option("--seconds", "9"));
if (!Number.isFinite(seconds) || seconds < 1 || seconds > 120)
  throw new Error("--seconds must be between 1 and 120");
const output = resolve(option("--output", `debug-reports/${mode}.json`));
const file = resolve(
  option("--audio", `${tmpdir()}/maritime-latency-tone.wav`),
);
if (!args.includes("--audio")) {
  // Three one-second signals, each followed by enough silence to close a segment.
  const pcm = new Float32Array(16000 * 12);
  for (let burst = 0; burst < 3; burst++) {
    for (let i = 0; i < 16000; i++)
      pcm[(0.5 + burst * 2.6) * 16000 + i] =
        0.2 * Math.sin((i * 2 * Math.PI * 440) / 16000);
  }
  await writeFile(
    file,
    new Uint8Array(await encodeWav(pcm, 16000).arrayBuffer()),
  );
}

const browser = await chromium.launch({
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${file}%noloop`,
  ],
});
try {
  const context = await browser.newContext({
    permissions: ["microphone"],
    viewport: { width: 1500, height: 1000 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  let asrRequests = 0,
    translationRequests = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().endsWith("/api/transcribe")) asrRequests++;
    if (request.url().endsWith("/api/translate")) translationRequests++;
  });
  if (mode === "capture") {
    await page.route("**/api/transcribe", (route) => route.abort());
    await page.route("**/api/translate", (route) => route.abort());
  }
  if (mode === "mock") {
    await page.route("**/api/transcribe", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await route.fulfill({
        headers: { "Server-Timing": "provider;dur=100" },
        json: {
          text: "The vessel is approaching. Please stand by.",
          language: "en",
        },
      });
    });
    await page.route("**/api/translate", async (route) => {
      // Deliberately slow translation to expose queue wait separately from capture.
      await new Promise((resolve) => setTimeout(resolve, 1800));
      const request = route.request().postDataJSON();
      await route.fulfill({
        headers: { "Server-Timing": "provider;dur=1800" },
        json: {
          translations: request.targets.map((language: string) => ({
            language,
            text: "Test translation.",
          })),
        },
      });
    });
  }
  await page.goto(option("--url", "http://127.0.0.1:6005"));
  await page.locator(".diagnostics-panel summary").click();
  if (mode === "capture")
    await page
      .getByRole("switch", { name: "Capture only", exact: true })
      .click();
  // Use a known source language; retain the UI's two default translation targets.
  await page.locator("#source-languages").click();
  await page
    .locator(".ant-select-dropdown:visible")
    .getByText("English", { exact: true })
    .click();
  await page.getByRole("heading", { level: 1 }).click();
  await page.getByRole("button", { name: "Start listening" }).click();
  await page.getByText("Listening live", { exact: true }).waitFor();
  console.log(
    `Recording ${seconds}s through Chromium's synthetic microphone (${mode}).`,
  );
  await page.waitForTimeout(seconds * 1000);
  await page.getByRole("button", { name: "Stop listening" }).click();
  await expect(
    page.getByRole("button", { name: "Start listening" }),
  ).toBeEnabled({ timeout: 240_000 });
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export timings", exact: true })
    .click();
  const downloadedPath = await (await download).path();
  if (!downloadedPath)
    throw new Error("The browser did not save the timing report.");
  const report = JSON.parse(
    await readFile(downloadedPath, "utf8"),
  ) as ReturnType<typeof diagnostics.export>;
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        verification: {
          mode,
          syntheticMicrophone: true,
          realProviders: mode === "live",
          seconds,
          asrRequests,
          translationRequests,
          browserErrors: errors,
        },
        ...report,
      },
      null,
      2,
    ),
  );
  await page.screenshot({
    path: output.replace(/\.json$/, ".png"),
    fullPage: true,
  });
  if (errors.length) throw new Error(`Browser errors: ${errors.join(", ")}`);
  if (!report.segments.length)
    throw new Error(
      "No audio segments detected; inspect the report and input WAV.",
    );
  if (mode === "capture" && (asrRequests || translationRequests))
    throw new Error("Capture-only mode unexpectedly sent model requests.");
  if (
    mode !== "capture" &&
    (!report.translations.length ||
      report.translations.some((trace) => trace.status !== "complete") ||
      report.segments.some((trace) => trace.status === "error"))
  )
    throw new Error(
      "Model processing did not complete successfully; inspect the saved report.",
    );
  console.table(
    report.segments.map((segment, index) => ({
      segment: index + 1,
      reason: segment.reason,
      pauseMs: Math.round(segment.quietMs),
      queueMs: Math.round(segment.queueMs ?? 0),
      asrMs: Math.round(segment.asrMs ?? 0),
      providerMs: Math.round(segment.providerMs ?? 0),
      status: segment.status,
    })),
  );
  console.table(
    report.translations.map((translation, index) => ({
      translation: index + 1,
      requestMs: Math.round(translation.requestMs ?? 0),
      providerMs: Math.round(translation.providerMs ?? 0),
      afterAsrMs: Math.round(translation.afterAsrMs ?? 0),
      afterSpeechMs: Math.round(translation.afterSpeechMs ?? 0),
      status: translation.status,
    })),
  );
  console.log(`Report: ${output}`);
} finally {
  await browser.close();
}
