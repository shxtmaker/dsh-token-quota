// test/provider-policy.mjs — 验证组 A：范围白名单与排除查询
//
// 门槛（方案第 10 节 A 组）：
//   - 活动查询注册表恰好是 7 个 ID；
//   - 被排除厂商即使旧配置 enabled=true，在注册表、自动探测、调度、凭据解析、
//     手动刷新与 /test 绕过路径上都不产生任何 HTTP／进程调用；
//   - 凭据不跨平台传递；
//   - 本地被动观测映射与查询白名单分离。
import test from "node:test";
import assert from "node:assert/strict";

import {
  QUERY_PROVIDER_IDS, EXCLUDED_PROVIDER_IDS, isQueryProvider, unsupportedProviderResult,
  methodsOf, METHOD_KINDS, PASSIVE_ROUTE_MAP, passiveSupplierForRoute, parseOpenDesignWorkspace,
} from "../lib/provider-policy.js";
import { PROVIDERS, SUPPLIER_IDS, runMethod, makeLegacyQuery, buildTaskSpecs } from "../lib/providers.js";
import { createScheduler } from "../lib/scheduler.js";

/** 拦截所有网络：任何一次 fetch 都记为违约。 */
function forbidNetwork(t) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), options });
    throw new Error(`未预期的网络调用: ${url}`);
  });
  return calls;
}

test("活动查询注册表恰好是 7 个白名单 ID", () => {
  assert.deepEqual([...QUERY_PROVIDER_IDS], [
    "deepseek", "openrouter", "openrouter-account", "opencode", "commandcode", "fireworks", "opendesign",
  ]);
  assert.equal(Object.isFrozen(QUERY_PROVIDER_IDS), true, "白名单必须冻结，普通配置无法扩大范围");
  assert.deepEqual([...SUPPLIER_IDS], [...QUERY_PROVIDER_IDS], "注册表键必须与白名单一致");
  assert.deepEqual(Object.keys(PROVIDERS).sort(), [...QUERY_PROVIDER_IDS].sort());
});

test("每个白名单供应商都有已实现的方法（无空函数占位）", () => {
  for (const id of QUERY_PROVIDER_IDS) {
    const methods = methodsOf(id);
    assert.ok(methods.length > 0, `${id} 必须有活动查询方法`);
    for (const method of methods) {
      assert.match(method.methodId, /^[a-z-]+\.[a-z-]+\.[a-z-]+$/, `${method.methodId} 命名不符合 methodId 约定`);
      assert.ok(method.kinds.length > 0);
      for (const kind of method.kinds) {
        assert.ok(Object.values(METHOD_KINDS).includes(kind), `${method.methodId} 的能力类型非法`);
      }
    }
  }
  // 被排除 ID 不得有任何方法
  for (const id of EXCLUDED_PROVIDER_IDS) {
    assert.equal(isQueryProvider(id), false, `${id} 必须被排除`);
    assert.deepEqual(methodsOf(id), [], `${id} 不得有查询方法`);
    assert.equal(id in PROVIDERS, false, `${id} 不得出现在活动注册表`);
  }
});

test("被排除与未知 ID：runMethod 返回结构化 unsupported-provider 且零网络调用", async (t) => {
  const calls = forbidNetwork(t);
  for (const id of [...EXCLUDED_PROVIDER_IDS, "codex", "gemini", "xai", "unknown-vendor", "", null, undefined]) {
    const result = await runMethod(id, "anything", { apiKey: "sk-should-never-be-used" });
    assert.equal(result.status, "unsupported-provider", `${id} 必须返回 unsupported-provider`);
    assert.equal(result.excluded, true);
    assert.equal(result.items.length, 0);
    assert.equal(result.error.code, "unsupported-provider");
    assert.match(result.error.message, /不在本轮查询范围|未知或不支持/);
  }
  assert.equal(calls.length, 0, "被排除/未知 ID 不得触发任何网络调用");
});

test("旧配置 enabled=true 的被排除项：注册表查询与调度都不发请求", async (t) => {
  const calls = forbidNetwork(t);
  // 1) 注册表查询入口（旧式聚合查询）
  for (const id of EXCLUDED_PROVIDER_IDS) {
    const legacy = makeLegacyQuery(id);
    const result = await legacy({ enabled: true, apiKey: "sk-legacy", baseUrl: "" });
    assert.equal(result.state, "off");
    assert.equal(result.status, "unsupported-provider");
    assert.equal(result.excluded, true);
  }
  // 2) 调度任务构造：被排除 ID 永远得到空任务集
  for (const id of [...EXCLUDED_PROVIDER_IDS, "codex"]) {
    const specs = buildTaskSpecs(id, { enabled: true, apiKey: "sk-legacy" }, {});
    assert.deepEqual(specs, [], `${id} 不得构造任何调度任务`);
  }
  assert.equal(calls.length, 0, "旧 enabled=true 配置不得触发任何网络调用");
});

