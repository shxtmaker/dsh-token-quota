// scripts/benchmark-storage.mjs — 存储层基准（可重复、按需运行，不进入默认测试）
//
// 用法：
//   node scripts/benchmark-storage.mjs            # 默认：1/7 供应商 × 7/90 天（7 = 当前查询白名单规模）
//   node scripts/benchmark-storage.mjs --quick    # 快速档（样本更少，改动前后自查用）
//   node scripts/benchmark-storage.mjs --json     # 只输出 JSON（供报告收集）
//
// 测量项（技术方案 6.1）：
//   - 完整同步保存：flush() 的 p50/p95/max 与写盘字节数（含跨进程合并与修剪）；
//   - 当日统计读取成本：sumDayTokens（最多 24 次键查询）与旧式「遍历整份桶表」对照。
//   状态生成与事件循环开销由 scripts/benchmark-runtime.mjs 承担（需要真实插件装配）。
import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireUsageStore, saveUsageFile, hourKeyOf, dayKeyOf, sumDayTokens } from "../lib/storage.js";

const args = new Set(process.argv.slice(2));
const quick = args.has("--quick");
const jsonOnly = args.has("--json");
const SAMPLES = quick ? 5 : 10;
const SUPPLIER_COUNTS = [1, 7]; // 7 = 当前查询白名单的供应商数量
const HISTORY_DAYS = [7, 90];

const log = (...a) => { if (!jsonOnly) console.log(...a); };
const stats = (times) => {
  const sorted = [...times].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { medianMs: +at(0.5).toFixed(3), p95Ms: +at(0.95).toFixed(3), maxMs: +sorted.at(-1).toFixed(3) };
};

/** 旧口径（C1 之前）：遍历整份桶表、按日前缀求和。 */
function sumDayTokensLegacy(hours, date = new Date()) {
  if (!hours || typeof hours !== "object") return null;
  const day = dayKeyOf(date);
  let sum = 0;
  for (const [key, value] of Object.entries(hours)) if (key.startsWith(day)) sum += Number(value) || 0;
  return sum > 0 ? sum : null;
}

function makeBuckets(suppliers, days) {
  const buckets = {};
  for (let s = 0; s < suppliers; s++) {
    const hours = buckets[`supplier-${s}`] = {};
    for (let h = 0; h < days * 24; h++) hours[hourKeyOf(new Date(Date.now() - h * 3600000))] = 10_000;
  }
  return buckets;
}

function benchSave(root, suppliers, days) {
  const buckets = makeBuckets(suppliers, days);
  const file = join(root, `save-${suppliers}-${days}.json`);
  const initial = saveUsageFile(file, buckets, days);
  if (!initial.ok) throw new Error(initial.error);
  const store = acquireUsageStore(file, days);
  const bytes = statSync(file).size;
  const times = [];
  try {
    for (let i = 0; i < SAMPLES; i++) {
      store.store.buckets["supplier-0"][hourKeyOf()]++;
      store.markDirty();
      const start = performance.now();
      const result = store.flush();
      times.push(performance.now() - start);
      if (!result.ok) throw new Error(result.error);
    }
  } finally { store.release(); }
  return { suppliers, days, bytes, samples: SAMPLES, ...stats(times) };
}

function benchDaySum(suppliers, days) {
  const buckets = makeBuckets(suppliers, days);
  const loops = quick ? 2000 : 10_000;
  const measure = (fn) => {
    for (let i = 0; i < 100; i++) fn(buckets["supplier-0"]);
    const start = performance.now();
    for (let i = 0; i < loops; i++) fn(buckets["supplier-0"]);
    return +((performance.now() - start) / loops * 1000).toFixed(3); // µs/次
  };
  const next = measure((hours) => sumDayTokens(hours));
  const legacy = measure((hours) => sumDayTokensLegacy(hours));
  return { suppliers, days, keys: days * 24, nextUs: next, legacyUs: legacy, speedup: +(legacy / next).toFixed(1) };
}

const root = mkdtempSync(join(tmpdir(), "qm-benchmark-"));
const report = {
  kind: "storage", node: process.version, platform: `${process.platform} ${process.arch}`,
  generatedAt: new Date().toISOString(), quick, save: [], daySum: [],
};
try {
  for (const suppliers of SUPPLIER_COUNTS) {
    for (const days of HISTORY_DAYS) {
      const save = benchSave(root, suppliers, days);
      report.save.push(save);
      log(`保存 ${String(suppliers).padStart(2)} 供应商 / ${String(days).padStart(2)} 天：`
        + `${String(save.bytes).padStart(7)} B  p50 ${save.medianMs} ms  p95 ${save.p95Ms} ms  max ${save.maxMs} ms`);
      const day = benchDaySum(suppliers, days);
      report.daySum.push(day);
      log(`  今日统计（${day.keys} 桶）：24 键 ${day.nextUs} µs/次 vs 旧式遍历 ${day.legacyUs} µs/次（${day.speedup}×）`);
    }
  }
} finally { rmSync(root, { recursive: true, force: true }); }
if (jsonOnly) process.stdout.write(`${JSON.stringify(report)}\n`);
else log("\n说明：本机合成负载，不代表真实 DSH 服务器或真实会话性能。");
