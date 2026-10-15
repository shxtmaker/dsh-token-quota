// lib/providers/opendesign.js — OpenDesign：工作空间成员的 Design Plan 窗口
//
// 范围界定（方案 4.6）：
//   - 保留推理 Base URL https://amr-link.open-design.ai/v1、原 API Key 与协议配置；
//     额度使用**独立控制台会话**，绝不把推理 Key 当作控制台认证，也不随请求传送。
//   - 工作空间配置接受合法 ID，或严格匹配
//     https://open-design.ai/cloud/dashboard?workspaceId=... 的链接（见 provider-policy）。
//   - 只查询「所选工作空间成员」的 Design Plan 窗口与重置时间：
//       GET https://amr-api.open-design.ai/api/v1/workspaces/current
//       GET https://amr-api.open-design.ai/api/v1/workspaces/{workspaceId}/billing/coding-plan-usage
//     携带 credentials: include 与 x-vela-workspace-id（由固定读取脚本在页面上下文执行）。
//   - 本轮**不查询钱包余额**（/wallet/balance）与估算接口（/api/v1/billing/summary）。
//
// 校验：context.workspaceId 必须与配置一致、workspaceMemberId 非空、响应中出现的
// workspaceId 必须一致；解析 eligible / policyId / durationSeconds / limitCredits /
// remainingCredits / resetsAt；拒绝重复 policyId、非法时长与非正限额。
// 窗口按服务端给出的时长命名，不硬编码 5 小时／周。
// 内部 credits 不称为 USD／Token／microCents；eligible:false 表示无对应套餐（不是已耗尽）。

import {
  STATUS, QueryError, num, bool, item, result, failure, failureFromError, isAbort, formatResetText,
} from "../provider-common.js";
import { CONSOLE_ORIGINS, parseOpenDesignWorkspace } from "../provider-policy.js";

export const ID = "opendesign";
export const METHOD_ID = "opendesign.windows.console";
export const API_ORIGIN = CONSOLE_ORIGINS.opendesign.apiOrigin;
export const PAGE_ORIGIN = CONSOLE_ORIGINS.opendesign.page;
export const LOGIN_URL = CONSOLE_ORIGINS.opendesign.loginUrl;

/** 工作空间输入解析（ID 或控制台链接）；供配置层与 UI 复用。 */
export function resolveWorkspace(input) {
  return parseOpenDesignWorkspace(input);
}

export function dashboardUrl(workspace) {
  return `${PAGE_ORIGIN}/cloud/dashboard?workspaceId=${encodeURIComponent(workspace)}`;
}

export function resourcePath(workspace) {
  return `/api/v1/workspaces/${encodeURIComponent(workspace)}/billing/coding-plan-usage`;
}

/**
 * 解析浏览器读取器回传的观察载荷（纯函数，便于固定样本测试）。
 * @param observation { status, context:{workspaceId, workspaceMemberId}, body }
 * @param workspace   配置的工作空间 ID
 * @returns 结构化结果
 * @throws QueryError
 */
