import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, Config } from "../lib/index.js";
import { createCtx } from "./harness.mjs";
import { PROVIDERS } from "../lib/providers.js";

test("plugin instances do not share traffic and dispose releases event handlers", async () => {
  const originalHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "qm-runtime-"));
  process.env.DSH_HOME = home;
  const instances = [];
  function mount() {
    const { ctx, configRef, routes, events } = createCtx({ schema: Config, config: {} });
    const dispose = apply(ctx, configRef);
    instances.push(dispose);
    return { events, state() {
      let state;
      routes.get("/api/dsh-token-quota/state")({ method: "GET", headers: {}, url: "/api/dsh-token-quota/state" },
        { writeHead() {}, end(value) { state = JSON.parse(value); } });
      return state;
    } };
  }
  try {
    const first = mount();
    first.events.get("session/event")[0]({ id: "a" }, { type: "request/header", data: {
      config: { provider: "deepseek-official", model: "one" },
    } });
    const second = mount();
    assert.equal(first.state().active.model, "one");
    assert.equal(second.state().active, null);
    instances[0]();
    assert.equal(first.events.size, 0);
  } finally {
    for (const dispose of instances) dispose();
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
    rmSync(home, { force: true, recursive: true });
  }
});

test("state reports the last successful query time and never substitutes a failed attempt", async (t) => {
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), "qm-state-time-"));
  process.env.DSH_HOME = home;
  let time = 1_800_000_000_000;
  let queryResult = { state: "err", error: { code: "network", message: "offline" }, entries: [] };
  const success = { state: "ok", entries: [{ type: "balance", remain: "10", unit: "CNY" }], headline: { kind: "amt", amt: "¥10" } };
  t.mock.method(Date, "now", () => time);
  // 方法级调度：替换注册表上的方法实现（唯一公开接缝）
  t.mock.method(PROVIDERS.deepseek.methods, "deepseek.balance.api-key", async () => queryResult);
  const harness = createCtx({ schema: Config, config: {
    suppliers: { deepseek: { enabled: true, apiKey: "saved" } },
  } });
  const dispose = apply(harness.ctx, harness.configRef);
  t.after(() => {
    dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  const supplier = (payload) => payload.suppliers.find((s) => s.id === "deepseek");

  const failedFirst = supplier(await harness.call("/api/dsh-token-quota/refresh", {}));
  assert.equal(failedFirst.state, "err");
  assert.equal(Object.hasOwn(failedFirst, "lastSuccessAt"), false, "没有成功数据时省略成功时间");

  time += 5_000;
  queryResult = success;
  const succeeded = supplier(await harness.call("/api/dsh-token-quota/refresh", {}));
  assert.equal(succeeded.lastSuccessAt, time, "成功时间来自调度器的查询完成时刻");
  assert.equal(supplier(await harness.call("/api/dsh-token-quota/state")).lastSuccessAt, time);

  time += 5_000;
  queryResult = { state: "err", error: { code: "network", message: "offline again" }, entries: [] };
  const failedAgain = supplier(await harness.call("/api/dsh-token-quota/refresh", {}));
  assert.equal(failedAgain.state, "err");
  assert.deepEqual(failedAgain.entries, success.entries, "失败时继续提供上次有效数据");
  assert.equal(failedAgain.lastSuccessAt, succeeded.lastSuccessAt, "失败时间不得覆盖成功数据时间");
  assert.match(failedAgain.fetchedAt, /失败/);

  const changed = await harness.call("/api/dsh-token-quota/settings", {
    suppliers: { deepseek: { apiKey: "replacement", enabled: false } },
  });
  assert.equal(changed.ok, true);
  const reset = supplier(await harness.call("/api/dsh-token-quota/state"));
  assert.equal(Object.hasOwn(reset, "lastSuccessAt"), false, "配置变更后不得沿用旧凭据的数据时间");
  assert.equal(reset.error.code, "no-run");
});
