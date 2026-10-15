// lib/providers/openrouter.js — OpenRouter：当前 Key 额度／今日费用 + 账户 credits
//
// 两类凭据严格隔离（方案 4.2）：
//   - openrouter（普通 API Key）：GET /api/v1/key。一次响应同时产出「周期额度」与
//     「UTC 今日费用」，两个能力复用同一次请求，不重复发相同请求。
//     周期已用 = 明确的上限 − 剩余；不把终身 usage 配到月额度，不叠加 BYOK 推算消费。
//   - openrouter-account（Management Key）：GET /api/v1/credits。
//     账户剩余 = total_credits − total_usage。不从 Key 前缀推断权限，
//     普通推理 Key 不自动升级为管理凭据；两类凭据不互相尝试。
//
// 状态区分：无上限（服务方明确表示无限）／未返回额度／0 剩余是三种不同状态。
// 周期名称不是精确重置时刻，不自行生成倒计时。

import {
  STATUS, QueryError, httpJson, num, item, result, failure, failureFromError, sharedResponse,
} from "../provider-common.js";

export const ID = "openrouter";
export const ACCOUNT_ID = "openrouter-account";

const OFFICIAL_HOSTS = ["openrouter.ai"];
const OFFICIAL_BASE_PATHS = ["", "/api", "/api/v1"];

export function officialOrigin(baseUrl) {
  const fallback = { origin: null, error: new QueryError(STATUS.SCHEMA_MISMATCH, `Base URL 需为官方 HTTPS 地址（${OFFICIAL_HOSTS.join(" / ")}）`) };
  try {
    const url = new URL(String(baseUrl || "").trim() || "https://openrouter.ai/api/v1");
    if (url.protocol !== "https:") return fallback;
    if (url.port && url.port !== "443") return fallback;
    if (url.username || url.password || url.search || url.hash) return fallback;
    if (!OFFICIAL_HOSTS.includes(url.hostname.toLowerCase())) return fallback;
    const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    if (!OFFICIAL_BASE_PATHS.includes(basePath)) return fallback;
    return { origin: url.origin, error: null };
  } catch {
    return fallback;
  }
}

const PERIOD_LABEL = { daily: "每日重置", weekly: "每周重置", monthly: "每月重置" };

export const METHOD_QUOTA = "openrouter.key-quota.api-key";
export const METHOD_DAILY_COST = "openrouter.daily-cost.api-key";
export const METHOD_CREDITS = "openrouter.credits.management-key";

/**
 * 当前 Key 查询：一次 GET /api/v1/key 产出额度与今日费用两个能力。
 * @returns { quota, dailyCost } 两个独立的结构化结果（取消时原样上抛）
 */
export async function queryKey(ctx) {
  const now = ctx.now ?? Date.now();
  try {
    if (!ctx.cfg?.apiKey) {
      const off = () => failure(ID, METHOD_QUOTA, STATUS.AUTH_REQUIRED, "未配置 API Key");
      return { quota: off(), dailyCost: failure(ID, METHOD_DAILY_COST, STATUS.AUTH_REQUIRED, "未配置 API Key") };
    }
    const { origin, error } = officialOrigin(ctx.cfg.baseUrl);
    if (error) {
      return {
        quota: failure(ID, METHOD_QUOTA, error.status, error.message),
        dailyCost: failure(ID, METHOD_DAILY_COST, error.status, error.message),
      };
    }
    // 额度与今日费用共享同一响应：一次 /api/v1/key 请求产出两个能力。
    // 共享键含端点与凭据的 opaque 标识（长度 + 末尾片段，不可逆推出密钥），
    // 不同 Key 之间绝不串用；失败不保留，下一个调用者会重新尝试。
    const credentialTag = `${ctx.cfg.apiKey.length}:${ctx.cfg.apiKey.slice(-6)}`;
    const body = await sharedResponse(
      `openrouter:key:${origin}:${credentialTag}`,
      () => httpJson(`${origin}/api/v1/key`, {
        key: ctx.cfg.apiKey,
        auth: "bearer",
        signal: ctx.signal,
        timeoutMs: ctx.timeoutMs,
      }),
    );
    const data = body?.data;
    if (!data || typeof data !== "object") {
      const message = "OpenRouter 响应缺少 data";
      return {
        quota: failure(ID, METHOD_QUOTA, STATUS.SCHEMA_MISMATCH, message),
        dailyCost: failure(ID, METHOD_DAILY_COST, STATUS.SCHEMA_MISMATCH, message),
      };
    }

    // ---- 周期额度 ----
    const limit = num(data.limit);
    const remaining = num(data.limit_remaining);
    const isFreeTier = data.is_free_tier === true;
    const items = [];
    let quotaStatus = STATUS.OK;
    let quotaError = null;
    if (limit === null && remaining === null) {
      // 未返回额度字段：保持未知（不是 0，也不假定无限）
      items.push(item({
        providerId: ID,
        methodId: METHOD_QUOTA,
        itemId: "quota.unknown",
        scope: ctx.scope,
        kind: "balance",
        label: "周期额度",
        raw: { limit: null, used: null, remaining: null, unit: "USD", currency: "USD", scale: 1 },
        usedPercent: null,
        basis: "reported",
        fetchedAtMs: now,
        status: STATUS.NO_DATA,
        note: "服务方未返回额度上限与剩余；未知不等于无限或 0",
      }));
      quotaStatus = STATUS.NO_DATA;
      quotaError = { code: STATUS.NO_DATA, message: "OpenRouter 未报告额度字段" };
    } else {
      if (limit !== null && limit < 0) return {
        quota: failure(ID, METHOD_QUOTA, STATUS.SCHEMA_MISMATCH, "OpenRouter 额度上限无效"),
        dailyCost: dailyCostResult(ctx, data, now),
      };
      const resetKey = typeof data.limit_reset === "string" ? data.limit_reset : null;
      const periodLabel = resetKey && PERIOD_LABEL[resetKey] ? PERIOD_LABEL[resetKey] : null;
      // 已用只在「上限 + 剩余」都明确时计算；不推算。
      const used = limit !== null && remaining !== null ? Math.max(0, limit - remaining) : null;
      const unlimited = limit === null && remaining !== null;
      items.push(item({
        providerId: ID,
        methodId: METHOD_QUOTA,
        itemId: "quota.period",
        scope: ctx.scope,
        kind: "balance",
        label: periodLabel ? `周期额度 · ${periodLabel}` : "周期额度",
        raw: { limit, used, remaining, unit: "USD", currency: "USD", scale: 1 },
        // 不显式给 usedPercent：由 item() 在「上限 + 已用」都有效时推导，
        // 上限未知（无限额度未标注）时自然保持 null。
        period: { description: periodLabel ? `服务方声明的周期：${periodLabel}` : "服务方定义的周期" },
        basis: "reported",
        fetchedAtMs: now,
        note: [
          unlimited ? "服务方未返回上限（不视为无限）" : null,
          resetKey ? `周期标识 ${resetKey}（非精确重置时刻）` : null,
          isFreeTier ? "免费额度 Key" : null,
        ].filter(Boolean).join(" · "),
      }));
    }

    return { quota: result({ providerId: ID, methodId: METHOD_QUOTA, status: quotaStatus, items, error: quotaError, fetchedAtMs: now }),
      dailyCost: dailyCostResult(ctx, data, now) };
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    const failed = failureFromError(ID, METHOD_QUOTA, error, ctx.signal);
    return {
      quota: failed,
      dailyCost: failure(ID, METHOD_DAILY_COST, failed.status, failed.error?.message || "OpenRouter 查询失败"),
    };
  }
}

