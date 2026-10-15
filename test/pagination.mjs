import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS } from "../lib/providers.js";

// 分页安全的归属在本轮发生变化：
//   被排除的 OpenAI/Anthropic 组织分页实现已随范围收敛删除，
//   当前唯一需要分页的官方方法是 Fireworks 账户列表。
// 保留同一条不变量：未完成的分页绝不发布部分汇总。
test("unfinished account pagination never publishes a partial total", async () => {
  const original = globalThis.fetch;
  let page = 0;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/v1/accounts") {
      // 无限后续页：调用方必须在设上限时明确失败，而不是把已累计的账户当成全集
      return { ok: true, text: async () => JSON.stringify({
        accounts: [], nextPageToken: `cursor-${++page}`,
      }) };
    }
    return { ok: true, text: async () => JSON.stringify({ usage: 1 }) };
  };
  try {
    const result = await PROVIDERS.fireworks.query({ apiKey: "test" });
    assert.equal(result.state, "err");
    assert.match(result.error.message, /分页|上限/);
    assert.deepEqual(result.entries, [], "分页未完成时不得发布任何部分汇总");
  } finally { globalThis.fetch = original; }
});

test("repeated pagination cursor is rejected instead of looping forever", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/v1/accounts") {
      return { ok: true, text: async () => JSON.stringify({
        accounts: [{ name: "accounts/a" }], nextPageToken: "same-cursor",
      }) };
    }
    return { ok: true, text: async () => JSON.stringify({ usage: 1 }) };
  };
  try {
    const result = await PROVIDERS.fireworks.query({ apiKey: "test" });
    assert.equal(result.state, "err");
    assert.match(result.error.message, /分页|游标/);
    assert.deepEqual(result.entries, [], "重复游标时不得发布部分汇总");
  } finally { globalThis.fetch = original; }
});
