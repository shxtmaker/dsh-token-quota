import { test, expect } from "@playwright/test";
import { PROVIDERS } from "../../lib/providers.js";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const BASE = "http://127.0.0.1:4179";
const baseConfig = { suppliers: { opencode: { enabled: true, orgId: "org-original" } } };
const visualDirectory = resolve(".scratch/sidebar-ui-visual");
const displayFixture = () => ({
  ok: true, now: Date.now(), traffic: { channelAlive: true },
  active: { supplierId: "opencode", name: "OpenCode", model: "deepseek-v4.1-flash-with-a-very-long-model-name", at: Date.now() },
  suppliers: [
    { id: "opencode", name: "OpenCode", enabled: true, added: true, current: true, state: "ok", todayTokens: 1_240_000,
      warnPct: 80, critPct: 95, lastSuccessAt: Date.now(), entries: [
        { kind: "win", name: "5 小时", pct: 63, limit: "100%", used: "63%", resetAt: Date.now() + 7_980_000 },
        { kind: "win", name: "周用量", pct: 40, limit: "100%", used: "40%" },
      ] },
    { id: "deepseek", name: "DeepSeek", enabled: true, added: true, current: true, state: "err", todayTokens: 12_000,
      lastSuccessAt: Date.now() - 3_600_000, error: { message: "查询超时" }, entries: [
        { kind: "bal", name: "USD", remain: "$3.20", pct: null },
        { kind: "bal", name: "CNY", remain: "¥41.99", pct: null },
      ] },
  ],
});
const useDisplayFixture = (page) => page.route(/\/api\/dsh-token-quota\/state(?:\?.*)?$/, (route) => route.fulfill({ json: displayFixture() }));

