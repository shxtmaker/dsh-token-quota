// lib/runtime/console-readers/fireworks-balance.js — Fireworks 控制台 Credits 余额读取器
//
// 在 app.fireworks.ai 页面上下文内：
//   1) 调用页面自身的 /api/v2/auth/refresh 做会话检查，取得 session.accountID；
//   2) 只在「唯一可识别」的 Credits 区域读取金额（DOM 不唯一即报 schema，绝不抓页面任意金额）。
// 不点击充值／付款／额度调整控件；原始会话响应与 cookie 不离开浏览器。
//
// 账户归属仍需宿主侧用 API Key 的官方账户列表核对（见 lib/providers/fireworks.js）。

export const CONSOLE_URL = "https://app.fireworks.ai/account/home";
export const PAGE_ORIGIN = "https://app.fireworks.ai";

export function readScript() {
  return `(() => {
  const pageOrigin = ${JSON.stringify(PAGE_ORIGIN)};
  return (async () => {
    if (location.origin !== pageOrigin) return { status: 'auth' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
      response = await fetch('/api/v2/auth/refresh', {
        credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      return { status: 'network' };
    } finally { clearTimeout(timer); }
    if (response.status === 401 || response.status === 403) return { status: 'auth' };
    if (!response.ok) return { status: 'network' };
    let session;
    try {
      const payload = await response.json();
      session = payload && payload.session;
    } catch (error) { return { status: 'schema' }; }
    if (!session || !session.accountID) return { status: 'auth' };
    // 唯一可识别的 Credits 区域：在同一按钮上同时出现 Total Spend 与 Credits，且仅一处
    for (let attempt = 0; attempt < 30; attempt++) {
      const matches = [...document.querySelectorAll('button')].filter((button) =>
        !button.disabled
        && button.getAttribute('aria-disabled') !== 'true'
        && button.getClientRects().length > 0
        && /Total Spend:/.test(button.innerText)
        && /Credits:/.test(button.innerText));
      if (matches.length > 1) return { status: 'schema' };
      if (matches.length === 1) {
        const amount = matches[0].innerText.match(/Credits:\\s*((?:-\\$|\\$-?)[\\d,]+(?:\\.\\d{1,2})?)(?=\\s|$)/);
        if (!amount) return { status: 'schema' };
        return { status: 'ready', accountId: session.accountID, credits: amount[1] };
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { status: 'schema' };
  })();
})();`;
}
