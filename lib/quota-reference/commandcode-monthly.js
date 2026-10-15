// lib/quota-reference/commandcode-monthly.js — Command Code 公开套餐规则读取与月度进度
//
// 职责（方案 4.4、T05）：只读官网公开资源，得到「官网口径」的月度进度参考值。
//   - 数据来源：GET https://commandcode.ai/signin 页 → 唯一 /assets/plan-tiers-*.js → 该脚本；
//   - **绝不发送任何凭据**：本模块不接收、不使用 API Key；账户数据由 providers 侧提供；
//   - **绝不执行下载的 JavaScript**：没有 eval／new Function／import()／vm，只做数据字面量解析；
//   - 一个有界正则 + 有界输入（单资源上限 4 MB，记录数上限），不做无界回溯式解析。
//
// 三条不可越过的底线：
//   1) 月度进度只在「有效订阅 + 有效账期 + 有效公开套餐规则」同时成立时计算，否则返回 null；
//      绝不使用硬编码月额度，也绝不用「套餐总额 − 周期消费」倒推剩余。
//   2) 公开规则失败／过期时返回 null，且只影响本模块缓存；账户窗口与 credits 原样保留
//      （调用方应继续展示服务端直接报告的窗口与月度剩余）。
//   3) 计算结果是「公开规则计算」，basis 固定为 'public-rule'，必须与服务端直接报告
//      （basis: 'reported'）区分，不得混为同一来源。

import { STATUS, QueryError, httpText, num, isoOrEpochMs, isAbort } from "../provider-common.js";

/** 公开规则页面（无凭据）。 */
export const RULE_SOURCE = "https://commandcode.ai/signin";

/** 公开站点来源（资产路径只允许拼在该来源之后）。 */
export const SITE_ORIGIN = "https://commandcode.ai";

/**
 * 套餐资源路径匹配（plan-tiers-*.js）。
 * 故意不带 g 标志：导出对象保持无状态（不依赖 lastIndex），调用方 .test()／.match() 均安全；
 * 内部遍历时由源码重新构造带 g 的正则。
 */
export const ASSET_PATTERN = /\/assets\/plan-tiers-[A-Za-z0-9_-]{1,64}\.js/;

/** 单资源上限 4 MB（与 httpText 的 maxBytes 同值；超限即 schema-mismatch，不静默截断）。 */
export const MAX_ASSET_BYTES = 4 * 1024 * 1024;

/** 规则成功缓存 24 小时；失败后退避 5 分钟（退避期间不再请求公开站点）。 */
export const RULES_TTL_MS = 24 * 3600_000;
export const RULES_RETRY_MS = 5 * 60_000;

/** 单次解析允许的最大套餐记录数（防止异常脚本拖长解析）。 */
const MAX_TIER_RECORDS = 200;

/**
 * 公开规则口径的额度单位（官网按 USD 计价的 usage-value credits）。
 * 这是「规则分母」的单位，与服务端窗口直接返回的原始值单位无关。
 */
export const CREDIT_UNIT = "USD";

/** 数值字面量（十进制，可有小数与指数）。 */
const NUMBER_LITERAL = "[0-9]+(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?";

/**
 * 套餐记录模式（对应官网 plan-tiers 脚本里的对象字面量）：
 *   id:"...",name:"...",type:"individual|org", …（≤1500 字符的其它字段）… ,
 *   limits:{premiumCredits:N,opensourceCredits:N,totalCredits:N,
 * 所有量词都有显式上界，且 [^{}] 互斥于 {}，无嵌套回溯路径。
 */
const TIER_RECORD_PATTERN = "id:\"(?<id>[a-z0-9][a-z0-9-]{0,79})\",name:\"[^\"]{0,100}\",type:\"(?<type>individual|org)\","
  + "[^{}]{0,1500}?limits:\\{premiumCredits:(?<premium>" + NUMBER_LITERAL + "),opensourceCredits:(?<open>"
  + NUMBER_LITERAL + "),totalCredits:(?<total>" + NUMBER_LITERAL + "),";

/** 解析结果的数值边界（与参考实现一致）。 */
const MAX_CREDITS = 1_000_000;

// ---------- 纯函数：页面 → 资源路径 ----------

/**
 * 从 signin 页面 HTML 中取出唯一的 plan-tiers 脚本路径。
 * @throws QueryError(SCHEMA_MISMATCH) 0 个或多个候选（不猜测、不取第一个）
 */
export function assetPathFromHtml(html) {
  if (typeof html !== "string" || !html) {
    throw new QueryError(STATUS.SCHEMA_MISMATCH, "Command Code 公开规则页面为空");
  }
  const scanner = new RegExp(ASSET_PATTERN.source, "g");
  const found = new Set();
  let match;
  let steps = 0;
  // 输入长度已有界（≤4 MB），匹配数另有上界；正则本身线性，无灾难性回溯。
  while ((match = scanner.exec(html)) !== null) {
    found.add(match[0]);
    if (found.size > 1 || ++steps > 64) break;
  }
  if (found.size !== 1) {
    throw new QueryError(STATUS.SCHEMA_MISMATCH,
      found.size ? "Command Code 公开套餐资源不唯一" : "Command Code 公开套餐资源未找到");
  }
  return [...found][0];
}

