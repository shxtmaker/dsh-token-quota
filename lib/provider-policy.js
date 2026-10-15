// lib/provider-policy.js — 查询范围策略（唯一的查询白名单事实来源）
//
// 本模块是「哪些供应商可以发起远程额度／余额／用量／费用查询」的代码级防线：
//   - QUERY_PROVIDER_IDS 由 Object.freeze 固定，普通配置无法扩大范围；
//   - 任何未知或被排除的 ID 一律得到结构化 unsupported-provider，调用方不得发请求、起进程；
//   - 与本地 Token 观测映射（PASSIVE_ROUTE_MAP）分离：本地统计继续按原机制记录，
//     不会被查询白名单误伤（见方案 1.3）。
//
// 被排除的厂商（OpenAI/ChatGPT/Codex、Anthropic/Claude、Moonshot/Kimi、Z.ai/智谱、
// MiniMax 以及任何未列入白名单者）在本模块中只作为「已知排除项」存在，用于生成明确
// 的拒绝原因与迁移提示，绝不带查询实现。

/**
 * 允许参与远程查询的供应商 ID（代码级冻结）。
 * 顺序即 UI 展示顺序；新增成员必须经过显式授权并同步测试。
 */
export const QUERY_PROVIDER_IDS = Object.freeze([
  "deepseek",
  "openrouter",
  "openrouter-account",
  "opencode",
  "commandcode",
  "fireworks",
  "opendesign",
]);

const QUERY_SET = new Set(QUERY_PROVIDER_IDS);

/** 是否为允许查询的供应商 ID（配置、探测、刷新、测试的唯一判定入口）。 */
export function isQueryProvider(id) {
  return typeof id === "string" && QUERY_SET.has(id);
}

/** 被排除的供应商：仅用于拒绝原因与迁移说明，不参与任何查询。 */
export const EXCLUDED_PROVIDER_IDS = Object.freeze([
  "openai-org",
  "anthropic-org",
  "moonshot-cn",
  "moonshot-intl",
  "zai",
  "zai-cn",
  "minimax",
  "minimax-cn",
]);

const EXCLUDED_SET = new Set(EXCLUDED_PROVIDER_IDS);

/** 被排除 ID 的展示名（迁移提示用，不生成供应商卡片）。 */
export const EXCLUDED_PROVIDER_NAMES = Object.freeze({
  "openai-org": "OpenAI 组织",
  "anthropic-org": "Anthropic 组织",
  "moonshot-cn": "Moonshot 国内",
  "moonshot-intl": "Moonshot 国际",
  zai: "Z.ai",
  "zai-cn": "智谱 Coding Plan",
  minimax: "MiniMax 国际",
  "minimax-cn": "MiniMax 国内",
});

/** 本轮范围收敛的统一说明（一次性迁移提示，不含秘密）。 */
export const SCOPE_NOTICE = "本轮仅查询 DeepSeek、OpenRouter、OpenRouter 账户、OpenCode、Command Code、Fireworks、OpenDesign；"
  + "其他供应商（含 Codex/OpenAI、Anthropic、Moonshot、Z.ai、MiniMax）不参与远程查询，旧配置保留为惰性条目。";

/**
 * 结构化「不支持」结果：排除项与未知 ID 都走这里。
 * @param id 请求的供应商 ID
 * @returns 与既有条目兼容的结果对象（state/error/entries/headline）
 */
export function unsupportedProviderResult(id) {
  const known = typeof id === "string" && EXCLUDED_SET.has(id);
  const name = known ? EXCLUDED_PROVIDER_NAMES[id] : null;
  return {
    providerId: typeof id === "string" ? id : null,
    methodId: null,
    state: "off",
    status: "unsupported-provider",
    error: {
      code: "unsupported-provider",
      message: known
        ? `${name}（${id}）不在本轮查询范围内`
        : `未知或不支持的供应商 ${id ?? "(空)"}`,
    },
    // 结构化结果字段：调用方无需为「不支持」分支做特殊处理
    items: [],
    entries: [],
    headline: { kind: "amt", amt: "—" },
    fetchedAtMs: Date.now(),
    excluded: true,
  };
}

/** 某 ID 的排除原因（无则 null），供迁移与诊断使用。 */
export function exclusionReason(id) {
  if (!isQueryProvider(id)) {
    return EXCLUDED_SET.has(id)
      ? `${EXCLUDED_PROVIDER_NAMES[id]} 不在本轮查询范围内`
      : "未知供应商不在查询白名单内";
  }
  return null;
}

