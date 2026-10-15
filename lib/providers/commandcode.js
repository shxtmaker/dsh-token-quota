// lib/providers/commandcode.js — Command Code：服务端窗口 + 经核验的月度进度
//
// 固定业务来源 https://api.commandcode.ai（方案 4.4）：
//   1) GET /alpha/whoami              → 确认组织（orgId）
//   2) GET /alpha/billing/credits[?orgId=]
//   3) GET /alpha/billing/subscriptions[?orgId=]
// 在明确取得 orgId 时按接口规则携带；身份查询失败不得静默改查默认组织。
// 接口明确成功但无组织的个人账户，按经过验证的个人范围处理。
//
// 本轮删除的旧逻辑：
//   - PLAN_MONTHLY_CREDITS 静态套餐额度作为账务分母；
//   - /alpha/usage/summary 周期消费倒推月剩余。
//   `monthlyCredits` 是**剩余**（随用量递减），不是月度总额；没有接口提供上限／已用。
//
// 月度进度优先级（方案 4.4）：
//   已核实的服务端直接进度 > 按当前公开规则计算的进度 > 真实剩余或「进度暂不可得」。
// 公开规则读取器（lib/quota-reference/commandcode-monthly.js）不携带任何凭据，
// 失败或过期时**不清除**真实窗口与 credits，只是不再输出新的月度进度。
//
// 窗口契约：兼容根级或 credits 内 windowLimits，消费 used / limit|cap / remaining /
// reset|resetAt。不存在完整分母时仅展示实际返回字段；保留原始值，百分比可裁剪，
// 不篡改超额／加赠原值。月重置只认有效的账期结束，不把 currentPeriodStart 当重置。

import {
  STATUS, QueryError, httpJson, num, bool, safeInt, isoOrEpochMs, item, result, failure, failureFromError, isAbort,
} from "../provider-common.js";
import { loadTiers, computeMonthlyProgress } from "../quota-reference/commandcode-monthly.js";

export const ID = "commandcode";
export const API_BASE = "https://api.commandcode.ai";

export const METHOD_WINDOWS = "commandcode.windows.api-key";
export const METHOD_MONTHLY = "commandcode.monthly.public-rule";

const PLAN_NAMES = {
  "individual-go": "Go",
  "individual-goat": "GOAT",
  "individual-pro": "Pro",
  "individual-pro-v1": "Pro",
  "individual-provider": "Provider",
  "individual-max": "Max",
  "individual-ultra": "Ultra",
  "teams-pro": "Teams Pro",
};

/** 私有兼容来源的服务器地址规约（忽略路径）。 */
function deriveServer(baseUrl) {
  try {
    const url = new URL(String(baseUrl || "").trim());
    if (url.host) return `${url.protocol}//${url.host}`;
  } catch {
    /* 忽略非法地址 */
  }
  return API_BASE;
}

/** 业务响应中的显式失败（HTTP 200 下仍可能返回 success:false）。 */
function assertBusinessSuccess(body) {
  if (!body || typeof body !== "object") return;
  if (body.success === false) {
    const code = body.error?.code ?? "UNKNOWN";
    if (String(code).toUpperCase() === "UNAUTHORIZED") {
      throw new QueryError(STATUS.AUTH_REQUIRED, "Command Code 业务码 UNAUTHORIZED（key 无效）");
    }
    throw new QueryError(STATUS.SCHEMA_MISMATCH, `Command Code 业务错误 ${code}`);
  }
}

/**
 * 解析 windowLimits（根级或 credits 内），消费 used/limit|cap/remaining/reset|resetAt。
 * @returns Map<windowKey, {used, limit, remaining, resetAtMs, limited}>
 */
export function parseWindowLimits(root) {
  const limits = root?.windowLimits && typeof root.windowLimits === "object"
    ? root.windowLimits
    : (root?.credits?.windowLimits && typeof root.credits.windowLimits === "object" ? root.credits.windowLimits : null);
  const out = new Map();
  if (!limits) return out;
  const limited = bool(limits.limited);
  const aliases = { fiveHour: "5h 窗口", weekly: "周窗口" };
  for (const [key, label] of Object.entries(aliases)) {
    const w = limits[key];
    if (!w || typeof w !== "object") continue;
    const used = num(w.used);
    const limit = num(w.limit ?? w.cap);
    const remaining = num(w.remaining);
    if (used === null && limit === null && remaining === null) continue;
    const resetAtMs = isoOrEpochMs(w.reset ?? w.resetAt);
    out.set(key, { label, used, limit, remaining, resetAtMs, limited });
  }
  return out;
}

/** 解析订阅数据（data 对象）。 */
export function parseSubscription(body) {
  const data = body?.data;
  if (!data || typeof data !== "object") return null;
  return {
    status: typeof data.status === "string" ? data.status : null,
    planId: typeof data.planId === "string" ? data.planId : null,
    quantity: num(data.quantity),
    currentPeriodStart: isoOrEpochMs(data.currentPeriodStart),
    currentPeriodEnd: isoOrEpochMs(data.currentPeriodEnd),
  };
}

