import { expect, test } from "@playwright/test";

test("verified judge flow remains usable", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /QBNOTE-26/ })).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll).toBe(dimensions.client);

  await page.getByRole("button", { name: "Replay verified run" }).click();
  await expect(page.getByRole("heading", { name: "Verified run complete" })).toBeVisible({
    timeout: 8_000,
  });

  for (const role of ["Issuer", "Investor", "Auditor", "Public"]) {
    await page.getByRole("tab", { name: role, exact: true }).click();
  }

  await page.locator(".round-actions").getByRole("button", { name: "Evidence" }).click();
  await expect(page.getByRole("heading", { name: "Atomic settlement" })).toBeVisible();
  const qrSize = await page.locator(".evidence-drawer canvas").evaluate((canvas) => ({
    width: canvas.width,
    height: canvas.height,
  }));
  expect(qrSize.width).toBeGreaterThan(0);
  expect(qrSize.height).toBeGreaterThan(0);
  await page.locator(".evidence-drawer").getByTitle("Close evidence drawer").click();

  await page.locator(".main-nav").getByRole("button", { name: "Evidence" }).click();
  await expect(page.getByRole("heading", { name: "Verification index" })).toBeVisible();
  await page.getByRole("button", { name: "Contracts" }).click();
  await expect(page.getByRole("heading", { name: "Contract registry" })).toBeVisible();
  await page.getByRole("button", { name: "Live round" }).click();

  expect(browserErrors).toEqual([]);
});
