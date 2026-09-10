import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("capture-only mode records timing data without contacting either model", async ({
  page,
}) => {
  let modelRequests = 0;
  await page.route("**/api/config", (route) =>
    route.fulfill({ json: { asrModel: "ASR", llmModel: "LLM" } }),
  );
  await page.route(/\/api\/(transcribe|translate)$/, (route) => {
    modelRequests++;
    return route.abort();
  });
  await page.goto("/");
  await page.locator(".diagnostics-panel summary").click();
  await page.getByRole("switch", { name: "Capture only", exact: true }).click();
  await page.getByRole("button", { name: "Start listening" }).click();
  await expect(page.getByText("Listening live", { exact: true })).toBeVisible();
  // The fake device emits repeated tones. The sampled display may land in a brief pause.
  await expect(page.locator(".diagnostic-health")).toContainText(/speech|waiting for pause/);
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Stop listening" }).click();
  await expect(
    page
      .getByRole("table", { name: "Audio segment timings", exact: true })
      .locator("tbody tr"),
  ).toHaveCount(1);
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export timings", exact: true })
    .click();
  const path = await (await download).path();
  const report = JSON.parse(await readFile(path!, "utf8"));
  expect(report.settings.captureOnly).toBe(true);
  expect(report.segments[0].reason).toBe("stop");
  expect(report.segments[0].durationMs).toBeGreaterThan(120);
  expect(report.segments[0].asrStartedAt).toBeUndefined();
  expect(report.firstPacketMs).toBeGreaterThanOrEqual(0);
  expect(report.translations).toEqual([]);
  expect(modelRequests).toBe(0);
  await expect(page.locator(".sentence-card")).toHaveCount(0);
});

test("timings separate pause, queue, ASR and translation from transcript content", async ({
  page,
}) => {
  await page.route("**/api/config", (route) =>
    route.fulfill({ json: { asrModel: "ASR", llmModel: "LLM" } }),
  );
  await page.route("**/api/transcribe", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    await route.fulfill({
      headers: { "Server-Timing": "provider;dur=100.0" },
      json: { text: "A private test sentence.", language: "en" },
    });
  });
  await page.route("**/api/translate", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      headers: { "Server-Timing": "provider;dur=230.0" },
      json: {
        translations: [{ language: "en", text: "A private test translation." }],
      },
    });
  });
  await page.goto("/");
  await page.locator(".diagnostics-panel summary").click();
  await page.getByRole("button", { name: "Start listening" }).click();
  await expect(page.locator(".diagnostic-health")).toContainText(/speech|waiting for pause/);
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Stop listening" }).click();
  await expect(
    page.getByRole("button", { name: "Start listening" }),
  ).toBeEnabled();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export timings", exact: true })
    .click();
  const path = await (await download).path();
  const json = await readFile(path!, "utf8");
  const report = JSON.parse(json);
  expect(report.segments[0].queueMs).toBeGreaterThanOrEqual(0);
  expect(report.segments[0].asrMs).toBeGreaterThanOrEqual(120);
  expect(report.segments[0].providerMs).toBe(100);
  expect(report.translations[0].requestMs).toBeGreaterThanOrEqual(250);
  expect(report.translations[0].providerMs).toBe(230);
  expect(report.translations[0].afterSpeechMs).toBeGreaterThan(
    report.translations[0].requestMs,
  );
  expect(json).not.toContain("private test");
});
