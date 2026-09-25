// test/mock-dsh.mjs — 宿主半集成冒烟（mock Cordis ctx + fetch，真实调度/路由/自动探测代码）
// 用法：node test/mock-dsh.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { hourKeyOf, loadUsageFile, usageFilePath } from "../lib/storage.js";

const NS = "dsh-token-quota";
// 初始：三家都未配置（模拟新装插件），等待自动探测接入
const BACKING = {
  suppliers: {
    deepseek: { enabled: false, apiKey: "", baseUrl: "https://api.deepseek.com", warnPct: 80, critPct: 95 },
    opencode: { enabled: false, apiKey: "", allowanceToken: "", baseUrl: "https://opencode.ai", warnPct: 80, critPct: 95 },
    commandcode: { enabled: false, apiKey: "", baseUrl: "https://api.commandcode.ai", warnPct: 80, critPct: 95 },
    // 其余供应商无缺省项 → runtime 按注册表默认（enabled=false）运行，自动探测到才填入
  },
  intervalSeconds: 60,
  trafficWindowHours: 24,
};
let resolved = structuredClone(BACKING);
const userLayer = { suppliers: {} };

// 模拟 Schemastery 返回的只读配置：探测补丁只能经 settings.update 持久化，
// 任何对 runtime.config 的原地修改都会在这里抛 TypeError（回归护栏）
const deepFreeze = (o) => {
  if (!o || typeof o !== "object" || Object.isFrozen(o)) return o;
  for (const v of Object.values(o)) deepFreeze(v);
  return Object.freeze(o);
};
const frozenView = () => deepFreeze(structuredClone(resolved));

// 模拟真实 DSH（~/.dsh/settings.yaml + .credentials.yaml）：
//   - llm-pi-ai.providers.opencode-go / commandcode-goat（用户添加的 OpenCode/Command Code）
//   - llm-deepseek 无 user 层，但 DEEPSEEK_API_KEY 存在 DSH 凭据库（source=file）
//   - openrouter 已添加但本插件暂不支持 → detectedUnmapped
const HARNESS = {
  "llm-deepseek": { baseURL: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY" },
  "llm-pi-ai": {
    providers: {
      "opencode-go": { apiKeyEnv: "OPENCODE_GO_API_KEY" },
      "commandcode-goat": { apiKeyEnv: "COMMANDCODE_GOAT_API_KEY", baseURL: "https://api.commandcode.ai/provider/v1" },
      openrouter: { apiKeyEnv: "OPENROUTER_API_KEY", baseURL: "https://openrouter.ai/api/v1" },
      "moonshotai-cn": { apiKeyEnv: "MOONSHOT_CN_API_KEY", baseURL: "https://api.moonshot.cn/v1" },
      "zai-coding-cn": { apiKeyEnv: "ZAI_CODING_CN_API_KEY", baseURL: "https://open.bigmodel.cn/api/anthropic" },
      openai: { apiKeyEnv: "OPENAI_API_KEY", baseURL: "https://api.openai.com/v1" }, // 普通聊天 Key → Admin 供应商不套用
    },
  },
};
// DSH settings describe() 的 user 层：llm-pi-ai 是用户配置文档；llm-deepseek 没有 user 层
const harnessUser = {
  "llm-pi-ai": {
    providers: {
      "opencode-go": { apiKeyEnv: "OPENCODE_GO_API_KEY" },
      "commandcode-goat": { apiKeyEnv: "COMMANDCODE_GOAT_API_KEY", baseURL: "https://api.commandcode.ai/provider/v1" },
      openrouter: { apiKeyEnv: "OPENROUTER_API_KEY", baseURL: "https://openrouter.ai/api/v1" },
      "moonshotai-cn": { apiKeyEnv: "MOONSHOT_CN_API_KEY", baseURL: "https://api.moonshot.cn/v1" },
      "zai-coding-cn": { apiKeyEnv: "ZAI_CODING_CN_API_KEY", baseURL: "https://open.bigmodel.cn/api/anthropic" },
      openai: { apiKeyEnv: "OPENAI_API_KEY", baseURL: "https://api.openai.com/v1" },
    },
  },
};

const mergePatch = (dst, src) => {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === "object" && !Array.isArray(v)) mergePatch(dst[k] ??= {}, v);
    else dst[k] = v;
  }
};

