import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, Config } from "../lib/index.js";
import { createCtx } from "./harness.mjs";

test("host-derived custom routes share attribution and tool events do not change the latest call", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "qm-routes-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  // 0.1.7：pi-ai 的自定义路由从 llm-pi-ai 行的 value.providers 里读
  const harness = createCtx({
    schema: Config,
    config: { suppliers: {} },
    foreign: [{ ns: "llm-pi-ai", value: { providers: {
      "custom-a": { baseURL: "https://api.deepseek.com" },
      "custom-b": { baseURL: "https://api.deepseek.com" },
    } }, user: undefined }],
  });
  const { routes, events } = harness;
  const dispose = apply(harness.ctx, harness.configRef);
  t.after(() => { dispose(); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true }); });
  await routes.get("/api/dsh-token-quota/rescan")({ method: "POST", headers: {}, url: "/" }, { writeHead() {}, end() {} });
  const emit = (s, type, data) => harness.emit("session/event", s, { type, data });
  const read = (url = "/") => {
    let state;
    routes.get("/api/dsh-token-quota/state")({ method: "GET", headers: {}, url },
      { writeHead() {}, end(s) { state = JSON.parse(s); } });
    return state;
  };
  const a = { id: "a" }, b = { id: "b" };
  emit(a, "assistant/message", { message: { source: { provider: "custom-a", model: "a" } }, usage: { inputTokens: 100 }, turn: 1, step: 1 });
  emit(b, "assistant/message", { message: { source: { provider: "custom-b", model: "b" } }, usage: { inputTokens: 20 }, turn: 1, step: 1 });
  assert.equal(read().suppliers.find((s) => s.id === "deepseek").todayTokens, 120);
  const before = read().active;
  emit(a, "tool/result", {});
  assert.deepEqual(read().active, before);
  assert.equal(before.model, "b");
  harness.emit("api-session/removed", "a");
  assert.equal(read("/?session=a").active, null);
  assert.equal(read("/?session=b").active.model, "b");
});