/** 解析 credits 对象。 */
export function parseCredits(body) {
  const credits = body?.credits;
  if (!credits || typeof credits !== "object") return null;
  return {
    // monthlyCredits 是服务端直接返回的月度**剩余**（随用量递减），不是总额
    monthlyRemaining: num(credits.monthlyCredits),
    monthlyGranted: num(credits.monthlyCreditsGranted),
    planId: typeof credits.planId === "string" ? credits.planId : null,
  };
}

/**
 * 由窗口数据构造结构化条目。
 * 分母不完整时只展示实际返回字段（百分比保持 null），不做任何推算。
 */
export function buildWindowItems(ctx, windows, planName) {
  const now = ctx.now ?? Date.now();
  const items = [];
  for (const [key, w] of windows) {
    const { used, limit, remaining, resetAtMs } = w;
    const hasDenominator = Number.isFinite(limit) && limit > 0;
    // 仅在分母有效且分子明确时计算百分比；缺失保持 null
    let usedPercent = null;
    if (hasDenominator && Number.isFinite(used)) usedPercent = (used / limit) * 100;
    else if (hasDenominator && Number.isFinite(remaining)) usedPercent = ((limit - remaining) / limit) * 100;
    else if (usedPercent === null) usedPercent = null;
    const notes = [];
    if (!hasDenominator) notes.push("服务端未提供完整分母，仅展示实际返回字段");
    if (resetAtMs === null) notes.push("未提供重置时刻");
    if (w.limited === false) notes.push("服务端标记为不限额");
    items.push(item({
      providerId: ID,
      methodId: METHOD_WINDOWS,
      itemId: `window.${key}`,
      scope: ctx.scope,
      kind: "window",
      label: planName ? `${w.label} · ${planName}` : w.label,
      raw: {
        limit: hasDenominator ? limit : null,
        used,
        remaining,
        unit: "USD",
        currency: "USD",
        scale: 1,
      },
      usedPercent,
      period: { description: `${w.label}（服务端窗口）` },
      resetAtMs,
      basis: "reported",
      fetchedAtMs: now,
      note: notes.join(" · "),
    }));
  }
  return items;
}

/**
 * 窗口查询（全部 HTTP）。
 * @returns 结构化结果；窗口与月度进度是两个独立结果
 */
export async function queryWindows(ctx) {
  const now = ctx.now ?? Date.now();
  try {
    if (!ctx.cfg?.apiKey) return failure(ID, METHOD_WINDOWS, STATUS.AUTH_REQUIRED, "未配置 API Key");
    const server = deriveServer(ctx.cfg.baseUrl);

    // 1) 身份：确认组织。auth 失败直接上抛；其他失败保留无组织状态
    let orgId = null;
    let orgResolved = false;
    try {
      const who = await httpJson(`${server}/alpha/whoami`, { key: ctx.cfg.apiKey, signal: ctx.signal, timeoutMs: ctx.timeoutMs });
      assertBusinessSuccess(who);
      orgId = typeof who?.org?.id === "string" && who.org.id ? who.org.id : null;
      orgResolved = true;
    } catch (error) {
      if (isAbort(error, ctx.signal)) throw error;
      if (error instanceof QueryError && error.status === STATUS.AUTH_REQUIRED) throw error;
    }
    // 身份查询失败：不静默改查默认组织（orgId 保持 null，接口按个人范围处理）

    const orgQuery = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
    const [creditsBody, subsBody] = await Promise.all([
      httpJson(`${server}/alpha/billing/credits${orgQuery}`, { key: ctx.cfg.apiKey, signal: ctx.signal, timeoutMs: ctx.timeoutMs }),
      httpJson(`${server}/alpha/billing/subscriptions${orgQuery}`, { key: ctx.cfg.apiKey, signal: ctx.signal, timeoutMs: ctx.timeoutMs }),
    ]);
    assertBusinessSuccess(creditsBody);
    assertBusinessSuccess(subsBody);

    const credits = parseCredits(creditsBody);
    const subscription = parseSubscription(subsBody);
    const planId = credits?.planId ?? subscription?.planId ?? null;
    const planName = PLAN_NAMES[planId] || planId || null;
    const windows = parseWindowLimits(creditsBody);
    const items = buildWindowItems({ ...ctx, now }, windows, planName);

    if (!items.length) {
      return failure(ID, METHOD_WINDOWS, STATUS.NO_DATA, orgResolved
        ? "Command Code 未返回可识别的窗口数据"
        : "Command Code 身份查询失败且未返回窗口数据");
    }
    return result({
      providerId: ID,
      methodId: METHOD_WINDOWS,
      status: STATUS.OK,
      items,
      fetchedAtMs: now,
      scope: { ...(ctx.scope || {}), orgId },
      notes: [orgId ? `组织 ${orgId}` : "未取得组织标识（按个人范围处理）"],
    });
  } catch (error) {
    if (isAbort(error, ctx.signal)) throw error;
    return failureFromError(ID, METHOD_WINDOWS, error, ctx.signal);
  }
}