// 0.1.7 settings 契约：按行 id 描述/写入；行 config 是 loader 维护的 volatile 引用，
// 写入后引用就地更新并派发 loader/volatile-update（插件不重挂）。
const ctx = {
  settings: {
    describe: () => [
      { ns: NS, value: resolved, user: userLayer, revision: 1 },
      { ns: "llm-deepseek", value: HARNESS["llm-deepseek"], user: undefined },
      { ns: "llm-pi-ai", value: HARNESS["llm-pi-ai"], user: harnessUser["llm-pi-ai"] },
    ],
    update: async (ns, patch) => {
      assert.equal(ns, NS, "settings 写入必须落在本行 id");
      mergePatch(resolved, patch);
      mergePatch(userLayer, patch);
      for (const cb of ctx._events["loader/volatile-update"] ?? []) cb([]);
    },
  },
  get: (name) =>
    name === "credentials"
      ? { resolve: async (ref) => ({ value: "file-sk-" + ref, source: "file" }) }
      : undefined,
  webServer: { register: (route) => { ctx._routes.push(route); return () => {}; } },
  on: (name, cb) => { (ctx._events[name] ??= []).push(cb); return () => {}; },
  _routes: [],
  _events: {},
};
/** apply 的第二参数：模拟 loader 的 volatile 引用（读时取当前生效配置）。 */
const configRef = { get: () => resolved };

// Mock 供应商服务器（记录调用，供密钥回退断言）
const calls = [];
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), auth: opts?.headers?.authorization || null });
  const u = String(url);
  if (u.includes("user/balance")) return { ok: true, status: 200, text: async () => JSON.stringify({ balance_infos: [{ currency: "CNY", total_balance: "66.60" }] }) };
  if (u.includes("zen/go/v1/usage")) return { ok: false, status: 404, text: async () => "" };
  return { ok: false, status: 401, text: async () => "" };
};

// 本地用量数据落盘目标：隔离的临时 DSH_HOME（不污染真实 ~/.dsh）
const TEST_HOME = mkdtempSync(join(tmpdir(), "qm-mock-home-"));
process.env.DSH_HOME = TEST_HOME;

const dispose = apply(ctx, configRef);
await new Promise((r) => setTimeout(r, 400)); // 首轮 tick + 自动探测填入

// 模拟真实 DSH 启动时派发 llm/adapters-updated（拓扑变更；不是流量观测信号）
for (const cb of ctx._events["llm/adapters-updated"] ?? []) cb();

