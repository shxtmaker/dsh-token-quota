// lib/provider-common.js — 有界 HTTP、错误分类、数字／时间解析与结构化结果
//
// 数据层公共工具：所有查询方法共用一套传输与结果语义，避免各自实现超时、重试、
// 单位换算和「缺失转零」。设计要点（对应方案 5.3 / 5.4 / 8）：
//   - 请求可取消（调用方 signal + 单请求超时），失败分类到稳定的 status 枚举；
//   - 429 尊重 Retry-After，5xx／网络错误交给调度器退避；
//   - 缺失值一律 null，绝不 Number(null) === 0；整数若超出 JS 安全范围保留字符串；
//   - 结构化快照承载原始单位与来源依据，旧 entries/headline 只是投影。

/** 稳定查询状态（与「快照新鲜度」「告警级别」分开）。 */
export const STATUS = Object.freeze({
  OK: "ok",
  NO_DATA: "no-data",
  AUTH_REQUIRED: "auth-required",
  FORBIDDEN: "forbidden",
  RATE_LIMITED: "rate-limited",
  SCHEMA_MISMATCH: "schema-mismatch",
  NETWORK_ERROR: "network-error",
  ENVIRONMENT_UNAVAILABLE: "environment-unavailable",
  DISABLED: "disabled",
  UNSUPPORTED_PROVIDER: "unsupported-provider",
});

export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** 带 status 的错误；transport 层与解析层共用。 */
export class QueryError extends Error {
  constructor(status, message, { retryAfterMs = null, httpStatus = null } = {}) {
    super(message);
    this.name = "QueryError";
    this.status = status;
    this.code = status;
    this.retryAfterMs = retryAfterMs;
    this.httpStatus = httpStatus;
  }
}

/** 把 HTTP 状态码映射为稳定查询状态。 */
export function statusFromHttp(httpStatus) {
  if (httpStatus === 401) return STATUS.AUTH_REQUIRED;
  if (httpStatus === 403) return STATUS.FORBIDDEN;
  if (httpStatus === 429) return STATUS.RATE_LIMITED;
  if (httpStatus >= 500) return STATUS.NETWORK_ERROR;
  return STATUS.SCHEMA_MISMATCH;
}

/** 解析 Retry-After（秒数或 HTTP 日期），返回毫秒或 null。 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 24 * 3600_000);
  const date = new Date(String(value));
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.min(ms - now, 24 * 3600_000));
}

/**
 * 有界 JSON 请求。
 * @param url          完整 https URL（由各方法用固定端点策略构造，不接受用户任意输入）
 * @param opts.key     凭据；opts.auth: 'bearer' | 'x-api-key' | 'raw' | 'none'
 * @param opts.signal  调用方取消信号（与内部超时合并）
 * @param opts.maxBytes 响应体上限（超出即 schema 错误，不静默截断）
 * @returns 解析后的 JSON；204/空体返回 null
 */
export async function httpJson(url, {
  key = "",
  auth = "bearer",
  extraHeaders = {},
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  signal = null,
  maxBytes = MAX_RESPONSE_BYTES,
  allowEmpty = true,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new QueryError(STATUS.NETWORK_ERROR, "请求超时")), timeoutMs);
  const signals = [controller.signal];
  if (signal) signals.push(signal);
  const headers = { accept: "application/json", ...extraHeaders };
  if (key && auth === "bearer") headers.authorization = `Bearer ${key}`;
  else if (key && auth === "x-api-key") headers["x-api-key"] = key;
  else if (key && auth === "raw") headers.authorization = key;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any(signals),
      headers,
      redirect: "error", // 官方查询安全边界：拒绝重定向
    });
    if (!response.ok) {
      throw new QueryError(statusFromHttp(response.status), `HTTP ${response.status}`, {
        httpStatus: response.status,
        retryAfterMs: parseRetryAfter(headerValue(response, "retry-after")),
      });
    }
    const declared = Number(headerValue(response, "content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new QueryError(STATUS.SCHEMA_MISMATCH, "响应体超过已设上限");
    }
    const text = await readBounded(response, maxBytes);
    if (!text) {
      if (allowEmpty) return null;
      throw new QueryError(STATUS.SCHEMA_MISMATCH, "响应为空");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new QueryError(STATUS.SCHEMA_MISMATCH, "响应不是有效 JSON");
    }
  } catch (error) {
    if (error instanceof QueryError) throw error;
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      // 调用方取消 vs 自身超时：取消要原样上抛，交给调度器丢弃结果
      if (signal?.aborted) throw error;
      throw new QueryError(STATUS.NETWORK_ERROR, "请求超时");
    }
    throw new QueryError(STATUS.NETWORK_ERROR, error?.message || "网络错误");
  } finally {
    clearTimeout(timer);
  }
}

