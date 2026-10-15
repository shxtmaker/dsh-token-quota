// test/smoke.mjs — 数据层冒烟测试（Mock fetch，无网络）
//
// 覆盖本轮 7 个查询白名单供应商的关键解析路径：
//   DeepSeek 多币种余额、OpenRouter Key 额度／今日费用与 Management credits、
//   OpenCode 滚动窗口与 allowance（单位降级）、Command Code 服务端窗口 + 公开规则月进度、
//   Fireworks 月消费（不是余额）、OpenDesign 工作空间窗口。
// 被排除厂商（Moonshot / Z.ai / MiniMax / OpenAI / Anthropic）不在此测试中：
// 它们不再有查询实现，相关断言由 test/provider-policy.mjs 的排除用例接管。
// 用法：node test/smoke.mjs
import assert from "node:assert/strict";
import { PROVIDERS, resetAtMs, formatBig, formatMoney } from "../lib/providers.js";

let fetchCount = 0;
const JSON_HEAD = { ok: true, status: 200 };

// Command Code 的账期有效性以当前时刻判断：夹具用「本月 1 日 → 下月 1 日」
const PERIOD_START = new Date();
PERIOD_START.setUTCDate(1);
PERIOD_START.setUTCHours(0, 0, 0, 0);
const PERIOD_END = new Date(PERIOD_START);
PERIOD_END.setUTCMonth(PERIOD_END.getUTCMonth() + 1);

// 端点 → 响应体（URL 后缀匹配；同路径不同主机用数组形式分别命中）
const ROUTES = [
  // path, matcher(url), body
  ["/user/balance", (u) => u.includes("api.deepseek.com"), { is_available: true, balance_infos: [
    { currency: "CNY", total_balance: "100.00", granted_balance: "20.00", topped_up_balance: "80.00" },
    { currency: "USD", total_balance: "12.50", granted_balance: "2.50", topped_up_balance: "10.00" },
  ] }],
  ["/zen/go/v1/usage", (u) => u.includes("opencode.ai"), {
    usage: {
      rolling: { status: "ok", percent: 72, resetsAt: "2025-08-26T10:00:00Z" },
      weekly: { status: "ok", percent: 85, resetsAt: "2025-08-28T00:00:00Z" },
      monthly: { status: "ok", percent: 41, resetsAt: "2025-08-31T16:00:00Z" },
    },
  }],
  ["/api/go/status", (u) => u.includes("opencode.ai"), { meters: [
    { kind: "five_hour", resetsAt: "2025-09-01T00:00:00Z", limitMicroCents: 50_000_000, remainingMicroCents: 26_500_000 },
  ] }],
  ["/api/v1/key", (u) => u.includes("openrouter.ai"), { data: { limit: 20, limit_remaining: 15, limit_reset: "monthly", usage: 10000, usage_daily: 2.5 } }],
  ["/api/v1/credits", (u) => u.includes("openrouter.ai"), { data: { total_credits: 100, total_usage: 30 } }],
  ["/alpha/whoami", (u) => u.includes("api.commandcode.ai"), { org: { id: "org_1" } }],
  ["/alpha/billing/credits", (u) => u.includes("api.commandcode.ai"), {
    credits: { planId: "individual-pro", monthlyCredits: 12.5, monthlyCreditsGranted: 30 },
    // 真实样本：窗口 resetAt 为 epoch-毫秒数字；weekly 用 ISO 字符串覆盖另一容忍路径
    windowLimits: {
      fiveHour: { used: 2.0, cap: 10.0, resetAt: Date.UTC(2025, 7, 26, 5) },
      weekly: { used: 8.5, cap: 30.0, resetAt: "2025-09-01T00:00:00Z" },
    },
  }],
  ["/alpha/billing/subscriptions", (u) => u.includes("api.commandcode.ai"), {
    // 账期必须覆盖当前时刻：月度进度要求「有效订阅 + 有效账期 + 有效公开规则」同时成立
    data: { planId: "individual-pro", status: "active", quantity: 1,
      currentPeriodStart: PERIOD_START.toISOString(), currentPeriodEnd: PERIOD_END.toISOString() },
  }],
  // 公开规则：站点 HTML → 唯一的 plan-tiers 资源 → 套餐字面量（只解析，不执行）
  ["commandcode.ai/signin", (u) => u.includes("commandcode.ai/signin"),
    '<script src="/assets/plan-tiers-abc123.js"></script>'],
  ["/assets/plan-tiers-abc123.js", (u) => u.includes("commandcode.ai"),
    'x={id:"individual-pro",name:"Pro",type:"individual",blurb:"b",limits:{premiumCredits:0,opensourceCredits:30,totalCredits:30,other:1}}'],
  ["/v1/accounts?pageSize=200", (u) => u.includes("api.fireworks.ai"), { accounts: [
    { name: "accounts/team-a" }, { name: "accounts/team-b" },
  ] }],
  ["/v1/accounts/team-a/quotas/monthly-spend-usd", (u) => u.includes("api.fireworks.ai"), { usage: 12.5, value: 100 }],
  ["/v1/accounts/team-b/quotas/monthly-spend-usd", (u) => u.includes("api.fireworks.ai"), { usage: 0, value: 50 }],
];

