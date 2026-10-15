// lib/providers.js — 供应商注册表（本轮范围收敛后的活动查询白名单）
//
// 本文件是「活动查询注册表」的唯一入口，只包含 7 个允许远程查询的供应商 ID：
//   deepseek / openrouter / openrouter-account / opencode / commandcode / fireworks / opendesign
// 被排除厂商（OpenAI/Codex、Anthropic、Moonshot、Z.ai、MiniMax 及一切未列入者）
// **不在此注册表中**：注册、自动探测、凭据解析、轮询、手动刷新与测试接口都由
// lib/provider-policy.js 的冻结白名单拦截（见 SUPPLIER_IDS / PROVIDERS）。
//
// 供应商按「凭据类别 × 地域」拆分（一种页面保存一种凭据）：
//   - api-key（普通 Key，可从 DSH harness 密钥自动识别）
//       deepseek           官方多币种余额；控制台用量／费用另需独立会话
//       openrouter         当前 Key 周期额度 + UTC 今日报告费用
//       opencode           API Key 滚动窗口；OAuth allowance（两类凭据隔离）
//       commandcode        服务端窗口 + 经核验的公开规则月度进度
//       fireworks          官方账户本月消费（不是余额）
//   - management-key（Management Key，DSH 无此类接缝 → 手动配置）
//       openrouter-account 账户 credits
//   - console-session（插件专用浏览器会话，默认关闭，用户显式启用）
//       deepseek 控制台用量／费用、fireworks 控制台余额、opendesign Design Plan 窗口
//
// 兼容层：保留 formatReset / resetAtMs / formatMoney / formatBig 等既有导出，
// 以及 isOfficialBaseUrl / OFFICIAL_ENDPOINTS / OFFICIAL_HOSTS（探测侧复用同一份策略）。
// 旧式 query(cfg) 入口仍然存在，供 /test 与嵌入场景按「已启用方法」聚合调用。

import { QUERY_PROVIDER_IDS, isQueryProvider, methodsOf, METHOD_KINDS, unsupportedProviderResult } from "./provider-policy.js";
import { STATUS, projectLegacy, mergeResults, failure } from "./provider-common.js";
import { queryBalance as dsBalance, queryConsoleUsage as dsConsoleUsage, queryConsoleCost as dsConsoleCost, ID as DS_ID } from "./providers/deepseek.js";
import { queryKey, queryCredits, ID as OR_ID, ACCOUNT_ID as OR_ACCOUNT_ID } from "./providers/openrouter.js";
import { queryRollingWindow, queryAllowance, ID as OC_ID } from "./providers/opencode.js";
import { queryWindows as ccWindows, queryMonthly as ccMonthly, ID as CC_ID } from "./providers/commandcode.js";
import { queryMonthlyCost as fwMonthlyCost, queryConsoleBalance as fwConsoleBalance, ID as FW_ID } from "./providers/fireworks.js";
import { queryWindows as odWindows, ID as OD_ID } from "./providers/opendesign.js";

// ---------- 通用展示工具（既有导出，保持兼容） ----------

function parseNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// 查询中的数字日期字段按 epoch-毫秒契约解析。2001-09 之前的值属于占位或错误单位，
// 不得作为当前服务的配额窗口时刻；不会猜测为秒数或推算重置日期。
const MIN_RESET_EPOCH_MS = 1e12;

function parseDate(value) {
  let date;
  if (value instanceof Date) date = value;
  else if (typeof value === "number") date = new Date(value);
  else if (typeof value === "string" && value.trim() !== "") {
    const text = value.trim();
    // 数字串也必须按毫秒处理，避免 Date("0") 被解释成 2000 年 1 月。
    const numeric = Number(text);
    date = new Date(Number.isFinite(numeric) ? numeric : text);
  } else return null;
  const ms = date.getTime();
  return Number.isFinite(ms) && ms >= MIN_RESET_EPOCH_MS ? date : null;
}

/** 重置时间人话化：「约 X 小时后重置」/「M月D日 重置」。 */
export function formatReset(resetsAt) {
  const target = parseDate(resetsAt);
  if (!target) return "—";
  const diffMs = target.getTime() - Date.now();
  if (diffMs > 0 && diffMs < 48 * 3600 * 1000) {
    const hours = Math.max(1, Math.round(diffMs / 3600_000));
    return `约 ${hours} 小时后重置`;
  }
  return `${target.getMonth() + 1}月${target.getDate()}日 重置`;
}

/**
 * 重置时刻的原始 epoch-毫秒（无时刻返回 null）。
 * 只在供应商确实给出时刻时返回非空——绝不为了排版推算一个时刻出来。
 */
export function resetAtMs(resetsAt) {
  return parseDate(resetsAt)?.getTime() ?? null;
}