/** 有界文本读取（公开规则脚本等非 JSON 资源复用）。 */
export async function readBounded(response, maxBytes = MAX_RESPONSE_BYTES) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (text.length > maxBytes) throw new QueryError(STATUS.SCHEMA_MISMATCH, "响应体超过已设上限");
    return text;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new QueryError(STATUS.SCHEMA_MISMATCH, "响应体超过已设上限");
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

/** 有界文本请求（公开规则读取器用；不发送凭据）。 */
export async function httpText(url, {
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  signal = null,
  maxBytes = MAX_RESPONSE_BYTES,
  headers = {},
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signals = [controller.signal];
  if (signal) signals.push(signal);
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any(signals),
      headers: { accept: "text/html,application/javascript;q=0.9,*/*;q=0.8", ...headers },
      redirect: "error",
    });
    if (!response.ok) {
      throw new QueryError(statusFromHttp(response.status), `HTTP ${response.status}`, {
        httpStatus: response.status,
        retryAfterMs: parseRetryAfter(headerValue(response, "retry-after")),
      });
    }
    return await readBounded(response, maxBytes);
  } catch (error) {
    if (error instanceof QueryError) throw error;
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      if (signal?.aborted) throw error;
      throw new QueryError(STATUS.NETWORK_ERROR, "请求超时");
    }
    throw new QueryError(STATUS.NETWORK_ERROR, error?.message || "网络错误");
  } finally {
    clearTimeout(timer);
  }
}

/** 读取响应头：宿主／测试替身可能不提供 headers，缺失一律当作没有该头。 */
function headerValue(response, name) {
  try {
    return response?.headers?.get?.(name) ?? null;
  } catch {
    return null;
  }
}

// ---------- 数字与时间解析 ----------

