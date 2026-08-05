import { expect, test } from "@playwright/test";

test("verified judge flow remains usable", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /QBNOTE-26/ })).toBeVisible();
  await expect(page.getByText(/^(Indexer \+ RPC|Live RPC) verified$/)).toBeVisible({ timeout: 12_000 });

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
  await page.getByRole("tab", { name: "Auditor", exact: true }).click();
  await expect(page.getByText("Recipient disclosure", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Investor", exact: true }).click();
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByText("Freighter extension was not detected", { exact: true })).toBeVisible({ timeout: 4_000 });
  await page.getByRole("tab", { name: "Public", exact: true }).click();

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
  await expect(page.getByText("Settlement receipt confirmed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Contracts" }).click();
  await expect(page.getByRole("heading", { name: "Contract registry" })).toBeVisible();
  await page.getByRole("button", { name: "Live round" }).click();

  expect(browserErrors).toEqual([]);
});

test("falls back to recorded evidence when public RPC is unavailable", async ({ page }) => {
  await page.route("https://soroban-testnet.stellar.org/**", (route) => route.abort());
  await page.goto("/");
  await expect(page.getByText("Evidence fallback active", { exact: true })).toBeVisible({
    timeout: 12_000,
  });
  await page.locator(".main-nav").getByRole("button", { name: "Evidence" }).click();
  await expect(page.getByText(/Recorded Testnet evidence remains active/)).toBeVisible();
});