function currencySymbol(currency) {
  if (currency === "USD") return "$";
  if (currency === "CNY") return "¥";
  return "";
}

/** 金额格式化：两位小数 + 千分位。 */
export function formatMoney(value, currency = "") {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const formatted = n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency && currency !== "USD" && currency !== "CNY"
    ? `${formatted} ${currency}`
    : `${currencySymbol(currency)}${formatted}`;
}

const SYMBOLS = [
  { value: 1, symbol: "" },
  { value: 1e3, symbol: "K" },
  { value: 1e6, symbol: "M" },
  { value: 1e9, symbol: "B" },
];

/** 大数缩写（≥10 万用 K/M 缩写；级内千分位）。 */
export function formatBig(value, unit = "") {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  let scale = SYMBOLS[0];
  for (const s of SYMBOLS) {
    if (abs >= s.value) scale = s;
  }
  if (scale.value === 1) return `${Math.round(n).toLocaleString()}${unit && ` ${unit}`}`;
  return `${(n / scale.value).toLocaleString(undefined, { maximumFractionDigits: 1 })}${scale.symbol}${unit && ` ${unit}`}`;
}

// ---------- 官方地址策略（唯一事实来源） ----------
//
// 查询函数与自动探测校验必须引用同一份主机/基础路径策略：任何一方单独改动都会让
// 「探测可采纳的地址」与「查询可使用的地址」出现分歧。
export const DEEPSEEK_ENDPOINT = { hosts: ["api.deepseek.com"], basePaths: ["", "/v1"] };
export const OPENROUTER_ENDPOINT = { hosts: ["openrouter.ai"], basePaths: ["", "/api", "/api/v1"] };

/** 各官方供应商允许的主机与基础路径（无该键 = 私有兼容来源，不做官方地址约束）。 */
export const OFFICIAL_ENDPOINTS = {
  deepseek: DEEPSEEK_ENDPOINT,
  openrouter: OPENROUTER_ENDPOINT,
  "openrouter-account": OPENROUTER_ENDPOINT,
  fireworks: { hosts: ["api.fireworks.ai"], basePaths: ["", "/v1", "/inference/v1"] },
};

/** 各官方供应商允许的主机（无该键 = 私有兼容来源，不做官方地址约束）。 */
export const OFFICIAL_HOSTS = Object.fromEntries(
  Object.entries(OFFICIAL_ENDPOINTS).map(([id, spec]) => [id, spec.hosts]),
);

/** 校验官方端点：https + 默认端口 + 无 userinfo/query/hash + 主机与基础路径白名单。 */
export function officialEndpoint(baseUrl, { hosts, basePaths, defaultBase }) {
  const fallback = { origin: null, error: { code: "endpoint", message: `Base URL 需为官方 HTTPS 地址（${hosts.join(" / ")}）` } };
  try {
    // 未配置 baseUrl 时使用供应商官方默认地址（注册表默认）；显式配置的越界地址仍被拒绝
    const url = new URL(String((baseUrl || "").trim() || defaultBase));
    const host = url.hostname.toLowerCase();
    const isHttps = url.protocol === "https:";
    const defaultPort = !url.port || (url.protocol === "https:" && url.port === "443");
    if (!isHttps || !defaultPort) return fallback;
    if (url.username || url.password || url.search || url.hash) return fallback;
    if (!hosts.includes(host)) return fallback;
    const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    if (!basePaths.includes(basePath)) return fallback;
    return { origin: url.origin, error: null };
  } catch {
    return fallback;
  }
}

/** DSH 路由带进来的 baseURL 是否可直接作为该供应商的官方查询地址。 */
export function isOfficialBaseUrl(supplierId, baseUrl) {
  const spec = OFFICIAL_ENDPOINTS[supplierId];
  if (!spec) return false;
  const { error } = officialEndpoint(baseUrl, spec);
  return !error;
}

// ---------- 方法运行器 ----------

/** 方法运行器：methodId → (ctx) => 结构化结果。 */
const RUNNERS = {
  "deepseek.balance.api-key": (ctx) => dsBalance(ctx),
  "deepseek.console-usage.console-session": (ctx) => dsConsoleUsage(ctx),
  "deepseek.console-cost.console-session": (ctx) => dsConsoleCost(ctx),
  "openrouter.key-quota.api-key": async (ctx) => (await queryKey(ctx)).quota,
  "openrouter.daily-cost.api-key": async (ctx) => (await queryKey(ctx)).dailyCost,
  "openrouter.credits.management-key": (ctx) => queryCredits(ctx),
  "opencode.rolling-window.api-key": (ctx) => queryRollingWindow(ctx),
  "opencode.allowance.oauth": (ctx) => queryAllowance(ctx),
  "commandcode.windows.api-key": (ctx) => ccWindows(ctx),
  "commandcode.monthly.public-rule": (ctx) => ccMonthly(ctx),
  "fireworks.monthly-cost.api-key": (ctx) => fwMonthlyCost(ctx),
  "fireworks.balance.console": (ctx) => fwConsoleBalance(ctx),
  "opendesign.windows.console": (ctx) => odWindows(ctx),
};

