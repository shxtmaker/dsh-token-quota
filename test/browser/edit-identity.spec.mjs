import { test, expect } from "@playwright/test";

// A2 编辑器身份 / A3 阈值一致性：用真实插件后端 + 延迟与失败注入复现，
// 不只检查函数返回值（设置保存、目录刷新、连接测试都经真实路由往返）。

const API = "/api/dsh-token-quota";

/** 打开设置页（0.1.7：外壳把 settings.section 渲染在设置面板内容列，不再是弹层）。 */
async function openSettings(page) {
  await page.goto("/");
  const panel = page.locator(".qm-settings-page");
  await expect(panel).toBeVisible();
  return panel;
}

/** 进入某个供应商的独立配置页（目录行 → 打开配置）。 */
async function openSupplier(page, dialog, name) {
  // 精确匹配行内的供应商名容器，避免 hasText 命中「可添加」折叠区或按钮的可访问名
  const row = dialog.locator(".qm-page-row").filter({ has: page.locator("span.qm-page-name", { hasText: name }) });
  await row.first().getByRole("button", { name: "打开配置" }).click();
  await expect(dialog.locator(".qm-page-head")).toContainText(name);
}

const BASE = "http://127.0.0.1:4179";
const control = (request, body) =>
  request.post(`${BASE}/__control`, { data: body }).then((r) => r.json());

const BASE_CONFIG = {
  suppliers: {
    opencode: { enabled: true, orgId: "org-original" },
    commandcode: { enabled: true },
  },
};

test.beforeEach(async ({ request }) => {
  // 每个用例都从同一份干净配置开始（配置在服务端持久，必须显式复位）
  await control(request, { stateDelay: 0, settingsDelay: 0, settingsFail: false, postCount: 0, config: BASE_CONFIG });
});

test("保存中切换编辑器：旧回调不清除新草稿、不覆盖新提示", async ({ page, request }) => {
  const dialog = await openSettings(page);
  await openSupplier(page, dialog, "OpenCode");
  const orgA = page.getByLabel("org id（可选）", { exact: true });
  await orgA.fill("draft-A");

  await control(request, { settingsDelay: 1500 });
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  // 保存期间：当前表单禁用编辑、重复保存被禁用，但仍允许返回目录
  await expect(orgA).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  const back = dialog.getByRole("button", { name: "← 返回" });
  await expect(back).toBeEnabled();
  await back.click();
  await expect(dialog.locator(".qm-page-list")).toBeVisible();

  // 打开另一个编辑器输入新草稿，然后等 A 的保存落地
  await openSupplier(page, dialog, "Command Code");
  const keyB = page.getByLabel("API Key", { exact: true });
  await keyB.fill("sk-draft-B");
  await page.waitForTimeout(2000);

  // A 的成功回调不得清掉 B 的草稿、也不得把界面切回目录
  await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("sk-draft-B");
  await expect(dialog.locator(".qm-page-head")).toContainText("Command Code");
  await expect(dialog.locator(".s-saved")).toHaveCount(0);
});

test("保存失败保留草稿；重新打开该供应商时以服务端为准", async ({ page, request }) => {
  const dialog = await openSettings(page);
  await openSupplier(page, dialog, "OpenCode");
  const org = page.getByLabel("org id（可选）", { exact: true });
  await org.fill("rejected-draft");

  await control(request, { settingsFail: true });
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("validation rejected");
  await expect(org).toHaveValue("rejected-draft");
  await expect(org).toBeEnabled();

  // 失败后重新打开：草稿按服务端最新值重建（不是残留的 rejected-draft）
  await dialog.getByRole("button", { name: "← 返回" }).click();
  await openSupplier(page, dialog, "OpenCode");
  await expect(page.getByLabel("org id（可选）", { exact: true })).toHaveValue("org-original");
});

test("编辑字段后旧连接测试返回，不显示为当前草稿的结果", async ({ page }) => {
  const dialog = await openSettings(page);
  await openSupplier(page, dialog, "OpenCode");
  const org = page.getByLabel("org id（可选）", { exact: true });

  await page.route(`**${API}/test`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, result: { state: "ok", entries: [], headline: { kind: "amt", amt: "—" } } }) });
  });
  await dialog.getByRole("button", { name: "测试连接" }).click();
  // 测试在途时修改草稿：旧结果不得再显示为当前草稿的结果
  await org.fill("changed-after-test");
  await expect(org).toHaveValue("changed-after-test");
  await page.waitForTimeout(1600);
  // 旧测试既不得显示「连接正常」，其「测试中…」提示也不得停留在已改动的新草稿上
  await expect(dialog.locator(".s-test-res")).toHaveCount(0);
  await page.unroute(`**${API}/test`);
});

test("自定义阈值在详情卡与设置页预览使用同一判定", async ({ page, request }) => {
  // 供应商查询替身返回 rolling=49 / weekly=60 / monthly=80；阈值 50/70
  await request.post(`${BASE}/__suppliers`, { data: { opencode: { enabled: true, apiKey: "sk-test", warnPct: 50, critPct: 70 } } });
  await control(request, { usagePercent: 49 });
  await page.waitForTimeout(1200); // 等宿主轮询把替身响应折叠成条目

  const dialog = await openSettings(page);
  await openSupplier(page, dialog, "OpenCode");
  const tones = () => dialog.locator(".qm-quota-preview .ci-big").evaluateAll((nodes) => nodes.map((n) => n.className));
  // 设置页预览 = 已保存配置（50/70）对应的查询结果
  await expect.poll(tones).toEqual(["ci-big ok", "ci-big warn", "ci-big crit"]);
  // 状态药丸与预览同口径（最高 80 ≥ crit 70 → 临界）
  await expect(dialog.locator(".qm-page-head .qm-pill")).toHaveText("临界");

  // 详情弹层用同一份阈值判定（设置页是内容列里的一页，无遮罩，直接点侧栏小组件）
  await page.locator(".qm-strip, .qm-rail").first().click();
  await page.getByRole("button", { name: "详情" }).click();
  const detail = page.getByRole("dialog", { name: "供应商限额明细" });
  await expect(detail).toBeVisible();
  const detailTones = await detail.locator(".qm-card-item .ci-big").evaluateAll((nodes) => nodes.map((n) => n.className));
  expect(detailTones).toContain("ci-big ok");   // 49 < 50
  expect(detailTones).toContain("ci-big warn"); // 50 ≤ 60 < 70
  expect(detailTones).toContain("ci-big crit"); // 80 ≥ 70
  // 详情页的状态药丸与预览同口径
  await expect(detail.locator(".qm-col", { hasText: "OpenCode" }).locator(".qm-pill")).toHaveText("临界");
});
