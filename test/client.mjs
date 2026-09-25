import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import React from "react";
import { create, act } from "react-test-renderer";

// 第三个参数两种用法都要支持：新的 `slot` 名称（GH v1.2.1 测试）与旧的 `location` 对象（本地用例）
// timers：数组时用作 setInterval/setTimeout 的手动桩（旧用例按索引触发）；
//         对象 { timers, document } 时启用「真实定时器 + 可切换可见性」模式（请求生命周期用例）。
function client(fetch, timers = [], third = "sidebar.footer.action", fourth) {
  const slot = typeof third === "string" ? third : (fourth || "sidebar.footer.action");
  const location = typeof third === "string" ? { search: "" } : third;
  const manual = Array.isArray(timers);
  const controls = manual ? null : timers;
  const scheduled = manual ? timers : controls.timers;
  let plugin;
  const slots = {};
  const listeners = {};
  const timersFor = (type) => (listeners[type] = listeners[type] || []);
  const document = {
    querySelector() { return true; },
    body: {},
    visibilityState: manual ? undefined : (controls.visibilityState || "visible"),
    addEventListener(type, fn) { timersFor(type).push(fn); },
    removeEventListener(type, fn) {
      if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
    },
  };
  const window = {
    __ModuleLoader__: { load({ factory }) {
      plugin = factory((id) => id === "react" ? React : { createPortal: (child) => child });
    } },
    location,
    addEventListener(type, fn) { timersFor(type).push(fn); },
    removeEventListener(type, fn) {
      if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
    },
  };
  let handleSeq = 0;
  const handles = new Map();
  const context = {
    window, document, fetch, console, location,
    AbortController, AbortSignal,
    setTimeout(fn, ms) {
      if (manual) return scheduled.push(fn);
      const handle = { id: ++handleSeq, fn, ms };
      handles.set(handle.id, handle);
      scheduled.push(handle);
      handle.native = setTimeout(() => { handles.delete(handle.id); fn(); }, ms);
      handle.native.unref?.();
      return handle;
    },
    clearTimeout(handle) {
      if (!manual && handle && handles.delete(handle.id)) {
        clearTimeout(handle.native);
        const index = scheduled.indexOf(handle);
        if (index >= 0) scheduled.splice(index, 1);
      }
    },
    setInterval(fn) { scheduled.push(fn); return fn; },
    clearInterval() {},
  };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), context);
  plugin.apply({ locale: { register() {} }, effect() {}, slots: {
    inject(name, fn) { fn(); }, register(descriptor, component) { slots[descriptor.name ?? descriptor.key] = component; },
  } });
  slots.__document = document;
  slots.__listeners = listeners;
  slots.__timers = scheduled;
  slots.__pending = (ms) => scheduled.filter((entry) => entry && typeof entry === "object" && entry.ms === ms);
  return slots[slot];
}

const payload = (name) => ({ ok: true, traffic: { channelAlive: true }, suppliers: [], active: { name, model: "model", at: Date.now() } });
const lines = (tree) => ({
  l1: tree.root.findByProps({ className: "qm-l1" }),
  l2: tree.root.findByProps({ className: "qm-l2" }),
  l3: tree.root.findByProps({ className: "qm-l3" }),
});
// React 元素的文本可能嵌在 span 里，递归取全部文本节点
const textOf = (node) => {
  const walk = (c) => Array.isArray(c) ? c.map(walk).join("") : typeof c === "string" ? c : c?.children ? walk(c.children) : "";
  return walk(node.children ?? node);
};

test("collapsed sidebar click opens and closes the detail dialog", async () => {
  const Component = client(async () => ({ json: async () => payload("A") }));
  let tree;
  try {
    await act(async () => { tree = create(React.createElement(Component, { wide: false, t: (k) => k })); });
    await act(async () => { tree.root.findByProps({ className: "qm-rail" }).props.onClick(); });
    assert.equal(tree.root.findAllByProps({ role: "dialog" }).length, 1);
    const close = tree.root.findAllByType("button").find((b) => b.props["aria-label"] === "close" || b.children.includes("close"));
    assert.ok(close);
    await act(async () => { close.props.onClick(); });
    assert.equal(tree.root.findAllByProps({ role: "dialog" }).length, 0);
  } finally { await act(async () => { tree?.unmount(); }); }
});