/** 注册表元数据（不再含任何被排除厂商）。 */
function supplier(meta) {
  return meta;
}

export const PROVIDERS = {
  deepseek: supplier({
    id: DS_ID,
    name: "DeepSeek",
    credentialClass: "api-key",
    credentialKey: "apiKey",
    credentialLabel: "API Key",
    baseUrlDefault: "https://api.deepseek.com",
    official: "官方稳定",
    needs: [{ key: "apiKey", label: "API Key", secret: true }],
  }),
  openrouter: supplier({
    id: OR_ID,
    name: "OpenRouter",
    credentialClass: "api-key",
    credentialKey: "apiKey",
    credentialLabel: "API Key",
    baseUrlDefault: "https://openrouter.ai/api/v1",
    official: "官方稳定",
    needs: [{ key: "apiKey", label: "API Key", secret: true }],
  }),
  "openrouter-account": supplier({
    id: OR_ACCOUNT_ID,
    name: "OpenRouter 账户 credits",
    credentialClass: "management-key",
    credentialKey: "managementKey",
    credentialLabel: "Management Key",
    baseUrlDefault: "https://openrouter.ai/api/v1",
    official: "官方条件（需 Management Key）",
    needs: [{ key: "apiKey", label: "Management Key", secret: true }],
  }),
  opencode: supplier({
    id: OC_ID,
    name: "OpenCode",
    credentialClass: "api-key",
    credentialKey: "apiKey",
    credentialLabel: "API Key / OAuth",
    compat: "私有兼容来源",
    baseUrlDefault: "https://opencode.ai",
    needs: [
      { key: "apiKey", label: "API Key（窗口用量）", secret: true },
      { key: "allowanceToken", label: "allowance Token（OAuth）", secret: true },
      { key: "orgId", label: "org id（可选）", secret: false },
    ],
  }),
  commandcode: supplier({
    id: CC_ID,
    name: "Command Code",
    credentialClass: "api-key",
    credentialKey: "apiKey",
    credentialLabel: "API Key",
    compat: "私有兼容来源",
    baseUrlDefault: "https://api.commandcode.ai",
    needs: [{ key: "apiKey", label: "API Key", secret: true }],
  }),
  fireworks: supplier({
    id: FW_ID,
    name: "Fireworks AI",
    credentialClass: "api-key",
    credentialKey: "apiKey",
    credentialLabel: "API Key",
    official: "官方（月消费）；控制台余额需独立会话",
    baseUrlDefault: "https://api.fireworks.ai",
    needs: [
      { key: "apiKey", label: "API Key", secret: true },
      { key: "accountId", label: "指定账户（可选）", secret: false },
    ],
  }),
  opendesign: supplier({
    id: OD_ID,
    name: "OpenDesign",
    credentialClass: "console-session",
    credentialKey: "workspaceId",
    credentialLabel: "工作空间",
    compat: "私有兼容来源（控制台会话）",
    baseUrlDefault: "https://amr-link.open-design.ai/v1",
    needs: [
      { key: "workspaceId", label: "工作空间 ID 或控制台链接", secret: false },
    ],
  }),
};

/**
 * 活动查询白名单（= PROVIDERS 键）。定义在 provider-policy.js，
 * 本处只做一致性断言，避免两处漂移。
 */
export const SUPPLIER_IDS = Object.freeze([...QUERY_PROVIDER_IDS]);

for (const id of SUPPLIER_IDS) {
  if (!Object.hasOwn(PROVIDERS, id)) throw new Error(`活动白名单缺少注册信息: ${id}`);
}
for (const id of Object.keys(PROVIDERS)) {
  if (!SUPPLIER_IDS.includes(id)) throw new Error(`注册表含非白名单供应商: ${id}`);
}

/** 某供应商的活动方法定义。 */
export function methodsFor(id) {
  return methodsOf(id);
}

/**
 * 构造调度任务：每个方法一个任务，带资源范围与缓存身份。
 * @param opts.configInstanceId 配置实例标识（凭据版本的一部分）
 * @param opts.credentialVersion 凭据版本的 opaque 标识（不写明文）
 * @param opts.console 控制台桥接（console 方法需要）
 * @param opts.now 可注入时钟
 */