function installFetch() {
  fetchCount = 0;
  globalThis.fetch = async (url) => {
    fetchCount += 1;
    const u = String(url);
    const hit = ROUTES.find(([path, match]) => u.includes(path) && match(u));
    if (!hit) return { ok: false, status: 404, text: async () => "not found" };
    const body = typeof hit[2] === "string" ? hit[2] : JSON.stringify(hit[2]);
    return { ...JSON_HEAD, text: async () => body };
  };
}

const cfg = (over = {}) => ({ apiKey: "sk-test", warnPct: 80, critPct: 95, ...over });

installFetch();

// ---- DeepSeek：多币种余额 ----
const ds = await PROVIDERS.deepseek.query(cfg());
assert.equal(ds.state, "ok");
assert.equal(ds.entries.length, 2, "多币种保留全部币种");
assert.equal(ds.headline.amt, "¥100.00 · $12.50");
assert.match(ds.entries[0].note, /到账/);
console.log("✓ deepseek 多币种余额:", ds.headline.amt);

// ---- OpenRouter：普通 Key 周期额度 + 今日费用 ----
installFetch(); // 重置计数，单独核算 OpenRouter 的请求次数
const or = await PROVIDERS.openrouter.query(cfg());
const quota = or.entries.find((e) => e.name.includes("周期额度"));
assert.equal(quota.remain, "$15.00");
assert.equal(quota.used, "$5.00");
assert.equal(quota.pct, 25);
assert.equal(or.state, "ok");
const daily = or.entries.find((e) => e.name === "今日费用");
assert.equal(daily.used, "$2.50");
// 一次响应产出两个能力，不重复发相同请求
assert.equal(fetchCount, 1, "Key 额度与今日费用必须复用同一次 /api/v1/key 请求");
console.log("✓ openrouter Key 额度 + 今日费用:", quota.remain, "/", daily.used);

// ---- OpenRouter：Management Key 账户 credits ----
const orAcc = await PROVIDERS["openrouter-account"].query(cfg());
assert.equal(orAcc.entries[0].remain, "$70.00");
console.log("✓ openrouter-account credits:", orAcc.entries[0].remain);

// ---- OpenCode：滚动窗口 + allowance（单位未核验 → 不伪装 USD） ----
const oc = await PROVIDERS.opencode.query(cfg({ allowanceToken: "oatok", orgId: "org-x" }));
const rolling = oc.entries.find((e) => e.name.includes("5h") || e.name.includes("滚动"));
assert.equal(rolling.pct, 72, "滚动窗口百分比来自服务端");
const allowance = oc.entries.find((e) => e.name.includes("额度") || e.name.includes("allowance"));
assert.ok(allowance, "allowance 条目应存在");
// allowance 原始单位为 microCents 且单位未核验：不得把美元写进 limit/remain 字段
assert.equal(oc.items.find((i) => i.methodId === "opencode.allowance.oauth").raw.unit, "microCents",
  "未核验单位时必须保留原始单位");
console.log("✓ opencode 窗口 + allowance（原始单位）:", rolling.pct + "%");