/** 数值解析：缺失/非法一律 null（绝不把 null/"" 转成 0）。 */
export function num(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * 安全整数字符串：超过 JS 安全整数范围时保留十进制字符串，不静默取整。
 * @returns {number|string|null}
 */
export function safeInt(value) {
  const parsed = num(value);
  if (parsed === null) return null;
  if (!Number.isInteger(parsed)) return null;
  if (Number.isSafeInteger(parsed)) return parsed;
  return String(BigInt(Math.trunc(parsed)));
}

/** 布尔解析：接受 true/false 与 'true'/'false' 字符串，其他为 null。 */
export function bool(value) {
  if (value === true || value === false) return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return null;
}

/** 2001-09 之前的数值时刻视为占位或单位错误，不作为窗口时刻。 */
export const MIN_RESET_EPOCH_MS = 1e12;

/** epoch 毫秒契约解析（不接受秒数猜测）。 */
export function epochMs(value) {
  const parsed = num(value);
  if (parsed === null) return null;
  return parsed >= MIN_RESET_EPOCH_MS ? parsed : null;
}

/** ISO／epoch 毫秒混合解析：明确给出单位语义时才使用。 */
export function isoOrEpochMs(value) {
  if (typeof value === "string" && value.trim() !== "") {
    const text = value.trim();
    const numeric = Number(text);
    if (Number.isFinite(numeric)) return epochMs(numeric);
    const ms = Date.parse(text);
    return Number.isFinite(ms) && ms >= MIN_RESET_EPOCH_MS ? ms : null;
  }
  return epochMs(value);
}

/**
 * 明确单位的时间戳解析：秒 → 毫秒。
 * 只在契约确认「该字段是秒」时调用（如 DeepSeek 控制台桶时间），不靠数字大小猜测。
 */
export function secondsToMs(value) {
  const parsed = num(value);
  if (parsed === null) return null;
  const ms = parsed * 1000;
  return ms >= MIN_RESET_EPOCH_MS ? ms : null;
}

// ---------- 金额 ----------
//
// 内部一律用「最小单位整数 + 每单位刻度」表达，避免浮点累加误差；
// 只有格式化时才转成人类可读字符串，且格式化字符串绝不回parse。

/** 金额：{ amount: number（最小单位）, scale: number（1 USD = scale 单位）, currency } */
export function money(amount, scale, currency) {
  if (amount === null || amount === undefined || !Number.isFinite(amount) || !Number.isFinite(scale) || scale <= 0) return null;
  return { amount, scale, currency: currency || null };
}

/** 内部金额 → 十进制数值（仅用于展示与百分比，不用于再计算）。 */
export function moneyValue(value) {
  if (!value || !Number.isFinite(value.amount) || !Number.isFinite(value.scale) || value.scale <= 0) return null;
  return value.amount / value.scale;
}

/** 同一刻度下的安全减法（缺失返回 null，不转零）。 */
export function moneySubtract(a, b) {
  if (!a || !b || a.scale !== b.scale) return null;
  return { amount: a.amount - b.amount, scale: a.scale, currency: a.currency ?? b.currency ?? null };
}

// ---------- 结构化结果 ----------

/**
 * 单个指标项（能力值）。字段与方案 5.3 对齐，字段缺失一律 null。
 * @param spec.providerId / methodId / itemId
 * @param spec.scope       { configInstanceId, accountId, orgId, workspaceId, memberId }
 * @param spec.kind        'window' | 'balance' | 'usage' | 'cost'
 * @param spec.raw         { limit, used, remaining, unit, currency, scale }
 */
export function item(spec) {
  const { raw = {} } = spec;
  const limit = raw.limit ?? null;
  const used = raw.used ?? null;
  const remaining = raw.remaining ?? null;
  let usedPercent = spec.usedPercent;
  if (usedPercent === undefined) {
    // 百分比统一为「已用」；仅在分母有效时计算，缺失保持 null。
    if (Number.isFinite(limit) && limit > 0 && Number.isFinite(used)) usedPercent = (used / limit) * 100;
    else if (Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining)) usedPercent = ((limit - remaining) / limit) * 100;
    else usedPercent = null;
  }
  return {
    providerId: spec.providerId,
    methodId: spec.methodId,
    itemId: spec.itemId ?? null,
    scope: {
      configInstanceId: spec.scope?.configInstanceId ?? null,
      accountId: spec.scope?.accountId ?? null,
      orgId: spec.scope?.orgId ?? null,
      workspaceId: spec.scope?.workspaceId ?? null,
      memberId: spec.scope?.memberId ?? null,
    },
    kind: spec.kind,
    label: spec.label ?? null,
    raw: {
      limit,
      used,
      remaining,
      unit: raw.unit ?? null,
      currency: raw.currency ?? null,
      scale: raw.scale ?? null,
    },
    usedPercent: usedPercent === null || usedPercent === undefined || !Number.isFinite(usedPercent) ? null : usedPercent,
    period: {
      startMs: spec.period?.startMs ?? null,
      endMs: spec.period?.endMs ?? null,
      timeZone: spec.period?.timeZone ?? null,
      granularity: spec.period?.granularity ?? null,
      description: spec.period?.description ?? null,
    },
    resetAtMs: spec.resetAtMs ?? null,
    basis: spec.basis ?? "reported",
    fetchedAtMs: spec.fetchedAtMs ?? null,
    sourceUpdatedAtMs: spec.sourceUpdatedAtMs ?? null,
    validUntilMs: spec.validUntilMs ?? null,
    status: spec.status ?? STATUS.OK,
    error: spec.error ?? null,
    note: spec.note ?? null,
  };
}

