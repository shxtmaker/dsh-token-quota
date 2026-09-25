// test/scan-coordinator.mjs — B1/B2 扫描协调器回归（纯逻辑 + 真实插件装配）
// 用法：node --test test/scan-coordinator.mjs
//
// 覆盖技术方案 B1/B2/B3 的验收项：
//   - 常规周期触发复用进行中的扫描，不因定时到达让有效结果过期；
//   - 来源变化（路由/凭据/配置）版本 +1，旧候选不得提交；
//   - 手动重扫必须等到覆盖本次点击的新扫描；超时返回失败 +「稍后重试」，不把旧扫描包装成成功；
//   - 等待期间来源变更：旧候选不得写密钥，新一轮填入新值；
//   - 同一窗口用户手填密钥 / 显式关闭：自动填入不得覆盖；
//   - 扫描失败保留最后成功发现；成功空扫描才移除当前发现；
//   - 短时间连续事件只产生有界后续扫描，不出现并发扫描或自身 watch 无限循环；
//   - 卸载后不再扫描、不再提交，并立即释放等待者。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScanCoordinator } from "../lib/scan-coordinator.js";
import { apply } from "../lib/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 可手动放行的扫描桩：记录每次启动的版本与提交结果。 */
function harness({ scanDelay = 0, fail = false, commitImpl } = {}) {
  const state = { scans: [], commits: [], gates: [] };
  const coordinator = createScanCoordinator({
    logger: { warn: (...a) => state.warn = (state.warn || []).concat([a.join(" ")]) },
    manualTimeoutMs: 200,
    async scan({ revision }) {
      state.scans.push(revision);
      if (scanDelay) {
        let open;
        // 用 ref 定时器兜底：测试若提前结束也不会留下永不结算的 Promise
        const gate = new Promise((r) => { open = r; setTimeout(r, 2000); });
        state.gates.push(open);
        await gate;
      }
      if (fail) throw new Error("scan boom");
      return { revision, suppliers: [`s${revision}`] };
    },
    async commit(args) {
      state.commits.push({ revision: args.revision, current: args.isCurrent() });
      if (commitImpl) return commitImpl(args);
      return { committed: args.isCurrent() };
    },
  });
  return { coordinator, state };
}

test("periodic triggers reuse the in-flight scan instead of invalidating it", async () => {
  const { coordinator, state } = harness({ scanDelay: true });
  const first = coordinator.request({ reason: "startup" });
  const second = coordinator.request({ reason: "periodic" });
  const third = coordinator.request({ reason: "periodic" });
  await sleep(0);
  assert.equal(state.scans.length, 1, "三个触发只允许一次扫描");
  assert.deepEqual(coordinator.revision, { requested: 1, completed: 0 }, "周期触发不得增加版本");
  state.gates[0]();
  await Promise.all([first, second, third]);
  assert.deepEqual(coordinator.revision, { requested: 1, completed: 1 });
  assert.equal(state.commits.length, 1, "提交恰好一次");
});

test("a source change invalidates the pending candidate and a manual rescan waits for its own version", async () => {
  const { coordinator, state } = harness({ scanDelay: true });
  const startup = coordinator.request({ reason: "startup" });
  await sleep(0);
  const change = coordinator.noteSourceChange("routes");   // 版本 1 → 2
  const manual = coordinator.request({ reason: "manual", requireFresh: true }); // 版本 2 → 3
  state.gates[0]();                                         // 第 1 轮扫描完成：版本已被作废
  await startup;
  assert.deepEqual(state.commits[0], { revision: 1, current: false }, "旧候选不得提交（版本已过期）");
  await sleep(0);
  assert.equal(state.scans.length, 2, "来源变化合并启动后续扫描");
  state.gates[1]();                                         // 版本 3 的扫描完成
  const manualResult = await manual;
  assert.equal(manualResult.ok, true, "手动重扫必须拿到覆盖自己版本的结果");
  assert.equal(manualResult.revision, 3);
  await change;
  assert.equal(state.commits.at(-1).current, true);
  assert.deepEqual(coordinator.revision, { requested: 3, completed: 3 });
});

test("a manual rescan that cannot get its own result fails with retryable error instead of reporting the old scan", async () => {
  const { coordinator, state } = harness({ scanDelay: true });
  coordinator.request({ reason: "startup" });
  await sleep(0);
  const result = await coordinator.request({ reason: "manual", requireFresh: true }); // 200ms 超时
  assert.equal(result.ok, false, "拿不到本轮扫描时不得报成功");
  assert.match(result.error, /稍后重试/);
  assert.equal(result.revision >= 2, true, "失败结果必须带上目标版本供诊断");
  state.gates.forEach((open) => open());
  await sleep(5);
});

