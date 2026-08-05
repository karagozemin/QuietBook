import { expect, test } from "@playwright/test";

test("landing, intro and verified Testnet story remain usable", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "QuietBook", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();

  const canvasPixels = await page.locator("canvas.hero-canvas").evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext("2d");
    if (!context || canvas.width === 0 || canvas.height === 0) return 0;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let visible = 0;
    for (let index = 3; index < pixels.length; index += 64) {
      if (pixels[index]! > 0) visible += 1;
    }
    return visible;
  });
  expect(canvasPixels).toBeGreaterThan(100);

  const dimensions = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll).toBe(dimensions.client);

  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByText("Freighter extension was not detected", { exact: true })).toBeVisible({ timeout: 4_000 });

  await page.getByRole("button", { name: "Run Testnet story" }).click();
  await expect(page.getByRole("heading", { name: "The market sees participation. Not the demand curve." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "The winner is proven against the complete book." })).toBeVisible({ timeout: 6_000 });
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Confidential payment. Public delivery. One invocation." })).toBeVisible();
  await page.getByRole("button", { name: "Enter verified run" }).click();

  await expect(page.getByRole("heading", { name: "QBNOTE-26", exact: true })).toBeVisible();
  await expect(page.getByText("Start here", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Verify completed round" }).click();
  await expect(page.getByRole("dialog", { name: "Verified Testnet story" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Round verified" })).toBeVisible({ timeout: 22_000 });
  const dialogBox = await page.getByRole("dialog", { name: "Verified Testnet story" }).locator(".verification-dialog").boundingBox();
  expect(dialogBox?.width).toBeLessThanOrEqual(720);
  await page.getByRole("button", { name: "Open evidence" }).click();
  await expect(page.getByRole("heading", { name: "Evidence", exact: true })).toBeVisible();
  await expect(page.getByText("Atomic settlement", { exact: true })).toBeVisible();

  expect(browserErrors).toEqual([]);
});

test("live story fails honestly when public RPC is unavailable", async ({ page }) => {
  await page.route("https://soroban-testnet.stellar.org/**", (route) => route.abort());
  await page.goto("/");
  await expect(page.getByText("Evidence fallback", { exact: true })).toBeVisible({ timeout: 14_000 });
  await page.getByRole("button", { name: /Explore live round/ }).click();
  await expect(page.getByRole("heading", { name: "QBNOTE-26", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Verify completed round" }).click();
  await expect(page.getByText("Live infrastructure did not answer", { exact: true })).toBeVisible({ timeout: 14_000 });
  await expect(page.getByText("TESTNET_RPC_UNAVAILABLE", { exact: true })).toBeVisible();
});