// ---------- 纯函数：脚本 → 套餐表 ----------

/**
 * 解析公开套餐脚本为 Map<planId, {id, isOrganization, totalCredits}>。
 * 校验（任一不满足即 schema-mismatch，绝不返回部分结果）：
 *   - planId 唯一；
 *   - totalCredits 为 (0, 1e6]；
 *   - premiumCredits／opensourceCredits 合法（[0, 1e6]）且两项之和等于 totalCredits。
 * @returns {Map<string, {id: string, isOrganization: boolean, totalCredits: number}>}
 * @throws QueryError(SCHEMA_MISMATCH)
 */
export function parseTiers(script) {
  if (typeof script !== "string" || !script) {
    throw new QueryError(STATUS.SCHEMA_MISMATCH, "Command Code 公开套餐脚本为空");
  }
  const tiers = new Map();
  const scanner = new RegExp(TIER_RECORD_PATTERN, "g");
  let match;
  let records = 0;
  while ((match = scanner.exec(script)) !== null) {
    if (++records > MAX_TIER_RECORDS) {
      throw new QueryError(STATUS.SCHEMA_MISMATCH, "Command Code 公开套餐记录数超出上限");
    }
    const id = match.groups.id;
    const type = match.groups.type;
    const premium = num(match.groups.premium);
    const open = num(match.groups.open);
    const total = num(match.groups.total);
    if (premium === null || open === null || total === null
      || total <= 0 || total > MAX_CREDITS
      || premium < 0 || premium > MAX_CREDITS || open < 0 || open > MAX_CREDITS
      || !sameAmount(premium + open, total)) {
      throw new QueryError(STATUS.SCHEMA_MISMATCH, `Command Code 公开套餐限额无法确认（${id}）`);
    }
    if (tiers.has(id)) {
      throw new QueryError(STATUS.SCHEMA_MISMATCH, `Command Code 公开套餐 ID 重复（${id}）`);
    }
    tiers.set(id, { id, isOrganization: type === "org", totalCredits: total });
  }
  if (tiers.size === 0) {
    throw new QueryError(STATUS.SCHEMA_MISMATCH, "Command Code 公开套餐限额缺失");
  }
  return tiers;
}

/** 十进制字面量之和比较：容忍浮点表示误差，但不容忍真实差额。 */
function sameAmount(a, b) {
  const scale = Math.max(1, Math.abs(b));
  return Math.abs(a - b) <= 1e-9 * scale;
}

// ---------- 纯函数：月度进度 ----------

/**
 * 官网口径月度进度（参考 CommandCodeMonthlyMeterSource.Normalize）。
 * 必须同时满足才计算，否则返回 null（绝不编造百分比）：
 *   - subscription.planId 与 tier.id 完全一致；
 *   - subscription.status ∈ {active, trialing}；
 *   - 账期有效：currentPeriodStart ≤ now < currentPeriodEnd；
 *   - credits.monthlyRemaining 有限且 |x| ≤ 1e12；
 *   - 有效授予量优先：monthlyCreditsGranted > 0 时 total = max(tier.totalCredits, granted)；
 *     否则组织套餐按 floor(quantity) 个席位放大（quantity 必须 1..10000，否则 null）。
 * @param {object} input { credits, subscription, tier, nowMs }
 * @returns {{usedPercent: number, resetsAtMs: number, basis: 'public-rule'}|null}
 *          usedPercent 保留一位小数并夹紧到 0–100（只裁剪展示，不修改原始剩余值）
 */