test("旧配置 enabled=true 的被排除项：调度器整体不产生任务、不取数", async (t) => {
  const calls = forbidNetwork(t);
  const configs = {
    // 白名单供应商未启用；被排除项声明 enabled=true（模拟旧配置）
    deepseek: { enabled: false, apiKey: "" },
    fireworks: { enabled: false, apiKey: "" },
  };
  for (const id of EXCLUDED_PROVIDER_IDS) configs[id] = { enabled: true, apiKey: "sk-legacy" };
  const scheduler = createScheduler({
    providers: PROVIDERS,
    getConfig: (id) => configs[id] || { enabled: false },
    getTaskSpecs: (id, cfg) => buildTaskSpecs(id, cfg, { configInstanceId: "t" }),
  });
  // 全量 tick 与逐个刷新都必须安静
  scheduler.tick();
  await Promise.all(EXCLUDED_PROVIDER_IDS.map((id) => scheduler.runProvider(id, { force: true })));
  await scheduler.runProvider("deepseek", { force: true });
  assert.equal(calls.length, 0, "被排除项不得触发任何网络调用");
  assert.deepEqual(scheduler.debugSlots(), [], "被排除项不得创建任何任务槽");
  scheduler.dispose();
});

test("自动化探测产出的补丁永远不含被排除供应商", async () => {
  const { autoFillPatch } = await import("../lib/detect.js");
  const injected = [
    { route: "openai", supplier: "openai-org", keyPresent: true, key: "sk-x", ns: "llm-pi-ai", apiKeyEnv: "OPENAI_API_KEY" },
    { route: "anthropic", supplier: "anthropic-org", keyPresent: true, key: "sk-y", ns: "llm-pi-ai", apiKeyEnv: "ANTHROPIC_API_KEY" },
    { route: "moonshotai-cn", supplier: "moonshot-cn", keyPresent: true, key: "sk-z", ns: "llm-pi-ai" },
    { route: "zai", supplier: "zai", keyPresent: true, key: "sk-w", ns: "llm-pi-ai" },
    { route: "minimax-cn", supplier: "minimax-cn", keyPresent: true, key: "sk-v", ns: "llm-pi-ai" },
    // 白名单内的一项作为对照，证明补丁机制本身工作
    { route: "deepseek-official", supplier: "deepseek", keyPresent: true, key: "sk-ok", ns: "llm-deepseek", apiKeyEnv: "DEEPSEEK_API_KEY" },
  ];
  const { patch, applied, unfilled } = autoFillPatch(injected, () => ({}), { deepseek: "https://api.deepseek.com" });
  assert.deepEqual(Object.keys(patch.suppliers), ["deepseek"], "补丁只能包含白名单供应商");
  assert.equal(applied.length, 1);
  for (const id of EXCLUDED_PROVIDER_IDS) {
    assert.equal(id in patch.suppliers, false, `${id} 绝不能被自动填入`);
  }
  assert.ok(unfilled.some((u) => u.reason === "out-of-scope"), "被排除项应记为 out-of-scope");
});

test("凭据不跨平台：每个供应商只读取自己配置里的密钥字段", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    seen.push({ url: String(url), auth: options.headers?.authorization || null, headers: options.headers || {} });
    // 直接失败，避免真实网络；这里只关心「有没有发」以及「带的是谁的凭据」
    throw new Error("no network in test");
  });
  // 只给 openrouter 配置了密钥；其他白名单供应商没有密钥 → 不得发出请求
  const cfgs = {
    openrouter: { enabled: true, apiKey: "sk-openrouter-only", baseUrl: "https://openrouter.ai/api/v1", methods: {} },
    deepseek: { enabled: true, apiKey: "", baseUrl: "https://api.deepseek.com", methods: {} },
    fireworks: { enabled: true, apiKey: "", baseUrl: "https://api.fireworks.ai", methods: {} },
    opencode: { enabled: true, apiKey: "", allowanceToken: "", baseUrl: "https://opencode.ai", methods: {} },
  };
  for (const [id, cfg] of Object.entries(cfgs)) {
    if (!cfg.apiKey) {
      const specs = buildTaskSpecs(id, cfg, {});
      assert.deepEqual(specs, [], `${id} 无密钥时不得下发任务`);
    }
  }
  const specs = buildTaskSpecs("openrouter", cfgs.openrouter, {});
  assert.ok(specs.length > 0, "有密钥的供应商应下发任务");
  for (const spec of specs) await spec.run({ signal: undefined, now: Date.now() });
  assert.ok(seen.length > 0, "应有请求发出用于检查凭据归属");
  for (const call of seen) {
    assert.match(call.url, /openrouter\.ai/, "请求只能发往该供应商自己的端点");
    assert.equal(call.auth, "Bearer sk-openrouter-only", "只能携带该供应商自己的密钥");
  }
  // 其他平台的密钥绝不能出现在发往 openrouter 的请求里
  for (const call of seen) {
    assert.ok(!JSON.stringify(call.headers).includes("sk-deepseek"), "不得跨平台传密钥");
  }
});