test("a scan failure keeps the last successful discovery and does not advance the version", async () => {
  let failing = false;
  const coordinator = createScanCoordinator({
    logger: { warn: () => {} },
    manualTimeoutMs: 200,
    async scan({ revision }) {
      if (failing) throw new Error("scan boom");
      return { revision, suppliers: ["keep"] };
    },
    async commit({ isCurrent }) { return { committed: isCurrent() }; },
  });
  const ok = await coordinator.request({ reason: "startup" });
  assert.equal(ok.stale, false, "成功扫描的结果不是过期候选");
  assert.deepEqual(coordinator.revision, { requested: 1, completed: 1 });
  failing = true;
  await coordinator.request({ reason: "startup-retry" });
  assert.deepEqual(coordinator.revision, { requested: 1, completed: 1 }, "失败不得推进完成版本");
});

test("consecutive source changes produce bounded, non-overlapping scans", async () => {
  const { coordinator, state } = harness({ scanDelay: true });
  coordinator.request({ reason: "startup" });
  await sleep(0);
  // 短时间连续 5 次来源变化：不逐个等待（那会被进行中的扫描卡住），模拟真实事件风暴
  for (let i = 0; i < 5; i++) {
    coordinator.noteSourceChange("routes");
    await sleep(0);
  }
  assert.equal(state.scans.length, 1, "变化期间不得并发启动第二次扫描");

  const running = new Set();
  let released = 0;
  // 逐个放行；每放行一次都检查「同时最多一个扫描」
  while (released < state.gates.length) {
    if (running.size === 0 && released < state.gates.length) {
      running.add(released);
      assert.equal(state.scans.length - released <= 1, true, "任何时刻最多一个进行中的扫描");
      state.gates[released++]();
    }
    await sleep(0);
    if (state.scans.length > released) { running.clear(); }
  }
  await sleep(5);
  assert.equal(coordinator.revision.completed, coordinator.revision.requested, "最终必须收敛到最新版本");
  assert.equal(state.scans.length, state.gates.length, "追赶轮次与启动轮次必须一致");
  assert.equal(state.scans.length <= 3, true, `连续 5 次变化只允许有界的后续扫描（实际 ${state.scans.length} 轮）`);
  assert.deepEqual(state.commits.filter((c) => c.current).map((c) => c.revision), [coordinator.revision.completed],
    "只有最新版本允许提交");
});

test("dispose prevents further scans and commits and releases waiters immediately", async () => {
  const { coordinator, state } = harness({ scanDelay: true });
  coordinator.request({ reason: "startup" });
  await sleep(0);
  const manual = coordinator.request({ reason: "manual", requireFresh: true });
  await sleep(0);
  coordinator.dispose();
  const result = await manual;
  assert.equal(result.ok, false, "卸载后等待者必须立即释放");
  assert.equal(result.disposed, true);
  state.gates.forEach((open) => open());
  await sleep(5);
  assert.equal(state.commits.every((c) => c.current === false), true, "卸载后不得提交候选");
  const afterDispose = state.scans.length;
  await coordinator.request({ reason: "periodic" });
  assert.equal(state.scans.length, afterDispose, "卸载后不得再启动扫描");
});

test("self writes are distinguished from external settings changes", async () => {
  const { coordinator } = harness();
  await coordinator.request({ reason: "startup" });
  const write = coordinator.enqueueWrite(async () => {
    // 宿主在写入期间派发 watch：应被识别为自身写入
    assert.equal(coordinator.noteSettingsChange(), true);
    return { ok: true };
  });
  assert.deepEqual(await write, { ok: true });
  assert.equal(coordinator.noteSettingsChange(), false, "写入结束后的变化属于外部变化");
  // 队列串行：后一个任务必须等前一个结束
  const order = [];
  const slow = coordinator.enqueueWrite(async () => { await sleep(10); order.push("first"); });
  const fast = coordinator.enqueueWrite(async () => { order.push("second"); });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ["first", "second"], "设置写入必须串行执行");
});

// ---------- 真实插件装配：B1/B2/B3 的端到端语义 ----------