// ---- 自动探测：harness 里已添加的普通 Key 供应商全部自动填入 ----
assert.equal(resolved.suppliers.deepseek.enabled, true, "凭据库有 DEEPSEEK_API_KEY → 自动启用 deepseek");
assert.equal(resolved.suppliers.deepseek.autoSource, "llm-deepseek");
assert.equal(resolved.suppliers.opencode.enabled, true, "pi-ai opencode-go → 自动启用 opencode");
assert.equal(resolved.suppliers.opencode.autoSource, "llm-pi-ai");
assert.equal(resolved.suppliers.opencode.autoApiKeyEnv, "OPENCODE_GO_API_KEY");
assert.equal(resolved.suppliers.commandcode.enabled, true, "pi-ai commandcode-goat → 自动启用 commandcode");
assert.equal(resolved.suppliers.commandcode.autoSource, "llm-pi-ai");
assert.equal(resolved.suppliers.commandcode.autoApiKeyEnv, "COMMANDCODE_GOAT_API_KEY");
assert.equal(resolved.suppliers.commandcode.baseUrl, "https://api.commandcode.ai/provider/v1", "Base URL 跟随 DSH（兼容网关路径）");
assert.equal(resolved.suppliers.openrouter.enabled, true, "pi-ai openrouter → 自动启用 openrouter（普通 Key 额度/费用）");
assert.equal(resolved.suppliers["moonshot-cn"].enabled, true, "moonshotai-cn → 自动启用 moonshot-cn（国内余额）");
assert.equal(resolved.suppliers["moonshot-cn"].baseUrl, "https://api.moonshot.cn/v1");
assert.equal(resolved.suppliers["zai-cn"].enabled, true, "zai-coding-cn → 自动启用 zai-cn（智谱国内 Coding Plan）");
assert.equal(resolved.suppliers["openai-org"], undefined, "OpenAI 普通聊天 Key 绝不自动启用 openai-org（需 Admin Key）");
assert.equal(resolved.suppliers.deepseek.apiKey, "file-sk-DEEPSEEK_API_KEY", "API Key 本体自动填入插件 settings");
assert.equal(resolved.suppliers.opencode.apiKey, "file-sk-OPENCODE_GO_API_KEY");
assert.equal(resolved.suppliers.commandcode.apiKey, "file-sk-COMMANDCODE_GOAT_API_KEY");
assert.equal(resolved.suppliers.openrouter.apiKey, "file-sk-OPENROUTER_API_KEY");
assert.equal(resolved.suppliers["moonshot-cn"].apiKey, "file-sk-MOONSHOT_CN_API_KEY");
assert.equal(resolved.suppliers["zai-cn"].apiKey, "file-sk-ZAI_CODING_CN_API_KEY");
const dsCall = calls.find((c) => c.url.includes("user/balance"));
assert.ok(dsCall, "自动填入后应发起余额查询");
assert.equal(dsCall.auth, "Bearer file-sk-DEEPSEEK_API_KEY", "取数使用的是自动填入的密钥（与 DSH 凭据库一致）");
console.log("✓ 自动探测：6 个普通 Key 供应商自动启用 + 官方 baseUrl + API Key 自动填入；Admin 不套用");

// ---- 路由表 ----
const paths = ctx._routes.map((r) => r.path);
assert.deepEqual(paths, ["/api/dsh-token-quota/state", "/api/dsh-token-quota/refresh", "/api/dsh-token-quota/test", "/api/dsh-token-quota/settings", "/api/dsh-token-quota/rescan"]);

const call = async (path, body, headers = { origin: "" }, method = String(path).split("?")[0].endsWith("/state") ? "GET" : "POST") => {
  const route = ctx._routes.find((r) => r.path === String(path).split("?")[0]);
  let status = 0;
  let payload = null;
  const res = { writeHead: (s) => { status = s; }, end: (d) => { payload = JSON.parse(d); } };
  const req = { url: path, method, headers, on: (ev, cb) => { if (ev === "data") { if (body) cb(JSON.stringify(body)); } if (ev === "end") cb(); } };
  await route.handler(req, res);
  return { status, payload };
};

// ---- HTTP method and origin contract ----
assert.equal((await call("/api/dsh-token-quota/refresh", null, {}, "GET")).status, 405);
assert.equal((await call("/api/dsh-token-quota/state", null, { origin: "http://localhost:3001", host: "localhost:3000" })).status, 403);
assert.equal((await call("/api/dsh-token-quota/state", null, { origin: "http://[::1]:3000", host: "[::1]:3000" })).status, 200);
assert.equal((await call("/api/dsh-token-quota/test", { supplier: "toString" })).status, 400);

