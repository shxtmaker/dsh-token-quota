import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, Config } from "../lib/index.js";
import { createCtx } from "./harness.mjs";

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
