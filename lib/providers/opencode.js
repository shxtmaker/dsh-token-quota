// lib/providers/opencode.js — OpenCode：API Key 滚动窗口 + 独立 OAuth allowance
//
// 两种方法完全隔离（方案 4.3），凭据、端点与身份都不同：
//   1) opencode.rolling-window.api-key：GET {server}/zen/go/v1/usage（Bearer API Key）。
//      只展示响应中实际存在且有效的 rolling／weekly／monthly；未知百分比保持未知，
//      非法范围（0–100 之外、缺少有效 resetsAt）报结构不兼容。
//   2) opencode.allowance.oauth：GET {server}/api/go/status（Bearer allowance Token，
//      配置了 orgId 时携带 x-org-id）。保留 usedMicroCents／limitMicroCents／
//      remainingMicroCents 原始值，优先直接报告字段，再做同一 meter 范围内的明确算术推导。
//   一种方法失败绝不生成另一种的结果，也不互相补字段、不去重合并；两类结果的 scope 各自
//   记录自己的 org 身份，身份不明时分别展示。
//
// 单位证据（本模块最关键的一条）：
//   参考项目 Money.cs 采用 1 USD = 10,000,000 microCents，目标仓库旧实现用 1,000,000。
//   已确认的只是「两个仓库相差十倍」，**不是真实服务单位**。因此：
//     - 原始值一律以 microCents 原样保留：raw.unit='microCents'、raw.scale=1；
//     - 不设置 raw.currency='USD'，不把未核验单位伪装成已核验金额；
//     - 唯一换算函数 microCentsToUsd() 只用于生成带标注的估算文本（note）。
//   allowanceUnitEvidence() 返回明确的证据状态（verified=false）；真实页面对照或可靠契约
//   确认前，美元展示保持关闭，百分比仍可使用。
//
// 旧配置兼容：cfg.allowanceToken、cfg.orgId 继续支持（本轮不新增完整 OAuth 设备码登录）。

import {
  STATUS, QueryError, httpJson, num, item, result, failure, failureFromError, isoOrEpochMs,
} from "../provider-common.js";

export const ID = "opencode";

/** 参考项目换算规则：1 USD = 10,000,000 microCents（唯一事实来源，禁止散落魔法数字）。 */
export const MICRO_CENTS_PER_USD = 10_000_000;

export const METHOD_ROLLING_WINDOW = "opencode.rolling-window.api-key";
export const METHOD_ALLOWANCE = "opencode.allowance.oauth";

/** 兼容来源默认服务器（私有网关；baseUrl 只取 scheme://host）。 */
export const DEFAULT_SERVER = "https://opencode.ai";

/** 单位是否已核验：未与真实响应／服务方契约对照前恒为 false。 */
export const UNIT_VERIFIED = false;

/** 单位证据状态（供 UI／诊断展示，禁止把它当成「已核验」）。 */
const UNIT_EVIDENCE = Object.freeze({
  scale: MICRO_CENTS_PER_USD,
  verified: false,
  source: "reference-project",
  note: "1 USD = 10,000,000 microCents 来自参考项目 Money.cs 的内部规则；目标仓库旧实现使用 1,000,000，"
    + "两者相差十倍。未与真实 /api/go/status 响应或服务方公开契约核对前，USD 仅为带标注的估算，"
    + "原始额度仍以 microCents 展示。",
});

/** 返回单位证据副本（调用方不可修改模块内事实）。 */
export function allowanceUnitEvidence() {
  return { ...UNIT_EVIDENCE };
}

/**
 * 唯一的 microCents → USD 换算函数（其余位置不得再出现除数）。
 * @returns {number|null} 无法解析时 null（绝不折算 0）
 */
export function microCentsToUsd(microCents) {
  const value = num(microCents);
  if (value === null) return null;
  return value / MICRO_CENTS_PER_USD;
}

/**
 * Base URL → 服务器地址（scheme://host，忽略路径，如 /zen/go/v1）。
 * 兼容来源只要求安全 HTTPS 形态：默认端口、无用户信息／查询串／片段。
 * @returns {{ server: string|null, error: QueryError|null }}
 */
export function deriveServer(baseUrl) {
  const fallback = {
    server: null,
    error: new QueryError(STATUS.SCHEMA_MISMATCH,
      "OpenCode Base URL 需为安全的 HTTPS 地址（https://主机，默认端口，无用户信息／查询串／片段）"),
  };
  try {
    const url = new URL(String(baseUrl ?? "").trim() || DEFAULT_SERVER);
    if (url.protocol !== "https:") return fallback;
    if (url.port && url.port !== "443") return fallback;
    if (url.username || url.password || url.search || url.hash) return fallback;
    if (!url.hostname) return fallback;
    return { server: url.origin, error: null };
  } catch {
    return fallback;
  }
}

