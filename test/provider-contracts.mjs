import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS } from "../lib/providers.js";

test("OpenCode rejects a successful HTTP response without recognized data", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, text: async () => "{}" }));
  // 只跑滚动窗口方法（allowance 需要另一把凭据，属于独立方法）
  const { runMethod } = await import("../lib/providers.js");
  const result = await runMethod("opencode", "opencode.rolling-window.api-key", { apiKey: "fake" });
  // 200 + 空对象：结构不兼容（不是「用量为 0」），必须明确归类且不产出条目
  assert.equal(result.status, "schema-mismatch");
  assert.deepEqual(result.items, []);
  assert.match(result.error.message, /结构|usage|不匹配/);
});

test("cancellation reaches the HTTP request and produces no fabricated result", async (t) => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, { signal } = {}) => {
    calls++;
    return new Promise((resolve, reject) => {
      if (!signal) return reject(new Error("no signal"));
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const { runMethod } = await import("../lib/providers.js");
  const pending = runMethod("deepseek", "deepseek.balance.api-key", { apiKey: "fake" }, { signal: controller.signal });
  controller.abort();
  // 取消必须原样上抛（由调度器丢弃结果），绝不吞成一个「失败但看起来正常」的结果
  await assert.rejects(pending);
  assert.equal(calls, 1);
});

// ---- 官方地址策略只有一个事实来源（探测可采纳地址 ≡ 查询可使用的基础地址）----
test("every official supplier accepts exactly its declared hosts/base paths and rejects the rest without network calls", async (t) => {
  const { OFFICIAL_ENDPOINTS, OFFICIAL_HOSTS, isOfficialBaseUrl } = await import("../lib/providers.js");
  // 任何被拒绝的地址都不得触发网络调用
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return { ok: true, text: async () => "{}" }; });

  const otherHost = "evil.example.com";
  const rejected = (id) => {
    const spec = OFFICIAL_ENDPOINTS[id];
    const host = spec.hosts[0];
    return [
      `https://other.example.com`,                       // 非官方主机
      `http://${host}`,                                  // 非 HTTPS
      `https://${host}:8443`,                            // 非默认端口
      `https://user:pass@${host}`,                       // 携带用户信息
      `https://${host}/v1?x=1`,                          // 查询串
      `https://${host}/v1#frag`,                         // fragment
      `https://${host}/not-a-known-base`,                // 未声明的基础路径
      `https://sub.${host}`,                             // 子域不匹配（精确主机）
      `not a url`,
      "",
    ];
  };

  for (const [id, spec] of Object.entries(OFFICIAL_ENDPOINTS)) {
    assert.deepEqual(OFFICIAL_HOSTS[id], spec.hosts, `${id} 的主机策略必须与端点策略同源`);
    // 声明过的基础路径全部可采纳
    for (const path of spec.basePaths) {
      const url = `https://${spec.hosts[0]}${path}`;
      assert.equal(isOfficialBaseUrl(id, url), true, `${id} 应采纳官方地址 ${url}`);
    }
    // 未声明的形态一律拒绝
    for (const url of rejected(id)) {
      assert.equal(isOfficialBaseUrl(id, url), false, `${id} 必须拒绝 ${JSON.stringify(url)}`);
    }
    // 通过探测校验拒绝的地址，在查询入口也不得发出请求
    const before = calls;
    const result = await PROVIDERS[id].query({ apiKey: "fake", baseUrl: `https://${otherHost}` });
    assert.equal(result.state, "err", `${id} 使用非法地址必须直接失败`);
    assert.equal(result.status, "schema-mismatch", `${id} 非法地址应报端点不匹配（实际 ${result.status}）`);
    assert.match(result.error.message, /Base URL/, `${id} 错误信息必须指出是地址问题`);
    assert.equal(calls, before, `${id} 非法地址不得触发任何网络调用`);
  }
  // 私有兼容来源没有官方白名单：它们的安全边界另行处理（只要求安全 HTTPS 形态）
  assert.equal(OFFICIAL_ENDPOINTS.opencode, undefined);
  assert.equal(OFFICIAL_ENDPOINTS.commandcode, undefined);
  assert.equal(OFFICIAL_ENDPOINTS.opendesign, undefined);
});

// ---- 被排除厂商不在端点策略中（不会因地址策略残留而被重新接入）----
test("excluded vendors have no endpoint policy and no registry entry", async () => {
  const { OFFICIAL_ENDPOINTS, PROVIDERS: registry } = await import("../lib/providers.js");
  for (const id of ["openai-org", "anthropic-org", "moonshot-cn", "moonshot-intl", "zai", "zai-cn", "minimax", "minimax-cn"]) {
    assert.equal(OFFICIAL_ENDPOINTS[id], undefined, `${id} 不得残留端点策略`);
    assert.equal(id in registry, false, `${id} 不得残留注册项`);
  }
});