/**
 * 一次方法查询的结构化结果。
 * @param spec.providerId / methodId / status
 * @param spec.items     item() 数组
 * @param spec.error     { code, message }
 */
export function result(spec) {
  return {
    providerId: spec.providerId,
    methodId: spec.methodId,
    scope: spec.scope ?? null,
    status: spec.status ?? STATUS.OK,
    items: spec.items ?? [],
    error: spec.error ?? null,
    fetchedAtMs: spec.fetchedAtMs ?? Date.now(),
    validUntilMs: spec.validUntilMs ?? null,
    stale: false,
    partial: !!spec.partial,
    notes: spec.notes ?? [],
  };
}

/** 失败结果（带稳定 status；不含任何秘密）。 */
export function failure(providerId, methodId, status, message, extra = {}) {
  return result({
    providerId,
    methodId,
    status,
    items: [],
    error: { code: status, message },
    ...extra,
  });
}

/** 从异常构造失败结果：取消信号必须原样上抛，绝不吞掉。 */
export function failureFromError(providerId, methodId, error, signal = null) {
  if (isAbort(error, signal)) throw error;
  if (error instanceof QueryError) {
    return failure(providerId, methodId, error.status, error.message, {
      retryAfterMs: error.retryAfterMs ?? null,
    });
  }
  return failure(providerId, methodId, STATUS.NETWORK_ERROR, error?.message || "未知错误");
}

/** 调用方取消判定（AbortError 且 signal 已 aborted）。 */
export function isAbort(error, signal) {
  if (!error) return false;
  if (signal?.aborted) return true;
  return error.name === "AbortError" || error.name === "TimeoutError";
}

// ---------- 共享响应（同一供应商的多个能力复用一次请求） ----------

const sharedResponses = new Map();

/**
 * 让多个方法共享同一次网络请求的结果（方案 5.2：共享同一 HTTP 响应的能力要复用一次请求）。
 * 仅做「同一刷新周期内的合并」，不是长期缓存：
 *   - 在途请求直接复用同一个 Promise（并发方法调用不会各发一次）；
 *   - 已完成的响应保留极短窗口（默认 3 秒），供紧随其后的同批方法读取；
 *   - 失败不保留（下一个调用者会重新尝试）。
 * @param key   共享键（应包含供应商与凭据身份，避免不同凭据互相串用）
 * @param fn    真正发起请求的函数
 */
export function sharedResponse(key, fn, { ttlMs = 3_000, now = Date.now } = {}) {
  const entry = sharedResponses.get(key);
  if (entry) {
    if (entry.pending) return entry.pending;
    if (entry.expiresAt > now()) return Promise.resolve(entry.value);
  }
  const pending = Promise.resolve()
    .then(fn)
    .then((value) => {
      sharedResponses.set(key, { pending: null, value, expiresAt: now() + ttlMs });
      return value;
    })
    .catch((error) => {
      // 失败不保留：允许后续方法重新尝试
      if (sharedResponses.get(key)?.pending === pending) sharedResponses.delete(key);
      throw error;
    });
  sharedResponses.set(key, { pending, value: null, expiresAt: 0 });
  return pending;
}

/** 清空共享响应缓存（配置/凭据变更、卸载或测试隔离用）。 */
export function clearSharedResponses() {
  sharedResponses.clear();
}

/** 合并同一供应商多个方法的结果（能力合并，不互相掩盖失败）。 */
export function mergeResults(providerId, results) {
  const list = results.filter(Boolean);
  if (!list.length) return failure(providerId, null, STATUS.NO_DATA, "没有可用的查询方法");
  const items = [];
  const errors = [];
  let anyOk = false;
  for (const r of list) {
    if (r.status === STATUS.OK && r.items.length) anyOk = true;
    items.push(...r.items);
    if (r.status !== STATUS.OK) errors.push({ methodId: r.methodId, status: r.status, message: r.error?.message || r.status });
  }
  const status = anyOk ? STATUS.OK : (errors.length ? errors[0].status : STATUS.NO_DATA);
  return result({
    providerId,
    methodId: null,
    status,
    items,
    error: errors.length ? { code: status, message: errors.map((e) => `${e.methodId}：${e.message}`).join("；") } : null,
    partial: anyOk && errors.length > 0,
  });
}