export function parseObservation(observation, workspace, ctx = {}) {
  const now = ctx.now ?? Date.now();
  if (!observation || typeof observation !== "object") {
    throw new QueryError(STATUS.SCHEMA_MISMATCH, "OpenDesign 读取器未返回数据");
  }
  const state = observation.status;
  if (state !== "ready") {
    const map = {
      auth: [STATUS.AUTH_REQUIRED, "OpenDesign 控制台会话尚未登录或已失效"],
      forbidden: [STATUS.FORBIDDEN, "没有权限访问此 OpenDesign 工作空间"],
      rate: [STATUS.RATE_LIMITED, "OpenDesign 请求过于频繁"],
      network: [STATUS.NETWORK_ERROR, "OpenDesign 网络查询失败"],
      unavailable: [STATUS.ENVIRONMENT_UNAVAILABLE, "当前环境没有可用的浏览器会话"],
    };
    const [status, message] = map[state] || [STATUS.SCHEMA_MISMATCH, "OpenDesign 响应结构不匹配"];
    throw new QueryError(status, message);
  }
  const context = observation.context;
  if (!context || typeof context !== "object") {
    throw new QueryError(STATUS.SCHEMA_MISMATCH, "OpenDesign 响应缺少 context");
  }
  if (context.workspaceId !== workspace) {
    throw new QueryError(STATUS.FORBIDDEN, "OpenDesign 返回的工作空间与配置不一致");
  }
  const memberId = typeof context.workspaceMemberId === "string" && context.workspaceMemberId
    ? context.workspaceMemberId
    : null;
  if (!memberId) throw new QueryError(STATUS.SCHEMA_MISMATCH, "OpenDesign 未返回工作空间成员标识");

  const body = observation.body;
  if (!body || typeof body !== "object") throw new QueryError(STATUS.SCHEMA_MISMATCH, "OpenDesign 响应缺少额度数据");
  if (typeof body.workspaceId === "string" && body.workspaceId && body.workspaceId !== workspace) {
    throw new QueryError(STATUS.FORBIDDEN, "OpenDesign 额度数据属于其他工作空间");
  }

  const scope = {
    configInstanceId: ctx.scope?.configInstanceId ?? null,
    accountId: null,
    orgId: null,
    workspaceId: workspace,
    memberId,
  };

  const eligible = bool(body.eligible);
  if (eligible === false) {
    // 无对应套餐 ≠ 已耗尽：明确 no-data，绝不渲染成 0%
    throw new QueryError(STATUS.NO_DATA, "此 OpenDesign 工作空间成员没有 Design Plan 套餐");
  }
  if (eligible === null) throw new QueryError(STATUS.SCHEMA_MISMATCH, "OpenDesign 响应缺少 eligible 字段");

  const windows = Array.isArray(body.windows) ? body.windows : null;
  if (!windows) throw new QueryError(STATUS.SCHEMA_MISMATCH, "OpenDesign 响应缺少 windows");
  if (!windows.length) throw new QueryError(STATUS.NO_DATA, "OpenDesign 未返回额度窗口");

  const seen = new Set();
  const items = [];
  for (const w of windows) {
    if (!w || typeof w !== "object") throw new QueryError(STATUS.SCHEMA_MISMATCH, "OpenDesign 窗口条目无效");
    const policyId = typeof w.policyId === "string" && w.policyId ? w.policyId : null;
    if (!policyId) throw new QueryError(STATUS.SCHEMA_MISMATCH, "OpenDesign 窗口缺少 policyId");
    if (seen.has(policyId)) throw new QueryError(STATUS.SCHEMA_MISMATCH, "OpenDesign 返回重复的 policyId");
    seen.add(policyId);
    const durationSeconds = num(w.durationSeconds);
    if (durationSeconds === null || !Number.isInteger(durationSeconds) || durationSeconds <= 0) {
      throw new QueryError(STATUS.SCHEMA_MISMATCH, "OpenDesign 窗口时长非法");
    }
    const limit = num(w.limitCredits);
    if (limit === null || limit <= 0) throw new QueryError(STATUS.SCHEMA_MISMATCH, "OpenDesign 窗口限额非正");
    const remaining = num(w.remainingCredits);
    if (remaining === null) throw new QueryError(STATUS.SCHEMA_MISMATCH, "OpenDesign 窗口缺少剩余额度");

    let resetAtMs = null;
    if (w.resetsAt !== null && w.resetsAt !== undefined && w.resetsAt !== "") {
      const parsed = Date.parse(String(w.resetsAt));
      if (!Number.isFinite(parsed)) throw new QueryError(STATUS.SCHEMA_MISMATCH, "OpenDesign 重置时刻无效");
      resetAtMs = parsed;
    }

    // 展示百分比夹紧到合法范围，但原始额度保持不变（不篡改超额／加成值）。
    const clampedRemaining = Math.min(Math.max(remaining, 0), limit);
    const usedPercent = (1 - clampedRemaining / limit) * 100;
    items.push(item({
      providerId: ID,
      methodId: METHOD_ID,
      itemId: `window.${policyId}`,
      scope,
      kind: "window",
      label: windowLabel(durationSeconds),
      raw: {
        limit,
        used: null,
        remaining,
        unit: "credits", // 内部 credits：既不称 USD，也不称 Token 或 microCents
        currency: null,
        scale: 1,
      },
      usedPercent,
      period: {
        startMs: resetAtMs === null ? null : resetAtMs - durationSeconds * 1000,
        endMs: resetAtMs,
        timeZone: null,
        granularity: "window",
        description: `服务端声明的窗口时长 ${durationSeconds} 秒`,
      },
      resetAtMs,
      basis: "reported",
      fetchedAtMs: now,
      note: resetAtMs === null ? "服务端未给出重置时刻" : "",
    }));
  }
  return result({
    providerId: ID,
    methodId: METHOD_ID,
    status: STATUS.OK,
    items,
    fetchedAtMs: now,
  });
}

