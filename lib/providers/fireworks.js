// lib/providers/fireworks.js — Fireworks AI：官方账户月消费 + 控制台 Credits 余额
//
// 两个来源严格分离，语义不可互换（方案 4.5）：
//   1) 官方月消费（api-key，纯 HTTP）：
//        GET https://api.fireworks.ai/v1/accounts?pageSize=200[&pageToken=...]
//        GET https://api.fireworks.ai/v1/accounts/{id}/quotas/monthly-spend-usd
//      只读 `usage` 作为该账户本月**已消费**金额。同一响应里的 `value`（预算额度）与
//      `value - usage`（预算余量）都不是钱包余额／充值余额，本模块绝不把它们当作余额输出，
//      也不跨账户求和。
//   2) 控制台余额（console，独立浏览器会话）：
//      https://app.fireworks.ai/account/home 页面内唯一可识别的 Credits 区域读数；
//      会话账户取自页面内 /api/v2/auth/refresh 的 session.accountID，原始会话响应不离开浏览器。
//      读数必须用官方账户列表核对属于该 API Key 可访问范围；指定账户必须完全一致，
//      即使同 Key 下的另一账户也不放入指定账户卡片。
//
// 安全与解析边界：
//   - 账户资源名必须严格匹配 accounts/<[A-Za-z0-9_-]+> 才允许拼进请求路径（防路径注入）；
//   - 账户列表分页有批数上限、账户去重与循环游标保护；任何一项不满足都整体失败，
//     绝不把已累计的账户子集当作完整发现集合发布（保留旧列表是调度层职责）；
//   - 单账户额度失败只标记该账户，其他账户保留，整体置 partial，且不生成“完整总计”；
//   - 失败／缺字段／未知一律 null，绝不变成 0；服务方未声明月度时区契约时不推算月初重置。

import {
  STATUS, QueryError, httpJson, num, item, result, failure, failureFromError, isAbort, formatResetText,
} from "../provider-common.js";
import { CONSOLE_ORIGINS, consoleRefOf } from "../provider-policy.js";

export const ID = "fireworks";

export const METHOD_MONTHLY_COST = "fireworks.monthly-cost.api-key";
export const METHOD_CONSOLE_BALANCE = "fireworks.balance.console";

/** 官方 API 源（固定代码决定，不接受前端传入任意 URL）。 */
export const API_ORIGIN = "https://api.fireworks.ai";
/** 控制台页面源与登录地址（与 lib/provider-policy.js 同源）。 */
export const PAGE_ORIGIN = CONSOLE_ORIGINS.fireworks.page;
export const CONSOLE_LOGIN_URL = CONSOLE_ORIGINS.fireworks.loginUrl;

/** 控制台会话引用名：桥接按此隔离浏览器目录（策略表是唯一事实来源）。 */
const CONSOLE_REF = consoleRefOf(ID, METHOD_CONSOLE_BALANCE) || "fireworks-balance";

const API_HOSTS = ["api.fireworks.ai"];
const API_BASE_PATHS = ["", "/v1", "/inference/v1"];

/** 账户资源名：只接受 accounts/<合法 ID>，任何其他形态都不得进入请求路径。 */
const ACCOUNT_NAME_RE = /^accounts\/[A-Za-z0-9_-]+$/;
/** 控制台会话账户 ID（页面 session.accountID）形态。 */
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]+$/;

/** 账户列表分页上限：超出即明确失败，不延长到无界。 */
const MAX_ACCOUNT_BATCHES = 20;
const PAGE_SIZE = 200;
/** 可访问账户上限（含分页合并后）：防无界扇出。 */
const MAX_ACCOUNTS = 1000;
/** 多账户方法整体时间预算（方案 8：复杂多账户方法最多 120 秒，可取消）。 */
const METHOD_BUDGET_MS = 120_000;