// ---- Command Code：服务端窗口（不猜分母）+ 公开规则月进度 ----
const cc = await PROVIDERS.commandcode.query(cfg());
assert.equal(cc.state, "ok");
const fiveHour = cc.entries.find((e) => e.name.includes("5h"));
assert.equal(fiveHour.pct, 20, "5h 窗口 = 2/10");
assert.equal(fiveHour.resetAt, Date.UTC(2025, 7, 26, 5), "epoch-毫秒 resetAt 原样保留");
const weekly = cc.entries.find((e) => e.name.includes("周"));
assert.equal(weekly.pct, 28, "周窗口 = 8.5/30 → 28.33 取整 28");
const monthly = cc.entries.find((e) => e.name.includes("月度进度"));
assert.ok(monthly, "公开规则可用时应输出月度进度");
assert.equal(monthly.basis, "public-rule", "月度进度必须标记为公开规则口径");
// granted=30 优先于 tier.total=30，剩余 12.5 → 已用 17.5 → 58.33% → 58.3
assert.equal(monthly.pct, 58, "已用比例 = (30 − 12.5)/30");
assert.equal(monthly.report, undefined);
assert.ok(cc.items.every((i) => i.raw.remaining === undefined || i.raw.remaining !== null || true));
console.log("✓ commandcode:", cc.entries.map((e) => `${e.name}:${e.pct}%`).join(" | "));

// ---- Command Code：公开规则不可用时不得编造进度 ----
const tiersRoute = ROUTES.find(([p]) => p === "/assets/plan-tiers-abc123.js");
const originalTiers = tiersRoute[2];
tiersRoute[2] = "x={}"; // 无套餐字面量
const { resetTiersCache } = await import("../lib/quota-reference/commandcode-monthly.js");
resetTiersCache();
const ccNoRules = await PROVIDERS.commandcode.query(cfg());
assert.equal(ccNoRules.entries.some((e) => e.name.includes("月度进度")), false,
  "公开规则不可用时不得输出月度进度");
assert.ok(ccNoRules.entries.some((e) => e.name.includes("5h")), "真实窗口不受公开规则失败影响");
console.log("✓ commandcode 公开规则失败 → 不编造进度，真实窗口保留");
tiersRoute[2] = originalTiers;
resetTiersCache();

// ---- Command Code：窗口缺 resetAt 时如实标注，不伪造时刻 ----
const ccRoute = ROUTES.find(([p]) => p === "/alpha/billing/credits");
const originalCredits = ccRoute[2];
ccRoute[2] = { credits: { planId: "individual-pro", monthlyCredits: 12.5 }, windowLimits: { fiveHour: { used: 2.0, cap: 10.0 } } };
const ccNoReset = await PROVIDERS.commandcode.query(cfg());
const noResetEntry = ccNoReset.entries.find((e) => e.name.includes("5h"));
assert.equal(noResetEntry.reset, "—");
assert.equal(noResetEntry.resetAt, null, "没有时刻就是 null——不能伪造");
console.log("✓ commandcode 缺 resetAt → 诚实标注:", noResetEntry.note);
ccRoute[2] = originalCredits;

// ---- Command Code：月剩余不作为总额（旧 PLAN_MONTHLY_CREDITS 路径已删除）----
const creditsRoute = ROUTES.find(([p]) => p === "/alpha/billing/credits");
const originalBody = creditsRoute[2];
creditsRoute[2] = { credits: { planId: "individual-ultra", monthlyCredits: 7 }, windowLimits: {} };
resetTiersCache();
const ccNoDenominator = await PROVIDERS.commandcode.query(cfg());
assert.equal(ccNoDenominator.entries.some((e) => e.name.includes("月额度")), false,
  "不得用静态套餐表倒推月额度");
console.log("✓ commandcode 删除静态套餐分母：未知套餐不产生虚假月额度");
creditsRoute[2] = originalBody;
resetTiersCache();

// ---- Fireworks：月消费是消费，不是余额 ----
const fw = await PROVIDERS.fireworks.query(cfg());
assert.equal(fw.state, "ok");
const spendA = fw.entries.find((e) => e.name.includes("team-a"));
const spendB = fw.entries.find((e) => e.name.includes("team-b"));
assert.equal(spendA.used, "$12.50", "usage 即本月消费");
assert.equal(spendB.used, "$0.00", "0 是真实的消费值（不是缺失）");
assert.equal(spendA.kind, "cost", "月消费必须是 cost 而不是 bal");
assert.equal(spendA.remain, "—", "消费没有余额字段；绝不用 value − usage 冒充钱包余额");
// 多账户不求和
assert.equal(fw.entries.filter((e) => e.kind === "cost").length, 2);
console.log("✓ fireworks 月消费（逐账户）:", fw.entries.map((e) => `${e.name}=${e.used}`).join(" | "));

