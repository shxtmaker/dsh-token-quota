import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { apply, Config } from "../lib/index.js";
import { createCtx } from "./harness.mjs";
import { PROVIDERS } from "../lib/providers.js";

test("test connection validates the current draft without persisting it", async (t) => {
  const previous = process.env.DSH_HOME, home = mkdtempSync(join(tmpdir(), "qm-draft-"));
  process.env.DSH_HOME = home;
  const queried = [];
  t.mock.method(PROVIDERS.opencode, "query", async (config) => {
    queried.push(config); return { state: "ok", entries: [], headline: { amt: "10" } };
  });
  const harness = createCtx({
    schema: Config,
    config: { suppliers: { opencode: { enabled: false, apiKey: "saved", orgId: "saved-org" } } },
  });
  const { ctx, routes } = harness;
  const dispose = apply(ctx, harness.configRef);
  t.after(() => { dispose(); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true }); });
  async function request(body) {
    const req = Object.assign(new PassThrough(), { method: "POST", headers: {} });
    let result;
    const response = routes.get("/api/dsh-token-quota/test")(req, { writeHead() {}, end(s) { result = JSON.parse(s); } });
    req.end(JSON.stringify(body)); await response; return result;
  }
  assert.equal((await request({ supplier: "opencode", config: { apiKey: "draft", orgId: "draft-org" } })).ok, true);
  assert.equal(queried[0].apiKey, "draft"); assert.equal(queried[0].orgId, "draft-org");
  assert.equal((await request({ supplier: "opencode", config: { warnPct: 200 } })).ok, false);
  assert.equal(queried.length, 1);
  await request({ supplier: "opencode" });
  assert.equal(queried[1].apiKey, "saved"); assert.equal(harness.settings.writes.length, 0, "试连接不得落盘");
});