/** 控制台 Credits 文本：必须自带美元符号（单位由页面文本本身核定，不靠数字大小猜测）。 */
const CREDITS_TEXT_RE = /^(?:-\$|\$-?)(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/;

/**
 * 校验官方 API 地址：https + 默认端口 + 无用户信息／查询串／片段 + 主机与基础路径白名单。
 * 地址不合法时调用方不得发出任何请求。
 * @returns { origin, error }（error 为 QueryError 或 null）
 */
export function resolveApiOrigin(baseUrl) {
  const fallback = {
    origin: null,
    error: new QueryError(STATUS.SCHEMA_MISMATCH, `Base URL 需为官方 HTTPS 地址（${API_HOSTS.join(" / ")}）`),
  };
  try {
    const url = new URL(String(baseUrl ?? "").trim() || API_ORIGIN);
    if (url.protocol !== "https:") return fallback;
    if (url.port && url.port !== "443") return fallback;
    if (url.username || url.password || url.search || url.hash) return fallback;
    if (!API_HOSTS.includes(url.hostname.toLowerCase())) return fallback;
    const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    if (!API_BASE_PATHS.includes(basePath)) return fallback;
    return { origin: url.origin, error: null };
  } catch {
    return fallback;
  }
}

/**
 * 读取**完整**的账户列表（分页合并）。
 * 任何一批失败、游标循环、批数超限或账户名非法都直接抛错：调用方拿不到部分集合，
 * 因此不可能发布“虚假的完整汇总”。重复账户（同批或跨批）只保留首个。
 * @returns { accounts: [{ name }] }（账户列表为空时返回空数组，由调用方决定语义）
 */
async function fetchAllAccounts({ origin, key, signal, timeoutMs }) {
  const seenAccounts = new Set();
  const seenTokens = new Set();
  const accounts = [];
  let token = null;
  for (let batch = 0; batch < MAX_ACCOUNT_BATCHES; batch++) {
    const query = `/v1/accounts?pageSize=${PAGE_SIZE}`
      + (token === null ? "" : `&pageToken=${encodeURIComponent(token)}`);
    const body = await httpJson(origin + query, { key, auth: "bearer", signal, timeoutMs });
    if (!body || typeof body !== "object" || !Array.isArray(body.accounts)) {
      throw new QueryError(STATUS.SCHEMA_MISMATCH, "Fireworks 账户列表响应缺少 accounts");
    }
    for (const account of body.accounts) {
      if (!account || typeof account !== "object") {
        throw new QueryError(STATUS.SCHEMA_MISMATCH, "Fireworks 账户条目无效");
      }
      const name = typeof account.name === "string" ? account.name : "";
      if (!ACCOUNT_NAME_RE.test(name)) {
        throw new QueryError(STATUS.SCHEMA_MISMATCH, "Fireworks 账户资源名称无效");
      }
      if (seenAccounts.has(name)) continue;
      seenAccounts.add(name);
      accounts.push({ name });
    }
    if (accounts.length > MAX_ACCOUNTS) {
      throw new QueryError(STATUS.SCHEMA_MISMATCH, `Fireworks 可访问账户超过上限（${MAX_ACCOUNTS}）`);
    }
    const next = body.nextPageToken;
    if (next === null || next === undefined || next === "") return { accounts };
    if (typeof next !== "string") {
      throw new QueryError(STATUS.SCHEMA_MISMATCH, "Fireworks 分页游标类型无效");
    }
    if (seenTokens.has(next)) {
      throw new QueryError(STATUS.SCHEMA_MISMATCH, "Fireworks 账户分页出现重复游标");
    }
    seenTokens.add(next);
    token = next;
  }
  throw new QueryError(STATUS.SCHEMA_MISMATCH, `Fireworks 账户分页超过上限（${MAX_ACCOUNT_BATCHES} 批）`);
}

/**
 * 选定账户（可选）→ 实际参与查询的账户名列表。
 * 配置值接受 accounts/<id> 或裸 <id>，其余形态一律 schema-mismatch；
 * 指定了账户必须存在，否则 forbidden（不静默换成别的账户）。
 */
function selectAccountNames(allNames, requested) {
  if (requested === null || requested === undefined || String(requested).trim() === "") {
    return { names: allNames, error: null };
  }
  const raw = String(requested).trim();
  const name = raw.startsWith("accounts/") ? raw : `accounts/${raw}`;
  if (!ACCOUNT_NAME_RE.test(name)) {
    return { names: [], error: new QueryError(STATUS.SCHEMA_MISMATCH, "配置的 Fireworks 账户标识无效") };
  }
  if (!allNames.includes(name)) {
    return {
      names: [],
      error: new QueryError(STATUS.FORBIDDEN, `指定的 Fireworks 账户 ${name} 不在该 API Key 可访问范围内`),
    };
  }
  return { names: [name], error: null };
}

/**
 * 归一化单个账户的 quota 取值：
 * 允许 Map 值为 { quota }（成功）、{ error } / QueryError（失败）、缺失，或直接给 quota 响应体。
 */
function normalizeQuotaEntry(entry) {
  if (entry === null || entry === undefined) return { missing: true };
  if (entry instanceof QueryError) return { error: entry };
  if (typeof entry === "object") {
    if (entry.error) return { error: entry.error };
    if (Object.hasOwn(entry, "quota")) return { quota: entry.quota };
  }
  return { quota: entry };
}

/** 单个账户 → 本月消费或该账户的失败原因（缺失／失败／未知绝不变成 0）。 */
function quotaUsageOf(entry) {
  const normalized = normalizeQuotaEntry(entry);
  if (normalized.missing) {
    return { error: { status: STATUS.NO_DATA, message: "该账户未查询月度消费" } };
  }
  if (normalized.error) {
    const err = normalized.error;
    return {
      error: {
        status: typeof err?.status === "string" ? err.status : STATUS.NETWORK_ERROR,
        message: err?.message || "账户额度查询失败",
      },
    };
  }
  const quota = normalized.quota;
  if (!quota || typeof quota !== "object") {
    return { error: { status: STATUS.SCHEMA_MISMATCH, message: "账户额度响应无效" } };
  }
  const usage = num(quota.usage);
  if (usage === null) {
    return { error: { status: STATUS.SCHEMA_MISMATCH, message: "账户额度响应缺少 usage" } };
  }
  if (usage < 0) {
    return { error: { status: STATUS.SCHEMA_MISMATCH, message: "账户月度消费不能为负" } };
  }
  return { usage };
}

/**
 * 服务方定义的月度周期：未声明时区契约，因此不推算月初、不给出重置时刻。
 * resetAtMs 保持 null（方案 4.5）。
 */
function monthPeriod() {
  return {
    startMs: null,
    endMs: null,
    timeZone: null,
    granularity: "month",
    description: "服务方定义的账户月度周期（未声明时区，不推算月初重置）",
  };
}

function shortAccountId(name) {
  return name.startsWith("accounts/") ? name.slice("accounts/".length) : name;
}

/** 单账户消费项（成功）。 */
function costItem({ name, usage, now, scope }) {
  return item({
    providerId: ID,
    methodId: METHOD_MONTHLY_COST,
    itemId: `monthly-cost.${name}`,
    scope: { ...scope, accountId: name },
    kind: "cost",
    label: `月消费 · ${shortAccountId(name)}`,
    // 只有「已消费」是确定值；limit／remaining 保持 null：预算余量不是钱包余额。
    raw: { limit: null, used: usage, remaining: null, unit: "USD", currency: "USD", scale: 1 },
    usedPercent: null,
    period: monthPeriod(),
    resetAtMs: null,
    basis: "reported",
    fetchedAtMs: now,
    note: "账户本月已消费（额度接口 usage 字段）；预算额度与 value-usage 余量不是钱包余额",
  });
}

/** 单账户失败项：状态与原因显式挂在条目上，数值保持 null。 */
function failedCostItem({ name, status, message, now, scope }) {
  return item({
    providerId: ID,
    methodId: METHOD_MONTHLY_COST,
    itemId: `monthly-cost.${name}`,
    scope: { ...scope, accountId: name },
    kind: "cost",
    label: `月消费 · ${shortAccountId(name)}`,
    raw: { limit: null, used: null, remaining: null, unit: "USD", currency: "USD", scale: 1 },
    usedPercent: null,
    period: monthPeriod(),
    resetAtMs: null,
    basis: "reported",
    fetchedAtMs: now,
    status,
    error: { code: status, message },
    note: "该账户未取得本月消费（未知，不是 0）",
  });
}

/**
 * 纯函数：由**已完成分页**的账户列表与逐账户 quota 结果构造月消费结果。
 * 便于固定样本测试，不发起任何网络请求。
 *
 * @param accountsBody 账户列表响应；必须已合并全部分页（残留 nextPageToken 视为不完整 → 抛错）
 * @param quotasByName Map<accountName, { quota } | { error } | QueryError | quota 响应体>
 * @param ctx          { now, scope, accountId }（accountId 存在时只输出该账户）
 * @returns 结构化结果（多账户各自独立 item，不跨账户求和）
 * @throws QueryError 账户列表结构不兼容或分页未完成（绝不发布部分汇总）
 */
export function monthlyCostFromAccounts(accountsBody, quotasByName, ctx = {}) {
  const methodId = METHOD_MONTHLY_COST;
  const now = ctx.now ?? Date.now();
  if (!accountsBody || typeof accountsBody !== "object" || Array.isArray(accountsBody)) {
    throw new QueryError(STATUS.SCHEMA_MISMATCH, "Fireworks 账户列表响应无效");
  }
  if (!Array.isArray(accountsBody.accounts)) {
    throw new QueryError(STATUS.SCHEMA_MISMATCH, "Fireworks 账户列表响应缺少 accounts");
  }
  const pending = accountsBody.nextPageToken;
  if (pending !== null && pending !== undefined && pending !== "") {
    // 分页没读完就汇总 = 发布部分发现集合，直接拒绝。
    throw new QueryError(STATUS.SCHEMA_MISMATCH, "Fireworks 账户列表分页未完成，拒绝发布部分账户集合");
  }

  const seen = new Set();
  const allNames = [];
  for (const account of accountsBody.accounts) {
    if (!account || typeof account !== "object") {
      throw new QueryError(STATUS.SCHEMA_MISMATCH, "Fireworks 账户条目无效");
    }
    const name = typeof account.name === "string" ? account.name : "";
    if (!ACCOUNT_NAME_RE.test(name)) {
      throw new QueryError(STATUS.SCHEMA_MISMATCH, "Fireworks 账户资源名称无效");
    }
    if (seen.has(name)) continue;
    seen.add(name);
    allNames.push(name);
  }
  if (!allNames.length) {
    return failure(ID, methodId, STATUS.NO_DATA, "该 API Key 下没有可访问的 Fireworks 账户");
  }

  const selected = selectAccountNames(allNames, ctx.accountId);
  if (selected.error) return failure(ID, methodId, selected.error.status, selected.error.message);

  const quotas = quotasByName instanceof Map ? quotasByName : new Map(Object.entries(quotasByName || {}));
  const scope = ctx.scope || {};
  const items = [];
  const failed = [];
  for (const name of selected.names) {
    const parsed = quotaUsageOf(quotas.get(name));
    if (parsed.error) {
      items.push(failedCostItem({ name, status: parsed.error.status, message: parsed.error.message, now, scope }));
      failed.push({ name, ...parsed.error });
      continue;
    }
    items.push(costItem({ name, usage: parsed.usage, now, scope }));
  }

  const okCount = selected.names.length - failed.length;
  if (!okCount) {
    // 全部失败：整体报第一条失败原因，但逐账户的失败条目照常保留（数值全为 null），
    // 这样 UI 能指出是哪个账户失败，同时不存在任何“看起来完整”的汇总数字。
    return failure(ID, methodId, failed[0].status,
      `全部 ${selected.names.length} 个账户均未取得月度消费：${failed[0].message}`, {
        items,
        fetchedAtMs: now,
        scope: { ...scope, accountId: selected.names.length === 1 ? selected.names[0] : null },
        notes: failed.map((f) => `${f.name} → ${f.status}：${f.message}`),
      });
  }

  const notes = [
    `该 API Key 下可访问账户 ${selected.names.length} 个，逐个独立展示，不跨账户求和`,
    failed.length ? `${failed.length} 个账户未取得月度消费，已单独标记（未生成完整总计）` : null,
  ].filter(Boolean);
  return result({
    providerId: ID,
    methodId,
    status: STATUS.OK,
    items,
    fetchedAtMs: now,
    partial: failed.length > 0,
    scope: { ...scope, accountId: selected.names.length === 1 ? selected.names[0] : null },
    notes,
  });
}

/**
 * 官方月消费查询（Bearer API Key）。
 * 账户列表分页失败 → 整体失败（不发布任何新发现集合）；单账户额度失败 → 该账户标记失败，
 * 其余账户保留并置 partial。取消信号原样上抛。
 */
export async function queryMonthlyCost(ctx = {}) {
  const methodId = METHOD_MONTHLY_COST;
  const cfg = ctx.cfg || {};
  try {
    if (!cfg.apiKey) return failure(ID, methodId, STATUS.AUTH_REQUIRED, "未配置 API Key");
    const { origin, error } = resolveApiOrigin(cfg.baseUrl);
    if (error) return failure(ID, methodId, error.status, error.message);

    const request = { origin, key: cfg.apiKey, signal: ctx.signal, timeoutMs: ctx.timeoutMs };
    // 分页不完整时这里直接抛错，调用方保留上一次的列表（不发布半份账户集合）。
    const listed = await fetchAllAccounts(request);
    const selected = selectAccountNames(listed.accounts.map((a) => a.name), cfg.accountId);
    if (selected.error) return failure(ID, methodId, selected.error.status, selected.error.message);

    const budgetMs = Number.isFinite(ctx.methodBudgetMs) && ctx.methodBudgetMs > 0
      ? ctx.methodBudgetMs
      : METHOD_BUDGET_MS;
    const deadline = Date.now() + budgetMs;
    const quotasByName = new Map();
    for (const name of selected.names) {
      if (Date.now() >= deadline) {
        // 超时预算的账户明确标记为未查询，而不是当成 0 或悄悄丢掉。
        quotasByName.set(name, {
          error: new QueryError(STATUS.NETWORK_ERROR, `超出方法整体时间预算（${budgetMs} ms），该账户未查询`),
        });
        continue;
      }
      try {
        const quota = await httpJson(`${origin}/v1/${name}/quotas/monthly-spend-usd`, {
          key: cfg.apiKey,
          auth: "bearer",
          signal: ctx.signal,
          timeoutMs: ctx.timeoutMs,
        });
        quotasByName.set(name, { quota });
      } catch (quotaError) {
        if (isAbort(quotaError, ctx.signal)) throw quotaError;
        quotasByName.set(name, { error: quotaError });
      }
    }
    return monthlyCostFromAccounts({ accounts: listed.accounts }, quotasByName, {
      now: ctx.now,
      scope: ctx.scope,
      accountId: cfg.accountId,
    });
  } catch (error) {
    if (isAbort(error, ctx.signal)) throw error;
    return failureFromError(ID, methodId, error, ctx.signal);
  }
}

/**
 * 纯函数：解析浏览器读取器回传的载荷（固定样本可测，不含任何网络与 DOM 依赖）。
 * 载荷形态：{ status: 'ready'|'auth'|'forbidden'|'network'|'schema'|'unavailable', accountId, credits }
 * @returns { accountId, accountName, balance, displayText, currency, unit }
 * @throws QueryError 会话失效、结构不匹配或单位不明（绝不抓页面任意金额充数）
 */
export function parseConsoleObservation(payload) {
  if (!payload || typeof payload !== "object") {
    throw new QueryError(STATUS.SCHEMA_MISMATCH, "Fireworks 控制台读取器未返回数据");
  }
  if (payload.status !== "ready") {
    const map = {
      auth: [STATUS.AUTH_REQUIRED, "Fireworks 控制台会话尚未登录或已失效"],
      forbidden: [STATUS.FORBIDDEN, "没有权限读取该 Fireworks 控制台账户"],
      network: [STATUS.NETWORK_ERROR, "Fireworks 控制台会话检查失败"],
      unavailable: [STATUS.ENVIRONMENT_UNAVAILABLE, "当前环境没有可用的浏览器会话"],
    };
    const [status, message] = map[payload.status] || [STATUS.SCHEMA_MISMATCH, "控制台未显示可识别的 Credits 余额"];
    throw new QueryError(status, message);
  }
  const accountId = typeof payload.accountId === "string" ? payload.accountId.trim() : "";
  if (!ACCOUNT_ID_RE.test(accountId)) {
    throw new QueryError(STATUS.SCHEMA_MISMATCH, "Fireworks 控制台账户标识无效");
  }
  const displayText = typeof payload.credits === "string" ? payload.credits.trim() : "";
  if (!CREDITS_TEXT_RE.test(displayText)) {
    // 没有明确美元符号／格式不符：单位不明，宁可失败也不猜。
    throw new QueryError(STATUS.SCHEMA_MISMATCH, "Fireworks 控制台余额文本不是可识别的美元金额（单位不明）");
  }
  const balance = num(displayText.replace(/[$,]/g, ""));
  if (balance === null) {
    throw new QueryError(STATUS.SCHEMA_MISMATCH, "Fireworks 控制台余额无法解析");
  }
  return {
    accountId,
    accountName: `accounts/${accountId}`,
    balance, // 允许为负（页面可能出现负数 Credits）
    displayText, // 已通过严格金额格式校验的页面文本，仅作展示依据
    currency: "USD",
    unit: "USD",
  };
}

/**
 * 固定页面内读取脚本（随包发布的代码，不接受前端传入 URL／JS）。
 * 只做两件事：核对页面源与会话、读取唯一可识别的 Credits 区域；cookie 与完整会话响应
 * 不离开浏览器，回传内容只有状态、账户标识与被校验过的金额文本。
 */
export function consoleReadScript(nonce) {
  return `(() => {
  const nonce = ${JSON.stringify(nonce)};
  const pageOrigin = ${JSON.stringify(PAGE_ORIGIN)};
  const post = (value) => {
    try { window.__dshConsoleRead.post(nonce, value); } catch (error) { /* 桥接不可用：由桥接超时兜底 */ }
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  (async () => {
    try {
      if (location.origin !== pageOrigin) return post({ status: 'auth' });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      let response;
      try {
        response = await fetch('/api/v2/auth/refresh', {
          credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        });
      } finally { clearTimeout(timer); }
      if (response.status === 401 || response.status === 403) return post({ status: 'auth' });
      if (!response.ok) return post({ status: 'network' });
      let body;
      try { body = await response.json(); } catch (error) { return post({ status: 'schema' }); }
      const accountId = body && body.session && body.session.accountID;
      if (!accountId) return post({ status: 'auth' });
      // 只接受唯一可识别的 Credits 区域：可见、未禁用、同时显示 Total Spend 与 Credits 的按钮。
      for (let attempt = 0; attempt < 30; attempt++) {
        const matches = [...document.querySelectorAll('button')].filter((button) => !button.disabled
          && button.getAttribute('aria-disabled') !== 'true' && button.getClientRects().length > 0
          && /Total Spend:/.test(button.innerText) && /Credits:/.test(button.innerText));
        if (matches.length === 1) {
          const amount = matches[0].innerText.match(/Credits:\\s*(\\S+)/);
          // 金额是否可识别、单位是否明确由解析层判定；这里只回传原始文本。
          if (amount) return post({ status: 'ready', accountId: String(accountId), credits: amount[1] });
        }
        await sleep(200);
      }
      post({ status: 'schema' });
    } catch (error) { post({ status: 'network' }); }
  })();
})();`;
}

/** 非秘密关联标识：用于把页面回传与本次读取配对（桥接亦可用自己的 nonce）。 */
function newNonce() {
  const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(16));
  if (bytes) return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
}