/**
 * 月度进度查询：只有「有效订阅 + 有效账期 + 有效公开规则」同时成立才输出；
 * 否则返回进度暂不可得，同时**不**影响真实窗口数据。
 *
 * 该方法的调度间隔为 24 小时（公开规则缓存），凭据仅用于读取账户侧
 * monthlyCredits / 订阅状态；公开规则请求不携带任何凭据。
 */
export async function queryMonthly(ctx) {
  const now = ctx.now ?? Date.now();
  try {
    if (!ctx.cfg?.apiKey) return failure(ID, METHOD_MONTHLY, STATUS.AUTH_REQUIRED, "未配置 API Key");
    const server = deriveServer(ctx.cfg.baseUrl);

    // 账户侧数据：与窗口查询同源，但独立失败（这里重新取一次以保证方法自治；
    // 调度器按方法隔离缓存，共享响应由方法矩阵声明）
    let orgId = null;
    try {
      const who = await httpJson(`${server}/alpha/whoami`, { key: ctx.cfg.apiKey, signal: ctx.signal, timeoutMs: ctx.timeoutMs });
      assertBusinessSuccess(who);
      orgId = typeof who?.org?.id === "string" && who.org.id ? who.org.id : null;
    } catch (error) {
      if (isAbort(error, ctx.signal)) throw error;
      if (error instanceof QueryError && error.status === STATUS.AUTH_REQUIRED) throw error;
    }
    const orgQuery = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
    const [creditsBody, subsBody] = await Promise.all([
      httpJson(`${server}/alpha/billing/credits${orgQuery}`, { key: ctx.cfg.apiKey, signal: ctx.signal, timeoutMs: ctx.timeoutMs }),
      httpJson(`${server}/alpha/billing/subscriptions${orgQuery}`, { key: ctx.cfg.apiKey, signal: ctx.signal, timeoutMs: ctx.timeoutMs }),
    ]);
    assertBusinessSuccess(creditsBody);
    assertBusinessSuccess(subsBody);
    const credits = parseCredits(creditsBody);
    const subscription = parseSubscription(subsBody);
    if (!credits || !subscription) {
      return failure(ID, METHOD_MONTHLY, STATUS.NO_DATA, "Command Code 未返回账期或额度数据，月度进度暂不可得");
    }

    // 公开规则（无凭据）：失败/过期只影响本方法
    const tiers = await loadTiers({ signal: ctx.signal, now });
    if (!tiers) {
      return failure(ID, METHOD_MONTHLY, STATUS.NO_DATA, "公开套餐规则暂不可得，月度进度暂不可得（真实窗口不受影响）");
    }
    const tier = tiers.get(subscription.planId);
    if (!tier) {
      return failure(ID, METHOD_MONTHLY, STATUS.NO_DATA, `公开规则中没有套餐 ${subscription.planId ?? "(未知)"}，月度进度暂不可得`);
    }
    const progress = computeMonthlyProgress({ credits, subscription, tier, nowMs: now });
    if (!progress) {
      return failure(ID, METHOD_MONTHLY, STATUS.NO_DATA, "订阅或账期不满足计算前提，月度进度暂不可得");
    }
    const remaining = credits.monthlyRemaining;
    const total = progress.totalCredits ?? null;
    return result({
      providerId: ID,
      methodId: METHOD_MONTHLY,
      status: STATUS.OK,
      items: [item({
        providerId: ID,
        methodId: METHOD_MONTHLY,
        itemId: "monthly.progress",
        scope: { ...(ctx.scope || {}), orgId },
        kind: "window",
        label: `月度进度 · ${PLAN_NAMES[subscription.planId] || subscription.planId}`,
        raw: {
          limit: total,
          used: total !== null && Number.isFinite(remaining) ? total - remaining : null,
          remaining,
          unit: "USD",
          currency: "USD",
          scale: 1,
        },
        usedPercent: progress.usedPercent,
        period: {
          startMs: subscription.currentPeriodStart,
          endMs: subscription.currentPeriodEnd,
          description: "当前订阅账期（公开规则口径）",
        },
        resetAtMs: progress.resetsAtMs,
        basis: "public-rule",
        sourceUpdatedAtMs: progress.rulesFetchedAtMs ?? null,
        validUntilMs: progress.rulesValidUntilMs ?? null,
        fetchedAtMs: now,
        note: "按官网公开套餐规则计算；规则过期或前提不满足时不输出",
      })],
      fetchedAtMs: now,
      notes: [`规则来源 ${progress.ruleSource || ""}`.trim()],
    });
  } catch (error) {
    if (isAbort(error, ctx.signal)) throw error;
    return failureFromError(ID, METHOD_MONTHLY, error, ctx.signal);
  }
}

export const planNameOf = (planId) => PLAN_NAMES[planId] || planId || null;
export const safeIntValue = safeInt;
