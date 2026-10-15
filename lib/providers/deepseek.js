// lib/providers/deepseek.js — DeepSeek：官方多币种余额 + 控制台用量／费用
//
// 两个来源严格分离（方案 4.1）：
//   1) 官方余额：GET https://api.deepseek.com/user/balance（Bearer API Key）。
//      保留 balance_infos 的全部币种与 granted/topped_up 分项；非法币种或缺失必需金额
//      不转零、不默认换汇。余额是账户数据，不称为某个模型独享额度。
//   2) 控制台用量／费用：platform.deepseek.com 的私有接口，需要独立控制台会话。
//      用量与费用各自独立成功／失败；缺字段、失败与未知一律不变成 0。
//
// 时间单位：控制台接口参数与桶时间按已核对契约明确采用**秒**，内部统一毫秒；
// 不依靠数字大小猜测单位。

import {
  STATUS, QueryError, httpJson, num, item, result, failure, failureFromError, isAbort,
  epochMs, secondsToMs, safeInt, formatResetText,
} from "../provider-common.js";

export const ID = "deepseek";
export const CONSOLE_URL = "https://platform.deepseek.com/usage";

const OFFICIAL_HOSTS = ["api.deepseek.com"];
const OFFICIAL_BASE_PATHS = ["", "/v1"];

/** 校验官方余额端点（https + 默认端口 + 无 userinfo/query/hash + 主机与基础路径白名单）。 */
export function officialOrigin(baseUrl) {
  const fallback = { origin: null, error: new QueryError(STATUS.SCHEMA_MISMATCH, `Base URL 需为官方 HTTPS 地址（${OFFICIAL_HOSTS.join(" / ")}）`) };
  try {
    const url = new URL(String(baseUrl || "").trim() || "https://api.deepseek.com");
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

/**
 * 官方余额查询。
 * @param ctx.cfg.apiKey 普通 API Key
 * @returns 结构化结果：每个币种一个 balance 项
 */
export async function queryBalance(ctx) {
  const methodId = "deepseek.balance.api-key";
  try {
    if (!ctx.cfg?.apiKey) return failure(ID, methodId, STATUS.AUTH_REQUIRED, "未配置 API Key");
    const { origin, error } = officialOrigin(ctx.cfg.baseUrl);
    if (error) return failure(ID, methodId, error.status, error.message);

    const body = await httpJson(`${origin}/user/balance`, {
      key: ctx.cfg.apiKey,
      auth: "bearer",
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
    });
    if (!body || typeof body !== "object") {
      return failure(ID, methodId, STATUS.SCHEMA_MISMATCH, "余额接口未返回数据");
    }
    const infos = Array.isArray(body.balance_infos) ? body.balance_infos : [];
    if (!infos.length) return failure(ID, methodId, STATUS.SCHEMA_MISMATCH, "余额接口未返回 balance_infos");

    const items = [];
    const now = ctx.now ?? Date.now();
    for (const info of infos) {
      if (!info || typeof info !== "object") continue;
      const currency = typeof info.currency === "string" && info.currency ? info.currency.toUpperCase() : null;
      if (!currency) {
        // 币种缺失无法把金额放入任何币种，属于结构不兼容（不猜 CNY）
        return failure(ID, methodId, STATUS.SCHEMA_MISMATCH, "余额条目缺少币种");
      }
      const total = num(info.total_balance);
      if (total === null) return failure(ID, methodId, STATUS.SCHEMA_MISMATCH, `余额条目缺少 ${currency} 总额`);
      const granted = num(info.granted_balance);
      const topped = num(info.topped_up_balance);
      const notes = [];
      if (topped !== null) notes.push(`到账 ${topped} ${currency}`);
      if (granted !== null) notes.push(`赠送 ${granted} ${currency}`);
      items.push(item({
        providerId: ID,
        methodId,
        itemId: `balance.${currency}`,
        scope: ctx.scope,
        kind: "balance",
        label: `余额 · ${currency}`,
        raw: { limit: null, used: null, remaining: total, unit: currency, currency, scale: 1 },
        usedPercent: null,
        period: { description: "账户可用余额（全部币种独立保留）" },
        basis: "reported",
        fetchedAtMs: now,
        note: notes.join(" · "),
      }));
    }
    if (!items.length) return failure(ID, methodId, STATUS.SCHEMA_MISMATCH, "余额接口未返回可用数据");
    const available = body.is_available;
    return result({
      providerId: ID,
      methodId,
      status: STATUS.OK,
      items,
      fetchedAtMs: now,
      notes: [typeof available === "boolean" ? `is_available=${available}` : null].filter(Boolean),
    });
  } catch (error) {
    return failureFromError(ID, methodId, error, ctx.signal);
  }
}

// ---------- 控制台用量／费用的解析（纯函数，便于固定样本测试） ----------

/**
 * 解析控制台 amount 响应。
 * @param body        JSON（data.biz_data.series[].buckets[]）
 * @param range       { startSec, endSec }（请求使用的秒范围，用于桶校验）
 * @returns { byModel: Map<model, {cacheHit, cacheMiss, response, request}>, bucketCount }
 * @throws QueryError(schema-mismatch) 结构不兼容或桶越界
 */
export function parseConsoleAmount(body, range) {
  const biz = body?.data?.biz_data;
  if (!biz || typeof biz !== "object") throw new QueryError(STATUS.SCHEMA_MISMATCH, "控制台用量响应缺少 data.biz_data");
  const series = Array.isArray(biz.series) ? biz.series : null;
  if (!series) throw new QueryError(STATUS.SCHEMA_MISMATCH, "控制台用量响应缺少 series");
  const byModel = new Map();
  let bucketCount = 0;
  for (const entry of series) {
    if (!entry || typeof entry !== "object") continue;
    const model = typeof entry.model === "string" && entry.model ? entry.model : "未分模型";
    const buckets = Array.isArray(entry.buckets) ? entry.buckets : [];
    const acc = byModel.get(model) || { cacheHit: 0, cacheMiss: 0, response: 0, request: 0 };
    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== "object") continue;
      const bucketMs = secondsToMs(bucket.time);
      if (bucketMs === null) throw new QueryError(STATUS.SCHEMA_MISMATCH, "控制台用量桶缺少有效时间");
      // 桶必须落在请求范围内：越界说明页面默认范围大于请求范围，不做硬裁剪冒充汇总
      if (!bucketInRange(bucketMs, range)) {
        throw new QueryError(STATUS.SCHEMA_MISMATCH, "控制台用量返回了请求范围以外的时间桶");
      }
      const usage = bucket.usage;
      if (!usage || typeof usage !== "object") throw new QueryError(STATUS.SCHEMA_MISMATCH, "控制台用量桶缺少 usage");
      const hit = num(usage.PROMPT_CACHE_HIT_TOKEN);
      const miss = num(usage.PROMPT_CACHE_MISS_TOKEN);
      const resp = num(usage.RESPONSE_TOKEN);
      const req = num(usage.REQUEST);
      if (hit === null || miss === null || resp === null || req === null) {
        throw new QueryError(STATUS.SCHEMA_MISMATCH, `控制台用量桶缺少必需字段（${model}）`);
      }
      acc.cacheHit += hit;
      acc.cacheMiss += miss;
      acc.response += resp;
      acc.request += req;
      bucketCount++;
    }
    byModel.set(model, acc);
  }
  return { byModel, bucketCount };
}