test("real provider parsing keeps unknown Command Code resets empty and valid OpenCode countdowns", async ({ page }) => {
  const resetAt = Date.now() + 5 * 3600_000;
  const previousFetch = globalThis.fetch;
  let command, opencode;
  try {
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      const body = path.endsWith("/whoami") ? { org: { id: "fixture-org" } }
        : path.endsWith("/credits") ? {
          credits: { planId: "goat", monthlyCredits: 70 },
          windowLimits: { fiveHour: { used: 0, cap: 14, resetAt: 0 }, weekly: { used: 0, cap: 35, resetAt: "0" } },
        } : path.endsWith("/subscriptions") ? { data: { currentPeriodEnd: new Date(resetAt).toISOString() } }
          : { usage: { rolling: { percent: 52, resetsAt: new Date(resetAt).toISOString() } } };
      return { ok: true, text: async () => JSON.stringify(body) };
    };
    const cfg = { apiKey: "fixture", warnPct: 80, critPct: 95 };
    command = await PROVIDERS.commandcode.query(cfg);
    opencode = await PROVIDERS.opencode.query(cfg);
  } finally { globalThis.fetch = previousFetch; }
  const fixture = displayFixture();
  fixture.suppliers = [
    { id: "commandcode", name: "Command Code", added: true, enabled: true, ...command },
    { id: "opencode", name: "OpenCode", added: true, enabled: true, ...opencode },
  ];
  await page.route(/\/api\/dsh-token-quota\/state(?:\?.*)?$/, route => route.fulfill({ json: fixture }));
  await page.goto("/");
  await page.locator("[data-qm-entry]").click();
  await page.locator(".qm-pop").getByRole("button", { name: "详情", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "供应商限额明细", exact: true });
  const entries = detail.locator(".qm-col").filter({ hasText: "Command Code" }).locator(".qm-card-item");
  // 本轮：月度进度改为「有效订阅 + 有效账期 + 有效公开规则」同时成立才算；
  // 本夹具没有有效订阅与公开规则，因此只展示两个服务端窗口
  // （旧版静态套餐分母已删除，不得再出现第三条「月额度」）
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(0).locator(".ci-name span").last()).toHaveText("—");
  await expect(entries.nth(1).locator(".ci-name span").last()).toHaveText("—");
  await expect(entries.nth(0)).toContainText("未提供重置时刻");
  await expect(detail.locator(".qm-col").filter({ hasText: "OpenCode" })).toContainText(/4h59m|5h00m/);
  await expect(detail).not.toContainText("1月1日");
  await expect(detail).not.toContainText("NaN");
  // 占位/非法重置时刻不得被渲染成任何日历日期
  await expect(entries.nth(0)).not.toContainText("1月1日");
  await expect(entries.nth(1)).not.toContainText("1月1日");
});
test("restored details show supplier columns and a bounded history table before settings", async ({ page }) => {
  const fixture = displayFixture();
  fixture.suppliers.push({ id: "commandcode", name: "Command Code", added: true, enabled: true, state: "ok",
    entries: [{ kind: "win", name: "5h 窗口", pct: 0, limit: "100%", used: "0%" }] });
  fixture.suppliers.push({ id: "hidden", name: "Unconfigured", added: false, entries: [] });
  fixture.history = Array.from({ length: 55 }, (_, i) => ({ t: `2026-10-04 12:00:${i}`, supplier: "OpenCode", ok: i !== 0, summary: "5h · 63%", error: i === 0 ? "fixture timeout" : null }));
  await page.route(/\/api\/dsh-token-quota\/state(?:\?.*)?$/, route => route.fulfill({ json: fixture }));
  await page.goto("/");
  await page.locator("[data-qm-entry]").click();
  await page.locator(".qm-pop").getByRole("button", { name: "详情", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "供应商限额明细", exact: true });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("tab")).toHaveCount(0);
  await expect(detail.locator(".qm-col")).toHaveCount(3);
  await expect(detail).not.toContainText("Unconfigured");
  const columns = await detail.locator(".qm-col").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
  expect(new Set(columns).size).toBe(1);
  await detail.getByRole("button", { name: "关闭", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(detail.locator(".qm-history summary")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(detail.getByRole("columnheader")).toHaveText(["时间", "供应商", "结果", "主指标", "备注"]);
  await expect(detail.locator("tbody tr")).toHaveCount(50);
  await expect(detail.locator("tbody tr").first()).toContainText("fixture timeout");
  await mkdir(visualDirectory, { recursive: true });
  await page.screenshot({ path: resolve(visualDirectory, "restored-details.png"), fullPage: true });
  await detail.getByRole("button", { name: "设置", exact: true }).click();
  await expect(detail).toHaveCount(0);
  const settings = page.getByRole("dialog", { name: "用量监控", exact: true });
  await expect(settings.getByRole("tab")).toHaveCount(3);
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(page.locator("[data-qm-entry]")).toBeFocused();
});
test.beforeEach(async ({ request }) => {
  await request.post(`${BASE}/__control`, { data: { stateDelay: 0, settingsDelay: 0, settingsFail: false, postCount: 0, config: baseConfig } });
});

for (const [width, density] of [[240, "expanded"], [180, "compact"], [64, "rail"]]) {
  test(`A2 ${width}px sidebar opens an anchored popover and returns focus`, async ({ page }) => {
    await useDisplayFixture(page);
    await page.goto(density === "rail" ? "/?rail&width=64" : `/?width=${width}`);
    const opener = page.locator("[data-qm-entry]");
    if (density !== "rail") await expect(page.locator("[data-qm-density]")).toHaveAttribute("data-qm-density", density);
    if (density !== "rail") {
      await expect(opener.locator(".qm-primary")).toContainText("63%");
      const entryBox = await opener.boundingBox(), metricBox = await opener.locator(".qm-primary").boundingBox();
      expect(metricBox.width).toBeGreaterThan(40);
      expect(metricBox.x + metricBox.width).toBeLessThanOrEqual(entryBox.x + entryBox.width);
    }
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "用量", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toHaveAttribute("aria-modal", "true");
    await expect(dialog.getByRole("tab")).toHaveCount(0);
    await expect(page.locator(".qm-overlay")).toHaveCount(0);
    const popupBox = await dialog.boundingBox(), anchorBox = await opener.boundingBox();
    expect(popupBox.y + popupBox.height).toBeLessThanOrEqual(anchorBox.y);
    expect(popupBox.x).toBeGreaterThanOrEqual(0);
    expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(1180);
    if (width === 240) {
      await expect(dialog.locator('[data-supplier="deepseek"]')).toContainText("更新失败 · 上次数据");
      await expect(dialog.locator('[data-supplier="deepseek"]')).toContainText("另有 1 项");
      await mkdir(visualDirectory, { recursive: true });
      await page.screenshot({ path: resolve(visualDirectory, "overview-normal-and-stale.png"), fullPage: true });
    }
    await expect(page.locator(".qm-pop")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  });
}

test("A2 sidebar preference persists and automatic narrow layout never overwrites it", async ({ page }) => {
  await page.goto("/");
  const strip = page.locator("[data-qm-density]");
  await expect(strip).toHaveAttribute("data-qm-density", "expanded");
  await page.getByRole("button", { name: "收起", exact: true }).click();
  await expect(strip).toHaveAttribute("data-qm-density", "compact");
  await page.reload();
  await expect(strip).toHaveAttribute("data-qm-density", "compact");
  await page.getByRole("button", { name: "展开", exact: true }).click();
  await expect(strip).toHaveAttribute("data-qm-density", "expanded");
  await page.evaluate(() => window.__qmHost.setWidth(180));
  await expect(strip).toHaveAttribute("data-qm-density", "compact");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("dsh-token-quota.ui.v1")))).toEqual({ sidebarDensity: "expanded" });
  await page.evaluate(() => window.__qmHost.setWidth(240));
  await expect(strip).toHaveAttribute("data-qm-density", "expanded");
  await page.locator("[data-qm-entry]").click();
  await page.locator(".qm-pop").getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "用量监控", exact: true });
  await dialog.getByRole("tab", { name: "设置", exact: true }).click();
  await dialog.getByLabel("侧栏显示", { exact: true }).selectOption("compact");
  await expect(strip).toHaveAttribute("data-qm-density", "compact");
});

