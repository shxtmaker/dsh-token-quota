import { test, expect } from "@playwright/test";

test("settings trap keyboard focus, preserve organization, and retain a rejected draft", async ({ page }) => {
  await page.goto("/");
  // 0.1.7：设置页本身在设置面板内容列；小组件里的「设置」入口仍打开同一面板的弹层形态
  const opener = page.locator(".qm-strip");
  await opener.click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  const buttons = dialog.locator("button:visible");
  await buttons.last().focus(); await page.keyboard.press("Tab");
  await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await opener.click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  // 目录里可能有多个供应商行：显式点名 OpenCode（strict mode 下不允许多命中）
  await dialog.locator(".qm-page-row", { hasText: "OpenCode" }).getByRole("button", { name: "打开配置" }).click();
  const orgInput = page.getByLabel("org id（可选）", { exact: true });
  await expect(orgInput).toHaveValue("org-original");
  const warning = page.locator('input[type="number"][max="99"]');
  await warning.fill("150");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(warning).toHaveValue("150");
  await expect(orgInput).toHaveValue("org-original");
  await warning.fill("80");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.locator(".qm-page-list")).toBeVisible();
  await dialog.locator(".qm-page-row", { hasText: "OpenCode" }).getByRole("button", { name: "打开配置" }).click();
  await expect(page.locator('[value="org-original"]')).toHaveValue("org-original");
});

test("rail opens a detail dialog that fits the viewport and returns focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?rail");
  const opener = page.locator(".qm-rail");
  await opener.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
});
