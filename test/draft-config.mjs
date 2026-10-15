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
  // 方法级接缝：/test 逐个已启用方法调用注册表上的实现。
  // 这里 mock 两个方法（两种凭据各一），draft 的 apiKey/orgId 必须原样传到方法里。
  for (const methodId of ["opencode.rolling-window.api-key", "opencode.allowance.oauth"]) {
    t.mock.method(PROVIDERS.opencode.methods, methodId, async (ctx) => {
      queried.push(ctx.cfg);
      return { providerId: "opencode", methodId, status: "ok", items: [] };
    });
  }
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
  const afterFirst = queried.length;
  // 越界阈值必须被 schema 拒绝（校验失败不发起任何方法调用）
  assert.equal((await request({ supplier: "opencode", config: { warnPct: 200 } })).ok, false);
  assert.equal(queried.length, afterFirst, "校验失败不得调用方法");
  await request({ supplier: "opencode" });
  assert.equal(queried[afterFirst].apiKey, "saved", "不带 config 时使用已保存配置");
  assert.equal(harness.settings.writes.length, 0, "试连接不得落盘");
});