/** UTC 今日报告费用（usage_daily）；不把终身 usage 配到月额度。 */
function dailyCostResult(ctx, data, now) {
  const usageDaily = num(data.usage_daily);
  if (usageDaily === null) {
    return failure(ID, METHOD_DAILY_COST, STATUS.NO_DATA, "OpenRouter 未报告今日费用（usage_daily）");
  }
  return result({
    providerId: ID,
    methodId: METHOD_DAILY_COST,
    status: STATUS.OK,
    items: [item({
      providerId: ID,
      methodId: METHOD_DAILY_COST,
      itemId: "cost.today",
      scope: ctx.scope,
      kind: "cost",
      label: "今日费用",
      raw: { limit: null, used: usageDaily, remaining: null, unit: "USD", currency: "USD", scale: 1 },
      usedPercent: null,
      period: { timeZone: "UTC", granularity: "day", description: "当前 Key · UTC 今日报告费用" },
      basis: "reported",
      fetchedAtMs: now,
      note: "UTC 今日；汇报可能有延迟",
    })],
    fetchedAtMs: now,
  });
}

/** 账户 credits（Management Key）：total_credits − total_usage。 */
export async function queryCredits(ctx) {
  const now = ctx.now ?? Date.now();
  try {
    if (!ctx.cfg?.apiKey) return failure(ACCOUNT_ID, METHOD_CREDITS, STATUS.AUTH_REQUIRED, "未配置 Management Key");
    const { origin, error } = officialOrigin(ctx.cfg.baseUrl);
    if (error) return failure(ACCOUNT_ID, METHOD_CREDITS, error.status, error.message);
    const body = await httpJson(`${origin}/api/v1/credits`, {
      key: ctx.cfg.apiKey,
      auth: "bearer",
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
    });
    const data = body?.data;
    if (!data || typeof data !== "object") return failure(ACCOUNT_ID, METHOD_CREDITS, STATUS.SCHEMA_MISMATCH, "OpenRouter credits 响应缺少 data");
    const credits = num(data.total_credits);
    const used = num(data.total_usage);
    if (credits === null || used === null) {
      return failure(ACCOUNT_ID, METHOD_CREDITS, STATUS.SCHEMA_MISMATCH, "OpenRouter credits 缺少数值字段");
    }
    const remain = credits - used;
    return result({
      providerId: ACCOUNT_ID,
      methodId: METHOD_CREDITS,
      status: STATUS.OK,
      items: [item({
        providerId: ACCOUNT_ID,
        methodId: METHOD_CREDITS,
        itemId: "credits.account",
        scope: ctx.scope,
        kind: "balance",
        label: "账户 credits",
        raw: { limit: credits, used, remaining: remain, unit: "USD", currency: "USD", scale: 1 },
        usedPercent: null,
        period: { description: "平台账户累计（非上游模型厂商账户）" },
        basis: "arithmetic",
        fetchedAtMs: now,
        note: "管理密钥 · total_credits − total_usage",
      })],
      fetchedAtMs: now,
    });
  } catch (error) {
    return failureFromError(ACCOUNT_ID, METHOD_CREDITS, error, ctx.signal);
  }
}