export function buildTaskSpecs(providerId, cfg, opts = {}) {
  if (!isQueryProvider(providerId)) return [];
  const specs = [];
  const scope = {
    configInstanceId: opts.configInstanceId || "default",
    accountId: cfg.accountId || null,
    orgId: cfg.orgId || null,
    workspaceId: cfg.workspaceId || null,
    memberId: null,
  };
  for (const method of methodsFor(providerId)) {
    // 凭据缺失的方法不下发任务（不发请求；由 UI 提示凭据要求）
    if (method.credential === "apiKey" && !cfg.apiKey) continue;
    if (method.credential === "allowanceToken" && !cfg.allowanceToken) continue;
    if (method.credential === "consoleSession" && !method.requiresApiKey && !cfg.apiKey && providerId !== "opendesign") continue;
    if (providerId === "opendesign" && !cfg.workspaceId) continue;
    // 控制台方法默认关闭：必须由用户显式启用
    if (method.transport === "console" && cfg.methods?.[method.methodId] !== true) continue;
    // HTTP 方法：显式关闭即不调度（旧配置默认启用）
    if (method.transport === "http" && cfg.methods?.[method.methodId] === false) continue;
    const run = runnerFor(providerId, method.methodId);
    if (!run) continue;
    specs.push({
      methodId: method.methodId,
      method,
      resourceScope: scope,
      endpoint: method.transport === "console" ? (method.consoleRef || "") : (cfg.baseUrl || ""),
      credentialVersion: opts.credentialVersion || "",
      identityExtra: method.transport === "console" ? (cfg.workspaceId || "") : "",
      intervalMs: opts.intervalFor?.(method),
      run: (ctx) => run({
        cfg,
        scope,
        console: opts.console || null,
        signal: ctx.signal,
        timeoutMs: ctx.timeoutMs,
        now: ctx.now,
      }),
    });
  }
  return specs;
}

/** 直接运行单个方法（/test 与定向验证用）。 */
export async function runMethod(providerId, methodId, cfg, opts = {}) {
  if (!isQueryProvider(providerId)) return unsupportedProviderResult(providerId);
  const run = runnerFor(providerId, methodId);
  if (!run) return failure(providerId, methodId, STATUS.SCHEMA_MISMATCH, `未知方法 ${methodId}`);
  const scope = { configInstanceId: opts.configInstanceId || "default", accountId: cfg?.accountId || null, orgId: cfg?.orgId || null, workspaceId: cfg?.workspaceId || null, memberId: null };
  return run({ cfg, scope, console: opts.console || null, signal: opts.signal, timeoutMs: opts.timeoutMs, now: opts.now });
}

/**
 * 旧式聚合查询：按已启用方法并发取数并合并（供 /test 与嵌入场景）。
 * 被排除/未知 ID 一律返回结构化 unsupported-provider，不发任何请求。
 */
export function makeLegacyQuery(providerId, opts = {}) {
  return async (cfg) => {
    if (!isQueryProvider(providerId)) return unsupportedProviderResult(providerId);
    const methods = methodsFor(providerId).filter((m) => {
      if (m.transport === "console") return cfg?.methods?.[m.methodId] === true;
      return cfg?.methods?.[m.methodId] !== false;
    });
    if (!methods.length) {
      return { state: "off", status: STATUS.DISABLED, error: { code: STATUS.DISABLED, message: "没有已启用的查询方法" }, entries: [], headline: { kind: "amt", amt: "—" } };
    }
    const results = await Promise.all(methods.map((m) => runMethod(providerId, m.methodId, cfg, opts)));
    const merged = mergeResults(providerId, results);
    return projectLegacy(merged, { warnPct: cfg?.warnPct ?? 80, critPct: cfg?.critPct ?? 95 });
  };
}

// 注册表挂上方法运行器（公开接缝：调度与 /test 都从这里取实现，
// 测试与嵌入场景可替换单个方法而不影响其他供应商）。
for (const id of SUPPLIER_IDS) {
  PROVIDERS[id].methods = { ...RUNNERS_FOR(id) };
  PROVIDERS[id].query = makeLegacyQuery(id);
}

/** 某供应商的方法运行器（methodId → (ctx) => 结构化结果）。 */
function RUNNERS_FOR(id) {
  const picked = {};
  for (const method of methodsOf(id)) {
    const run = RUNNERS[method.methodId];
    if (run) picked[method.methodId] = run;
  }
  return picked;
}

/** 取某供应商某方法的当前实现（后绑定：替换注册表条目即可生效）。 */
function runnerFor(providerId, methodId) {
  return PROVIDERS[providerId]?.methods?.[methodId] || null;
}

/** 供应商 ID 是否在活动查询白名单内。 */
export { isQueryProvider };

export const METHOD_KIND = METHOD_KINDS;