// ---- state ----
const s1 = await call("/api/dsh-token-quota/state");
assert.equal(s1.status, 200);
const ds = s1.payload.suppliers.find((s) => s.id === "deepseek");
assert.equal(ds.state, "ok");
assert.equal(ds.headline.amt, "¥66.60");
// 只有真实 session/event 才置位 channelAlive：adapters-updated 之后仍按启用清单兜底
assert.equal(ds.current, true, "冷启动未调用时小组件应兜底显示启用供应商");
assert.equal(ds.keySet, true, "API Key 已自动填入插件 settings");
assert.equal(ds.envKeySet, true);
assert.equal(ds.autoDetected, true);
assert.equal(ds.autoKeySource, "file");
const oc = s1.payload.suppliers.find((s) => s.id === "opencode");
assert.equal(oc.autoDetected, true);
assert.equal(oc.keySet, true);
assert.equal(oc.envKeySet, true);
assert.equal(oc.state, "err");
const cc = s1.payload.suppliers.find((s) => s.id === "commandcode");
assert.equal(cc.autoDetected, true);
assert.equal(cc.keySet, true);
assert.equal(cc.autoEnvName, "COMMANDCODE_GOAT_API_KEY");
assert.equal(cc.state, "err");
assert.deepEqual(s1.payload.detectedUnmapped.map((u) => u.route), ["openai"], "pi-ai 普通聊天 Key（openai）应进入 detectedUnmapped 并提示需 Admin Key");
assert.match(s1.payload.detectedUnmapped[0].detail || "", /Admin Key/);
assert.equal(s1.payload.suppliers.length, 13, "供应商注册表含 13 项（凭据类别 × 地域拆分）");
// v1.1 已添加推导：探测到 → added（即使显式关闭也在主目录；仅阈值/BaseURL 改动不算）
for (const id of ["deepseek", "opencode", "commandcode", "openrouter", "moonshot-cn", "zai-cn"]) {
  const s = s1.payload.suppliers.find((x) => x.id === id);
  assert.equal(s.added, true, `${id} 探测到 → added`);
  assert.equal(s.addedReason, "detected", `${id} addedReason=detected`);
}
for (const id of ["openai-org", "anthropic-org", "openrouter-account"]) {
  const s = s1.payload.suppliers.find((x) => x.id === id);
  assert.equal(s.added, false, `${id} 未探测且未启用无密钥 → 不算已添加`);
  assert.equal(s.addedReason, null, `${id} addedReason=null`);
}
const det = s1.payload.detect;
assert.equal(det.error, null, "探测无异常");
assert.deepEqual([...det.found].sort(), [
  "commandcode", "deepseek", "moonshot-cn", "opencode", "openrouter", "zai-cn",
], "探测命中六家普通 Key 供应商");
assert.ok(det.candidates.some((c) => c.route === "opencode-go" && c.keySource === "file"));
assert.equal(det.credentialsPresent, true);
assert.equal(s1.payload.active, null, "尚未观测到任何 LLM 调用 → active=null（紧凑条显示暂无调用）");
const orMeta = s1.payload.suppliers.find((x) => x.id === "openrouter");
assert.equal(orMeta.autoDetected, true);
assert.equal(orMeta.meta.credentialClass, "api-key");
assert.deepEqual(orMeta.meta.needs.map((n) => n.key), ["apiKey"]);
const oiMeta = s1.payload.suppliers.find((x) => x.id === "openai-org");
assert.equal(oiMeta.meta.credentialClass, "admin-key", "Admin 供应商带凭据类别元数据供客户端提示手动配置");
console.log("✓ state：deepseek ok、5 家自动接入、detectedUnmapped=[openai]（Admin 提示）、供应商 meta/needs 下发");