// ---------- 展示投影（只在兼容层发生） ----------

const DEFAULT_UNIT_LABELS = Object.freeze({ USD: "$", CNY: "¥" });

/** 金额格式化（内部金额对象 → 文本）。 */
export function formatMoneyValue(value, { currency = null, unit = null } = {}) {
  const target = value;
  if (!target || !Number.isFinite(target.amount) || !Number.isFinite(target.scale) || target.scale <= 0) return "—";
  const symbol = DEFAULT_UNIT_LABELS[target.currency || currency || ""] ?? "";
  const text = (target.amount / target.scale).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (symbol) return `${symbol}${text}`;
  const code = target.currency || currency;
  return code ? `${text} ${code}` : `${text}${unit ? ` ${unit}` : ""}`;
}

/**
 * 结构化条目 → 旧 entries 投影。
 * 保留 raw 原始值与单位，仅把展示需要的部分格式化。
 * @param labelOf (item) => string
 */
export function projectEntries(items, labelOf = defaultItemLabel) {
  return items.map((it) => {
    const raw = it.raw || {};
    const pct = it.usedPercent === null || it.usedPercent === undefined ? null : Math.round(it.usedPercent);
    const entry = {
      name: labelOf(it),
      kind: entryKind(it.kind),
      limit: raw.limit === null || raw.limit === undefined ? "—" : rawUnitText(raw, raw.limit),
      used: raw.used === null || raw.used === undefined ? "—" : rawUnitText(raw, raw.used),
      remain: raw.remaining === null || raw.remaining === undefined ? "—" : rawUnitText(raw, raw.remaining),
      pct,
      reset: it.resetAtMs === null || it.resetAtMs === undefined ? "—" : formatResetText(it.resetAtMs),
      resetAt: it.resetAtMs ?? null,
      note: it.note ?? "",
      itemId: it.itemId ?? null,
      methodId: it.methodId ?? null,
      basis: it.basis ?? null,
      unit: raw.unit ?? null,
      currency: raw.currency ?? null,
      period: it.period ?? null,
    };
    if (it.status && it.status !== STATUS.OK) {
      entry.note = [entry.note, `状态 ${it.status}`].filter(Boolean).join(" · ");
      entry.status = it.status;
    }
    if (it.error?.message) entry.note = [entry.note, it.error.message].filter(Boolean).join(" · ");
    return entry;
  });
}

function defaultItemLabel(it) {
  if (it.label) return it.label;
  const raw = it.raw || {};
  if (it.kind === "balance") return raw.currency ? `余额 · ${raw.currency}` : "余额";
  if (it.kind === "cost") return "报告费用";
  if (it.kind === "usage") return "报告用量";
  return "窗口";
}

function entryKind(kind) {
  if (kind === "balance") return "bal";
  if (kind === "cost") return "cost";
  if (kind === "usage") return "usage";
  return "win";
}

/** 原始值 + 单位 → 展示文本；单位未核验时只显示原始数值加单位名，不伪装金额。 */
export function rawUnitText(raw, value) {
  const unit = raw.unit || raw.currency || "";
  if (unit === "USD" || unit === "CNY") return formatMoneyValue({ amount: value, scale: raw.scale || 1, currency: unit });
  if (unit === "percent") return `${value}%`;
  if (unit === "credits") return `${formatPlain(value)} credits`;
  const text = formatPlain(value);
  return unit ? `${text} ${unit}` : text;
}

