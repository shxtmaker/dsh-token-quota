// lib/scheduler.js — 唯一调度器（方法／资源粒度，兼容旧供应商级接口）
//
// 设计要点（方案 5.4 / 8）：
//   - 任务键 = configInstanceId + providerId + methodId + resourceScope；
//     调度器是唯一任务状态持有者，不再有第二套 query-state 定时器。
//   - 缓存身份覆盖端点、凭据版本、账户／组织／工作空间／成员、解析器版本：
//     身份变化使在途结果失效（迟到响应不回填）；阈值／展示设置变化只重新投影，不清空有效值。
//   - 查询状态与告警级别分离：status 用稳定枚举，卡片 warn/crit 由有效额度投影得出。
//   - 失败保留同身份的最后成功值：不推进成功时间、不把失败当新值、不把失败写成 0。
//   - 明确「无数据」（无套餐／成功空结果）清除对应旧窗口，不永久保留「曾经存在」的套餐。
//   - 手动刷新绕过普通成功缓存，但不绕过安全检查、在途合并与 429 的 Retry-After。
//   - 窗口到达 resetAt 只触发刷新与过期标记，绝不本地推算恢复为 100%。
//
// 兼容：
//   * 提供 getTaskSpecs 时走方法级调度（生产路径）；
//   * 未提供时按供应商级单一任务运行（旧 providers[id].query 形态，供既有测试与嵌入场景）；
//   * getState(providerId) 始终返回聚合视图。

import { STATUS, projectLegacy } from "./provider-common.js";

const BACKOFF = [30_000, 60_000, 120_000, 240_000, 600_000];
const AUTH_BACKOFF = 30 * 60_000;
const LEGACY_INTERVAL_MS = 60_000;
const PARSER_VERSION = "2.0.0";

/** 方法默认间隔（毫秒）：HTTP 窗口 60s；余额／月消费 300s；控制台 300s；公开规则 24h。 */
export function defaultIntervalFor(method) {
  if (!method) return LEGACY_INTERVAL_MS;
  if (method.publicRule) return 24 * 3600_000;
  if (method.transport === "console") return 300_000;
  if (method.kinds?.length === 1 && method.kinds[0] === "window") return 60_000;
  return 300_000;
}

/** 任务键：配置实例 + 供应商 + 方法 + 资源范围。 */
export function taskKey({ configInstanceId, providerId, methodId, resourceScope }) {
  const scope = resourceScope && typeof resourceScope === "object"
    ? [resourceScope.accountId, resourceScope.orgId, resourceScope.workspaceId, resourceScope.memberId]
        .map((v) => (v === null || v === undefined ? "" : String(v))).join("|")
    : "";
  return [configInstanceId || "default", providerId, methodId || "default", scope].join("::");
}

/**
 * 缓存身份：端点 + 凭据版本 + 资源范围 + 解析器版本。
 * 凭据版本使用宿主内部 opaque 标识，不写入明文或可猜测的指纹。
 */
function identityKey({ endpoint, credentialVersion, resourceScope, extra }) {
  return [
    endpoint || "",
    credentialVersion || "",
    PARSER_VERSION,
    resourceScope?.accountId || "",
    resourceScope?.orgId || "",
    resourceScope?.workspaceId || "",
    resourceScope?.memberId || "",
    extra || "",
  ].join("|");
}

/** 旧式错误码 → 稳定查询状态（兼容旧 providers[id].query 返回值）。 */
function statusFromLegacyCode(code) {
  if (code === "auth") return STATUS.AUTH_REQUIRED;
  if (code === "schema") return STATUS.SCHEMA_MISMATCH;
  if (code === "network") return STATUS.NETWORK_ERROR;
  if (code === "no-data") return STATUS.NO_DATA;
  if (typeof code === "string" && code.startsWith("http:")) {
    const httpStatus = Number(code.slice(5));
    if (Number.isFinite(httpStatus)) {
      if (httpStatus === 401) return STATUS.AUTH_REQUIRED;
      if (httpStatus === 403) return STATUS.FORBIDDEN;
      if (httpStatus === 429) return STATUS.RATE_LIMITED;
      if (httpStatus >= 500) return STATUS.NETWORK_ERROR;
    }
    return STATUS.SCHEMA_MISMATCH;
  }
  return STATUS.NETWORK_ERROR;
}