/**
 * 解析控制台 cost 响应。
 * @returns { byModel: Map<model, cost>, bucketCount }（cost 为该统计范围内的费用合计）
 */
export function parseConsoleCost(body, range) {
  const biz = body?.data?.biz_data;
  if (!biz || typeof biz !== "object") throw new QueryError(STATUS.SCHEMA_MISMATCH, "控制台费用响应缺少 data.biz_data");
  const groups = Array.isArray(biz.data) ? biz.data : null;
  if (!groups) throw new QueryError(STATUS.SCHEMA_MISMATCH, "控制台费用响应缺少 biz_data.data");
  const byModel = new Map();
  let bucketCount = 0;
  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const series = Array.isArray(group.series) ? group.series : [];
    for (const entry of series) {
      if (!entry || typeof entry !== "object") continue;
      const model = typeof entry.model === "string" && entry.model ? entry.model : "未分模型";
      const buckets = Array.isArray(entry.buckets) ? entry.buckets : [];
      let sum = byModel.get(model) || 0;
      for (const bucket of buckets) {
        if (!bucket || typeof bucket !== "object") continue;
        const bucketMs = secondsToMs(bucket.time);
        if (bucketMs === null) throw new QueryError(STATUS.SCHEMA_MISMATCH, "控制台费用桶缺少有效时间");
        if (!bucketInRange(bucketMs, range)) {
          throw new QueryError(STATUS.SCHEMA_MISMATCH, "控制台费用返回了请求范围以外的时间桶");
        }
        const cost = num(bucket.cost);
        if (cost === null) throw new QueryError(STATUS.SCHEMA_MISMATCH, "控制台费用桶缺少 cost");
        sum += cost;
        bucketCount++;
      }
      byModel.set(model, sum);
    }
  }
  return { byModel, bucketCount };
}

