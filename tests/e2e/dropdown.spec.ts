import { expect, test } from "@playwright/test";

for (const reducedMotion of ["reduce", "no-preference"] as const) {
  test(`dropdowns open on click and close on blur with motion: ${reducedMotion}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.route("**/api/config", (route) =>
      route.fulfill({ json: { asrModel: "ASR", llmModel: "LLM" } }),
    );
    await page.goto("/");

    for (const id of ["microphone", "source-languages", "target-languages"]) {
      const input = page.locator(`#${id}`);
      await input.click();
      await expect(input).toHaveAttribute("aria-expanded", "true");
      const dropdown = page.locator(".ant-select-dropdown:visible");
      await expect(dropdown).toHaveCount(1);
      // A popup can have dimensions and opacity 1 while stranded at x=-12800.
      await expect(dropdown).toBeInViewport();
      // Visibility alone does not catch an opacity-zero or scale-zero popup.
      await expect(dropdown).toHaveCSS("opacity", "1");
      await expect
        .poll(async () => (await dropdown.boundingBox())?.height ?? 0)
        .toBeGreaterThan(20);

      if (id !== "microphone") {
        await dropdown.getByText("Japanese", { exact: true }).click();
        await expect(
          page
            .locator(".field")
            .filter({ has: input })
            .getByTitle("Japanese", { exact: true }),
        ).toBeVisible();
      }

      await page.getByRole("heading", { level: 1 }).click();
      await expect(input).toHaveAttribute("aria-expanded", "false");
      await expect(dropdown).toHaveCount(0);

      // Moving focus to another control should also leave no dropdown behind.
      await input.click();
      await expect(page.locator(".ant-select-dropdown:visible")).toHaveCSS(
        "opacity",
        "1",
      );
      await expect(
        page.locator(".ant-select-dropdown:visible"),
      ).toBeInViewport();
      await page.locator(".advanced-toggle").focus();
      await expect(input).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
    }
  });
}
