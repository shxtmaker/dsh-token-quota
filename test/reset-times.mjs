import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS, formatReset, resetAtMs } from "../lib/providers.js";

test("Command Code zero reset placeholders never display January 1", async (t) => {
  for (const resetAt of [0, "0", 1000, "1000", "1970-01-01T00:00:00Z", "invalid"]) {
    t.mock.method(globalThis, "fetch", async (url) => {
      const path = new URL(url).pathname;
      const body = path.endsWith("/whoami") ? { org: { id: "fixture-org" } }
        : path.endsWith("/credits") ? {
          credits: { planId: "goat", monthlyCredits: 70 },
          windowLimits: {
            fiveHour: { used: 0, cap: 14, resetAt },
            weekly: { used: 0, cap: 35, resetAt },
          },
        } : { data: { planId: "goat", currentPeriodEnd: resetAt, status: "active" } };
      return { ok: true, text: async () => JSON.stringify(body) };
    });
    const result = await PROVIDERS.commandcode.query({ apiKey: "fixture", warnPct: 80, critPct: 95 });
    assert.equal(result.state, "ok");
    // 服务端窗口是真实报告值；月度进度已改为「公开规则口径」，占位时刻不得变成 1970 年
    const windows = result.entries.filter((entry) => entry.kind === "win");
    assert.equal(windows.length, 2, "5h / 周窗口各一条");
    for (const entry of windows) {
      assert.equal(entry.resetAt, null, `${resetAt}: reset epoch must be unknown`);
      assert.equal(entry.reset, "—", `${resetAt}: missing reset must not display January 1`);
      assert.match(entry.note, /未提供重置时刻/);
    }
    // 月度进度：账期结束是占位/非法值时不得输出进度（宁可暂不可得）
    assert.equal(result.entries.some((entry) => entry.name.startsWith("月度进度")), false,
      `${resetAt}: 无效账期不得输出月度进度`);
    t.mock.restoreAll();
  }
});

test("missing and invalid reset dates have no formatted calendar fallback", () => {
  for (const value of [null, undefined, 0, "0", -1, "", "invalid", new Date(0), new Date(NaN), Infinity]) {
    assert.equal(resetAtMs(value), null, String(value));
    assert.equal(formatReset(value), "—", String(value));
  }
});

test("seconds passed to millisecond reset fields cannot become 1970 dates", () => {
  for (const value of [1791129600, "1791129600", new Date(1791129600)]) {
    assert.equal(resetAtMs(value), null);
    assert.equal(formatReset(value), "—");
  }
});

test("millisecond and ISO reset timestamps remain exact including timezone offsets", async (t) => {
  const now = Date.UTC(2026, 9, 4, 16);
  const reset = now + 5 * 3600_000;
  t.mock.method(Date, "now", () => now);
  for (const value of [reset, String(reset), new Date(reset), "2026-10-05T05:00:00+08:00"]) {
    assert.equal(resetAtMs(value), reset);
    assert.equal(formatReset(value), "约 5 小时后重置");
  }
  t.mock.method(globalThis, "fetch", async (url) => ({ ok: true, text: async () => JSON.stringify(
    String(url).includes("/zen/go/v1/usage") ? { usage: {
      rolling: { percent: 0, resetsAt: "2026-10-05T05:00:00+08:00" },
      weekly: { percent: 15, resetsAt: new Date(now + 7 * 86400_000).toISOString() },
      monthly: { percent: 52, resetsAt: new Date(now + 30 * 86400_000).toISOString() },
    } } : {}
  ) }));
  const result = await PROVIDERS.opencode.query({ apiKey: "fixture", warnPct: 80, critPct: 95 });
  assert.equal(result.state, "ok");
  assert.deepEqual(result.entries.map(entry => entry.resetAt), [reset, now + 7 * 86400_000, now + 30 * 86400_000]);
});