export function computeMonthlyProgress({ credits, subscription, tier, nowMs } = {}) {
  const now = num(nowMs);
  if (now === null || !credits || !subscription || !tier) return null;

  // 1) 套餐身份必须精确一致：不使用用户手选参考套餐替代实际套餐
  const planId = typeof subscription.planId === "string" && subscription.planId ? subscription.planId : null;
  const tierId = typeof tier.id === "string" && tier.id ? tier.id : null;
  if (!planId || !tierId || planId !== tierId) return null;

  // 2) 订阅状态有效
  const status = typeof subscription.status === "string" ? subscription.status : null;
  if (status !== "active" && status !== "trialing") return null;

  // 3) 账期有效：起点已到、终点未过（月重置只认账期结束）
  const startMs = isoOrEpochMs(subscription.currentPeriodStart);
  const endMs = isoOrEpochMs(subscription.currentPeriodEnd);
  if (startMs === null || endMs === null) return null;
  if (!(startMs <= now && endMs > now)) return null;

  // 4) 月度剩余必须可用
  const remaining = num(credits.monthlyRemaining);
  if (remaining === null || Math.abs(remaining) > 1e12) return null;

  // 5) 有效授予量优先，否则组织套餐按有效席位放大
  const baseTotal = num(tier.totalCredits);
  if (baseTotal === null || baseTotal <= 0 || baseTotal > MAX_CREDITS) return null;
  let total = baseTotal;
  const granted = num(credits.monthlyCreditsGranted);
  if (granted !== null && granted > 0 && granted <= 1e12) {
    total = Math.max(baseTotal, granted);
  } else if (tier.isOrganization === true) {
    const seats = num(subscription.quantity);
    if (seats === null || seats < 1 || seats > 10_000) return null;
    total *= Math.floor(seats);
  }
  if (!(total > 0)) return null;

  // 已用 = 总量 − max(0, 剩余)，夹紧到 [0, total]；保留一位小数（四舍五入）
  const used = Math.min(total, Math.max(0, total - Math.max(0, remaining)));
  const usedPercent = Math.round((used / total) * 1000) / 10;
  // 追加字段只承载「本次计算使用的分母」与「规则元数据」，
  // 不改变上面任何前提判定：前提不成立时仍然返回 null。
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    resetsAtMs: endMs,
    basis: "public-rule",
    totalCredits: total,       // 最终分母（含 granted 优先与组织席位放大）
    creditUnit: CREDIT_UNIT,   // 公开规则口径的额度单位
    ruleSource: RULE_SOURCE,
    rulesFetchedAtMs: cache.fetchedAtMs ?? null,
    rulesValidUntilMs: cache.validUntilMs ?? null,
  };
}

// ---------- 无凭据公开读取（24h 缓存 + 5min 失败退避） ----------

const cache = {
  tiers: null,        // 最近一次成功的公开套餐表
  fetchedAtMs: null,  // 最近一次成功抓取时刻（规则元数据，随缓存一起失效；未加载保持 null）
  validUntilMs: null, // 规则有效期（到期即不再用于计算新进度；未加载保持 null）
  retryAfterMs: 0,    // 失败退避截止时刻
};

/** 测试／诊断用：清空本模块的公开规则缓存（不影响任何账户数据）。 */
export function resetTiersCache() {
  cache.tiers = null;
  cache.fetchedAtMs = null;
  cache.validUntilMs = null;
  cache.retryAfterMs = 0;
}

let inFlight = null;

/**
 * 读取公开套餐规则（无凭据）。
 * @param ctx.signal    取消信号（取消必须原样上抛）
 * @param ctx.now       当前时刻（便于测试）
 * @param ctx.timeoutMs 单请求超时
 * @returns {Map|null} 规则表；规则缺失／过期／失败时为 null（调用方据此停止输出月度进度）
 */
export async function loadTiers(ctx = {}) {
  const now = ctx.now ?? Date.now();
  if (cache.tiers && cache.validUntilMs !== null && now < cache.validUntilMs) return cache.tiers;
  if (now < cache.retryAfterMs) return null; // 退避中：不重新请求公开站点
  // 并发调用共享同一次公开读取（账户数据不受影响；任一调用方取消都可终止这次读取）
  if (inFlight) return settledFor(inFlight, ctx);
  inFlight = fetchTiers(ctx).finally(() => { inFlight = null; });
  return settledFor(inFlight, ctx);
}

/** 共享读取：把「其他调用方取消」转成 null，只有本次调用方自己的取消才上抛。 */
function settledFor(promise, ctx) {
  return promise.then(
    (value) => value,
    (error) => {
      if (isAbort(error, ctx.signal)) throw error;
      return null;
    },
  );
}

async function fetchTiers(ctx) {
  try {
    const html = await httpText(RULE_SOURCE, {
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      maxBytes: MAX_ASSET_BYTES,
    });
    const path = assetPathFromHtml(html);
    const script = await httpText(`${SITE_ORIGIN}${path}`, {
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      maxBytes: MAX_ASSET_BYTES,
      headers: { accept: "application/javascript,text/javascript;q=0.9,*/*;q=0.8" },
    });
    const tiers = parseTiers(script); // 只解析数据，不执行任何下载的代码
    const now = ctx.now ?? Date.now();
    cache.tiers = tiers;
    cache.fetchedAtMs = now;
    cache.validUntilMs = now + RULES_TTL_MS;
    cache.retryAfterMs = 0;
    return tiers;
  } catch (error) {
    if (isAbort(error, ctx.signal)) throw error; // 取消原样上抛，不写退避
    // 公开规则故障：清空规则缓存并退避 5 分钟；账户窗口／credits 不属于本模块，保持不动
    cache.tiers = null;
    cache.fetchedAtMs = null;
    cache.validUntilMs = null;
    cache.retryAfterMs = (ctx.now ?? Date.now()) + RULES_RETRY_MS;
    return null;
  }
}