// ---- 流量兜底（用户报告「小组件信息消失」）：有事件但无任何可用近期流量 → 按启用清单显示 ----
const emit = (e) => { for (const cb of ctx._events["session/event"]) cb(null, e); };
emit({ type: "assistant/message", data: { source: { provider: "unknown-route-xyz", model: "m" }, usage: { uncachedInputTokens: 1, outputTokens: 1 } } });
const sX = await call("/api/dsh-token-quota/state");
assert.equal(sX.payload.trafficStale, true, "无近期可用流量时应标记 trafficStale");
for (const id of ["deepseek", "opencode", "commandcode", "openrouter", "moonshot-cn", "zai-cn"]) {
  assert.equal(sX.payload.suppliers.find((s) => s.id === id).current, true, id + " 应兜底按启用清单显示");
}
console.log("✓ 流量兜底：无近期可用流量时小组件按启用清单显示（trafficStale=true）");
assert.equal(sX.payload.active, null, "未映射路由（unknown-route-xyz）不产生 active");
emit({ type: "assistant/message", data: { source: { provider: "deepseek-official", model: "deepseek-v3" }, usage: { uncachedInputTokens: 1000, outputTokens: 500 } } });
const s2 = await call("/api/dsh-token-quota/state");
assert.equal(s2.payload.suppliers.find((s) => s.id === "deepseek").todayTokens, 1500);
assert.equal(s2.payload.suppliers.find((s) => s.id === "deepseek").current, true);
assert.equal(s2.payload.active?.supplierId, "deepseek", "最近一次调用 → 小组件显示 DeepSeek");
assert.equal(s2.payload.active?.name, "DeepSeek");
assert.equal(s2.payload.active?.model, "deepseek-v3", "active 携带最近一次调用的模型名");
assert.equal(s2.payload.active?.fresh, true);
console.log("✓ session/event 折叠：当日 1500 tokens；active=DeepSeek · deepseek-v3");

// ---- 真实 DSH 载荷（request/header + usage chunk + assistant/message）----
// 用户报告「小组件显示 近24h 无流量·按启用清单显示，实际 token 有消耗」：
// DSH 实际事件里 provider 在 message.source / header.config，usage 字段是 inputTokens。
emit({ type: "request/header", data: { header: { config: { provider: "commandcode-goat", model: "cc-model" } } } });
emit({ type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 200, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 } } } });
emit({ type: "assistant/message", data: { turn: 1, step: 1, message: { source: { provider: "commandcode-goat", model: "cc-model" } }, usage: { inputTokens: 300, outputTokens: 60 } } });
emit({ type: "assistant/message", data: { turn: 1, step: 2, message: { source: { provider: "commandcode-goat", model: "cc-model" } }, usage: { inputTokens: 40 } } });
const s4 = await call("/api/dsh-token-quota/state");
const cc2 = s4.payload.suppliers.find((s) => s.id === "commandcode");
assert.equal(cc2.current, true, "真实 DSH 载荷应驱动 commandcode 进入当前集（而非流量兜底）");
assert.equal(s4.payload.trafficStale, false, "观测到真实流量后不得再标 近24h无流量");
assert.equal(cc2.todayTokens, 400, "同一 step 的 usage 应替换而非重复累加（265→360，再 +40 = 400）");
assert.equal(s4.payload.traffic.scheme, 2, "state 应带流量诊断标记（scheme=2）");
const ccRoute = s4.payload.traffic.routes.find((r) => r.route === "commandcode-goat");
assert.ok(ccRoute && ccRoute.supplier === "commandcode", "诊断 routes 应反映 commandcode-goat → commandcode");
assert.equal(s4.payload.active?.supplierId, "commandcode", "多点真实载荷后 active 应切到最近一次调用（commandcode）");
assert.equal(s4.payload.active?.model, "cc-model", "active 模型名随最近一次调用更新");
assert.ok(s4.payload.active?.at >= s2.payload.active?.at, "同毫秒事件允许相同时间戳，供应商选择由事件序号决定");
console.log("✓ 真实 DSH 事件载荷：header.config / message.source.provider / inputTokens 折叠正确；active 跟随最近调用");

// ---- 本地用量数据落盘（防抖 2s 后落盘，重载回读一致） ----
await new Promise((r) => setTimeout(r, 2500)); // 等防抖写入
const usageFile = usageFilePath(TEST_HOME);
const onDisk = loadUsageFile(usageFile);
assert.ok(onDisk.commandcode, "commandcode 应有落盘小时桶");
const hour = hourKeyOf();
assert.equal(onDisk.commandcode[hour], 400, "落盘小时桶应等于折叠后的当日数值（含替换语义）");
assert.equal(onDisk.deepseek[hour], 1500, "legacy 载荷的 deepseek 也应落盘");
assert.equal(s4.payload.poll.retentionDays, 7, "默认保留期应为 7 天");
console.log(`✓ 本地用量数据落盘：${usageFile}（commandcode=400，deepseek=1500，载入回读一致）`);