/** 把旧式 state 结果归一化为结构化结果（仅用于兼容路径）。 */
function normalizeLegacy(res) {
  if (!res || typeof res !== "object") {
    return { status: STATUS.NO_DATA, items: [], error: { code: STATUS.NO_DATA, message: "无结果" } };
  }
  if (res.status) return res; // 已是结构化结果
  // 旧式形态：保留整份结果对象（含 entries/headline 的展示文案），结构化层只做状态归类。
  if (res.state === "err") {
    const status = statusFromLegacyCode(res.error?.code);
    return { status, items: [], error: { code: status, message: res.error?.message || status }, legacy: res };
  }
  if (res.state === "off") {
    return { status: STATUS.AUTH_REQUIRED, items: [], error: { code: STATUS.AUTH_REQUIRED, message: res.error?.message || "未配置" }, legacy: res };
  }
  return { status: STATUS.OK, items: [], legacy: res };
}

/**
 * @param opts.providers     { [providerId]: { query(cfg, {signal}) } }（兼容路径）
 * @param opts.getConfig     (providerId) => 生效配置
 * @param opts.getTaskSpecs  (providerId, cfg) => [{ methodId, run(ctx), resourceScope, identity, intervalMs, method, endpoint, credentialVersion }]
 * @param opts.onRecord      (record) => void  刷新历史
 * @param opts.now           可注入时钟（测试）
 */