function formatPlain(value) {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (abs >= 1e6) return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (abs >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/** 重置时间文本（与既有 formatReset 语义一致，供投影使用）。 */
export function formatResetText(resetAtMs) {
  if (!Number.isFinite(resetAtMs)) return "—";
  const diff = resetAtMs - Date.now();
  if (diff > 0 && diff < 48 * 3600_000) return `约 ${Math.max(1, Math.round(diff / 3600_000))} 小时后重置`;
  const date = new Date(resetAtMs);
  return `${date.getMonth() + 1}月${date.getDate()}日 重置`;
}

/**
 * 结构化结果 → 旧 headline 投影（侧栏主指标）。
 * 优先「已用比例最高的有效窗口」，其后余额、报告费用、报告用量。
 */
export function projectHeadline(items) {
  const windows = items.filter((it) => it.kind === "window" && it.usedPercent !== null && it.usedPercent !== undefined);
  if (windows.length) {
    const tight = windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
    const pct = Math.round(tight.usedPercent);
    const remainText = tight.raw?.remaining !== null && tight.raw?.remaining !== undefined
      ? rawUnitText(tight.raw, tight.raw.remaining)
      : `${Math.max(0, 100 - pct)}%`;
    return {
      kind: "pct",
      pct: `${Math.min(100, Math.max(0, pct))}%`,
      amt: `余 ${remainText}`,
      reset: tight.resetAtMs ? formatResetText(tight.resetAtMs) : "—",
      resetAt: tight.resetAtMs ?? null,
    };
  }
  // 余额：保留全部币种（不跨币种求和，也不丢币种）
  const balances = items.filter((it) => it.kind === "balance" && it.raw?.remaining !== null && it.raw?.remaining !== undefined);
  if (balances.length) {
    return {
      kind: "amt",
      amt: balances.map((it) => rawUnitText(it.raw, it.raw.remaining)).join(" · "),
      reset: "—",
      resetAt: null,
    };
  }
  const cost = items.find((it) => it.kind === "cost");
  if (cost && cost.raw?.used !== null && cost.raw?.used !== undefined) {
    return { kind: "amt", amt: rawUnitText(cost.raw, cost.raw.used), reset: "—", resetAt: null };
  }
  const usage = items.find((it) => it.kind === "usage");
  if (usage && usage.raw?.used !== null && usage.raw?.used !== undefined) {
    return { kind: "amt", amt: rawUnitText(usage.raw, usage.raw.used), reset: "—", resetAt: null };
  }
  const fallback = items[0];
  if (fallback) {
    const value = fallback.raw?.remaining ?? fallback.raw?.used ?? null;
    return { kind: "amt", amt: value === null ? "—" : rawUnitText(fallback.raw || {}, value), reset: "—", resetAt: null };
  }
  return { kind: "amt", amt: "—", reset: "—", resetAt: null };
}

/** 结构化结果 → 旧供应商状态（warn/crit 由有效额度投影而来）。 */
export function projectState(status, items, warnPct = 80, critPct = 95) {
  if (status !== STATUS.OK) {
    if (status === STATUS.DISABLED || status === STATUS.AUTH_REQUIRED) return "off";
    return "err";
  }
  let tightest = null;
  for (const it of items) {
    if (it.kind !== "window" || it.usedPercent === null || it.usedPercent === undefined) continue;
    if (tightest === null || it.usedPercent > tightest) tightest = it.usedPercent;
  }
  if (tightest === null) return "ok";
  if (tightest >= critPct) return "crit";
  if (tightest >= warnPct) return "warn";
  return "ok";
}

/** 结构化结果 → 完整旧格式（state/error/entries/headline），供 UI 与兼容层使用。 */
export function projectLegacy(res, { warnPct = 80, critPct = 95, labelOf } = {}) {
  const entries = projectEntries(res.items, labelOf);
  const state = projectState(res.status, res.items, warnPct, critPct);
  const headline = projectHeadline(res.items);
  const out = { state, entries, headline, status: res.status };
  if (res.error) out.error = { code: res.error.code, message: res.error.message };
  if (res.partial) out.partial = true;
  if (res.stale) out.stale = true;
  if (res.retryAfterMs) out.retryAfterMs = res.retryAfterMs;
  // 结构化明细随投影一起下发（客户端只读展示；不含任何凭据）
  out.items = res.items;
  return out;
}
