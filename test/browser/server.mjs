import { createServer } from "node:http";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, Config } from "../../lib/index.js";

// 独立宿主数据目录；不读取真实 DSH 配置或供应商凭据。
const home = mkdtempSync(join(tmpdir(), "qm-browser-"));
process.env.DSH_HOME = home;
const routes = new Map();
const events = new Map();
function merge(a, b) {
  const result = structuredClone(a);
  for (const [key, value] of Object.entries(b)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      ? merge(result[key] || {}, value) : value;
  }
  return result;
}
// 0.1.7 settings 契约：行 id 寻址 + volatile 引用（写入后就地更新并发 loader/volatile-update）。
const resolveConfig = (raw) => {
  const parsed = Config(raw);
  return parsed && typeof parsed.get === "function" ? parsed.get() : parsed;
};
let user = { suppliers: { opencode: { enabled: true, orgId: "org-original" } } };
let config = resolveConfig(user);
const setUser = (next) => {
  user = next;
  config = resolveConfig(user);
  for (const cb of events.get("loader/volatile-update") ?? []) cb([]);
};
const dispose = apply({
  settings: {
    describe: () => [{ ns: "dsh-token-quota", value: config, user, revision: 1 }],
    update: async (ns, patch) => { setUser(merge(user, patch)); },
  },
  webServer: { register(r) { routes.set(r.path, r.handler); return () => {}; } },
  on(name, cb) { (events.get(name) ?? events.set(name, []).get(name)).push(cb); return () => {}; },
}, { get: () => config });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 供应商查询替身：测试进程内的插件后端会按轮询节奏查询真实供应商端点，
// 这里把出站请求换成固定响应，避免任何真实网络/计费调用（loopback 资产与路由不受影响）。
const usageMock = { percent: 49 };
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = String(input);
  if (!/^https?:\/\//.test(url)) return realFetch(input, init);
  const host = new URL(url).host;
  if (host === "127.0.0.1" || host === "localhost" || host === "[::1]") return realFetch(input, init);
  if (url.includes("/zen/go/v1/usage")) {
    return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({
      usage: {
        rolling: { percent: usageMock.percent, resetsAt: "2026-09-13T00:00:00Z", status: "ok" },
        weekly: { percent: Math.min(100, usageMock.percent + 11), resetsAt: "2026-09-15T00:00:00Z" },
        monthly: { percent: Math.min(100, usageMock.percent + 31), resetsAt: "2026-10-01T00:00:00Z" },
      },
    }) });
  }
  return Promise.resolve({ ok: false, status: 404, text: async () => "" });
};
// 测试开关：?delay=N 让 /settings 慢 N 毫秒；?fail=1 让 /settings 返回校验失败；
// ?stateDelay=N 让 /state 慢 N 毫秒（复现慢请求下的编辑身份问题）。
let stateDelayMs = 0;
let settingsDelayMs = 0;
let settingsFail = false;
let postCount = 0;
const readBody = (req) => new Promise((resolve) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => resolve(body));
});

const assets = new Map([
  ["/", [new URL("./shell.html", import.meta.url), "text/html; charset=utf-8"]],
  ["/client.js", [new URL("../../lib/client.js", import.meta.url), "text/javascript"]],
  ["/react.js", [new URL("../../node_modules/react/umd/react.development.js", import.meta.url), "text/javascript"]],
  ["/react-dom.js", [new URL("../../node_modules/react-dom/umd/react-dom.development.js", import.meta.url), "text/javascript"]],
]);
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  try {
    if (path === "/__control") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (body.stateDelay !== undefined) stateDelayMs = Number(body.stateDelay) || 0;
      if (body.settingsDelay !== undefined) settingsDelayMs = Number(body.settingsDelay) || 0;
      if (body.settingsFail !== undefined) settingsFail = !!body.settingsFail;
      if (body.postCount !== undefined) postCount = 0;
      if (body.config) setUser(body.config);
      if (body.usagePercent !== undefined) usageMock.percent = Number(body.usagePercent) || 0;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, postCount }));
      return;
    }
    if (path === "/__suppliers") {
      const body = JSON.parse((await readBody(req)) || "{}");
      for (const [id, value] of Object.entries(body)) setUser(merge(user, { suppliers: { [id]: value } }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (path === "/api/dsh-token-quota/state" && stateDelayMs) await sleep(stateDelayMs);
    if (path === "/api/dsh-token-quota/settings") {
      postCount++;
      if (settingsDelayMs) await sleep(settingsDelayMs);
      if (settingsFail) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "validation rejected" }));
        return;
      }
    }
    if (routes.has(path)) { await routes.get(path)(req, res); return; }
    const asset = assets.get(path);
    if (!asset) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": asset[1] }); res.end(readFileSync(asset[0]));
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
server.listen(4179, "127.0.0.1");
function close() { dispose(); server.close(); rmSync(home, { recursive: true, force: true }); }
process.on("SIGINT", close); process.on("SIGTERM", close);