// ---------- API Key 滚动窗口（纯 HTTP） ----------

const WINDOW_ORDER = ["rolling", "weekly", "monthly"];
const WINDOW_LABELS = Object.freeze({ rolling: "5h 滚动", weekly: "周用量", monthly: "月用量" });

/**
 * 解析 /zen/go/v1/usage 响应。
 * 契约（参考 OpenCodeUsageClient.FetchWindowUsageAsync）：body.usage.{rolling,weekly,monthly}
 * 每项含 status / percent / resetsAt；resetsAt 按 ISO 或 epoch 毫秒解析。
 * - 响应中不存在的窗口不展示，也不补 0；
 * - percent 缺失 → 保持未知（null），不转 0；percent 越界 → schema-mismatch；
 * - resetsAt 缺失或无法解析 → schema-mismatch（该方法契约要求每个窗口给出重置时刻）。
 * @returns {Array<{key, label, status, percent, resetsAtMs}>}
 * @throws QueryError
 */
export function parseRollingWindows(body) {
  const usage = body?.usage;
  if (!usage || typeof usage !== "object") {
    throw new QueryError(STATUS.SCHEMA_MISMATCH, "OpenCode 窗口响应缺少 usage");
  }
  const windows = [];
  for (const key of WINDOW_ORDER) {
    const raw = usage[key];
    if (raw === undefined || raw === null) continue; // 未返回该窗口 → 不展示、不补零
    if (typeof raw !== "object") {
      throw new QueryError(STATUS.SCHEMA_MISMATCH, `OpenCode ${key} 窗口不是对象`);
    }
    const percent = num(raw.percent);
    if (percent !== null && (percent < 0 || percent > 100)) {
      throw new QueryError(STATUS.SCHEMA_MISMATCH, `OpenCode ${key} 窗口 percent 超出 0–100`);
    }
    const resetsAtMs = isoOrEpochMs(raw.resetsAt);
    if (resetsAtMs === null) {
      throw new QueryError(STATUS.SCHEMA_MISMATCH, `OpenCode ${key} 窗口缺少有效 resetsAt`);
    }
    const status = typeof raw.status === "string" && raw.status.trim() ? raw.status.trim() : null;
    windows.push({ key, label: WINDOW_LABELS[key], status, percent, resetsAtMs });
  }
  if (!windows.length) {
    throw new QueryError(STATUS.SCHEMA_MISMATCH, "OpenCode 窗口响应未包含 rolling／weekly／monthly 中任何一项");
  }
  return windows;
}

/**
 * API Key 滚动窗口查询（opencode.rolling-window.api-key）。
 * 失败只影响本方法；allowance 由 queryAllowance 独立查询，互不掩盖。
 */
export async function queryRollingWindow(ctx) {
  const methodId = METHOD_ROLLING_WINDOW;
  const now = ctx.now ?? Date.now();
  try {
    if (!ctx.cfg?.apiKey) return failure(ID, methodId, STATUS.AUTH_REQUIRED, "未配置 API Key");
    const { server, error } = deriveServer(ctx.cfg.baseUrl);
    if (error) return failure(ID, methodId, error.status, error.message);

    const body = await httpJson(`${server}/zen/go/v1/usage`, {
      key: ctx.cfg.apiKey,
      auth: "bearer",
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
    });
    const windows = parseRollingWindows(body);
    const items = windows.map((w) => item({
      providerId: ID,
      methodId,
      itemId: `window.${w.key}`,
      scope: ctx.scope,
      kind: "window",
      label: w.label,
      raw: { limit: null, used: null, remaining: null, unit: "percent", scale: 1 },
      // 未知百分比保持 null（item() 不会在缺少分母时自行推导）
      usedPercent: w.percent,
      period: { description: `OpenCode Go 滚动窗口 · ${w.key}` },
      resetAtMs: w.resetsAtMs,
      basis: "reported",
      fetchedAtMs: now,
      note: [
        w.status ? `服务方状态：${w.status}` : "服务方未返回状态",
        w.percent === null ? "服务方未返回百分比（保持未知，不视为 0）" : null,
      ].filter(Boolean).join(" · "),
    }));
    return result({ providerId: ID, methodId, status: STATUS.OK, items, fetchedAtMs: now });
  } catch (error) {
    // 取消信号原样上抛（failureFromError 内部判定）
    return failureFromError(ID, methodId, error, ctx.signal);
  }
}