// ---------- 查询方法矩阵（方法 ID 与能力） ----------
//
// 一个方法可以产出多种能力；共享同一 HTTP 响应的能力复用一次请求。
// 需要不同凭据 / 账户 / 请求路径的来源独立调度（见 lib/scheduler.js 的任务键）。
export const METHOD_KINDS = Object.freeze({ WINDOW: "window", BALANCE: "balance", USAGE: "usage", COST: "cost" });

/**
 * 每个白名单供应商的活动查询方法。
 * transport: 'http' = 纯网络；'console' = 需要插件专用浏览器会话（默认关闭，用户显式启用）。
 * credential: 该方法需要的凭据字段（用于拦截「凭据缺失」与跨平台误用）。
 */
export const QUERY_METHODS = Object.freeze({
  deepseek: Object.freeze([
    Object.freeze({ methodId: "deepseek.balance.api-key", transport: "http", credential: "apiKey", kinds: Object.freeze([METHOD_KINDS.BALANCE]), defaultEnabled: true }),
    Object.freeze({ methodId: "deepseek.console-usage.console-session", transport: "console", credential: "consoleSession", kinds: Object.freeze([METHOD_KINDS.USAGE]), defaultEnabled: false, consoleRef: "deepseek-usage" }),
    Object.freeze({ methodId: "deepseek.console-cost.console-session", transport: "console", credential: "consoleSession", kinds: Object.freeze([METHOD_KINDS.COST]), defaultEnabled: false, consoleRef: "deepseek-usage" }),
  ]),
  openrouter: Object.freeze([
    Object.freeze({ methodId: "openrouter.key-quota.api-key", transport: "http", credential: "apiKey", kinds: Object.freeze([METHOD_KINDS.BALANCE]), defaultEnabled: true }),
    Object.freeze({ methodId: "openrouter.daily-cost.api-key", transport: "http", credential: "apiKey", kinds: Object.freeze([METHOD_KINDS.COST]), defaultEnabled: true, sharesResponseWith: "openrouter.key-quota.api-key" }),
  ]),
  "openrouter-account": Object.freeze([
    Object.freeze({ methodId: "openrouter.credits.management-key", transport: "http", credential: "apiKey", kinds: Object.freeze([METHOD_KINDS.BALANCE]), defaultEnabled: true }),
  ]),
  opencode: Object.freeze([
    Object.freeze({ methodId: "opencode.rolling-window.api-key", transport: "http", credential: "apiKey", kinds: Object.freeze([METHOD_KINDS.WINDOW]), defaultEnabled: true }),
    Object.freeze({ methodId: "opencode.allowance.oauth", transport: "http", credential: "allowanceToken", kinds: Object.freeze([METHOD_KINDS.WINDOW, METHOD_KINDS.BALANCE]), defaultEnabled: true }),
  ]),
  commandcode: Object.freeze([
    Object.freeze({ methodId: "commandcode.windows.api-key", transport: "http", credential: "apiKey", kinds: Object.freeze([METHOD_KINDS.WINDOW]), defaultEnabled: true }),
    Object.freeze({ methodId: "commandcode.monthly.public-rule", transport: "http", credential: "apiKey", kinds: Object.freeze([METHOD_KINDS.WINDOW]), defaultEnabled: true, publicRule: true }),
  ]),
  fireworks: Object.freeze([
    Object.freeze({ methodId: "fireworks.monthly-cost.api-key", transport: "http", credential: "apiKey", kinds: Object.freeze([METHOD_KINDS.COST]), defaultEnabled: true }),
    Object.freeze({ methodId: "fireworks.balance.console", transport: "console", credential: "consoleSession", kinds: Object.freeze([METHOD_KINDS.BALANCE]), defaultEnabled: false, consoleRef: "fireworks-balance", requiresApiKey: true }),
  ]),
  opendesign: Object.freeze([
    Object.freeze({ methodId: "opendesign.windows.console", transport: "console", credential: "consoleSession", kinds: Object.freeze([METHOD_KINDS.WINDOW]), defaultEnabled: false, consoleRef: "opendesign-windows" }),
  ]),
});

/** 某供应商的方法定义（副本数组，调用方不可修改注册表）。 */
export function methodsOf(id) {
  return isQueryProvider(id) ? (QUERY_METHODS[id] || []) : [];
}

/** 某方法是否需要控制台会话。 */
export function isConsoleMethod(id, methodId) {
  return methodsOf(id).some((m) => m.methodId === methodId && m.transport === "console");
}