function bucketInRange(bucketMs, range) {
  if (!range) return true;
  return bucketMs >= range.startMs && bucketMs <= range.endMs;
}

/**
 * 由控制台捕获结果构造用量／费用两个**独立**的结构化结果。
 * @param captured { amount, cost, range, timeZone, tzOffsetSeconds }
 * @returns { usage, cost }（任一为 null 表示该项没有数据／失败）
 */
export function buildConsoleResults(ctx, captured) {
  const now = ctx.now ?? Date.now();
  const scope = { ...(ctx.scope || {}), accountId: null };
  const period = {
    startMs: captured.range.startMs,
    endMs: captured.range.endMs,
    timeZone: captured.timeZone,
    granularity: captured.granularity ?? null,
    description: captured.rangeDescription ?? null,
  };
  let usage = null;
  let cost = null;
  if (captured.amountError) {
    usage = failure(ID, "deepseek.console-usage.console-session", captured.amountError.status, captured.amountError.message);
  } else if (captured.amount) {
    let parsed;
    try {
      parsed = parseConsoleAmount(captured.amount, captured.range);
    } catch (error) {
      usage = failureFromError(ID, "deepseek.console-usage.console-session", error);
    }
    if (!parsed) {
      // 已在上面记录失败
    } else if (!parsed.bucketCount) {
      usage = failure(ID, "deepseek.console-usage.console-session", STATUS.NO_DATA, "控制台用量在所选范围内没有数据桶");
    } else {
      const items = [];
      let totalTokens = 0;
      let totalRequests = 0;
      for (const [model, acc] of parsed.byModel) {
        const tokens = acc.cacheHit + acc.cacheMiss + acc.response;
        totalTokens += tokens;
        totalRequests += acc.request;
        items.push(item({
          providerId: ID,
          methodId: "deepseek.console-usage.console-session",
          itemId: `usage.${model}`,
          scope,
          kind: "usage",
          label: `用量 · ${model}`,
          raw: { limit: null, used: tokens, remaining: null, unit: "tokens", scale: 1 },
          usedPercent: null,
          period,
          basis: "reported",
          fetchedAtMs: now,
          note: `缓存命中 ${acc.cacheHit} · 缓存未命中 ${acc.cacheMiss} · 输出 ${acc.response} · 请求 ${acc.request}`,
        }));
      }
      items.unshift(item({
        providerId: ID,
        methodId: "deepseek.console-usage.console-session",
        itemId: "usage.total",
        scope,
        kind: "usage",
        label: "控制台用量（合计）",
        raw: { limit: null, used: totalTokens, remaining: null, unit: "tokens", scale: 1 },
        usedPercent: null,
        period,
        basis: "reported",
        fetchedAtMs: now,
        note: `请求数 ${totalRequests} · 缓存命中／未命中／输出分别保留`,
      }));
      usage = result({ providerId: ID, methodId: "deepseek.console-usage.console-session", status: STATUS.OK, items, fetchedAtMs: now });
    }
  } else {
    usage = failure(ID, "deepseek.console-usage.console-session", STATUS.NO_DATA, "控制台未返回用量数据");
  }

  if (captured.costError) {
    cost = failure(ID, "deepseek.console-cost.console-session", captured.costError.status, captured.costError.message);
  } else if (captured.cost) {
    let parsed = null;
    try {
      parsed = parseConsoleCost(captured.cost, captured.range);
    } catch (error) {
      cost = failureFromError(ID, "deepseek.console-cost.console-session", error);
    }
    if (!cost) {
      if (!parsed || !parsed.bucketCount) {
        cost = failure(ID, "deepseek.console-cost.console-session", STATUS.NO_DATA, "控制台费用在所选范围内没有数据桶");
      } else {
        const items = [];
        let total = 0;
        for (const [model, amount] of parsed.byModel) {
          total += amount;
          items.push(item({
            providerId: ID,
            methodId: "deepseek.console-cost.console-session",
            itemId: `cost.${model}`,
            scope,
            kind: "cost",
            label: `费用 · ${model}`,
            raw: { limit: null, used: amount, remaining: null, unit: "CNY", currency: "CNY", scale: 1 },
            usedPercent: null,
            period,
            basis: "reported",
            fetchedAtMs: now,
            note: "控制台报告费用（可能延迟）",
          }));
        }
        items.unshift(item({
          providerId: ID,
          methodId: "deepseek.console-cost.console-session",
          itemId: "cost.total",
          scope,
          kind: "cost",
          label: "控制台费用（合计）",
          raw: { limit: null, used: total, remaining: null, unit: "CNY", currency: "CNY", scale: 1 },
          usedPercent: null,
          period,
          basis: "reported",
          fetchedAtMs: now,
          note: "控制台报告费用（可能延迟）",
        }));
        cost = result({ providerId: ID, methodId: "deepseek.console-cost.console-session", status: STATUS.OK, items, fetchedAtMs: now });
      }
    }
  } else {
    cost = failure(ID, "deepseek.console-cost.console-session", STATUS.NO_DATA, "控制台未返回费用数据");
  }
  return { usage, cost };
}