// ---- 用户显式关闭后不被自动探测再次启用（用自动接入的 opencode 验证） ----
await call("/api/dsh-token-quota/settings", { suppliers: { opencode: { enabled: false } } });
await new Promise((r) => setTimeout(r, 3500)); // 等自动探测周期复查
assert.equal(resolved.suppliers.opencode.enabled, false, "用户显式关闭后自动探测不得重新启用");
console.log("✓ 用户显式关闭 → 自动探测尊重关闭");

// ---- settings 热更新 ----
await call("/api/dsh-token-quota/settings", { intervalSeconds: 30, suppliers: { commandcode: { enabled: true, apiKey: "sk-cc" }, deepseek: { enabled: true, apiKey: "" } } });
assert.equal(resolved.intervalSeconds, 30);
assert.equal(resolved.suppliers.deepseek.apiKey, "file-sk-DEEPSEEK_API_KEY", "空白密钥补丁保留已存凭据");
assert.equal(resolved.suppliers.commandcode.enabled, true);
const s3 = await call("/api/dsh-token-quota/state");
assert.equal(s3.payload.poll.intervalSeconds, 30);
console.log("✓ settings 路由深合并生效（interval=30，commandcode 启用）");

// ---- added 推导：仅启用（无探测无密钥）→ addedReason=enabled ----
await call("/api/dsh-token-quota/settings", { suppliers: { "openai-org": { enabled: true } } });
const sE = await call("/api/dsh-token-quota/state");
const oiE = sE.payload.suppliers.find((x) => x.id === "openai-org");
assert.equal(oiE.added, true, "仅启用（无密钥、未探测）→ 已添加");
assert.equal(oiE.addedReason, "enabled");
await call("/api/dsh-token-quota/settings", { suppliers: { "openai-org": { enabled: false } } });
console.log("✓ added 推导：探测到→detected；仅启用→enabled；未触碰→不算");

// ---- R2：POST /rescan 复用周期自动探测（幂等、尊重显式关闭）并返回 /state 载荷 ----
const rsc = await call("/api/dsh-token-quota/rescan");
assert.equal(rsc.status, 200);
assert.equal(rsc.payload.ok, true);
assert.equal(rsc.payload.suppliers.find((x) => x.id === "opencode").added, true, "opencode 仍被 DSH 探测 → 探测到即已添加（即使被用户显式关闭）");
assert.equal(resolved.suppliers.opencode.enabled, false, "rescan 不得重新启用用户显式关闭的供应商");
assert.ok(rsc.payload.detect.at, "rescan 后 detect.at 已刷新");
assert.ok(rsc.payload.detect.found.includes("commandcode"));
assert.equal((await call("/api/dsh-token-quota/rescan", null, {}, "GET")).status, 405, "rescan 仅接受 POST");
// B1：手动重扫必须对应「点击后」的新扫描（版本推进且完成版本追上目标版本）
assert.equal(rsc.payload.scan.completed, rsc.payload.scan.requested, "rescan 完成后目标版本必须已完成");
assert.equal(rsc.payload.detect.error, null, "成功重扫不得留下错误");
console.log("✓ POST /rescan：单实例扫描 + 自动填入幂等 + 尊重显式关闭 + 返回 state 载荷（版本已覆盖）");

// ---- B3：手动填写密钥 / 显式关闭不被自动填入覆盖（同一窗口的后续扫描也不覆盖）----
await call("/api/dsh-token-quota/settings", { suppliers: { opencode: { apiKey: "sk-user-typed" } } });
const keepRescan = await call("/api/dsh-token-quota/rescan");
assert.equal(resolved.suppliers.opencode.apiKey, "sk-user-typed", "自动填入不得覆盖用户手动填写的密钥");
assert.equal(keepRescan.payload.suppliers.find((s) => s.id === "opencode").keySet, true);
console.log("✓ 用户手填密钥：后续扫描不覆盖（首次复制契约）");