test("usage popover toggles, dismisses without a backdrop, and fits resized viewports", async ({ page }) => {
  await useDisplayFixture(page);
  await page.goto("/");
  const entry = page.locator("[data-qm-entry]");
  const popover = page.getByRole("dialog", { name: "用量", exact: true });
  await entry.click();
  await expect(entry).toHaveAttribute("aria-expanded", "true");
  await expect(popover).toBeVisible();
  await entry.click();
  await expect(popover).toHaveCount(0);
  await entry.click();
  await page.getByRole("button", { name: "打开原生设置", exact: true }).click();
  await expect(popover).toHaveCount(0);
  await expect(page.locator(".qm-settings-page")).toBeVisible();
  await entry.click();
  await page.setViewportSize({ width: 280, height: 380 });
  await expect(popover).toBeVisible();
  const box = await popover.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(280);
  expect(box.y + box.height).toBeLessThanOrEqual(380);
  await popover.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(popover).toHaveCount(0);
  await expect(entry).toBeFocused();
});

test("A3 dialog traps focus, preserves organization and retains a rejected draft", async ({ page }) => {
  await page.goto("/");
  const opener = page.locator("[data-qm-entry]");
  await opener.click();
  await page.locator(".qm-pop").getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "用量监控", exact: true });
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await dialog.locator("button:visible").last().focus();
  await page.keyboard.press("Tab");
  await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await dialog.getByRole("tab", { name: "供应商", exact: true }).click();
  await dialog.locator('.qm-page-row[data-supplier="opencode"]').getByRole("button", { name: "配置", exact: true }).click();
  const orgInput = dialog.getByLabel("org id（可选）", { exact: true });
  await expect(orgInput).toHaveValue("org-original");
  const advanced = dialog.locator("details.qm-advanced");
  await expect(advanced).not.toHaveAttribute("open", "");
  await advanced.locator("summary").click();
  const warning = advanced.locator('input[type="number"][max="99"]');
  await warning.fill("150");
  await advanced.locator("summary").click();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(advanced).toHaveAttribute("open", "");
  await expect(warning).toHaveValue("150");
  await expect(orgInput).toHaveValue("org-original");
  await warning.fill("80");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.locator(".qm-page-list")).toBeVisible();
  await dialog.locator('.qm-page-row[data-supplier="opencode"]').getByRole("button", { name: "配置", exact: true }).click();
  await expect(dialog.getByLabel("org id（可选）", { exact: true })).toHaveValue("org-original");
});

