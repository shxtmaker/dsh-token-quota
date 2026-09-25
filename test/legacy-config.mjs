// test/legacy-config.mjs — 旧 settings 文档读取（0.1.7 升级路径的关键一环）
// 用法：node --test test/legacy-config.mjs
//
// 读取目标只有两份候选：settings.yaml.imported（harness 改名后的现名）与 settings.yaml（旧名）。
// 断言重点是「宁可读不到，也不读错」：支持的子集（嵌套字典 + 标量）逐项读对，
// 遇到块标量/流式集合这类不支持的结构必须整段丢弃，绝不把半解析的值当成密钥写进配置。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLegacySections } from "../lib/legacy-config.js";

const NS = "dsh-token-quota";
const LEGACY = "quota-monitor";
const withHome = (files, run) => {
  const home = mkdtempSync(join(tmpdir(), "qm-legacy-"));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(home, name), text, "utf8");
    return run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

test("读取设置段：嵌套字典、引号、标量类型、注释与空行", () => {
  const doc = [
    "# 顶层注释",
    "unrelated:",
    "  keep: true",
    "dsh-token-quota:",
    "  intervalSeconds: 121   # 行尾注释",
    "  trafficWindowHours: 12",
    "  suppliers:",
    "    deepseek:",
    "      enabled: true",
    "      apiKey: sk-plain-123",
    "      warnPct: 85",
    "    opencode:",
    "      apiKey: \"sk-quoted:with:colons\"",
    "      critPct: 97.5",
    "      note: '单引号 # 不算注释'",
    "    blank:",
    "",
    "quota-monitor:",
    "  suppliers:",
    "    deepseek:",
    "      apiKey: sk-old",
    "      enabled: false",
    "",
  ].join("\n");
  withHome({ "settings.yaml.imported": doc }, (home) => {
    const sections = readLegacySections(home, [NS, LEGACY]);
    assert.equal(sections[NS].intervalSeconds, 121, "行尾注释必须剥掉，数字按数字读");
    assert.equal(sections[NS].trafficWindowHours, 12);
    assert.equal(sections[NS].suppliers.deepseek.apiKey, "sk-plain-123");
    assert.equal(sections[NS].suppliers.deepseek.enabled, true);
    assert.equal(sections[NS].suppliers.deepseek.warnPct, 85);
    assert.equal(sections[NS].suppliers.opencode.apiKey, "sk-quoted:with:colons", "引号内的冒号不是分隔符");
    assert.equal(sections[NS].suppliers.opencode.critPct, 97.5);
    assert.equal(sections[NS].suppliers.opencode.note, "单引号 # 不算注释");
    assert.deepEqual(sections[NS].suppliers.blank, {}, "空值 = 空字典");
    assert.equal(sections[LEGACY].suppliers.deepseek.apiKey, "sk-old", "另一段独立读取");
    assert.equal(sections.unrelated, undefined, "只要点名的段");
  });
});

test("settings.yaml 与 settings.yaml.imported 都读；未改名时以在用的 settings.yaml 为准", () => {
  withHome({
    "settings.yaml": ["dsh-token-quota:", "  intervalSeconds: 30", "  suppliers:", "    deepseek:", "      apiKey: sk-old-file"].join("\n"),
    "settings.yaml.imported": ["dsh-token-quota:", "  intervalSeconds: 90"].join("\n"),
  }, (home) => {
    const sections = readLegacySections(home, [NS]);
    // settings.yaml 还在 = harness 尚未改名导入，它才是用户最新的编辑；.imported 只贡献独有字段
    assert.equal(sections[NS].intervalSeconds, 30, "在用的 settings.yaml 覆盖改名后的存档");
    assert.equal(sections[NS].suppliers.deepseek.apiKey, "sk-old-file");
  });
});

test("不支持的结构整段丢弃，绝不半解析", () => {
  const doc = [
    "dsh-token-quota:",
    "  suppliers:",
    "    deepseek:",
    "      apiKey: |",
    "        sk-block-scalar",
    "  intervalSeconds: 60",
    "clean:",
    "  enabled: true",
  ].join("\n");
  withHome({ "settings.yaml.imported": doc }, (home) => {
    const sections = readLegacySections(home, [NS]);
    assert.equal(sections[NS], undefined, "块标量不在支持的子集内 → 整段丢弃（宁可让用户重填）");
  });
});

test("文档缺失/目录不存在/未点名段时返回空对象且不抛错", () => {
  withHome({}, (home) => {
    assert.deepEqual(readLegacySections(home, [NS]), {});
  });
  assert.deepEqual(readLegacySections("/nonexistent-dsh-home", [NS]), {});
  withHome({ "settings.yaml.imported": "dsh-token-quota:\n  a: 1\n" }, (home) => {
    assert.deepEqual(readLegacySections(home, []), {});
    assert.deepEqual(readLegacySections(home, ["other"]), {});
  });
});