/** 窗口名按服务端时长命名（不硬编码 5 小时／周）。 */
function windowLabel(durationSeconds) {
  if (durationSeconds % 86_400 === 0) return `${durationSeconds / 86_400} 天额度窗口`;
  if (durationSeconds % 3600 === 0) return `${durationSeconds / 3600} 小时额度窗口`;
  if (durationSeconds % 60 === 0) return `${durationSeconds / 60} 分钟额度窗口`;
  return `${durationSeconds} 秒额度窗口`;
}

/**
 * 查询入口（控制台会话）。
 * ctx.console 由 lib/runtime/console-bridge.js 提供：{ read(ref, options) }。
 * 缺少浏览器环境时返回 environment-unavailable，不影响其他供应商的 HTTP 方法。
 */
export async function queryWindows(ctx) {
  const methodId = METHOD_ID;
  try {
    const workspaceInput = ctx.cfg?.workspaceId || ctx.cfg?.baseUrl || "";
    const { workspace, error } = resolveWorkspace(workspaceInput);
    if (error) return failure(ID, methodId, STATUS.SCHEMA_MISMATCH, error);
    if (!ctx.console) {
      return failure(ID, methodId, STATUS.ENVIRONMENT_UNAVAILABLE, "当前环境没有可用的浏览器会话（OpenDesign 需要控制台登录）");
    }
    const observation = await ctx.console.read("opendesign-windows", {
      workspace,
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
    });
    return parseObservation(observation, workspace, ctx);
  } catch (error) {
    if (isAbort(error, ctx.signal)) throw error;
    return failureFromError(ID, methodId, error, ctx.signal);
  }
}

/**
 * 固定页面内读取脚本（随包发布，不接受前端传入任意 URL／JS）。
 * 在 open-design.ai 页面上下文内按顺序读取 current 与 coding-plan-usage，
 * 只回传归一化业务数据；cookie 与会话不离开浏览器。
 */
export function consoleReadScript(nonce) {
  return `(() => {
  const nonce = ${JSON.stringify(nonce)};
  const origin = ${JSON.stringify(API_ORIGIN)};
  const pageOrigin = ${JSON.stringify(PAGE_ORIGIN)};
  const send = (value) => window.__dshConsoleRead.post(nonce, value);
  (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      if (location.origin !== pageOrigin) return send({ status: 'auth' });
      const workspaceId = new URL(location.href).searchParams.get('workspaceId');
      if (!workspaceId) return send({ status: 'schema' });
      const read = async (path) => {
        const response = await fetch(origin + path, {
          method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error',
          headers: { Accept: 'application/json', 'x-vela-workspace-id': workspaceId },
          signal: controller.signal,
        });
        if (!response.ok) {
          const status = response.status === 401 ? 'auth' : response.status === 403 ? 'forbidden'
            : response.status === 429 ? 'rate' : response.status >= 500 ? 'network' : 'schema';
          throw { status };
        }
        try { return await response.json(); } catch { throw { status: 'schema' }; }
      };
      const context = await read('/api/v1/workspaces/current');
      if (context.workspaceId !== workspaceId) return send({ status: 'forbidden' });
      const body = await read('/api/v1/workspaces/' + encodeURIComponent(workspaceId) + '/billing/coding-plan-usage');
      send({
        status: 'ready',
        context: { workspaceId: context.workspaceId, workspaceMemberId: context.workspaceMemberId },
        body,
      });
    } catch (error) {
      const state = error && ['auth', 'forbidden', 'rate', 'schema'].includes(error.status) ? error.status : 'network';
      send({ status: state });
    } finally { clearTimeout(timer); }
  })();
})();`;
}

export const resetText = formatResetText;
