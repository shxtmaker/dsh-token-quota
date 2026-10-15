// lib/runtime/console-readers/opendesign-windows.js — OpenDesign Design Plan 窗口读取器
//
// 在 open-design.ai 页面上下文内，按顺序查询：
//   GET https://amr-api.open-design.ai/api/v1/workspaces/current
//   GET https://amr-api.open-design.ai/api/v1/workspaces/{workspaceId}/billing/coding-plan-usage
// 携带 credentials: include 与 x-vela-workspace-id。
//
// 本轮**不查询钱包**（/wallet/balance），也不为本轮未实施的估算调用
// /api/v1/billing/summary；只回传窗口业务数据与工作空间成员身份。

export const PAGE_ORIGIN = "https://open-design.ai";
export const API_ORIGIN = "https://amr-api.open-design.ai";

export function dashboardUrl(workspace) {
  return `${PAGE_ORIGIN}/cloud/dashboard?workspaceId=${encodeURIComponent(workspace)}`;
}

/** @param spec { workspace } 已由读取器注册表校验为合法工作空间标识 */
export function readScript({ workspace }) {
  return `(() => {
  const pageOrigin = ${JSON.stringify(PAGE_ORIGIN)};
  const apiOrigin = ${JSON.stringify(API_ORIGIN)};
  const workspace = ${JSON.stringify(workspace)};
  return (async () => {
    if (location.origin !== pageOrigin) return { status: 'auth' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const read = async (path) => {
      const response = await fetch(apiOrigin + path, {
        method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json', 'x-vela-workspace-id': workspace },
        signal: controller.signal,
      });
      if (!response.ok) {
        const state = response.status === 401 ? 'auth' : response.status === 403 ? 'forbidden'
          : response.status === 429 ? 'rate' : response.status >= 500 ? 'network' : 'schema';
        throw { state };
      }
      try { return await response.json(); } catch { throw { state: 'schema' }; }
    };
    try {
      const context = await read('/api/v1/workspaces/current');
      if (!context || context.workspaceId !== workspace) return { status: 'forbidden' };
      const body = await read('/api/v1/workspaces/' + encodeURIComponent(workspace) + '/billing/coding-plan-usage');
      return {
        status: 'ready',
        context: { workspaceId: context.workspaceId, workspaceMemberId: context.workspaceMemberId },
        body,
      };
    } catch (error) {
      const state = error && ['auth', 'forbidden', 'rate', 'schema'].includes(error.state) ? error.state : 'network';
      return { status: state };
    } finally { clearTimeout(timer); }
  })();
})();`;
}
