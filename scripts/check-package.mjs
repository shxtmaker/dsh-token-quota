import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const npm = process.env.npm_execpath;
if (!npm) throw new Error("请通过 npm run test:pack 运行");
const packed = spawnSync(process.execPath, [npm, "pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" });
assert.equal(packed.status, 0, packed.stderr);
const [manifest] = JSON.parse(packed.stdout);
const paths = new Set(manifest.files.map((file) => file.path));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));

// 运行时模块必须逐个断言：拆分/新增模块后漏打包会让安装版直接跑不起来。
// 覆盖本轮新增的范围策略、公共结果层、供应商适配器、控制台桥接与公开规则读取器。
for (const required of [pkg.main, pkg.exports["./client"], pkg.dsh.bundle.patch,
  "lib/routes.js", "lib/storage.js", "lib/scheduler.js", "lib/usage.js", "lib/detect.js",
  "lib/providers.js", "lib/scan-coordinator.js", "lib/legacy-config.js",
  "lib/provider-policy.js", "lib/provider-common.js",
  "lib/providers/deepseek.js", "lib/providers/openrouter.js", "lib/providers/opencode.js",
  "lib/providers/commandcode.js", "lib/providers/fireworks.js", "lib/providers/opendesign.js",
  "lib/quota-reference/commandcode-monthly.js",
  "lib/runtime/console-bridge.js",
  "lib/runtime/console-readers/index.js", "lib/runtime/console-readers/deepseek-usage.js",
  "lib/runtime/console-readers/fireworks-balance.js", "lib/runtime/console-readers/opendesign-windows.js",
  "README.md"]) {
  assert.ok(paths.has(required.replace(/^\.\//, "")), `产物缺少 ${required}`);
}

// 控制台运行时必须是**生产依赖**（devDependency 在安装版里不存在）
assert.ok(pkg.dependencies?.["playwright-core"], "playwright-core 必须在 dependencies 中（控制台取数需要生产运行时）");
assert.equal(pkg.devDependencies?.["playwright-core"], undefined, "playwright-core 不得只作为开发依赖");

// 产物不得混入依赖目录、测试产物、配置备份或任何会话/凭据文件
// （注意 `browser/` 只针对控制台会话目录，不能误伤 test/browser 下的浏览器用例）
const forbidden = [
  /^node_modules\//, /^test-results\//, /^playwright-report\//, /^\.scratch\//, /^\.refs\//,
  /(^|\/)\.env($|\.)/, /credential/i, /\.cookie/i, /\.har$/i,
  /^lib\/runtime\/browser\//, /^browser\//,
  /config-rollback/i, /usage\.json$/, /(^|\/)\.git\//,
];
for (const path of paths) {
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(path), `产物混入禁止内容: ${path}`);
  }
}

// 交付包不得包含任何被排除厂商的查询实现（范围收敛的产物级校验）
const suspicious = [...paths].filter((p) => /codex|openai|anthropic|moonshot|zai|minimax/i.test(p));
assert.deepEqual(suspicious, [], `产物含被排除厂商相关文件: ${suspicious.join(", ")}`);

assert.equal(manifest.name, "dsh-token-quota");
console.log(`打包验证通过：${manifest.files.length} 个文件，${manifest.size} 字节`);
