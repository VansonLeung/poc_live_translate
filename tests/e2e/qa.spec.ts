import { expect, test, type Page } from "@playwright/test";

async function openQA(page: Page) {
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: { asrModel: "ASR", llmModel: "LLM", configured: true },
    }),
  );
  await page.goto("/");
  await page.getByText("Live Q&A", { exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Live Q&A", exact: true }),
  ).toBeVisible();
}
const answer = (text: string) =>
  `${JSON.stringify({ type: "delta", text })}\n${JSON.stringify({ type: "done" })}\n`;

test("manual questions retain follow-up context, export, reset, and survive mode switching", async ({
  page,
}) => {
  const requests: { question: string; history: unknown[]; language: string }[] =
    [];
  await page.route("**/api/answer", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: answer(`Answer ${requests.length}`),
    });
  });
  await openQA(page);
  await expect(
    page.getByRole("switch", { name: "Automatic answers" }),
  ).not.toBeChecked();
  await page
    .getByLabel("Your question", { exact: true })
    .fill("What is a tugboat?");
  expect(requests).toHaveLength(0);
  await page.getByRole("button", { name: "Ask now", exact: true }).click();
  await expect(page.getByText("Answer 1", { exact: true })).toBeVisible();
  await page
    .getByLabel("Your question", { exact: true })
    .fill("What does it tow?");
  await page.getByRole("button", { name: "Ask now", exact: true }).click();
  await expect(page.getByText("Answer 2", { exact: true })).toBeVisible();
  expect(requests[1]).toMatchObject({
    question: "What does it tow?",
    language: "auto",
    history: [
      { role: "user", content: "What is a tugboat?" },
      { role: "assistant", content: "Answer 1" },
    ],
  });
  await page.getByText("Live Translate", { exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Live transcript" }),
  ).toBeVisible();
  await page.getByText("Live Q&A", { exact: true }).click();
  await expect(page.getByText("Answer 2", { exact: true })).toBeVisible();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export conversation", exact: true })
    .click();
  expect((await download).suggestedFilename()).toContain("conversation-");
  await page
    .getByRole("button", { name: "New conversation", exact: true })
    .click();
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await page.getByLabel("Your question", { exact: true }).fill("Start fresh");
  await page.getByRole("button", { name: "Ask now", exact: true }).click();
  await expect(page.getByText("Answer 3", { exact: true })).toBeVisible();
  expect(requests[2].history).toEqual([]);
  await page.screenshot({
    path: "test-results/qa-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({ path: "test-results/qa-mobile.png", fullPage: true });
});

test("Ask now flushes microphone audio and waits for the entire multi-sentence question", async ({
  page,
}) => {
  const questions: string[] = [];
  await page.route("**/api/transcribe", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      json: {
        text: "I am planning a voyage. What should I prepare?",
        language: "en",
      },
    });
  });
  await page.route("**/api/answer", (route) => {
    questions.push(route.request().postDataJSON().question);
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: answer("Plan the route."),
    });
  });
  await openQA(page);
  await page.locator(".diagnostics-panel summary").click();
  await page.getByRole("button", { name: "Start listening" }).click();
  await expect(page.locator(".diagnostic-health")).toContainText(
    /speech|waiting for pause/,
  );
  await page.waitForTimeout(400);
  expect(questions).toHaveLength(0);
  await page.getByRole("button", { name: "Ask now", exact: true }).click();
  await expect(
    page.getByText("Plan the route.", { exact: true }),
  ).toBeVisible();
  expect(questions).toEqual(["I am planning a voyage. What should I prepare?"]);
  await expect(
    page.getByRole("button", { name: "Start listening" }),
  ).toBeEnabled();
});