// ---------- OAuth allowance 绝对值 ----------

const METER_LABELS = Object.freeze({
  five_hour: "5h 额度",
  calendar_week: "周额度",
  product_period: "周期额度",
});

/** orgId 头部取值校验：拒绝控制字符（防头部注入），长度有界。 */
function safeOrgId(orgId) {
  if (orgId === undefined || orgId === null || orgId === "") return { value: null, error: null };
  const text = String(orgId).trim();
  if (!text) return { value: null, error: null };
  if (!/^[^\u0000-\u001f\u007f]{1,256}$/.test(text)) {
    return { value: null, error: new QueryError(STATUS.SCHEMA_MISMATCH, "OpenCode orgId 含非法字符（不接受控制字符或超长值）") };
  }
  return { value: text, error: null };
}

/** 单个 meter 的 microCents 说明文本：原始单位 + 带标注的 USD 估算。 */
function microCentsNote(value, { unitVerified }) {
  const usd = microCentsToUsd(value);
  if (usd === null) return null;
  const amount = `$${usd.toFixed(4)}`;
  return unitVerified
    ? `≈ ${amount}`
    : `按参考项目规则 ≈ ${amount}（1 USD = ${MICRO_CENTS_PER_USD.toLocaleString("en-US")} microCents；单位未核验）`;
}

/**
 * 解析 /api/go/status 响应。
 * - `meters` 缺失 → schema-mismatch；为空数组 → no-data；
 * - 三个原始字段原样保留（缺失为 null，不转 0）；
 * - used 优先用直接字段，其次在同一 meter 内做 limit − remaining 的明确推导；
 * - 百分比仅在 limit > 0 且已用可算时给出，并夹紧到 0–100（只裁剪展示，不改原始值）。
 * @param body               JSON 响应
 * @param opts.unitVerified  单位是否已核验（默认 false；false 时 note 带「单位未核验」标注）
 * @returns {Array<{itemId, label, kind, used, limit, remaining, percent, basis, resetsAtMs, note}>}
 * @throws QueryError
 */
export function parseMeters(body, { unitVerified = UNIT_VERIFIED } = {}) {
  if (!body || typeof body !== "object") {
    throw new QueryError(STATUS.SCHEMA_MISMATCH, "OpenCode allowance 响应不是对象");
  }
  if (!Array.isArray(body.meters)) {
    throw new QueryError(STATUS.SCHEMA_MISMATCH, "OpenCode allowance 响应缺少 meters");
  }
  if (!body.meters.length) {
    throw new QueryError(STATUS.NO_DATA, "OpenCode allowance 未返回任何 meter");
  }
  const meters = [];
  const usedIds = new Set();
  let usable = 0;
  body.meters.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new QueryError(STATUS.SCHEMA_MISMATCH, `OpenCode allowance 第 ${index + 1} 个 meter 不是对象`);
    }
    const kind = typeof raw.kind === "string" && raw.kind.trim() ? raw.kind.trim() : null;
    const limit = num(raw.limitMicroCents);
    const reportedUsed = num(raw.usedMicroCents);
    const reportedRemaining = num(raw.remainingMicroCents);
    if (limit === null && reportedUsed === null && reportedRemaining === null) {
      // 无任何额度字段：保留该 meter（不静默丢弃），由调用方整体判定 no-data
      meters.push({
        itemId: uniqueItemId(usedIds, `meter.${kind || "unknown"}`, index),
        label: kind ? `allowance · ${METER_LABELS[kind] || kind}` : "allowance",
        kind,
        used: null,
        limit: null,
        remaining: null,
        percent: null,
        basis: "reported",
        resetsAtMs: isoOrEpochMs(raw.resetsAt),
        note: "服务方未返回任何额度字段（保持未知，不视为 0）",
      });
      return;
    }
    // 直接报告优先；同一 meter 范围内做一次明确算术推导（limit − remaining / limit − used）
    let used = reportedUsed;
    let usedBasis = "reported";
    if (used === null && limit !== null && reportedRemaining !== null) {
      used = limit - reportedRemaining;
      usedBasis = "arithmetic";
    }
    let remaining = reportedRemaining;
    if (remaining === null && limit !== null && reportedUsed !== null) {
      remaining = limit - reportedUsed;
    }
    // 百分比只在分母有效且已用可算时给出；超出范围只裁剪展示
    const percent = limit !== null && limit > 0 && used !== null
      ? Math.min(100, Math.max(0, (used / limit) * 100))
      : null;
    const resetsAtMs = isoOrEpochMs(raw.resetsAt);
    const parts = [];
    if (usedBasis === "arithmetic") parts.push("已用由 limit − remaining 推导");
    const usedNote = microCentsNote(reportedUsed ?? used, { unitVerified });
    if (usedNote) parts.push(`已用 ${usedNote}`);
    const limitNote = microCentsNote(limit, { unitVerified });
    if (limitNote) parts.push(`上限 ${limitNote}`);
    if (percent === null) parts.push("上限无效或已用未知：不给出百分比");
    if (resetsAtMs === null) parts.push("服务方未返回有效 resetsAt");
    usable++;
    meters.push({
      itemId: uniqueItemId(usedIds, `meter.${kind || "unknown"}`, index),
      label: kind ? `allowance · ${METER_LABELS[kind] || kind}` : "allowance",
      kind,
      used,
      limit,
      remaining,
      percent,
      basis: usedBasis,
      resetsAtMs,
      note: parts.join(" · "),
    });
  });
  if (!usable) {
    throw new QueryError(STATUS.NO_DATA, "OpenCode allowance 的 meter 均未包含额度字段");
  }
  return meters;
}

