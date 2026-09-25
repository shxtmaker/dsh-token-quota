// test/migration.mjs — 旧配置的一次性迁移（改名 + 0.1.7 表单改造）
// 用法：node test/migration.mjs
//
// 覆盖两条来源与各自的守门条件：
//   1) 旧行（quota-monitor，改名前的 settings 命名空间）仍在 describe() 里 → 整段搬进本行；
//   2) 0.1.7 harness 把 <DSH_HOME>/settings.yaml 改名成 settings.yaml.imported，
//      本行当时没激活 → 段只留在这份文档里，升级后必须读回来（密钥都在里面）。
//   3) 本行已有用户层 → 绝不动；4) 全新安装 → 不写；5) describe 抛异常 → 不写、不崩。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, Config } from "../lib/index.js";
import { createCtx } from "./harness.mjs";

const NS = "dsh-token-quota";
const LEGACY_NS = "quota-monitor";
// 迁移默认首发 250ms、失败重试 5 次；测试压到近即时，避免为「放弃重试」等十几秒。
globalThis.__DSH_MIGRATION_TIMING__ = { initialDelayMs: 5, retryDelayMs: 5, maxAttempts: 2 };
/** 等迁移定时器跑完并留出余量。 */
const settle = () => new Promise((r) => setTimeout(r, 120));

const home = mkdtempSync(join(tmpdir(), "qm-migrate-ns-"));
process.env.DSH_HOME = home;
const legacySuppliers = { deepseek: { enabled: true, apiKey: "sk-legacy" } };

/** 写一份旧 settings 文档（0.1.7 改名后的形态）。 */
function writeLegacyDocument(text) {
  writeFileSync(join(home, "settings.yaml.imported"), text, "utf8");
}

// 1) 旧行仍有用户配置 ⇒ 整段拷到本行，且不写回旧行
{
  const { ctx, settings, configRef } = createCtx({
    schema: Config,
    config: {},
    foreign: [{ ns: LEGACY_NS, value: { suppliers: legacySuppliers }, user: { suppliers: legacySuppliers } }],
  });
  const dispose = apply(ctx, configRef);
  await settle();
  assert.equal(settings.writes.length, 1, "应恰好触发一次迁移写入");
  assert.equal(settings.writes[0].ns, NS, "写入目标必须是本行");
  assert.deepEqual(settings.writes[0].patch, { suppliers: legacySuppliers }, "必须整段拷贝旧用户配置（含密钥）");
  dispose();
  console.log("✓ 旧行配置已迁移到本行（旧数据保留）");
}

// 2) 旧文档（settings.yaml.imported）里的段 ⇒ 读回来并写入本行
{
  writeLegacyDocument([
    "# 旧 settings 文档（改名后）",
    "quota-monitor:",
    "  suppliers:",
    "    deepseek:",
    "      apiKey: sk-doc-legacy",
    "      enabled: true",
    "dsh-token-quota:",
    "  intervalSeconds: 120",
    "  suppliers:",
    "    opencode:",
    "      apiKey: \"sk-quoted:with-colon\"",
    "      enabled: true",
    "unrelated-section:",
    "  keep: true",
    "",
  ].join("\n"));
  const { ctx, settings, configRef } = createCtx({ schema: Config, config: {} });
  const dispose = apply(ctx, configRef);
  await settle();
  assert.equal(settings.writes.length, 1, "旧文档里的段应恰好迁移一次");
  assert.deepEqual(settings.writes[0].patch, {
    intervalSeconds: 120,
    suppliers: {
      deepseek: { apiKey: "sk-doc-legacy", enabled: true },
      opencode: { apiKey: "sk-quoted:with-colon", enabled: true },
    },
  }, "新段覆盖旧段，未涉及的行不进 patch");
  dispose();
  rmSync(join(home, "settings.yaml.imported"), { force: true });
  console.log("✓ settings.yaml.imported 里的旧段已迁移到本行");
}

// 3) 本行已有用户配置 ⇒ 不迁移、不覆盖
{
  const { ctx, settings, configRef } = createCtx({
    schema: Config,
    config: {},
    user: { suppliers: { deepseek: { apiKey: "sk-new" } } },
    foreign: [{ ns: LEGACY_NS, value: { suppliers: legacySuppliers }, user: { suppliers: legacySuppliers } }],
  });
  const dispose = apply(ctx, configRef);
  await settle();
  assert.equal(settings.writes.length, 0, "本行已有配置时不得覆盖");
  dispose();
  console.log("✓ 本行已有配置：不迁移、不覆盖");
}

// 4) 全新安装（既无旧行，也无旧文档）⇒ 不写入
{
  const { ctx, settings, configRef } = createCtx({ schema: Config, config: {} });
  const dispose = apply(ctx, configRef);
  await settle();
  assert.equal(settings.writes.length, 0, "全新安装不该产生迁移写入");
  dispose();
  console.log("✓ 全新安装：无迁移写入");
}

// 5) describe 抛异常 ⇒ 不写入、不崩（重试后留痕 warn）
{
  const warnings = [];
  const { ctx, configRef } = createCtx({ schema: Config, config: {}, logger: { info() {}, warn: (m) => warnings.push(m), error() {} } });
  ctx.settings = {
    describe: () => { throw new Error("settings backend down"); },
    update: async () => { throw new Error("must not write"); },
  };
  const dispose = apply(ctx, configRef);
  await settle();
  assert.equal(warnings.length, 1, "始终不可描述时必须 warn 留痕，不能静默");
  assert.match(warnings[0], /跳过旧配置迁移/);
  dispose();
  console.log("✓ describe 不可用：不写入、走 warn 留痕");
}

rmSync(home, { recursive: true, force: true });
console.log("\n改名/表单迁移测试全部通过 ✔");