test("automatic answers wait across a forced audio boundary for the final pause", async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const source = context.createOscillator();
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      gain.gain.value = 0.15;
      source.connect(gain).connect(destination);
      source.start();
      gain.gain.setValueAtTime(0, context.currentTime + 12.5);
      await context.resume();
      return destination.stream;
    };
  });
  let asrCalls = 0;
  const questions: string[] = [];
  await page.route("**/api/transcribe", (route) =>
    route.fulfill({
      json: {
        text:
          ++asrCalls === 1
            ? "I have a question. The vessel is approaching"
            : "the harbour. What is next?",
        language: "en",
      },
    }),
  );
  await page.route("**/api/answer", (route) => {
    questions.push(route.request().postDataJSON().question);
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: answer("Contact harbour control."),
    });
  });
  await openQA(page);
  await page.getByRole("switch", { name: "Automatic answers" }).click();
  await page.getByRole("button", { name: "Start listening" }).click();
  await expect(page.getByLabel("Your question", { exact: true })).toHaveValue(
    "I have a question. The vessel is approaching",
    { timeout: 18000 },
  );
  expect(questions).toHaveLength(0);
  await expect(
    page.getByText("Contact harbour control.", { exact: true }),
  ).toBeVisible({ timeout: 8000 });
  expect(questions).toEqual([
    "I have a question. The vessel is approaching the harbour. What is next?",
  ]);
  await page.getByRole("button", { name: "Stop listening" }).click();
});

test("stopping generation releases controls and excludes the interrupted exchange from context", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: { history: unknown[] }[] = [];
  await page.route("**/api/answer", async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) await held;
    await route
      .fulfill({
        contentType: "application/x-ndjson",
        body: answer("Completed"),
      })
      .catch(() => {});
  });
  await openQA(page);
  await page.getByLabel("Your question", { exact: true }).fill("Slow question");
  await page.getByRole("button", { name: "Ask now", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await page
    .getByRole("button", { name: "Stop generating", exact: true })
    .click();
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
  release();
  await page
    .getByRole("button", { name: "Edit and ask again", exact: true })
    .click();
  await page.getByRole("button", { name: "Ask now", exact: true }).click();
  await expect(page.getByText("Completed", { exact: true })).toBeVisible();
  expect(requests[1].history).toEqual([]);
});

test("a failed ASR turn pauses automatic answers until the user reviews the draft", async ({
  page,
}) => {
  const questions: string[] = [];
  await page.route("**/api/transcribe", (route) =>
    route.fulfill({ status: 502, json: { error: "ASR unavailable." } }),
  );
  await page.route("**/api/answer", (route) => {
    questions.push(route.request().postDataJSON().question);
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: answer("Reviewed answer"),
    });
  });
  await openQA(page);
  await page.getByRole("switch", { name: "Automatic answers" }).click();
  await page.locator(".diagnostics-panel summary").click();
  await page.getByRole("button", { name: "Start listening" }).click();
  await expect(page.locator(".diagnostic-health")).toContainText(
    /speech|waiting for pause/,
  );
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Stop listening" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Some speech may be missing",
  );
  expect(questions).toEqual([]);
  await page
    .getByLabel("Your question", { exact: true })
    .fill("Reviewed question");
  await page.getByRole("button", { name: "Ask now", exact: true }).click();
  await expect(
    page.getByText("Reviewed answer", { exact: true }),
  ).toBeVisible();
  expect(questions).toEqual(["Reviewed question"]);
});

test("Q&A capture-only mode disables questions and sends no model requests", async ({
  page,
}) => {
  let requests = 0;
  await page.route(/\/api\/(transcribe|translate|answer)$/, (route) => {
    requests++;
    return route.abort();
  });
  await openQA(page);
  await page.locator(".diagnostics-panel summary").click();
  await page.getByRole("switch", { name: "Capture only", exact: true }).click();
  await page.getByRole("button", { name: "Start listening" }).click();
  await expect(page.locator(".diagnostic-health")).toContainText(
    /speech|waiting for pause/,
  );
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Stop listening" }).click();
  await expect(
    page.getByRole("button", { name: "Ask now", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("Your question", { exact: true }),
  ).toBeDisabled();
  expect(requests).toBe(0);
});