/** 控制台会话引用名（无则 null）：桥接按此隔离浏览器目录。 */
export function consoleRefOf(id, methodId) {
  const method = methodsOf(id).find((m) => m.methodId === methodId);
  return method?.consoleRef || null;
}

/** 全部控制台会话引用名（桥接启动时按平台分组）。 */
export function consoleRefs() {
  const refs = new Set();
  for (const id of QUERY_PROVIDER_IDS) {
    for (const m of QUERY_METHODS[id] || []) {
      if (m.consoleRef) refs.add(m.consoleRef);
    }
  }
  return [...refs];
}

// ---------- 取数端点策略 ----------
//
// 每个方法的请求目标由固定代码决定，不接受前端传入任意 URL。
// 官方 HTTP 方法另外复用 providers.js 的官方地址策略（hosts/basePaths）。
export const CONSOLE_ORIGINS = Object.freeze({
  deepseek: Object.freeze({ page: "https://platform.deepseek.com", loginUrl: "https://platform.deepseek.com/usage" }),
  fireworks: Object.freeze({ page: "https://app.fireworks.ai", loginUrl: "https://app.fireworks.ai/account/home" }),
  opendesign: Object.freeze({ page: "https://open-design.ai", loginUrl: "https://open-design.ai/cloud/dashboard", apiOrigin: "https://amr-api.open-design.ai" }),
});

/** OpenDesign 控制台链接解析：只接受单个 workspaceId 参数，拒绝用户信息/端口/片段/额外参数。 */
export function parseOpenDesignWorkspace(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return { workspace: null, error: "请填写 OpenDesign 工作空间 ID 或控制台链接" };
  if (/^[A-Za-z0-9_-]{1,128}$/.test(raw)) return { workspace: raw, error: null };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { workspace: null, error: "OpenDesign 工作空间 ID 或链接格式无效" };
  }
  if (url.protocol !== "https:") return { workspace: null, error: "OpenDesign 控制台链接必须是 HTTPS" };
  if (url.port) return { workspace: null, error: "OpenDesign 控制台链接不允许非默认端口" };
  if (url.username || url.password) return { workspace: null, error: "OpenDesign 控制台链接不允许用户信息" };
  if (url.hash) return { workspace: null, error: "OpenDesign 控制台链接不允许片段" };
  if (url.hostname.toLowerCase() !== "open-design.ai") return { workspace: null, error: "OpenDesign 控制台链接必须指向 open-design.ai" };
  if (url.pathname.replace(/\/+$/, "") !== "/cloud/dashboard") return { workspace: null, error: "OpenDesign 控制台链接路径必须是 /cloud/dashboard" };
  const params = [...url.searchParams.entries()];
  if (params.length !== 1 || params[0][0] !== "workspaceId") {
    return { workspace: null, error: "OpenDesign 控制台链接只允许一个 workspaceId 参数" };
  }
  const workspace = params[0][1];
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspace)) return { workspace: null, error: "OpenDesign workspaceId 格式无效" };
  return { workspace, error: null };
}

// ---------- 本地被动观测映射（与查询白名单分离） ----------
//
// 本地 Token 统计不是远程查询：被排除厂商的模型仍可正常用于聊天与开发，
// 其 Token 继续按原机制落到本地小时桶（历史数据不丢），但不创建查询供应商。
export const PASSIVE_ROUTE_MAP = Object.freeze({
  "deepseek-official": "deepseek",
  deepseek: "deepseek",
  openrouter: "openrouter",
  opencode: "opencode",
  "opencode-go": "opencode",
  commandcode: "commandcode",
  "commandcode-goat": "commandcode",
  fireworks: "fireworks",
  opendesign: "opendesign",
  // 以下仅用于本地用量归集与历史连续性，绝不产生远程查询
  moonshotai: "moonshot-intl",
  "moonshotai-cn": "moonshot-cn",
  zai: "zai",
  "zai-coding-cn": "zai-cn",
  minimax: "minimax",
  "minimax-cn": "minimax-cn",
  "openai-org": "openai-org",
  "anthropic-org": "anthropic-org",
});

/** 本地观测映射命中的供应商（可能是被排除项，仅用于本地统计）。 */
export function passiveSupplierForRoute(route) {
  if (typeof route !== "string") return null;
  if (Object.hasOwn(PASSIVE_ROUTE_MAP, route)) return PASSIVE_ROUTE_MAP[route];
  for (const [prefix, supplier] of [["commandcode", "commandcode"], ["opencode", "opencode"]]) {
    if (route.startsWith(prefix)) return supplier;
  }
  return null;
}