/** 最小 Cordis ctx：settings 行 id 深合并 + volatile 更新派发 + 可切换的 llm 目录。 */
function mountPlugin({ harnessConfig = {}, userLayer = {}, failScan = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "qm-scan-"));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const config = { suppliers: {}, intervalSeconds: 3600, ...harnessConfig };
  const layer = { suppliers: {}, ...userLayer };
  const routes = new Map();
  const events = new Map();
  const updates = [];
  const failSwitch = { on: failScan };
  const applyFailure = () => { globalThis.__DSH_SCAN_FAIL__ = failSwitch.on; };
  const merge = (dst, src) => {
    for (const [key, value] of Object.entries(src)) {
      if (value && typeof value === "object" && !Array.isArray(value)) merge(dst[key] ??= {}, value);
      else dst[key] = value;
    }
  };
  // 0.1.7：settings 按行 id 描述/写入，热更新 = 引用就地更新 + loader/volatile-update
  const volatileUpdate = () => {
    for (const cb of events.get("loader/volatile-update") ?? []) cb([]);
  };
  const settings = {
    describe: () => [
      { ns: "dsh-token-quota", value: structuredClone(config), user: structuredClone(layer), revision: 1 },
      ...(harnessConfig.piAi ? [{ ns: "llm-pi-ai", value: harnessConfig.piAi, user: harnessConfig.piAi }] : []),
    ],
    update: async (ns, patch) => { updates.push({ ns, patch }); merge(config, patch); merge(layer, patch); volatileUpdate(); },
  };
  const configRef = { get: () => structuredClone(config) };
  // 扫描必须真的失败：探测函数对 settings.get 异常是容错的（会 fallback 到 ctx.settings），
  // 所以这里让 settings 这个属性访问本身就抛错 —— 注入的是「宿主服务不可用」这一类真实故障。
  const ctx = {
    get settings() { return settings; },
    get llm() { return undefined; },
    get(name) {
      if (name === "settings") return settings;
      if (name === "credentials") return { resolve: async (ref) => ({ value: `key-${ref}`, source: "file" }) };
      return undefined;
    },
    // 与 lib/detect.js 的读取顺序一致：先 ctx.get("llm")，再 ctx.llm
    get llm() { return undefined; },
    webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {}; } },
    on: (name, cb) => {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(cb);
      return () => {};
    },
    logger: { info() {}, warn() {}, error() {} },
  };
  // 失败路径的等待/重试窗口缩短（生产为 30s / 5s），集成用例不必等满
  globalThis.__DSH_SCAN_TIMING__ = { manualTimeoutMs: 300, retryAfterFailureMs: 60_000 };
  applyFailure();
  const dispose = apply(ctx, configRef);
  const readState = () => new Promise((resolve) => {
    routes.get("/api/dsh-token-quota/state")({ method: "GET", headers: {}, url: "/api/dsh-token-quota/state" },
      { writeHead() {}, end(value) { resolve(JSON.parse(value)); } });
  });
  const call = async (path) => {
    let status = 0, payload = null;
    await routes.get(path)({ method: "POST", headers: {}, url: path, on: (ev, cb) => { if (ev === "end") cb(); } },
      { writeHead: (s) => { status = s; }, end: (d) => { payload = JSON.parse(d); } });
    return { status, payload };
  };
  return {
    ctx, config, layer, updates, events, readState, call,
    setPiAi(next) { harnessConfig.piAi = next; },
    setScanFailure(on) { failSwitch.on = on; applyFailure(); },
    /** 等价于宿主写配置：改行 config 并派发 volatile 更新（插件侧读的引用随之刷新）。 */
    updateConfig(patch) { merge(config, patch); merge(layer, patch); volatileUpdate(); },
    async cleanup() {
      dispose();
      if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("auto-fill writes go through the serial queue and respect a key typed during the scan", async (t) => {
  const plugin = mountPlugin({
    harnessConfig: {
      piAi: { providers: { "opencode-go": { apiKeyEnv: "OPENCODE_GO_API_KEY" } } },
    },
  });
  t.after(() => plugin.cleanup());
  await sleep(60);
  assert.equal(plugin.config.suppliers.opencode?.apiKey, "key-OPENCODE_GO_API_KEY", "自动填入应写入探测到的密钥");
  // 用户在同一窗口手动填写密钥 → 后续扫描不得覆盖
  plugin.config.suppliers.opencode = { ...plugin.config.suppliers.opencode, apiKey: "sk-manual" };
  plugin.layer.suppliers.opencode = { apiKey: "sk-manual" };
  await plugin.call("/api/dsh-token-quota/rescan");
  assert.equal(plugin.config.suppliers.opencode.apiKey, "sk-manual", "已手动设置的密钥不得被自动填入覆盖");
});

test("a scan failure keeps the last discovery, and a successful empty scan removes it", async (t) => {
  // 周期扫描放到很远的将来：避免启动/重试扫描在断言前偷偷跑掉，失败注入才作用在扫描上
  const plugin = mountPlugin({
    intervalSeconds: 3600,
    harnessConfig: { piAi: { providers: { "opencode-go": { apiKeyEnv: "OPENCODE_GO_API_KEY" } } } },
  });
  t.after(() => plugin.cleanup());
  await sleep(60);
  const before = await plugin.readState();
  const opencode = before.suppliers.find((s) => s.id === "opencode");
  assert.equal(opencode.added, true, "探测到即已添加");
  assert.equal(opencode.autoDetected, true);

  // 扫描失败：保留上次成功发现（added 不翻转），detect.error 标明未刷新
  await failingRescan(plugin);
  const failed = await plugin.readState();
  assert.ok(failed.detect.error, "扫描失败必须记录错误");
  assert.equal(failed.suppliers.find((s) => s.id === "opencode").added, true, "扫描失败 ≠ 供应商消失");

  // 一次成功的空扫描：当前发现被移除（历史 autoSource 仍在，但不再算「当前接入」）
  plugin.setPiAi({ providers: {} });
  plugin.layer.suppliers = {};
  const empty = await plugin.call("/api/dsh-token-quota/rescan");
  assert.equal(empty.payload.ok, true);
  const cleared = await plugin.readState();
  const clearedOpencode = cleared.suppliers.find((s) => s.id === "opencode");
  assert.equal(clearedOpencode.autoDetected, false, "autoDetected 统一表示当前发现（空扫描后必须为 false）");
  assert.equal(clearedOpencode.addedReason, "enabled",
    "仍处于启用状态 → 仍算已添加（added 口径不变：探测到 ∨ 已启用 ∨ 任一密钥已填）");
  assert.equal(clearedOpencode.added, true, "已启用 → 仍可在目录中管理，但不再以「当前发现」计入");
  assert.equal(clearedOpencode.autoSource, "llm-pi-ai", "历史来源继续通过 autoSource 展示");
  assert.ok(cleared.detect.at, "成功扫描必须更新时间");
  assert.equal(cleared.detect.error, null);

  // 「无密钥、未启用、仅残留 autoSource」：成功重扫后 added 必须为 false
  plugin.updateConfig({ suppliers: { opencode: { enabled: false, apiKey: "" } } });
  plugin.layer.suppliers = {};
  await plugin.call("/api/dsh-token-quota/rescan");
  const idle = await plugin.readState();
  const idleOpencode = idle.suppliers.find((s) => s.id === "opencode");
  assert.equal(idleOpencode.autoDetected, false, "无密钥、未启用、仅残留 autoSource → 不算当前发现");
  assert.equal(idleOpencode.added, false, "无密钥、未启用、仅残留 autoSource → added=false");
  assert.equal(idleOpencode.autoSource, "llm-pi-ai", "历史来源元数据保留（不自动删除）");
});

/** 让扫描持续失败，直到本次手动重扫的结果返回。 */
async function failingRescan(plugin) {
  plugin.setScanFailure(true);
  try {
    const started = Date.now();
    const result = await plugin.call("/api/dsh-token-quota/rescan");
    assert.equal(result.payload.ok, false, "扫描失败时手动重扫不得报成功");
    assert.match(result.payload.error || "", /稍后重试|失败/, "失败必须带可诊断的错误说明");
    assert.ok(result.payload.detect?.error, "扫描失败必须记进 detect.error");
    assert.equal(result.payload.scan.completed < result.payload.scan.requested, true,
      "失败不得推进完成版本（completed 必须落后于 requested）");
    assert.equal(Date.now() - started < 5000, true, "失败必须尽快返回，不拖满等待上限");
    return result;
  } finally {
    plugin.setScanFailure(false);
  }
}


test("manual rescan returns a state payload with a fresh scan time", async (t) => {
  const plugin = mountPlugin();
  t.after(() => plugin.cleanup());
  await sleep(30);
  const manual = await plugin.call("/api/dsh-token-quota/rescan");
  assert.equal(manual.status, 200);
  assert.equal(manual.payload.ok, true, "正常手动重扫返回 state 载荷");
  assert.ok(manual.payload.detect.at, "重扫必须刷新 detect.at");
});