// ---- test 路由：401 → ok:false auth ----
const t = await call("/api/dsh-token-quota/test", { supplier: "commandcode" });
assert.equal(t.payload.ok, false);
assert.match(t.payload.error || "", /401/);
console.log("✓ test 路由：commandcode 401 →", t.payload.error);

// ---- refresh 路由（deepseek 强制刷新成功）----
const r = await call("/api/dsh-token-quota/refresh");
assert.equal(r.payload.suppliers.find((s) => s.id === "deepseek").state, "ok");
assert.equal(r.payload.history.filter((h) => h.supplier === "deepseek").length >= 1, true);
console.log("✓ refresh 路由 + 刷新历史记录");

// ---- 小组件按「当前显示页（会话）」归集最近一次调用；切页即换、互不干扰 ----
const emitTo = (session, e) => { for (const cb of ctx._events["session/event"]) cb(session, e); };
const sessA = { id: "session-a" };
const sessB = { id: "session-b" };
emitTo(sessA, { type: "assistant/message", data: { source: { provider: "deepseek-official", model: "ds-page-v3" }, usage: { inputTokens: 10 } } });
emitTo(sessB, { type: "assistant/message", data: { source: { provider: "commandcode-goat", model: "cc-page" }, usage: { inputTokens: 20 } } });
const pa = await call("/api/dsh-token-quota/state?session=session-a");
assert.equal(pa.payload.activeScope, "session-a");
assert.equal(pa.payload.active?.supplierId, "deepseek", "页 A 显示 A 的最近调用（DeepSeek）");
assert.equal(pa.payload.active?.model, "ds-page-v3");
const pb = await call("/api/dsh-token-quota/state?session=session-b");
assert.equal(pb.payload.active?.supplierId, "commandcode", "页 B 显示 B 的最近调用（Command Code）");
assert.equal(pb.payload.active?.model, "cc-page");
const pg = await call("/api/dsh-token-quota/state"); // 不带参数 = 全局最近一次（旧语义兜底）
assert.equal(pg.payload.activeScope, null);
assert.equal(pg.payload.active?.supplierId, "commandcode");
const pn = await call("/api/dsh-token-quota/state?session=");
assert.equal(pn.payload.activeScope, "");
assert.equal(pn.payload.active, null, "无当前页（空 session）严格显示暂无调用");
const px = await call("/api/dsh-token-quota/state?session=session-unknown");
assert.equal(px.payload.active, null, "未知会话页同样严格为空");
// 页 A 内再次调用 → 只影响 A；切回 B 仍是 B 的调用
emitTo(sessA, { type: "assistant/message", data: { source: { provider: "opencode-go", model: "oc-page" }, usage: { inputTokens: 30 } } });
const pa2 = await call("/api/dsh-token-quota/state?session=session-a");
assert.equal(pa2.payload.active?.supplierId, "opencode", "页 A 的最近调用更新为 OpenCode");
assert.equal(pa2.payload.active?.model, "oc-page");
const pb2 = await call("/api/dsh-token-quota/state?session=session-b");
assert.equal(pb2.payload.active?.supplierId, "commandcode", "页 B 不受页 A 新调用影响");
const pg2 = await call("/api/dsh-token-quota/state");
assert.equal(pg2.payload.active?.supplierId, "opencode", "全局最近一次跟随最后一次事件");
// refresh 也保持会话范围（手动刷新后不应把另一页的 active 带回来）
const rf = await call("/api/dsh-token-quota/refresh?session=session-b");
assert.equal(rf.payload.activeScope, "session-b");
assert.equal(rf.payload.active?.supplierId, "commandcode", "refresh 后仍显示当前页 B 的在用供应商");
console.log("✓ 当前显示页：A/B 会话独立最近调用、空/未知页严格为空、refresh 保持会话范围");

dispose();
rmSync(TEST_HOME, { recursive: true, force: true });
console.log("\n宿主半集成测试全部通过 ✔");