test("late state responses cannot overwrite a newer poll", async () => {
  const calls = [];
  const timers = [];
  const Component = client((url) => new Promise((resolve) => calls.push({ url: String(url), resolve })), { timers });
  let tree;
  const flush = async (index, name) => {
    await act(async () => { calls[index].resolve({ ok: true, json: async () => payload(name) }); });
  };
  try {
    await act(async () => { tree = create(React.createElement(Component, { wide: true, t: (k) => k })); });
    assert.equal(calls.length, 1, "挂载后应发起一次后台 GET");
    assert.ok(timers.some((t) => t?.ms === 30_000), "在途 GET 必须有 30s 初始等待上限");
    // 第一个请求回来后才会排下一次（完成后调度，不是固定间隔）：触发它形成第二个在途请求
    await flush(0, "first");
    const nextPoll = timers.find((t) => t?.ms === 10_000 && typeof t.fn === "function");
    assert.ok(nextPoll, "成功后必须排一次 10s 延迟的后续 GET");
    await act(async () => { nextPoll.fn(); });
    assert.equal(calls.length, 2, "第二次后台 GET 必须真的发出去");
    // 先回新的、再回旧的（模拟网络乱序）：旧结果绝不能回写覆盖新结果
    await flush(1, "new");
    await flush(0, "old");
    assert.ok(textOf(lines(tree).l2).includes("new"));
    assert.ok(!textOf(lines(tree).l2).includes("old"));
  } finally { await act(async () => { tree?.unmount(); }); }
});

test("wide strip renders three lines: title + today total / active supplier / meta", async () => {
  const state = {
    ok: true,
    traffic: { channelAlive: true },
    trafficStale: false,
    active: { supplierId: "opencode", name: "OpenCode", model: "deepseek-v4.1-flash", at: Date.now() - 5000 },
    suppliers: [
      { id: "opencode", name: "OpenCode", current: true, todayTokens: 64_429_367, state: "ok",
        headline: { kind: "pct", pct: "5%", reset: "约 2 小时后重置" },
        entries: [{ name: "5h 滚动", pct: 5, reset: "约 2 小时后重置" }, { name: "周用量", pct: 2, reset: "9月14日 重置" }] },
      { id: "deepseek", name: "DeepSeek", current: true, todayTokens: 1_318_275, state: "ok",
        headline: { kind: "amt", amt: "¥41.99", reset: "—" }, entries: [] },
    ],
  };
  // t 用词典式取值：{n} 占位符替换，函数式词条直接调用，与生产 LOCALES 形态一致
  const t = (key, params) => {
    const dict = { title: "用量", today: "今日 {n}", quota: "限额", noneActive: "暂无调用", countBadge: "×{n}", justNow: "刚刚", connOk: "已连接", connWarn: "已连接 · 降级", connStandby: "待命", connDown: "未连接", connFailed: "取数失败 {n} 个", resetInHM: "{h}h{m}m 后重置", resetInDH: "{d}h{h} 后重置", resetSoon: "即将重置" };
    const v = dict[key] ?? (key === "stale" ? "近 {n}h 无流量" : key);
    return String(v).replace(/\{(\w+)\}/g, (_, k) => (params && params[k] !== undefined ? params[k] : ""));
  };
  const Component = client(async () => ({ json: async () => state }));
  let tree;
  try {
    await act(async () => { tree = create(React.createElement(Component, { wide: true, t })); });
    const { l1, l2, l3 } = lines(tree);
    const strip = tree.root.findByProps({ "data-qm-variant": "A" });
    // 第 1 行：标题 + 今日全局总量（64.4M + 1.3M = 65.7M）
    assert.equal(textOf(l1), "已连接·今日 65.7M×2");
    // 第 2 行：在用供应商 · 模型
    assert.equal(textOf(l2), "OpenCode · deepseek-v4.1-flash");
    // 第 3 行：相对时间 · 限额（headline 的 5%）· 最紧条目的重置时间 · ×N 候选
    // 条目无 resetAt ⇒ 回落宿主文案；第 3 行不再含相对调用时间，也不含 ×N（已移到第 1 行）
    assert.equal(textOf(l3), "限额 5% · 约 2 小时后重置");
    assert.ok(!textOf(l3).includes("刚刚"));
    assert.ok(!textOf(l3).includes("×2"));
    // ×N 跟在第 1 行今日用量之后
    assert.ok(textOf(l1).endsWith("今日 65.7M×2"));
    assert.equal(tree.root.findByProps({ className: "qm-count" }).props.children, "×2");
    assert.equal(l3.props.title, textOf(l3));
    // 截断兜底：按钮 title = 状态/元信息 + 今日量；第 2 行自身 title = 完整「供应商 · 模型」
    assert.ok(strip.props.title.includes("今日 65.7M"));
    assert.equal(l2.findByProps({ className: "qm-strip-summary" }).props.title, "OpenCode · deepseek-v4.1-flash");
    // 状态点沿用供应商限额健康色
    assert.equal(tree.root.findAllByProps({ className: "qm-dot ok" }).length, 1);
  } finally { await act(async () => { tree?.unmount(); }); }
});