test("本地被动观测映射与查询白名单分离：被排除厂商的本地统计仍可归集", () => {
  // 本地历史归集：被排除厂商仍可映射（历史连续性），但不产生查询供应商
  assert.equal(passiveSupplierForRoute("moonshotai"), "moonshot-intl");
  assert.equal(passiveSupplierForRoute("zai"), "zai");
  assert.equal(passiveSupplierForRoute("minimax-cn"), "minimax-cn");
  assert.equal(isQueryProvider(passiveSupplierForRoute("moonshotai")), false, "本地映射不等于可查询");
  // 白名单厂商两侧一致
  for (const id of QUERY_PROVIDER_IDS) {
    if (PASSIVE_ROUTE_MAP[id]) assert.equal(passiveSupplierForRoute(id), id);
  }
  assert.equal(passiveSupplierForRoute("deepseek-official"), "deepseek");
  assert.equal(passiveSupplierForRoute("unknown-route"), null);
});

test("OpenDesign 工作空间输入：只接受合法 ID 或单一 workspaceId 控制台链接", () => {
  const ok = [
    "ws-abc_123",
    "https://open-design.ai/cloud/dashboard?workspaceId=ws-abc_123",
  ];
  for (const input of ok) {
    const { workspace, error } = parseOpenDesignWorkspace(input);
    assert.equal(error, null, `${input} 应被接受`);
    assert.equal(workspace, "ws-abc_123");
  }
  const bad = [
    "",
    "https://open-design.ai.evil.com/cloud/dashboard?workspaceId=ws",
    "http://open-design.ai/cloud/dashboard?workspaceId=ws",
    "https://open-design.ai:8443/cloud/dashboard?workspaceId=ws",
    "https://user:pass@open-design.ai/cloud/dashboard?workspaceId=ws",
    "https://open-design.ai/cloud/dashboard?workspaceId=ws#frag",
    "https://open-design.ai/cloud/dashboard?workspaceId=ws&action=pay",
    "https://open-design.ai/cloud/dashboard?workspaceId=ws&workspaceId=ws2",
    "https://open-design.ai/other?workspaceId=ws",
    "https://open-design.ai/cloud/dashboard",
    "ws with spaces",
  ];
  for (const input of bad) {
    const { error } = parseOpenDesignWorkspace(input);
    assert.ok(error, `${input} 应被拒绝`);
  }
});

test("unsupportedProviderResult 对被排除与未知 ID 都给出可解释原因", () => {
  const excluded = unsupportedProviderResult("openai-org");
  assert.match(excluded.error.message, /OpenAI 组织/);
  assert.match(excluded.error.message, /不在本轮查询范围/);
  const unknown = unsupportedProviderResult("gemini");
  assert.match(unknown.error.message, /未知或不支持/);
  assert.equal(unknown.status, "unsupported-provider");
});

test("每个白名单方法都有已接线的运行器（防止空实现占位）", async () => {
  const { PROVIDERS } = await import("../lib/providers.js");
  const { methodsOf } = await import("../lib/provider-policy.js");
  let total = 0;
  for (const id of QUERY_PROVIDER_IDS) {
    const methods = methodsOf(id);
    const wired = Object.keys(PROVIDERS[id].methods || {});
    for (const method of methods) {
      assert.ok(wired.includes(method.methodId),
        `${method.methodId} 必须在注册表上有运行器（不能用空函数/暂不支持占位）`);
      assert.equal(typeof PROVIDERS[id].methods[method.methodId], "function");
      total++;
    }
    // 反过来：注册表上不得挂方法矩阵之外的方法
    for (const wiredId of wired) {
      assert.ok(methods.some((m) => m.methodId === wiredId),
        `${wiredId} 不在方法矩阵中，属于未登记的实现`);
    }
  }
  assert.equal(total, 13, "当前白名单共 13 个方法");
});

test("控制台方法：无浏览器会话时给出可解释阻塞，且不产出条目", async () => {
  const { runMethod } = await import("../lib/providers.js");
  const cases = [
    ["deepseek", "deepseek.console-usage.console-session", { apiKey: "k" }],
    ["deepseek", "deepseek.console-cost.console-session", { apiKey: "k" }],
    ["fireworks", "fireworks.balance.console", { apiKey: "k" }],
    ["opendesign", "opendesign.windows.console", { workspaceId: "ws-1" }],
  ];
  for (const [id, methodId, cfg] of cases) {
    const res = await runMethod(id, methodId, cfg, {});
    assert.ok(["environment-unavailable", "auth-required"].includes(res.status),
      `${methodId} 无浏览器时应报环境/会话阻塞（实际 ${res.status}）`);
    assert.deepEqual(res.items, [], `${methodId} 阻塞时不得产出条目`);
    assert.ok(res.error?.message, `${methodId} 必须给出可解释原因`);
  }
});
