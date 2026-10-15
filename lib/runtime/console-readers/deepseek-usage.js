// lib/runtime/console-readers/deepseek-usage.js — DeepSeek 控制台用量／费用读取器
//
// 在 platform.deepseek.com 页面上下文内，用页面自身的 XHR（凭据随页面 cookie 走，
// 等同浏览器原生请求）读取两个已核对的私有路径：
//   GET /api/v0/usage/by_api_key/amount?start=<sec>&end=<sec>&tz=<sec>
//   GET /api/v0/usage/by_api_key/cost?start=<sec>&end=<sec>&tz=<sec>
// 只回传「状态 + 原始响应体文本」；cookie、请求头与完整会话响应不离开浏览器。
//
// 单位契约：接口参数与桶时间按已核对契约明确采用**秒**；宿主侧统一转毫秒。
// 脚本本身不做任何汇总，避免在页面上下文里产生第二套口径。

export const CONSOLE_URL = "https://platform.deepseek.com/usage";
export const PAGE_ORIGIN = "https://platform.deepseek.com";

/**
 * @param spec { startSec, endSec, tzSec } 已由读取器注册表校验为整数
 */
export function readScript({ startSec, endSec, tzSec }) {
  const amountPath = `/api/v0/usage/by_api_key/amount?start=${startSec}&end=${endSec}&tz=${tzSec}`;
  const costPath = `/api/v0/usage/by_api_key/cost?start=${startSec}&end=${endSec}&tz=${tzSec}`;
  return `(() => {
  const pageOrigin = ${JSON.stringify(PAGE_ORIGIN)};
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
  return (async () => {
    // 页面来源校验：不在控制台域内不发送任何请求
    if (location.origin !== pageOrigin) return { state: 'auth' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40000);
    try {
      const amount = await read(${JSON.stringify(amountPath)});
      const cost = await read(${JSON.stringify(costPath)});
      return { state: 'ready', amount, cost };
    } catch (error) {
      return { state: 'network' };
    } finally { clearTimeout(timer); }
  })();
})();`;
}

/** 由读取器观察结果判定每个来源的状态（宿主侧使用，保持用量／费用独立）。 */
export function classify(endpointResult) {
  if (!endpointResult || typeof endpointResult !== "object") return { status: 0, body: "", empty: true };
  const status = Number(endpointResult.status) || 0;
  const body = typeof endpointResult.body === "string" ? endpointResult.body : "";
  return { status, body, empty: !body || body === "{}" };
}
