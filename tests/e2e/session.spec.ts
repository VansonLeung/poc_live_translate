import { expect, test } from "@playwright/test";

test("microphone capture transcribes, translates each sentence, exports, and stops cleanly", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const requests: string[] = [];
  let asrCalls = 0;
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        asrModel: "Qwen3-ASR-1.7B-bf16",
        llmModel: "Qwen3.5-35B-A3B-4bit",
      },
    }),
  );
  await page.route("**/api/transcribe", async (route) => {
    asrCalls++;
    expect(route.request().headers()["content-type"]).toContain(
      "multipart/form-data",
    );
    expect(
      route.request().postDataBuffer()!.includes(Buffer.from("RIFF")),
    ).toBe(true);
    await route.fulfill({
      json: {
        text: "The vessel is arriving. Please stand by.",
        language: "en",
      },
    });
  });
  await page.route("**/api/translate", async (route) => {
    const data = route.request().postDataJSON();
    requests.push(data.text);
    await route.fulfill({
      json: {
        translations: data.targets.map((language: string) => ({
          language,
          text: language === "en" ? data.text : "船舶即將抵達。",
        })),
      },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Every voice. Understood." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start listening" }).click();
  await expect(page.getByText("Listening live", { exact: true })).toBeVisible();
  await expect(page.locator(".sentence-card").first()).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole("button", { name: "Stop listening" }).click();
  await expect(
    page.getByRole("button", { name: "Start listening" }),
  ).toBeEnabled({ timeout: 20000 });
  expect(asrCalls).toBeGreaterThan(0);
  expect(requests).toContain("The vessel is arriving.");
  expect(requests).toContain("Please stand by.");
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export transcript", exact: true })
    .click();
  expect((await download).suggestedFilename()).toContain(
    "maritime-transcript-",
  );
  await page.screenshot({
    path: "test-results/session-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Clear transcript" }).click();
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.locator(".sentence-card")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("empty state fits a mobile viewport and validates translation selection", async ({
  page,
}) => {
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        asrModel: "Qwen3-ASR-1.7B-bf16",
        llmModel: "Qwen3.5-35B-A3B-4bit",
      },
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Start listening" }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/session-mobile.png",
    fullPage: true,
  });
  const targetField = page
    .locator(".field")
    .filter({ has: page.locator("#target-languages") });
  await targetField
    .locator(".ant-select-selection-item-remove")
    .first()
    .click();
  await targetField
    .locator(".ant-select-selection-item-remove")
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Start listening" }),
  ).toBeDisabled();
});

test("failed transcription retains audio for retry", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/config", (route) =>
    route.fulfill({ json: { asrModel: "ASR", llmModel: "LLM" } }),
  );
  await page.route("**/api/transcribe", (route) => {
    attempts++;
    return attempts === 1
      ? route.fulfill({
          status: 502,
          json: { error: "ASR is temporarily unavailable." },
        })
      : route.fulfill({ json: { text: "Recovered speech.", language: "en" } });
  });
  await page.route("**/api/translate", (route) =>
    route.fulfill({
      json: {
        translations: [
          { language: "en", text: "Recovered speech." },
          { language: "zh-Hant", text: "已恢復的語音。" },
        ],
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Start listening" }).click();
  const failedCard = page.locator(".sentence-card").first();
  await expect(
    failedCard.getByText("ASR is temporarily unavailable."),
  ).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: "Stop listening" }).click();
  await expect(
    page.getByRole("button", { name: "Start listening" }),
  ).toBeEnabled();
  await failedCard.getByRole("button", { name: "Retry" }).click();
  await expect(failedCard.locator(".original-text")).toHaveText(
    "Recovered speech.",
  );
  await expect(
    failedCard.getByText("Translated", { exact: true }),
  ).toBeVisible();
  await expect(
    failedCard.getByText("ASR is temporarily unavailable."),
  ).toHaveCount(0);
});

test("tab sharing without an audio track explains the problem and releases capture", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const testWindow = window as typeof window & {
      sharedTrack?: MediaStreamTrack;
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      const stream = document.createElement("canvas").captureStream();
      testWindow.sharedTrack = stream.getVideoTracks()[0];
      return stream;
    };
  });
  await page.route("**/api/config", (route) =>
    route.fulfill({ json: { asrModel: "ASR", llmModel: "LLM" } }),
  );
  await page.goto("/");
  await page.getByText("Browser tab", { exact: true }).click();
  await page.getByRole("button", { name: "Start listening" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "No shared audio was received.",
  );
  await expect(
    page.getByRole("button", { name: "Start listening" }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { sharedTrack?: MediaStreamTrack })
          .sharedTrack?.readyState,
    ),
  ).toBe("ended");
});