/**
 * 请求范围：按实际配置的统计时区生成「今日」[start, end]。
 * 明确携带时区标识与偏移，绝不把页面默认范围称为「今日」。
 * @param nowMs   当前时刻（毫秒）
 * @param offsetSeconds 统计时区相对 UTC 的偏移（秒）
 */
export function todayRange(nowMs, offsetSeconds, timeZone) {
  const offsetMs = offsetSeconds * 1000;
  const local = nowMs + offsetMs;
  const dayStartLocal = Math.floor(local / 86_400_000) * 86_400_000;
  const startMs = dayStartLocal - offsetMs;
  return {
    startMs,
    endMs: nowMs,
    startSec: Math.floor(startMs / 1000),
    endSec: Math.floor(nowMs / 1000),
    timeZone: timeZone || `UTC${offsetSeconds >= 0 ? "+" : "-"}${Math.abs(offsetSeconds / 3600)}`,
  };
}

/**
 * 控制台用量／费用查询（需要插件专用浏览器会话）。
 *
 * 用量与费用是**两个独立方法**，各自成功／失败：缺字段、失败与未知一律不变成 0。
 * 两者由同一次页面读取产出（同一个 start/end/tz 范围），避免重复取数。
 * 读取脚本来自桥接的固定读取器注册表；这里只提供业务上必要的统计范围参数。
 *
 * ctx.console 由 lib/runtime/console-bridge.js 提供；缺少浏览器时返回
 * environment-unavailable，不影响该供应商的 HTTP 余额方法。
 * @param ctx.cfg.statisticsTimeZone 可选 IANA 时区名（仅作展示标注）
 * @param ctx.now 注入时钟（测试）
 * @param ctx.utcOffsetMinutes 统计时区相对 UTC 的偏移（分钟）；缺省用宿主时区
 */
async function readConsole(ctx) {
  if (!ctx.console) {
    throw new QueryError(STATUS.ENVIRONMENT_UNAVAILABLE, "当前环境没有可用的浏览器会话（DeepSeek 控制台需要登录）");
  }
  const nowMs = ctx.now ?? Date.now();
  // 统计时区：优先显式注入（宿主可配置），否则用宿主运行时偏移。
  // 绝不假定「访问网页的人」所在时区等于远端宿主时区。
  const offsetMinutes = Number.isFinite(ctx.utcOffsetMinutes)
    ? ctx.utcOffsetMinutes
    : -new Date(nowMs).getTimezoneOffset();
  const range = todayRange(nowMs, offsetMinutes * 60, ctx.cfg?.statisticsTimeZone);
  const observation = await ctx.console.read("deepseek-usage", {
    startSec: range.startSec,
    endSec: range.endSec,
    tzSec: offsetMinutes * 60,
    signal: ctx.signal,
    timeoutMs: ctx.timeoutMs,
  });
  if (!observation || typeof observation !== "object") {
    throw new QueryError(STATUS.SCHEMA_MISMATCH, "控制台读取器未返回数据");
  }
  if (observation.state !== "ready") {
    const map = {
      auth: [STATUS.AUTH_REQUIRED, "DeepSeek 控制台会话尚未登录或已失效"],
      network: [STATUS.NETWORK_ERROR, "DeepSeek 控制台请求失败"],
    };
    const [status, message] = map[observation.state] || [STATUS.SCHEMA_MISMATCH, "DeepSeek 控制台响应结构不匹配"];
    throw new QueryError(status, message);
  }
  const { usage, cost } = buildConsoleResults(
    { now: nowMs, scope: ctx.scope },
    {
      ...consoleCapture(observation.amount, observation.cost),
      range: { startMs: range.startMs, endMs: range.endMs },
      timeZone: range.timeZone,
      granularity: "bucket",
      rangeDescription: `控制台统计范围 ${new Date(range.startMs).toISOString()} → ${new Date(range.endMs).toISOString()}（时区 ${range.timeZone}）`,
    },
  );
  return { usage, cost, range };
}