for (const light of [false, true]) {
  test(`A3 ${light ? "light" : "dark"} narrow panel remains inside viewport`, async ({ page }) => {
    await useDisplayFixture(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?rail${light ? "&light" : ""}`);
    const opener = page.locator("[data-qm-entry]");
    await opener.click();
    await page.locator(".qm-pop").getByRole("button", { name: "详情", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "供应商限额明细", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-metric-kind="balance"]')).toHaveCount(2);
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await mkdir(visualDirectory, { recursive: true });
    await page.screenshot({ path: resolve(visualDirectory, `narrow-${light ? "light" : "dark"}.png`), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  });
}

test("A3 embedded settings has no modal restrictions and sidebar reuses it", async ({ page }) => {
  await page.goto("/?settings");
  const panel = page.locator(".qm-settings-page");
  await expect(panel).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".qm-overlay")).toHaveCount(0);
  await panel.getByRole("tab", { name: "设置", exact: true }).click();
  await page.locator("#background").focus();
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
  await expect(page.locator("#background")).toBeFocused();
  await page.locator("[data-qm-entry]").click();
  await page.locator(".qm-pop").getByRole("button", { name: "设置", exact: true }).click();
  await expect(panel.getByRole("tab", { name: "概览", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await panel.locator("button:visible, summary:visible, input:visible, select:visible").last().focus();
  await page.keyboard.press("Tab");
  await expect.poll(() => panel.evaluate((node) => node.contains(document.activeElement))).toBe(false);
});

test("A3 native page takes over an open dialog and preserves its secret draft", async ({ page }) => {
  await page.goto("/");
  await page.locator("[data-qm-entry]").click();
  await page.locator(".qm-pop").getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "用量监控", exact: true });
  await dialog.getByRole("tab", { name: "供应商", exact: true }).click();
  await dialog.locator('.qm-page-row[data-supplier="opencode"]').getByRole("button", { name: "配置", exact: true }).click();
  await dialog.getByLabel("API Key", { exact: true }).fill("isolated-draft-key");
  await page.evaluate(() => window.__qmHost.mountSettings());
  const panel = page.locator(".qm-settings-page");
  await expect(panel).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(panel.getByLabel("API Key", { exact: true })).toHaveValue("isolated-draft-key");
  expect(await page.evaluate(() => localStorage.getItem("dsh-token-quota.ui.v1") ?? "")).not.toContain("isolated-draft-key");
});

test("A3 embedded page restores its host scroll position after supplier configuration", async ({ page }) => {
  await useDisplayFixture(page);
  await page.goto("/?settings");
  await page.locator("#settings").evaluate((node) => Object.assign(node.style, { width: "350px", height: "260px", overflow: "auto" }));
  const panel = page.locator(".qm-settings-page");
  const configure = panel.locator('.qm-supplier-card[data-supplier="deepseek"]').getByRole("button", { name: "配置", exact: true });
  await configure.scrollIntoViewIfNeeded();
  const scrollTop = await page.locator("#settings").evaluate((node) => node.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
  await configure.click();
  await expect(panel.locator(".qm-page-head")).toContainText("DeepSeek");
  await panel.getByRole("button", { name: "← 返回" }).click();
  await expect(panel.locator(".qm-overview-grid")).toBeVisible();
  await expect.poll(() => page.locator("#settings").evaluate((node) => node.scrollTop)).toBe(scrollTop);
});