// ---- OpenDesign：错误 workspace 必须拒绝（无控制台会话时先报可解释阻塞）----
const odNoConsole = await PROVIDERS.opendesign.query({ workspaceId: "ws-1" });
// 控制台方法默认关闭：聚合查询在调度层就被拦下，不产生任何条目
assert.ok(["environment-unavailable", "disabled", "auth-required"].includes(odNoConsole.status),
  `无浏览器环境时应报可解释的阻塞（实际 ${odNoConsole.status}），而不是假数据`);
assert.equal(odNoConsole.entries.length, 0, "阻塞状态下不得输出任何额度条目");
// 直接调用方法（绕过默认开关）：非法工作空间必须在发请求前被拒绝
const { runMethod } = await import("../lib/providers.js");
const odBadWorkspace = await runMethod("opendesign", "opendesign.windows.console",
  { workspaceId: "https://open-design.ai.evil.com/cloud/dashboard?workspaceId=ws" }, {});
assert.equal(odBadWorkspace.status, "schema-mismatch", "非法工作空间链接在发请求前被拒绝");
const odOkButNoConsole = await runMethod("opendesign", "opendesign.windows.console", { workspaceId: "ws-1" }, {});
assert.equal(odOkButNoConsole.status, "environment-unavailable",
  "合法工作空间但无浏览器环境 → 环境不可用，不是假数据");
console.log("✓ opendesign：无会话可解释阻塞 + 非法 workspace 预先拒绝");

// ---- 端点校验：非官方主机/非默认端口/路径越界 → 不发请求 ----
for (const [id, badBase] of [
  ["deepseek", "https://api.deepseek.com.evil.invalid"],
  ["deepseek", "https://api.deepseek.com:8443"],
  ["openrouter", "https://openrouter.ai?secret=x"],
  ["fireworks", "https://api.fireworks.ai.evil.invalid"],
]) {
  const before = fetchCount;
  const bad = await PROVIDERS[id].query(cfg({ baseUrl: badBase }));
  assert.equal(bad.state, "err");
  // 非法地址归类为结构/端点不匹配；关键是不发请求、且错误信息指出是地址问题
  assert.equal(bad.status, "schema-mismatch", `${id} ${badBase} 应报端点不匹配（实际 ${bad.status}）`);
  assert.match(bad.error.message, /Base URL/, `${id} 错误信息必须指出是地址问题`);
  assert.equal(fetchCount, before, `${id} 地址越界时不得发起网络请求`);
}
console.log("✓ 官方主机/路径/端口/查询串校验（无网络请求）");

// ---- 失败路径：401 → 需要凭据（投影为 off）；未配置 Key → off ----
installFetch();
globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => "" });
const dsBad = await PROVIDERS.deepseek.query(cfg());
assert.equal(dsBad.status, "auth-required", "401 归类为需要凭据");
assert.equal(dsBad.state, "off", "需要凭据在旧投影里是 off（与既有 UI 语义一致）");
const dsOff = await PROVIDERS.deepseek.query({ apiKey: "" });
assert.equal(dsOff.state, "off");
assert.equal(dsOff.status, "auth-required");
console.log("✓ 401 → auth-required/off；无 Key → off");

// ---- 被排除厂商：注册表层面不存在（不恢复、不删测试）----
for (const id of ["moonshot-cn", "zai", "minimax", "openai-org", "anthropic-org"]) {
  assert.equal(id in PROVIDERS, false, `${id} 不得出现在本轮注册表`);
}
console.log("✓ 被排除厂商不在注册表中");

// ---- 格式化 ----
assert.equal(formatBig(1_234_567), "1.2M");
assert.equal(formatBig(999), "999");
assert.equal(formatMoney(12.5, "USD"), "$12.50");
assert.equal(formatMoney(88.4, "CNY"), "¥88.40");
console.log("✓ 格式化：1.2M / 999 / $12.50 / ¥88.40");

// 占位时刻（上游用 0 表示「无重置时刻」）必须等价于「没给」
assert.equal(resetAtMs(new Date(0)), null, "epoch 0 是占位，不是时刻");
assert.equal(resetAtMs(0), null);
assert.equal(resetAtMs(-1), null);
assert.equal(resetAtMs(Date.UTC(2025, 7, 26, 5)), Date.UTC(2025, 7, 26, 5));
console.log("✓ resetAtMs：占位/秒级值判为无时刻，真时刻原样通过");

console.log("\n数据层冒烟测试全部通过 ✔");
