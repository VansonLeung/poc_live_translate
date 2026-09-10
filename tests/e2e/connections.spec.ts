import { expect, test } from "@playwright/test";

test("connection settings can be tested, saved, and reopened without displaying keys", async ({
  page,
}) => {
  let settings = {
    asr: {
      baseUrl: "http://127.0.0.1:8000/v1",
      model: "old-asr",
      hasKey: true,
    },
    llm: {
      baseUrl: "http://127.0.0.1:8000/v1",
      model: "old-llm",
      hasKey: false,
    },
    storage: "Test profile",
  };
  let saved: Record<string, { model: string; apiKey?: string }> | undefined;
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        asrModel: settings.asr.model,
        llmModel: settings.llm.model,
        configured: true,
      },
    }),
  );
  await page.route("**/api/settings", (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      saved = body;
      settings = {
        ...settings,
        asr: { baseUrl: body.asr.baseUrl, model: body.asr.model, hasKey: true },
        llm: {
          baseUrl: body.llm.baseUrl,
          model: body.llm.model,
          hasKey: Boolean(body.llm.apiKey),
        },
      };
    }
    return route.fulfill({ json: settings });
  });
  await page.route("**/api/settings/test", (route) =>
    route.fulfill({
      json: { models: ["new-asr"], modelFound: true, elapsedMs: 10 },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(page.locator("#asr-api-key")).toHaveValue("");
  await page.locator("#asr-model").fill("new-asr");
  await page.locator("#llm-model").fill("new-llm");
  await page.locator("#llm-api-key").fill("new-test-key");
  await page
    .getByRole("button", { name: "Test ASR connection", exact: true })
    .click();
  await expect(
    page.getByText("Connected. Model listed (10 ms).", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Save connections", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(saved?.asr.model).toBe("new-asr");
  expect(saved?.asr.apiKey).toBe("");
  expect(saved?.llm.apiKey).toBe("new-test-key");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(page.locator("#llm-model")).toHaveValue("new-llm");
  await expect(page.locator("#llm-api-key")).toHaveValue("");
  await expect(page.locator("#llm-api-key")).toHaveAttribute(
    "placeholder",
    "Saved key",
  );
});