/**
 * 把页面读取结果拆成「原始响应体 / 明确错误」两部分，供 buildConsoleResults 分别消费。
 * 用量与费用互相独立：一侧 401/失败不牵连另一侧。
 */
export function consoleCapture(amountResult, costResult) {
  const classify = (result, label) => {
    if (!result || typeof result !== "object") {
      return { body: null, error: { status: STATUS.NETWORK_ERROR, message: `控制台${label}未返回响应` } };
    }
    const status = Number(result.status) || 0;
    const body = typeof result.body === "string" ? result.body : "";
    if (status === 401 || status === 403) {
      return { body: null, error: { status: STATUS.AUTH_REQUIRED, message: `控制台${label}会话失效（HTTP ${status}）` } };
    }
    if (status === 429) {
      return { body: null, error: { status: STATUS.RATE_LIMITED, message: `控制台${label}请求过于频繁` } };
    }
    if (status === 0) {
      return { body: null, error: { status: STATUS.NETWORK_ERROR, message: `控制台${label}请求失败` } };
    }
    if (status < 200 || status >= 300) {
      return { body: null, error: { status: STATUS.SCHEMA_MISMATCH, message: `控制台${label} HTTP ${status}` } };
    }
    if (!body || body === "{}") {
      return { body: null, error: { status: STATUS.NO_DATA, message: `控制台${label}在所选范围内没有数据` } };
    }
    try {
      return { body: JSON.parse(body), error: null };
    } catch {
      return { body: null, error: { status: STATUS.SCHEMA_MISMATCH, message: `控制台${label}响应不是有效 JSON` } };
    }
  };
  const a = classify(amountResult, "用量");
  const c = classify(costResult, "费用");
  return { amount: a.body, amountError: a.error, cost: c.body, costError: c.error };
}

/** 控制台用量方法（独立失败）。 */
export async function queryConsoleUsage(ctx) {
  const methodId = "deepseek.console-usage.console-session";
  try {
    const { usage } = await readConsole(ctx);
    return usage;
  } catch (error) {
    if (isAbort(error, ctx.signal)) throw error;
    return failureFromError(ID, methodId, error, ctx.signal);
  }
}

/** 控制台费用方法（独立失败）。 */
export async function queryConsoleCost(ctx) {
  const methodId = "deepseek.console-cost.console-session";
  try {
    const { cost } = await readConsole(ctx);
    return cost;
  } catch (error) {
    if (isAbort(error, ctx.signal)) throw error;
    return failureFromError(ID, methodId, error, ctx.signal);
  }
}

/**
 * 控制台读取脚本（随包发布的固定代码，不接受前端传入 URL／JS）。
 * 在 platform.deepseek.com 页面上下文内用 XHR 读取两个固定路径，
 * 只回传状态码与响应体文本；cookie 与会话不离开浏览器。
 */
export function consoleReadScript(nonce, { startSec, endSec, tzSec }) {
  const amountPath = `/api/v0/usage/by_api_key/amount?start=${startSec}&end=${endSec}&tz=${tzSec}`;
  const costPath = `/api/v0/usage/by_api_key/cost?start=${startSec}&end=${endSec}&tz=${tzSec}`;
  return `(() => {
  const nonce = ${JSON.stringify(nonce)};
  const send = (value) => window.__dshConsoleRead.post(nonce, value);
  const read = (path) => new Promise((resolve) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', path, true);
      xhr.withCredentials = true;
      xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
      xhr.onerror = () => resolve({ status: 0, body: '' });
      xhr.ontimeout = () => resolve({ status: 0, body: '' });
      xhr.timeout = 15000;
      xhr.send();
    } catch (error) { resolve({ status: 0, body: '' }); }
  });
  (async () => {
    if (location.origin !== 'https://platform.deepseek.com') return send({ state: 'auth' });
    const amount = await read(${JSON.stringify(amountPath)});
    const cost = await read(${JSON.stringify(costPath)});
    send({ state: 'ready', amount, cost });
  })();
})();`;
}

/** 展示用：重置文本（沿用既有语义）。 */
export const resetText = formatResetText;