/** meter itemId 唯一化：不同 kind 与重复 kind 都不合并。 */
function uniqueItemId(usedIds, base, index) {
  let id = base;
  if (usedIds.has(id)) id = `${base}.${index}`;
  usedIds.add(id);
  return id;
}

/**
 * OAuth allowance 查询（opencode.allowance.oauth）。
 * 需要独立凭据 cfg.allowanceToken（旧字段）与可选 cfg.orgId；
 * 与滚动窗口方法完全隔离：这里不发 /zen/go/v1/usage 请求，失败也不影响窗口结果。
 */
export async function queryAllowance(ctx) {
  const methodId = METHOD_ALLOWANCE;
  const now = ctx.now ?? Date.now();
  try {
    const token = ctx.cfg?.allowanceToken;
    if (!token) return failure(ID, methodId, STATUS.AUTH_REQUIRED, "未配置 allowance Token（OAuth access token）");
    const { server, error } = deriveServer(ctx.cfg.baseUrl);
    if (error) return failure(ID, methodId, error.status, error.message);
    const org = safeOrgId(ctx.cfg.orgId);
    if (org.error) return failure(ID, methodId, org.error.status, org.error.message);

    const extraHeaders = {};
    if (org.value) extraHeaders["x-org-id"] = org.value;

    const body = await httpJson(`${server}/api/go/status`, {
      key: token,
      auth: "bearer",
      extraHeaders,
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
    });
    const meters = parseMeters(body, { unitVerified: UNIT_VERIFIED });
    // 身份：orgId 来自本方法的配置；未配置时保持未知，不借用其他方法的 scope 猜测
    const scope = { ...(ctx.scope || {}), orgId: org.value ?? ctx.scope?.orgId ?? null };
    const items = meters.map((m) => item({
      providerId: ID,
      methodId,
      itemId: m.itemId,
      scope,
      kind: "balance",
      label: m.label,
      raw: {
        limit: m.limit,
        used: m.used,
        remaining: m.remaining,
        unit: "microCents", // 原始单位：未经核验，绝不写 USD
        currency: null,     // 不伪装成已核验币种金额
        scale: 1,           // 原始整数刻度（换算只在 microCentsToUsd 内发生）
      },
      usedPercent: m.percent,
      period: { description: `OpenCode Go allowance · ${m.kind || "meter"}` },
      resetAtMs: m.resetsAtMs,
      basis: m.basis,
      fetchedAtMs: now,
      note: m.note,
    }));
    return result({
      providerId: ID,
      methodId,
      status: STATUS.OK,
      items,
      fetchedAtMs: now,
      notes: [
        `单位证据：verified=${UNIT_EVIDENCE.verified}，来源 ${UNIT_EVIDENCE.source}（原始值保留 microCents，USD 仅估算）`,
        org.value ? null : "未配置 orgId：该结果的组织身份未知，不与已确认组织的快照合并",
      ].filter(Boolean),
    });
  } catch (error) {
    return failureFromError(ID, methodId, error, ctx.signal);
  }
}