test("a page with no calls shows 暂无调用 and never borrows another page's supplier", async () => {
  const state = {
    ok: true, trafficStale: false, active: null,
    suppliers: [{ id: "deepseek", name: "DeepSeek", current: true, todayTokens: 1200, state: "ok", headline: { kind: "pct", pct: "3%", reset: "—" }, entries: [] }],
  };
  const t = (key, params) => {
    const dict = { title: "用量", today: "今日 {n}", noneActive: "暂无调用", connOk: "已连接", connWarn: "已连接 · 降级", connStandby: "待命", connDown: "未连接", connFailed: "取数失败 {n} 个", resetInHM: "{h}h{m}m 后重置", resetInDH: "{d}h{h} 后重置", resetSoon: "即将重置" };
    return String(dict[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => (params && params[k] !== undefined ? params[k] : ""));
  };
  const Component = client(async () => ({ json: async () => state }));
  let tree;
  try {
    await act(async () => { tree = create(React.createElement(Component, { wide: true, t })); });
    const { l2, l3 } = lines(tree);
    assert.equal(textOf(l2), "暂无调用");
    assert.ok(!textOf(l2).includes("DeepSeek"));
    // 无在用供应商 ⇒ 不显示限额/重置（那是「在用供应商」的信息），只留今日量与候选计数
    assert.equal(textOf(l3), "");
    assert.equal(textOf(lines(tree).l1), "待命·今日 1K");
    assert.equal(tree.root.findAllByProps({ className: "qm-count" }).length, 0);
  } finally { await act(async () => { tree?.unmount(); }); }
});

test("?qm-strip=B|C switches the wide-strip layout variant", async () => {
  const state = { ok: true, trafficStale: false, active: { supplierId: "ds", name: "DeepSeek", model: "chat", at: Date.now() }, suppliers: [] };
  const t = (key, params) => String({ title: "用量", today: "今日 {n}", connOk: "已连接", connWarn: "已连接 · 降级", connStandby: "待命", connDown: "未连接", connFailed: "取数失败 {n} 个", resetInHM: "{h}h{m}m 后重置", resetInDH: "{d}h{h} 后重置", resetSoon: "即将重置" }[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => (params && params[k] !== undefined ? params[k] : ""));
  const Component = client(async () => ({ json: async () => state }), [], { search: "?qm-strip=B" });
  let tree;
  try {
    await act(async () => { tree = create(React.createElement(Component, { wide: true, t })); });
    assert.equal(tree.root.findAllByProps({ "data-qm-variant": "B" }).length, 1);
    const b = tree.root.findByProps({ "data-qm-variant": "B" });
    assert.ok(b.props.className.includes("qm-vB"));
  } finally { await act(async () => { tree?.unmount(); }); }
});

test("reset time is rendered as a precise countdown from resetAt", async () => {
  const t = (key, params) => {
    const dict = { title: "用量", today: "今日 {n}", quota: "限额", noneActive: "暂无调用", countBadge: "×{n}",
      connOk: "已连接", connWarn: "已连接 · 降级", connStandby: "待命", connDown: "未连接", connFailed: "取数失败 {n} 个",
      resetInHM: "{h}h{m}m 后重置", resetInDH: "{d}d{h}h 后重置", resetSoon: "即将重置" };
    return String(dict[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => (params && params[k] !== undefined ? params[k] : ""));
  };
  const render = async (headline, entry) => {
    const state = {
      ok: true, traffic: { channelAlive: true },
      active: { supplierId: "cc", name: "Command Code", model: "claude-sonnet-4.5", at: Date.now() },
      suppliers: [{ id: "cc", name: "Command Code", current: true, enabled: true, added: true, state: "ok",
        todayTokens: 0, headline, entries: [entry] }],
    };
    const Component = client(async () => ({ json: async () => state }));
    let tree;
    await act(async () => { tree = create(React.createElement(Component, { wide: true, t })); });
    const out = textOf(tree.root.findByProps({ className: "qm-l3" }));
    await act(async () => { tree.unmount(); });
    return out;
  };
  // 2 小时 13 分后重置（渲染有耗时，分钟可能刚好借位，故按同一时刻算期望值并容许 1 分钟差）
  const hmAt = Date.now() + (2 * 60 + 13) * 60_000 + 30_000;
  const inHM = await render(
    { kind: "pct", pct: "5%", reset: "约 2 小时后重置", resetAt: hmAt },
    { name: "5h 窗口", pct: 5, reset: "约 2 小时后重置", resetAt: hmAt },
  );
  const hmRemain = Math.floor((hmAt - Date.now()) / 60_000);
  assert.ok(
    inHM === `限额 5% · 2h${String(hmRemain % 60).padStart(2, "0")}m 后重置`
      || inHM === `限额 5% · 2h${String((hmRemain + 1) % 60).padStart(2, "0")}m 后重置`,
    `unexpected countdown: ${inHM}`,
  );
  // 1 天 19 小时后重置
  const dhAt = Date.now() + (43 * 60) * 60_000 + 30_000;
  const inDH = await render(
    { kind: "pct", pct: "3%", reset: "9月14日 重置", resetAt: dhAt },
    { name: "周用量", pct: 3, reset: "9月14日 重置", resetAt: dhAt },
  );
  assert.equal(inDH, "限额 3% · 1d19h 后重置");
  // 已过期 → 即将重置
  const past = await render(
    { kind: "pct", pct: "1%", reset: "—", resetAt: Date.now() - 1000 },
    { name: "窗口", pct: 1, reset: "—", resetAt: Date.now() - 1000 },
  );
  assert.equal(past, "限额 1% · 即将重置");
  // 占位时刻（上游用 0 表示「没有重置时刻」）→ 不得算成「即将重置」，回落宿主文案
  const bogus = await render(
    { kind: "pct", pct: "4%", reset: "1月1日 重置", resetAt: 0 },
    { name: "5h 窗口", pct: 4, reset: "1月1日 重置", resetAt: 0 },
  );
  assert.equal(bogus, "限额 4% · 1月1日 重置");
  // 只有文案、没有时刻 → 不猜，原样回落
  const fallback = await render(
    { kind: "pct", pct: "2%", reset: "约 5 小时后重置" },
    { name: "窗口", pct: 2, reset: "约 5 小时后重置" },
  );
  assert.equal(fallback, "限额 2% · 约 5 小时后重置");
});

test("connection status degrades on fetch failure and reports 未连接 only when nothing is configured", async () => {
  const t = (key, params) => {
    const dict = { title: "用量", today: "今日 {n}", connOk: "已连接", connWarn: "已连接 · 降级", connStandby: "待命", connDown: "未连接", connFailed: "取数失败 {n} 个", resetInHM: "{h}h{m}m 后重置", resetInDH: "{d}h{h} 后重置", resetSoon: "即将重置" };
    return String(dict[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => (params && params[k] !== undefined ? params[k] : ""));
  };
  const mk = (state) => client(async () => ({ json: async () => state }));
  const render = async (state) => {
    const Component = mk(state);
    let tree;
    await act(async () => { tree = create(React.createElement(Component, { wide: true, t })); });
    const l1 = tree.root.findByProps({ className: "qm-l1" });
    const conn = tree.root.findAllByType("span")
      .filter((n) => typeof n.props.className === "string" && n.props.className.includes("qm-conn-"))
      .map((n) => ({ cls: n.props.className, text: textOf(n), title: n.props.title }));
    const out = { l1: textOf(l1), conn };
    await act(async () => { tree.unmount(); });
    return out;
  };
  // 通道活着 + 一个已配置供应商标记 err ⇒ 降级，并在连接状态 title 里带上失败个数
  const degraded = await render({
    ok: true, traffic: { channelAlive: true }, active: null,
    suppliers: [{ id: "ds", name: "DeepSeek", current: false, enabled: true, added: true, state: "err", todayTokens: 0 }],
  });
  assert.equal(degraded.conn[0].text, "已连接 · 降级");
  assert.ok(degraded.conn[0].cls.includes("qm-conn-warn"));
  assert.equal(degraded.conn[0].title, "取数失败 1 个");
  // 通道从未见流量 + 没有任何已配置供应商 ⇒ 未连接
  const down = await render({ ok: true, traffic: { channelAlive: false }, active: null, suppliers: [] });
  assert.equal(down.conn[0].text, "未连接");
  assert.ok(down.conn[0].cls.includes("qm-conn-err"));
  // 停用/未添加的供应商即使 err 也不该把整体判成降级（口径：只看 enabled ∧ added）
  const offIgnored = await render({
    ok: true, traffic: { channelAlive: true }, active: null,
    suppliers: [{ id: "ds", name: "DeepSeek", current: false, enabled: false, added: false, state: "err", todayTokens: 0 }],
  });
  assert.equal(offIgnored.conn[0].text, "已连接");
});

test("popover and detail card show the same precise reset countdown", async () => {
  const t = (key, params) => {
    const dict = { title: "用量", today: "今日 {n}", quota: "限额", detail: "详情", close: "关闭", settings: "设置",
      refresh: "刷新", usedShort: "已用", noData: "无数据", lastRefresh: "上次刷新", poll: "每 {n}s",
      detailTitle: "供应商限额明细", historySummary: "刷新历史（最近 {n} 条）", colTime: "时间", colSupplier: "供应商",
      colResult: "结果", colOk: "成功", colFail: "失败", colMain: "主指标", colNote: "备注", allConfigured: "全部（共 {n}）",
      connOk: "已连接", resetInHM: "{h}h{m}m 后重置", resetInDH: "{d}d{h}h 后重置", resetSoon: "即将重置" };
    return String(dict[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => (params && params[k] !== undefined ? params[k] : ""));
  };
  const at = Date.now() + (5 * 60 + 7) * 60_000 + 30_000;
  const state = {
    ok: true, traffic: { channelAlive: true }, trafficStale: false, active: null,
    suppliers: [{ id: "cc", name: "Command Code", current: true, added: true, enabled: true, state: "ok",
      todayTokens: 10, headline: { kind: "pct", pct: "5%", reset: "约 5 小时后重置", resetAt: at },
      entries: [{ name: "5h 窗口", kind: "win", pct: 5, remain: "95%", reset: "约 5 小时后重置", resetAt: at, note: "" }] }],
  };
  const Component = client(async () => ({ json: async () => state }));
  let tree;
  try {
    await act(async () => { tree = create(React.createElement(Component, { wide: true, t })); });
    // Popover：点开紧凑条
    await act(async () => { tree.root.findByProps({ "data-qm-variant": "A" }).props.onClick(); });
    const row = tree.root.findByProps({ className: "qm-srow-entry" });
    const rowText = textOf(row);
    assert.match(rowText, /5h\d\dm 后重置/, `popover 应显示精确倒计时: ${rowText}`);
    assert.ok(!rowText.includes("约 5 小时后重置"), "popover 不该再显示四舍五入文案");
    // 详情弹层：从 Popover 进入
    const detailBtn = tree.root.findAllByType("button").find((b) => b.children.includes("详情"));
    await act(async () => { detailBtn.props.onClick(); });
    const card = tree.root.findByProps({ className: "qm-card-item" });
    assert.match(textOf(card), /5h\d\dm 后重置/, "详情卡片应显示同一倒计时");
  } finally { await act(async () => { tree?.unmount(); }); }
});

test("settings preserve non-secret values and retain the draft on rejected saves", async () => {
  const posts = [];
  const data = { ok: true, poll: {}, suppliers: [{ id: "opencode", name: "OpenCode", added: true,
    enabled: true, orgId: "org-original", meta: { needs: [{ key: "apiKey", secret: true }, { key: "orgId", secret: false }] } }] };
  const Component = client(async (url, opts) => {
    if (opts?.method === "POST") posts.push(JSON.parse(opts.body));
    return { ok: opts?.method !== "POST", status: 400,
      json: async () => opts?.method === "POST" ? { ok: false, error: "validation rejected" } : data };
  }, [], "settings.section");
  let tree;
  try {
    // 0.1.7：设置页 section 直接渲染面板本体（无遮罩/对话框语义），外壳传 close 供「关闭设置」用
    await act(async () => { tree = create(React.createElement(Component, { t: (k) => k, close: () => {} })); });
    const pageCard = tree.root.findAll((n) => typeof n.props?.className === "string" && n.props.className.includes("qm-settings-page"));
    assert.equal(pageCard.length, 1);
    assert.equal(tree.root.findAllByProps({ role: "dialog" }).length, 0);
    await act(async () => { tree.root.findByProps({ className: "qm-page-main" }).props.onClick(); });
    assert.ok(tree.root.findAllByType("input").some((i) => i.props.value === "org-original"));
    await act(async () => { tree.root.findAllByType("button").find((b) => b.children.includes("save")).props.onClick(); });
    assert.equal(posts[0].suppliers.opencode.orgId, "org-original");
    assert.equal(tree.root.findAllByProps({ className: "qm-page-head" }).length, 1);
    assert.equal(tree.root.findAllByProps({ className: "s-saved" }).length, 0);
    assert.equal(tree.root.findByProps({ role: "alert" }).children[0], "validation rejected");
  } finally { await act(async () => tree?.unmount()); }
});

// ---- A3：阈值判定统一（详情卡 / 供应商状态药丸 / 设置预览共用同一口径） ----
const entryTones = (tree) => tree.root.findAll((n) => n.props?.className?.startsWith?.("ci-big")).map((n) => n.props.className);
const pillText = (tree) => {
  const pill = tree.root.findAll((n) => typeof n.props?.className === "string" && /^qm-pill\b/.test(n.props.className))[0];
  return pill ? textOf(pill) : null;
};

test("thresholds classify 49/50/60/70 the same way in detail cards and supplier status", async () => {
  const mkState = (warnPct, critPct) => ({
    ok: true, traffic: { channelAlive: true },
    suppliers: [{ id: "opencode", name: "OpenCode", added: true, enabled: true, current: true,
      warnPct, critPct, state: "ok", todayTokens: 0,
      headline: { kind: "pct", pct: "70%" },
      entries: [49, 50, 60, 70].map((pct) => ({ name: `e${pct}`, kind: "win", limit: "100", used: `${pct}`, remain: `${100 - pct}`, pct, reset: "—" })) }],
  });
  // 默认阈值 80/95：49/50/60/70 全是正常；状态药丸同样是 stateOk
  for (const [warnPct, critPct, expected] of [
    [undefined, undefined, ["ci-big ok", "ci-big ok", "ci-big ok", "ci-big ok"]],
    [50, 70, ["ci-big ok", "ci-big warn", "ci-big warn", "ci-big crit"]],
  ]) {
    const Component = client(async () => ({ json: async () => mkState(warnPct, critPct) }));
    let tree;
    try {
      await act(async () => { tree = create(React.createElement(Component, { wide: true, t: (k) => k })); });
      await act(async () => { tree.root.findByProps({ "data-qm-variant": "A" }).props.onClick(); });
      await act(async () => { tree.root.findAllByType("button").find((b) => textOf(b).includes("detail")).props.onClick(); });
      assert.deepEqual(entryTones(tree), expected, `warn=${warnPct} crit=${critPct} 的详情卡色调`);
      assert.equal(pillText(tree), expected.at(-1) === "ci-big crit" ? "stateCrit" : "stateOk",
        "状态药丸与详情卡同一判定");
    } finally { await act(async () => { tree?.unmount(); }); }
  }
});

test("missing or unknown percentages stay unknown instead of becoming a healthy 0%", async () => {
  const state = {
    ok: true, traffic: { channelAlive: true },
    suppliers: [{ id: "ds", name: "DeepSeek", added: true, enabled: true, current: true, warnPct: 80, critPct: 95,
      state: "ok", todayTokens: 0, headline: { kind: "amt", amt: "—" },
      entries: [
        { name: "no-pct", kind: "bal", limit: "—", used: "—", remain: "$3", pct: null, reset: "—" },
        { name: "nan-pct", kind: "win", limit: "100", used: "—", remain: "—", pct: NaN, reset: "—" },
        { name: "undef-pct", kind: "win", limit: "100", used: "—", remain: "—", pct: undefined, reset: "—" },
      ] }],
  };
  const Component = client(async () => ({ json: async () => state }));
  let tree;
  try {
    await act(async () => { tree = create(React.createElement(Component, { wide: true, t: (k) => k })); });
    await act(async () => { tree.root.findByProps({ "data-qm-variant": "A" }).props.onClick(); });
    await act(async () => { tree.root.findAllByType("button").find((b) => textOf(b).includes("detail")).props.onClick(); });
    // 未知百分比既不显示 0%，也不冒充正常（ok）；余额条保留「无限额概念」提示
    assert.deepEqual(entryTones(tree), ["ci-big err", "ci-big err", "ci-big err"]);
    assert.ok(tree.root.findAllByProps({ className: "ci-err" }).some((n) => textOf(n).includes("noQuotaConcept")));
    // 药丸仍由宿主 state 决定（无有效百分比 → stateOk），不会被未知值拉成 err
    assert.equal(pillText(tree), "stateOk");
  } finally { await act(async () => { tree?.unmount(); }); }
});
