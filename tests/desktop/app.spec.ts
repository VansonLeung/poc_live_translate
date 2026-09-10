import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createServer } from "node:http";

test("desktop configures and persists encrypted endpoints, isolates the renderer, and captures audio", async () => {
  const profile = await mkdtemp(join(tmpdir(), "live-translate-desktop-"));
  const provider = createServer((_req, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({ data: [{ id: "test-asr" }, { id: "test-llm" }] }),
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test provider address");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== "ELECTRON_RUN_AS_NODE" && value !== undefined) environment[key] = value;
  }
  environment.LIVE_TRANSLATE_DATA_DIR = profile;
  const launch = () =>
    electron.launch({
      args: [
        resolve("."),
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
      env: environment,
    });
  let application = await launch();
  try {
    let page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(
      page.getByRole("dialog", { name: "Connections", exact: true }),
    ).toBeVisible();
    for (const kind of ["asr", "llm"]) {
      await page.locator(`#${kind}-base-url`).fill(baseUrl);
      await page.locator(`#${kind}-model`).fill(`test-${kind}`);
      await page.locator(`#${kind}-api-key`).fill(`${kind}-secret-for-test`);
    }
    await page
      .getByRole("button", { name: "Test ASR connection", exact: true })
      .click();
    await expect(page.getByText(/Connected. Model listed/)).toBeVisible();
    await page
      .getByRole("button", { name: "Save connections", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => typeof (window as unknown as { require?: unknown }).require,
      ),
    ).toBe("undefined");
    const origin = new URL(page.url()).origin;
    expect((await fetch(`${origin}/api/settings`)).status).toBe(401);
    const encrypted = await readFile(join(profile, "connections.enc"));
    expect(encrypted.toString()).not.toContain("asr-secret-for-test");
    await application.close();
    application = await launch();
    page = await application.firstWindow();
    await page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    await expect(page.locator("#asr-base-url")).toHaveValue(baseUrl);
    await expect(page.locator("#asr-model")).toHaveValue("test-asr");
    await expect(page.locator("#asr-api-key")).toHaveValue("");
    await expect(page.locator("#asr-api-key")).toHaveAttribute(
      "placeholder",
      "Saved key",
    );
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator(".diagnostics-panel summary").click();
    await page
      .getByRole("switch", { name: "Capture only", exact: true })
      .click();
    await page.getByRole("button", { name: "Start listening" }).click();
    await expect(
      page.getByText("Listening live", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".diagnostic-health")).toContainText(
      /speech|waiting for pause/,
    );
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "Stop listening" }).click();
    await expect(
      page
        .getByRole("table", { name: "Audio segment timings", exact: true })
        .locator("tbody tr"),
    ).toHaveCount(1);
    await page.screenshot({ path: "test-results/desktop.png", fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await application.close();
    provider.close();
    await rm(profile, { recursive: true, force: true });
  }
});