export function createScheduler({ providers, getConfig, getTaskSpecs = null, onRecord = () => {}, now = Date.now }) {
  const slots = new Map();
  let disposed = false;
  let configInstanceId = "default";

  function slotFor(key, providerId, methodId) {
    let slot = slots.get(key);
    if (!slot) {
      slot = {
        key, providerId, methodId,
        last: null, lastItems: null, lastEntries: null, lastStatus: null, lastError: null,
        lastSuccessAt: null, nextAt: 0, failures: 0,
        inFlight: null, controller: null,
        identity: null, revision: 0, stale: false,
        retryAfterUntil: 0, intervalMs: LEGACY_INTERVAL_MS,
        enabled: true, legacy: false, spec: null,
      };
      slots.set(key, slot);
    }
    return slot;
  }

  /** 旧式供应商级任务（未提供 getTaskSpecs 时）。 */
  function legacySpec(providerId) {
    const provider = providers[providerId];
    return {
      methodId: null,
      legacy: true,
      method: { transport: "http", kinds: [] },
      intervalMs: LEGACY_INTERVAL_MS,
      endpoint: "",
      credentialVersion: JSON.stringify(getConfig(providerId) || {}),
      run: (ctx) => provider.query(getConfig(providerId), { signal: ctx.signal }),
    };
  }

  /** 同步某供应商的方法任务集：新增任务、身份变化使旧结果失效、关闭的方法停止调度。 */
  function syncProvider(providerId) {
    const cfg = getConfig(providerId) || {};
    const useTasks = typeof getTaskSpecs === "function";
    const specs = cfg.enabled
      ? (useTasks ? (getTaskSpecs(providerId, cfg) || []) : [legacySpec(providerId)])
      : [];
    const seen = new Set();
    for (const spec of specs) {
      const key = taskKey({ configInstanceId, providerId, methodId: spec.methodId, resourceScope: spec.resourceScope });
      seen.add(key);
      const slot = slotFor(key, providerId, spec.methodId);
      slot.intervalMs = spec.intervalMs || defaultIntervalFor(spec.method);
      slot.legacy = !!spec.legacy;
      slot.spec = spec;
      slot.enabled = true;
      const identity = identityKey({
        endpoint: spec.endpoint,
        credentialVersion: spec.credentialVersion,
        resourceScope: spec.resourceScope,
        extra: spec.identityExtra,
      });
      if (slot.identity !== null && slot.identity !== identity) {
        // 身份变化：取消在途请求、清除不匹配身份的可见数据、版本 +1 使迟到响应失效
        slot.controller?.abort();
        slot.inFlight = null;
        slot.last = null;
        slot.lastItems = null;
        slot.lastStatus = null;
        slot.lastError = null;
        slot.lastSuccessAt = null;
        slot.nextAt = 0;
        slot.failures = 0;
        slot.stale = false;
        slot.revision++;
        // 账户／凭据变更时，同供应商其他方法的在途请求一并取消（避免旧身份结果回填）
        for (const other of slots.values()) {
          if (other !== slot && other.providerId === providerId) {
            other.controller?.abort();
            other.inFlight = null;
            other.revision++;
          }
        }
      }
      slot.identity = identity;
    }
    for (const slot of slots.values()) {
      if (slot.providerId !== providerId || seen.has(slot.key)) continue;
      // 关闭的方法：不再发请求，且清除可见数据
      slot.enabled = false;
      if (slot.inFlight) {
        slot.controller?.abort();
        slot.inFlight = null;
      }
      slot.last = null;
      slot.lastItems = null;
      slot.lastStatus = null;
      slot.lastError = null;
      slot.nextAt = Infinity;
      slot.revision++;
    }
    return specs.length;
  }

  /** 执行一个方法任务。 */
  function runSlot(slot, { force = false } = {}) {
    if (disposed || slot.enabled === false || !slot.spec) return Promise.resolve(null);
    if (slot.inFlight) return slot.inFlight;
    // 429 的 Retry-After：手动刷新也不绕过
    if (slot.retryAfterUntil > now()) return Promise.resolve(slot.last);
    if (!force && slot.nextAt > now()) return Promise.resolve(slot.last);
    const revision = slot.revision;
    const controller = new AbortController();
    slot.controller = controller;
    const timeoutMs = slot.spec.timeoutMs || (slot.spec.method?.transport === "console" ? 120_000 : 60_000);
    const pending = Promise.resolve()
      .then(() => slot.spec.run({
        signal: controller.signal,
        timeoutMs,
        now: now(),
      }))
      .catch((error) => {
        if (controller.signal.aborted) return null; // 取消：不产生结果
        return {
          status: error?.status || STATUS.NETWORK_ERROR,
          items: [],
          error: { code: error?.status || STATUS.NETWORK_ERROR, message: error?.message || String(error) },
        };
      })
      .then((raw) => {
        if (raw === null) return null;
        // 版本校验：身份变化或卸载后的迟到响应一律丢弃
        if (disposed || revision !== slot.revision) return null;
        const res = normalizeLegacy(raw);
        const time = now();
        const status = res.status || STATUS.NETWORK_ERROR;
        const ok = status === STATUS.OK;
        const hasData = Array.isArray(res.items) && res.items.length > 0;
        const clearsWindow = status === STATUS.NO_DATA;
        if (ok) {
          slot.failures = 0;
          slot.retryAfterUntil = 0;
          slot.nextAt = time + slot.intervalMs;
          if (hasData) {
            slot.lastSuccessAt = time;
            slot.stale = false;
            slot.lastItems = res.items;
            slot.lastEntries = null;
          } else if (res.legacy) {
            // 旧式形态结果（含嵌入/测试替身返回 { state, entries, headline }）：
            // 整份结果作为「保留值」，展示文案（entries/headline）原样留存。
            slot.lastSuccessAt = time;
            slot.stale = false;
            slot.lastEntries = Array.isArray(res.legacy.entries) ? res.legacy.entries : [];
          } else {
            // 成功但空数据：清除对应窗口，不保留「曾经存在」
            slot.lastItems = null;
            slot.lastEntries = null;
          }
        } else {
          const delay = status === STATUS.AUTH_REQUIRED || status === STATUS.FORBIDDEN
            ? AUTH_BACKOFF
            : (res.retryAfterMs || BACKOFF[Math.min(slot.failures, BACKOFF.length - 1)]);
          slot.failures++;
          slot.nextAt = time + delay;
          if (res.retryAfterMs) slot.retryAfterUntil = time + res.retryAfterMs;
          if (clearsWindow) slot.lastItems = null;
          // 其余失败：保留同身份最后成功值，但不推进成功时间、不当作新值
          if (slot.lastSuccessAt !== null || slot.last !== null) slot.stale = true;
        }
        slot.lastStatus = status;
        slot.lastError = ok ? null : (res.error || { code: status, message: status });
        slot.last = projectSlot(slot, res, time);
        onRecord({
          t: new Date(time).toLocaleTimeString(),
          supplier: slot.providerId,
          methodId: slot.methodId,
          ok,
          error: ok ? null : `${status}: ${res.error?.message || status}`,
          summary: slot.last?.headline?.amt ?? slot.last?.headline?.pct ?? "—",
        });
        return slot.last;
      })
      .finally(() => {
        if (slot.inFlight === pending) {
          slot.inFlight = null;
          slot.controller = null;
        }
      });
    slot.inFlight = pending;
    return slot.inFlight;
  }

  /**
   * 投影任务槽 → 兼容结果。
   * 失败但保留旧值时：沿用旧 items，叠加错误状态与「失败」标记，成功时间不变。
   */
  function projectSlot(slot, res, time) {
    const cfg = getConfig(slot.providerId) || {};
    const warnPct = cfg.warnPct ?? 80;
    const critPct = cfg.critPct ?? 95;
    const failed = res.status !== STATUS.OK;
    const keepOldItems = failed && Array.isArray(slot.lastItems) && slot.lastItems.length > 0;
    // 旧式形态（无结构化 items）：保留/沿用展示文案
    const keptEntries = Array.isArray(slot.lastEntries) ? slot.lastEntries : [];
    const keepLegacy = failed && keptEntries.length > 0;
    if (!failed && res.legacy) {
      return { ...res.legacy, fetchedAt: new Date(time).toLocaleTimeString() };
    }
    // 失败但上一轮是旧式结果：保留其条目文案，状态改为 err、成功时间不推进
    if (keepLegacy) {
      const keptHeadline = slot.last?.headline ?? null;
      return {
        state: "err",
        status: res.status,
        queryStatus: res.status,
        error: res.error || { code: res.status, message: res.status },
        entries: keptEntries,
        headline: keptHeadline,
        fetchedAt: `${new Date(time).toLocaleTimeString()}（失败）`,
        oldData: true,
        ...(slot.lastSuccessAt !== null ? { lastSuccessAt: slot.lastSuccessAt } : {}),
        nextAt: Number.isFinite(slot.nextAt) ? slot.nextAt : null,
        failures: slot.failures,
      };
    }
    const items = keepOldItems ? slot.lastItems : (res.items || []);
    const projected = projectLegacy(
      {
        providerId: slot.providerId,
        methodId: slot.methodId,
        status: keepOldItems ? STATUS.OK : res.status,
        items,
        error: res.error || null,
        partial: !!res.partial,
        stale: keepOldItems,
        retryAfterMs: res.retryAfterMs || null,
      },
      { warnPct, critPct },
    );
    if (Array.isArray(slot.lastItems) && slot.lastItems.length) projected.items = slot.lastItems;
    projected.methodId = slot.methodId;
    projected.status = res.status;
    projected.queryStatus = res.status;
    projected.stale = keepOldItems;
    projected.fetchedAt = `${new Date(time).toLocaleTimeString()}${failed ? "（失败）" : ""}`;
    if (failed) {
      projected.error = res.error || { code: res.status, message: res.status };
      projected.oldData = keepOldItems;
    }
    if (slot.lastSuccessAt !== null) projected.lastSuccessAt = slot.lastSuccessAt;
    projected.nextAt = Number.isFinite(slot.nextAt) ? slot.nextAt : null;
    projected.failures = slot.failures;
    return projected;
  }

  /**
   * 执行某供应商的全部方法（HTTP 最多 4 个在途；控制台任务串行，全局最多 1 个后台取数）。
   * 注意：本函数**不是** async —— 兼容路径必须原样返回在途 Promise 本体，
   * 使并发调用者拿到同一个 Promise 并共享一次请求（旧接口契约）。
   */
  function runProvider(providerId, { force = false } = {}) {
    syncProvider(providerId);
    const mine = [...slots.values()].filter((s) => s.providerId === providerId && s.enabled !== false);
    // 兼容路径：单一旧式任务直接返回该任务的 Promise
    if (mine.length === 1 && mine[0].legacy) return runSlot(mine[0], { force });
    if (!mine.length) return Promise.resolve(null);
    const http = mine.filter((s) => s.spec?.method?.transport !== "console");
    const consoles = mine.filter((s) => s.spec?.method?.transport === "console");
    return (async () => {
      const results = [];
      for (let i = 0; i < http.length; i += 4) {
        results.push(...await Promise.all(http.slice(i, i + 4).map((s) => runSlot(s, { force }))));
      }
      for (const slot of consoles) results.push(await runSlot(slot, { force }));
      return results.filter(Boolean);
    })();
  }

  /** 聚合某供应商全部方法 → 既有 UI 使用的状态格式。 */
  function getState(providerId) {
    syncProvider(providerId);
    const mine = [...slots.values()].filter((s) => s.providerId === providerId && s.enabled !== false);
    if (!mine.length) {
      return { last: null, failures: 0, nextAt: 0, lastSuccessAt: null, inFlight: false, methods: [] };
    }
    // 兼容路径：单任务直接返回其投影结果（保持旧 getState 语义）
    if (mine.length === 1 && mine[0].legacy) {
      const slot = mine[0];
      return {
        last: slot.last ? structuredClone(slot.last) : null,
        failures: slot.failures,
        nextAt: slot.nextAt,
        lastSuccessAt: slot.lastSuccessAt,
        inFlight: !!slot.inFlight,
        methods: [],
      };
    }
    // 全部任务都来自旧式形态（嵌入/测试替身）：按旧语义返回最后一份结果
    if (mine.every((s) => s.legacy)) {
      const primary = mine.reduce((a, b) => ((b.lastSuccessAt ?? 0) > (a.lastSuccessAt ?? 0) ? b : a));
      return {
        last: primary.last ? structuredClone(primary.last) : null,
        failures: Math.max(...mine.map((s) => s.failures)),
        nextAt: Math.min(...mine.map((s) => (Number.isFinite(s.nextAt) ? s.nextAt : Infinity))),
        lastSuccessAt: primary.lastSuccessAt,
        inFlight: mine.some((s) => !!s.inFlight),
        methods: [],
      };
    }
    const cfg = getConfig(providerId) || {};
    const warnPct = cfg.warnPct ?? 80;
    const critPct = cfg.critPct ?? 95;
    const allItems = [];
    const legacyEntries = [];
    const errors = [];
    let anyOk = false;
    let inFlight = false;
    let lastSuccessAt = null;
    let nextAt = null;
    let failures = 0;
    for (const slot of mine) {
      if (slot.inFlight) inFlight = true;
      if (slot.lastSuccessAt !== null && (lastSuccessAt === null || slot.lastSuccessAt > lastSuccessAt)) lastSuccessAt = slot.lastSuccessAt;
      if (Number.isFinite(slot.nextAt) && (nextAt === null || slot.nextAt < nextAt)) nextAt = slot.nextAt;
      failures = Math.max(failures, slot.failures);
      if (slot.lastItems?.length) {
        allItems.push(...slot.lastItems);
        anyOk = true;
      }
      if (slot.lastEntries?.length) {
        legacyEntries.push(...slot.lastEntries);
        anyOk = true;
      }
      if (slot.lastStatus && slot.lastStatus !== STATUS.OK) {
        errors.push({ methodId: slot.methodId, status: slot.lastStatus, message: slot.lastError?.message || slot.lastStatus });
      }
    }
    // 状态判定：只要还有未失败的方法就是 ok（部分失败 → partial）；
    // 全部方法都失败时取首个失败状态，此时**仍保留**已取得的旧展示值。
    const failedCount = errors.length;
    const allFailed = failedCount > 0 && failedCount >= mine.length;
    const status = allFailed ? errors[0].status : STATUS.OK;
    const projected = projectLegacy(
      {
        providerId,
        methodId: null,
        status,
        items: allItems,
        error: errors.length
          ? { code: status, message: errors.map((e) => `${e.methodId || "方法"}：${e.message}`).join("；") }
          : null,
        partial: !allFailed && errors.length > 0,
        stale: mine.some((s) => s.stale),
      },
      { warnPct, critPct },
    );
    // 旧式形态的展示条目优先原样透出（不重新格式化，避免二次投影失真）
    const out = {
      ...projected,
      ...(legacyEntries.length ? { entries: legacyEntries } : {}),
      status,
      stale: mine.some((s) => s.stale),
      // 取数时刻：任一方法本轮失败即标注（与旧语义一致，供 UI 区分新旧数据）
      fetchedAt: `${new Date(Math.max(...mine.map((s) => s.lastAttemptAt || 0))).toLocaleTimeString()}${errors.length ? "（失败）" : ""}`,
      methods: mine.map((s) => ({
        methodId: s.methodId,
        status: s.lastStatus || null,
        ok: s.lastStatus === STATUS.OK,
        items: s.lastItems?.length || 0,
        lastSuccessAt: s.lastSuccessAt,
        failures: s.failures,
        inFlight: !!s.inFlight,
        nextAt: Number.isFinite(s.nextAt) ? s.nextAt : null,
        stale: !!s.stale,
        error: s.lastError || null,
      })),
    };
    if (!mine.some((s) => s.last !== null) && !errors.length) {
      out.state = "off";
      out.error = { code: "no-run", message: "尚未取数" };
    }
    return {
      last: out,
      failures,
      nextAt: nextAt ?? 0,
      lastSuccessAt,
      inFlight,
      methods: out.methods,
    };
  }

  return {
    runProvider,
    /** 兼容旧签名：run(providerId, {force, interval})。 */
    run: (providerId, options = {}) => runProvider(providerId, options),
    /** 运行单个方法（测试与定向刷新用）。 */
    runMethod(providerId, methodId, options = {}) {
      syncProvider(providerId);
      const slot = [...slots.values()].find((s) => s.providerId === providerId && s.methodId === methodId);
      return slot ? runSlot(slot, options) : Promise.resolve(null);
    },
    getState,
    sync: () => Object.keys(providers).forEach(syncProvider),
    tick() {
      for (const providerId of Object.keys(providers)) {
        if (!getConfig(providerId)?.enabled) {
          syncProvider(providerId);
          continue;
        }
        runProvider(providerId).catch(() => {});
      }
    },
    /** 配置实例变化：全部任务身份失效并重建。 */
    setConfigInstanceId(id) {
      configInstanceId = id || "default";
      for (const slot of slots.values()) {
        slot.controller?.abort();
        slot.last = null;
        slot.lastItems = null;
        slot.lastStatus = null;
        slot.lastError = null;
        slot.lastSuccessAt = null;
        slot.failures = 0;
        slot.stale = false;
        slot.revision++;
      }
      slots.clear();
    },
    /** 诊断用：任务槽摘要（不含凭据）。 */
    debugSlots() {
      return [...slots.values()].map((s) => ({
        key: s.key,
        providerId: s.providerId,
        methodId: s.methodId,
        status: s.lastStatus || null,
        failures: s.failures,
        lastSuccessAt: s.lastSuccessAt,
        stale: !!s.stale,
      }));
    },
    dispose() {
      disposed = true;
      for (const slot of slots.values()) slot.controller?.abort();
    },
  };
}