/**
 * 控制台 Credits 余额查询（独立浏览器会话 + API Key 核对账户归属）。
 * ctx.console 由 lib/runtime/console-bridge.js 提供：{ read(ref, options) }。
 * 缺少浏览器环境 → environment-unavailable；缺少 API Key → auth-required（无法核对归属）。
 * 取消信号原样上抛。
 */
export async function queryConsoleBalance(ctx = {}) {
  const methodId = METHOD_CONSOLE_BALANCE;
  const cfg = ctx.cfg || {};
  try {
    if (!cfg.apiKey) {
      return failure(ID, methodId, STATUS.AUTH_REQUIRED,
        "请先保存 Fireworks API Key：控制台余额必须用它核对账户归属");
    }
    const { origin, error } = resolveApiOrigin(cfg.baseUrl);
    if (error) return failure(ID, methodId, error.status, error.message);
    if (typeof ctx.console?.read !== "function") {
      return failure(ID, methodId, STATUS.ENVIRONMENT_UNAVAILABLE,
        "当前环境没有可用的浏览器会话（Fireworks 余额需要控制台登录）");
    }

    // 读取脚本来自桥接的固定读取器注册表：这里不传 script／nonce／url，
    // 保证页面代码只有一份（避免出现第二个可被改写的来源）。
    const observation = await ctx.console.read(CONSOLE_REF, {
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
    });
    const parsed = parseConsoleObservation(observation);

    // 指定账户必须完全一致：页面会话账户不同就报 forbidden，绝不换到别的账户卡片。
    const requested = String(cfg.accountId ?? "").trim();
    if (requested) {
      const wantedName = requested.startsWith("accounts/") ? requested : `accounts/${requested}`;
      if (!ACCOUNT_NAME_RE.test(wantedName)) {
        return failure(ID, methodId, STATUS.SCHEMA_MISMATCH, "配置的 Fireworks 账户标识无效");
      }
      if (wantedName !== parsed.accountName) {
        return failure(ID, methodId, STATUS.FORBIDDEN,
          `控制台登录账户 ${parsed.accountName} 与指定账户 ${wantedName} 不一致，请切换账户后重试`);
      }
    }

    // 归属核对：即使余额来自同一 Key 可访问的另一个账户，也不能当作本次要查的账户。
    const listed = await fetchAllAccounts({ origin, key: cfg.apiKey, signal: ctx.signal, timeoutMs: ctx.timeoutMs });
    if (!listed.accounts.some((account) => account.name === parsed.accountName)) {
      return failure(ID, methodId, STATUS.FORBIDDEN,
        `控制台账户 ${parsed.accountName} 不属于该 API Key 可访问范围，请切换账户后重试`);
    }

    const now = ctx.now ?? Date.now();
    const scope = { ...(ctx.scope || {}), accountId: parsed.accountName };
    return result({
      providerId: ID,
      methodId,
      status: STATUS.OK,
      scope,
      fetchedAtMs: now,
      items: [item({
        providerId: ID,
        methodId,
        itemId: `balance.${parsed.accountName}`,
        scope,
        kind: "balance",
        label: `余额 · Credits（${parsed.accountId}）`,
        raw: {
          limit: null,
          used: null,
          remaining: parsed.balance,
          unit: parsed.unit,
          currency: parsed.currency,
          scale: 1,
        },
        usedPercent: null,
        period: { description: "控制台可用 Credits（页面唯一可识别区域）" },
        resetAtMs: null,
        basis: "reported",
        fetchedAtMs: now,
        note: `控制台 Credits 区域读数 ${parsed.displayText}，账户已与该 API Key 的官方账户列表核对`,
      })],
      notes: ["原始会话响应不离开浏览器；账户归属由官方账户列表核对"],
    });
  } catch (error) {
    if (isAbort(error, ctx.signal)) throw error;
    return failureFromError(ID, methodId, error, ctx.signal);
  }
}

/** 展示用：重置文本（沿用既有语义）。 */
export const resetText = formatResetText;
