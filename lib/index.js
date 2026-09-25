// lib/index.js — 宿主半（Node 进程内运行）
// dsh-token-quota：供应商可用周期限额监控的数据与调度侧。
//   - settings 命名空间 dsh-token-quota（dsh-settings-file，热重载，密钥 role('secret') 自动脱敏；
//     suppliers schema 由 providers.js 注册表的 needs 元数据动态生成）
//   - 供应商注册表：按「凭据类别 × 地域」拆分（普通 Key / Management / Admin 不互相尝试），
//     覆盖 Token-Consumption-Monitoring docs/query-coverage.md 的官方查询；
//     OpenCode / Command Code 保留为私有兼容来源
//   - 每供应商轮询调度：全局默认 60s（10–3600 可配）、同供应商 in-flight 合并去重、
//     失败指数退避（429/5xx/网络 30s→1m→2m→4m→10m；401/403 → 30min），成功复位
//   - 当前供应商：启用 ∩ 近期流量；无 DSH 路由（或只有组织账务）的供应商恒为候选；
//     流量接缝尚未观测到任何事件时按启用清单兜底（防御性）
//   - 小组件「当前在用」：最近一次 LLM 调用命中的供应商 + 模型名；全局 routeSeen
//     之外再按 sessionId 归集 sessionRouteSeen，state 支持 ?session= 让小组件跟随
//     「当前显示页」（严格当前页：该页无调用 → 空；不带参数仍返回全局最近一次）
//   - 自动探测：ctx.llm 注册表 + settings 配置节探测 DSH 已添加供应商；
//     普通 Key 类别（官方 + pi-ai 路由）→ 自动启用 + 官方 Base URL + API Key 本体拷贝；
//     Admin/Management 类供应商 DSH 无匹配密钥 → 提示手动配置；未映射路由记 detectedUnmapped
//   - 当日消耗量：session/event 的 usage 按 provider 归并进「供应商 × 小时桶」，
//     落盘 DSH 数据目录（保留期修剪），自然日 00:00 按桶求和重置
//   - 刷新历史：每供应商最近 50 条、全局 500 条，内存保存
//   - /api/dsh-token-quota/{state,refresh,test,settings} 路由（loopback 同源守卫）

// 0.1.7 起 harness 用 @deepseek-ai/schemastery（schemastery 分支）：解析时把 volatile
// 字段换成交互引用（createVolatile），Settings 表单与 loader 热更新都建立在这套引用上。
// 用上游 schemastery 解析出的 schema 拿不到引用，配置变更会被 loader 静默吞掉。
import z from "@deepseek-ai/schemastery";
import { readLegacySections } from "./legacy-config.js";
import { createScheduler } from "./scheduler.js";
import { createScanCoordinator } from "./scan-coordinator.js";
import { createUsageRecorder } from "./usage.js";
import { createRouteResolver } from "./routes.js";
import { autoFillPatch, DSH_ROUTE_MAP, detectHarnessSuppliers } from "./detect.js";
import { PROVIDERS, SUPPLIER_IDS } from "./providers.js";
import { sumDayTokens, dshHome, acquireUsageStore, migrateUsageDir } from "./storage.js";

// 0.1.7 起 settings 表单按「profile 行 id」寻址（一行 = 一张表），不再是插件自注册的
// 命名空间；本插件 cordis.patch.yml 插入的行 id 就是它，两者同串。
const NS = "dsh-token-quota";
/** 改名前（≤ v1.1.1，0.1.7 前叫 settings 命名空间）的旧段名，仅用于一次性迁移。 */
const LEGACY_NS = "quota-monitor";
const API_PREFIX = "/api/dsh-token-quota";
/** 自身写入后，volatile 更新事件可能先于/晚于 update() 返回到达：用窗口期认领。 */
const SELF_WRITE_WINDOW_MS = 2_000;

// DSH 暴露的 LLM 路由 id → 插件供应商 id（票 04 设计点；票 10 扩展至 pi-ai 同名单路由）。
// 当前供应商的流量折叠与自动探测共用同一张表。
const ROUTE_TO_SUPPLIER = DSH_ROUTE_MAP;

const BASE_URL_DEFAULTS = Object.fromEntries(Object.keys(PROVIDERS).map((id) => [id, PROVIDERS[id].baseUrlDefault]));
const HISTORY_PER_SUPPLIER = 50;
const HISTORY_GLOBAL = 500;

// ---------- 设置 schema（Schemastery；密钥 role('secret')） ----------
// suppliers 子项由 providers.js 注册表的 needs 元数据动态生成：每把 secret 密钥一个
// role('secret') 字段，非 secret 字段（如 orgId）为普通字符串。
//
// 整棵 Config 标记 volatile（0.1.7 契约）：harness 的 loader 把它解析成一个交互引用，
//   * 表单可写 —— SettingsForms.write() 只接受 volatile 字段（否则「no volatile fields」）；
//   * 热更新不重挂 —— 变更走 loader/volatile-update 就地提交，插件内存态（历史、路由观测）
//     与本地用量桶不会被一次保存清空；
//   * 读值统一走 config.get()（见 apply 的 readConfig）。

const secretNeeds = (id) => (PROVIDERS[id]?.needs || []).filter((n) => n.secret);

const supplierSchema = (id) => {
  const meta = PROVIDERS[id];
  const shape = {
    enabled: z.boolean().default(false),
    baseUrl: z.string().default(meta.baseUrlDefault),
    warnPct: z.number().default(80).min(1).max(99),
    critPct: z.number().default(95).min(1).max(100),
    autoSource: z.string().default(""), // 自动探测来源命名空间（如 llm-deepseek / llm-pi-ai）
    autoApiKeyEnv: z.string().default(""), // 自动探测到的密钥环境变量名
  };
  // apiKey 恒为第一把密钥字段；其余 needs（allowanceToken…）按元数据追加
  shape.apiKey = z.string().role("secret").default("");
  for (const need of meta.needs || []) {
    if (need.key === "apiKey") continue;
    shape[need.key] = need.secret
      ? z.string().role("secret").default("")
      : z.string().default("");
  }
  return z.object(shape);
};

/** 标记 volatile：优先用 harness 分支的 .volatile()，缺扩展时直接写 meta（同名语义）。 */
const markVolatile = (schema) => {
  if (typeof schema?.volatile === "function") return schema.volatile();
  schema.meta = { ...schema.meta, volatile: true };
  return schema;
};

export const Config = markVolatile(z.object({
  intervalSeconds: z.number().default(60).min(10).max(3600),
  trafficWindowHours: z.number().default(24).min(1).max(24 * 7),
  retentionDays: z.number().default(7).min(1).max(90), // 保留期：本地用量数据小时桶保留天数
  suppliers: z.object(Object.fromEntries(SUPPLIER_IDS.map((id) => [id, supplierSchema(id)]))),
}));

const SECRET_NEEDS_BY_SUPPLIER = Object.fromEntries(SUPPLIER_IDS.map((id) => [id, secretNeeds(id)]));

/** 配置段深合并：对象逐键递归，数组/标量整体替换（与 settings.update 的合并语义一致）。 */
function mergeSections(base, patch) {
  const out = base && typeof base === "object" ? { ...base } : {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = mergeSections(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ---------- 每次加载创建独立运行时 ----------

export const inject = ["settings", "webServer"];

export function apply(ctx, config) {
  let disposed = false;
  const routeResolver = createRouteResolver();
  const resolveSupplier = (route) => routeResolver.resolve(route);

  // 生效配置：0.1.7 传进来的是 loader 维护的 volatile 引用（热更新就地生效）；
  // 更老的 harness 传普通对象，对象/引用两种形态都在这里收敛。
  const readConfig = () => {
    try {
      const value = typeof config?.get === "function" ? config.get() : config;
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  };

  // 自身写入的 volatile 更新事件在 update() 返回前后异步到达：窗口期内认领，避免自我触发重扫。
  let selfWrites = 0;
  const markSelfWrite = () => {
    selfWrites++;
    const timer = setTimeout(() => { selfWrites = Math.max(0, selfWrites - 1); }, SELF_WRITE_WINDOW_MS);
    timer.unref?.();
  };
  const consumeSelfWrite = () => (selfWrites > 0 ? (selfWrites--, true) : false);

  // settings 新契约按行 id 寻址：正常就是 NS；行被改名时按值形状认领自己的那一行。
  let settingsNs = NS;
  const resolveSettingsNs = () => {
    try {
      const rows = ctx.settings?.describe?.() || [];
      if (rows.some((d) => d?.ns === NS)) return NS;
      const mine = rows.find((d) => d?.value && typeof d.value === "object"
        && "suppliers" in d.value && "intervalSeconds" in d.value);
      if (mine?.ns) return mine.ns;
    } catch {
      /* describe 不可用：按行 id 尝试 */
    }
    return NS;
  };

  /** 写配置：0.1.7 的 settings.update 按行 id 深合并 patch（未提及字段保持不动）。 */
  async function writeSettings(patch) {
    settingsNs = resolveSettingsNs();
    markSelfWrite();
    return ctx.settings.update(settingsNs, patch);
  }

  const runtime = {
    // 只读派生：每次读都取引用当前值，配置热更新后无需任何刷新动作
    get config() { return readConfig(); },
    history: [], // 全局环形 [{t, supplier, ok, error, summary}]
    routeSeen: {}, // routeId -> { lastSeenAt, lastModel, seq }（seq 为单调事件序号，同毫秒事件也严格有序）
    routeSeq: 0,
    sessionRouteSeen: {}, // sessionId -> routeId -> { lastSeenAt, lastModel, seq }（「当前显示页」按会话归集）
    usageBuckets: {}, // supplierId -> { "YYYYMMDDHH": tokens }（本地用量数据，落盘）
    usageFile: null, // <DSH_HOME>/dsh-token-quota/usage.json
    channelAlive: null, // null=未知(兜底启用清单) true=已观测到事件 false=不可用
    harness: {}, // supplierId -> { route, baseUrl, apiKeyEnv, apiKey, keySource }（探测结果，密钥仅宿主内存）
    unmapped: [], // 探测到但无插件供应商的路由（仅提示，不含密钥）
    detect: {
      error: null,
      at: null,
      llmPresent: false,
      credentialsPresent: false,
      directoryEntries: 0,
      liveRoutes: [],
      candidates: [],
      included: [],
      found: [],
      unmapped: [],
    }, // 探测诊断（仅非密钥字段）
  };

  // 解析供应商配置；apiKey 为空时若命中自动探测（autoSource），回退使用宿主内存解析的 DSH 密钥
  const supplierCfg = (id) => {
    const c = runtime.config.suppliers?.[id] || {};
    let apiKey = c.apiKey || "";
    if (!apiKey && c.autoSource) {
      apiKey = runtime.harness[id]?.apiKey || "";
    }
    return {
      ...c,
      apiKey,
      baseUrl: c.baseUrl || PROVIDERS[id]?.baseUrlDefault || "",
      warnPct: c.warnPct ?? 80,
      critPct: c.critPct ?? 95,
    };
  };

  /** DSH settings 全局描述里，某命名空间 user 层在 path 处是否有值（= 用户真正配置过）。 */
  function settingsUserHas(ctx, ns, path) {
    if (!ns || !ctx.settings?.describe) return false;
    try {
      const desc = ctx.settings.describe({ redactSecrets: true }).find((d) => d.ns === ns);
      const user = desc?.user;
      if (!user || typeof user !== "object") return false;
      if (!path || path.length === 0) return Object.keys(user).length > 0;
      let cur = user;
      for (const key of path) {
        if (cur === null || typeof cur !== "object" || !(key in cur)) return false;
        cur = cur[key];
      }
      return true;
    } catch {
      return false;
    }
  }

  function pushHistory(record) {
    runtime.history.push(record);
    const count = runtime.history.filter((h) => h.supplier === record.supplier).length;
    if (count > HISTORY_PER_SUPPLIER) {
      const first = runtime.history.findIndex((h) => h.supplier === record.supplier);
      if (first >= 0) runtime.history.splice(first, 1);
    }
    if (runtime.history.length > HISTORY_GLOBAL) {
      runtime.history.splice(0, runtime.history.length - HISTORY_GLOBAL);
    }
  }

  // ---------- 取数调度 ----------

  const scheduler = createScheduler({ providers: PROVIDERS, getConfig: supplierCfg, onRecord: pushHistory });
  const runQuery = (id, options) => scheduler.run(id, {
    interval: (runtime.config.intervalSeconds || 60) * 1000, ...options,
  });
  function tickSuppliers() {
    scheduler.tick((runtime.config.intervalSeconds || 60) * 1000);
  }

  // ---------- 当前供应商（Q11=C）与当日消耗量 ----------

  // 某供应商在当前观测里命中的 DSH 路由 id（真实事件优先，精确表兜底）；无 → null
  const routeForSupplier = (id) =>
    Object.keys(runtime.routeSeen).filter((r) => resolveSupplier(r) === id)
      .sort((a, b) => runtime.routeSeen[b].lastSeenAt - runtime.routeSeen[a].lastSeenAt)[0] ||
    Object.keys(ROUTE_TO_SUPPLIER).find((r) => ROUTE_TO_SUPPLIER[r] === id) ||
    null;

  function collectTraffic() {
    const enabledIds = Object.keys(PROVIDERS).filter((id) => supplierCfg(id).enabled);
    let currentIds = enabledIds.filter((id) => {
      // 优先用真实观测到的路由 id（pi-ai declared 变体也能命中前缀映射），再退化到精确表
      const routeId = routeForSupplier(id);
      if (!routeId) return true; // 无 DSH 路由 → 恒候选
      if (runtime.channelAlive === null) return true; // 接缝未知 → 启用清单兜底
      const seen = runtime.routeSeen[routeId];
      if (!seen) return false;
      return Date.now() - seen.lastSeenAt <= (runtime.config.trafficWindowHours || 24) * 3600_000;
    });
    // 兜底（用户报告「小组件信息消失」后确认）：没有任何供应商有近期流量时，
    // 小组件按启用清单显示，避免数据健康却渲染成空态；有任一近期流量则维持过滤。
    const trafficStale = enabledIds.length > 0 && currentIds.length === 0;
    if (trafficStale) currentIds = enabledIds;
    // 今日统计只读当天 24 个本地小时键（不再随历史长度遍历整份桶表）；
    // 自然日边界在 buildStatePayload 开始时捕获一次，本轮所有供应商共用。
    const now = new Date();
    const todayOf = (id) => sumDayTokens(runtime.usageBuckets[id], now);
    return { currentIds, todayOf, trafficStale };
  }

  // ---------- 「当前在用」供应商（小组件紧凑条主显示） ----------
  // 语义（用户选定）：最近一次真实 LLM 调用命中的供应商 + 模型名。
  // 只统计能映射到插件供应商的 route（session/event 已把 route/model 折叠进各 routeSeen 表）；
  // 与 enabled/current 过滤解耦：DSH 真在用的供应商即使本插件未启用也照实显示。
  // 同时维护两张表：全局 routeSeen（Popover「当前供应商/近 24h 无流量」沿用）与
  // 按 sessionId 归集的 sessionRouteSeen（小组件跟随「当前显示页」的最近调用）。
  function pickActiveFromRoutes(routes) {
    let best = null; // { seq, supplierId, model, at }
    for (const [route, seen] of Object.entries(routes || {})) {
      const seq = Number(seen?.seq) || 0;
      if (!seq || (best && best.seq >= seq)) continue;
      const supplierId = resolveSupplier(route);
      if (!supplierId || !PROVIDERS[supplierId]) continue;
      best = {
        seq,
        supplierId,
        model: seen.lastModel || null,
        at: Number(seen.lastSeenAt) || 0,
      };
    }
    if (!best) return null;
    const fresh = Date.now() - best.at <= (runtime.config.trafficWindowHours || 24) * 3600_000;
    return {
      supplierId: best.supplierId,
      name: PROVIDERS[best.supplierId].name,
      model: best.model,
      at: best.at,
      atText: new Date(best.at).toLocaleTimeString(),
      fresh,
    };
  }

  /** 全局最近一次（旧语义 / 无 sessions 服务的嵌入场景兜底）。 */
  function computeActiveSupplier() {
    return pickActiveFromRoutes(runtime.routeSeen);
  }

  /** 指定会话页的最近一次调用；该页尚无映射调用返回 null（严格当前页，不回退全局）。 */
  function computeActiveSupplierFor(sessionId) {
    return pickActiveFromRoutes(runtime.sessionRouteSeen[sessionId] || null);
  }

  // ---------- HTTP ----------

  function sameOriginGuard(req, res, method) {
    if (req.method !== method) {
      writeJson(res, 405, { ok: false, error: "method not allowed" });
      return false;
    }
    const origin = req.headers.origin || "";
    if (!origin) return true; // 非浏览器客户端（curl 等）放行——本机开发姿态
    try {
      const source = new URL(origin);
      const target = new URL(`${req.socket?.encrypted ? "https" : "http"}://${req.headers.host}`);
      if (source.origin === target.origin && ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) return true;
    } catch {
      /* 解析失败即拒绝 */
    }
    writeJson(res, 403, { ok: false, error: "forbidden" });
    return false;
  }

  function writeJson(res, status, payload) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(payload));
  }

  /** 解析 ?session= 查询参数：缺参 → null（全局）；`?session=` / `?session=id` → 按当前页严格计算。 */
  function readSessionQuery(req) {
    try {
      const url = new URL(String(req?.url || "/"), "http://localhost");
      if (!url.searchParams.has("session")) return null;
      return url.searchParams.get("session") ?? "";
    } catch {
      return null;
    }
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) {
          reject(new Error("payload too large"));
          req.destroy();
        }
      });
      req.on("end", () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          reject(new Error("bad json"));
        }
      });
      req.on("error", reject);
    });
  }

  function buildStatePayload(session = null) {
    const { currentIds, todayOf, trafficStale } = collectTraffic();
    // 当前发现集合：最近一次「成功」扫描的结果。扫描失败不清空（保留上次成功发现），
    // 失败由 detect.error + 最后成功时间标明「未刷新」；只有一次成功的空扫描才移除发现状态。
    const currentFound = runtime.detect.error ? (runtime.detect.lastFound || []) : (runtime.detect.found || []);
    // 流量诊断（供排查「近 24h 无流量」误报；scheme=2 标记新事件折叠代码已生效）
    const winMs = (runtime.config.trafficWindowHours || 24) * 3600_000;
    const windowHours = runtime.config.trafficWindowHours || 24;
    const trafficDiag = {
      scheme: 2,
      channelAlive: runtime.channelAlive,
      windowHours,
      usageFile: runtime.usageFile,
      routes: Object.keys(runtime.routeSeen).map((route) => {
        const seen = runtime.routeSeen[route];
        return {
          route,
          supplier: resolveSupplier(route),
          lastSeenAt: new Date(seen.lastSeenAt).toLocaleTimeString(),
          lastModel: seen.lastModel || null,
        };
      }),
      suppliers: Object.keys(PROVIDERS)
        .filter((id) => supplierCfg(id).enabled)
        .map((id) => {
          const routeId = routeForSupplier(id);
          const seen = routeId ? runtime.routeSeen[routeId] : undefined;
          return {
            id,
            routeId,
            seen: !!seen,
            lastSeenAt: seen ? new Date(seen.lastSeenAt).toLocaleTimeString() : null,
            fresh: !!seen && Date.now() - seen.lastSeenAt <= winMs,
          };
        }),
    };
    return {
      ok: true,
      active: session === null ? computeActiveSupplier() : computeActiveSupplierFor(String(session)),
      activeScope: session === null ? null : String(session), // 诊断：null=全局；""=无当前页；否则会话 id
      trafficStale: !!trafficStale,
      traffic: trafficDiag,
      now: new Date().toLocaleTimeString(),
      poll: {
        intervalSeconds: runtime.config.intervalSeconds,
        trafficWindowHours: runtime.config.trafficWindowHours,
        retentionDays: runtime.config.retentionDays || 7,
      },
      suppliers: Object.keys(PROVIDERS).map((id) => {
        const s = scheduler.getState(id);
        const c = supplierCfg(id);
        const rawC = runtime.config.suppliers?.[id] || {}; // 原始存储（不含环境密钥回退）
        // 供应商注册表元数据（needs/凭据类别）供客户端按 needs 动态渲染设置表单
        const meta = PROVIDERS[id];
        const needSets = {};
        for (const need of meta?.needs || []) {
          if (need.key !== "apiKey" && need.secret) needSets[`${need.key}Set`] = !!rawC[need.key];
        }
        const needValues = {};
        for (const need of meta?.needs || []) {
          if (!need.secret && need.key !== "apiKey") needValues[need.key] = c[need.key] ?? "";
        }
        // 「已添加」服务端推导（#3/#4 口径）：DSH 最新探测命中 ∨ 已启用 ∨ 任一密钥已填。
        // 仅 user 层改过阈值/BaseURL 而未启用、未填密钥 ⇒ 不算。
        const anyKeySet = !!rawC.apiKey || Object.values(needSets).some(Boolean);
        // B3：detectedNow 只表示「当前发现」（最近一次成功扫描的结果），绝不把持久化的
        // autoSource 历史来源算成当前接入；历史来源继续通过 autoSource 字段展示。
        const detectedNow = !!runtime.harness[id] || currentFound.includes(id);
        const added = detectedNow || !!c.enabled || anyKeySet;
        const addedReason = detectedNow ? "detected" : c.enabled ? "enabled" : anyKeySet ? "keySet" : null;
        return {
          id,
          name: meta.name,
          enabled: !!c.enabled,
          added,
          addedReason,
          current: currentIds.includes(id),
          todayTokens: todayOf(id),
          keySet: !!rawC.apiKey,
          ...needSets,
          ...needValues,
          // B3：autoDetected 的布尔含义统一为「当前发现」；历史来源继续用 autoSource 展示
          autoDetected: detectedNow,
          autoSource: c.autoSource || null,
          autoEnvName: c.autoApiKeyEnv || null,
          autoKeySource: c.autoSource ? runtime.harness[id]?.keySource || null : null,
          envKeySet: !!(c.autoSource && runtime.harness[id]?.apiKey),
          warnPct: c.warnPct,
          critPct: c.critPct,
          baseUrl: c.baseUrl,
          baseUrlDefault: meta.baseUrlDefault,
          meta: {
            credentialClass: meta.credentialClass || "api-key",
            credentialLabelKey: meta.credentialKey || "apiKey",
            credentialLabel: meta.credentialLabel || "API Key",
            region: meta.region || null,
            official: meta.official || null,
            compat: meta.compat || null,
            needs: (meta.needs || []).map((n) => ({ key: n.key, label: n.label, secret: !!n.secret })),
          },
          ...(s.last
            ? s.last
            : { state: "off", error: { code: "no-run", message: "尚未取数" }, headline: { kind: "amt", amt: "—" } }),
        };
      }),
      history: runtime.history.slice(-50),
      storageError: usageStore.store.error,
      detectedUnmapped: runtime.unmapped.map((u) => ({ route: u.route, displayName: u.displayName, ns: u.ns, detail: u.detail || u.reason || null })).slice(0, 20),
      detect: runtime.detect,
      // 扫描版本诊断：手动重扫是否真的跑到「点击后」的版本，看这里
      scan: scanCoordinator.revision,
    };
  }

  // ---------- 主入口 ----------

  /** 本行的用户层（= 用户真正配置过的字段）；行还不可描述时返回 null（未知，稍后重试）。 */
  function ownUserLayer() {
    try {
      const row = ctx.settings?.describe?.({ redactSecrets: true })?.find((d) => d.ns === settingsNs);
      return row ? (row.user || {}) : null;
    } catch {
      return null;
    }
  }

  // 一次性配置迁移，覆盖两次来源变更：
  //   1) 插件改名（quota-monitor → dsh-token-quota）：旧命名空间还在 describe() 里时整段拷过来；
  //   2) 0.1.7 表单改造（settings.yaml 段 → profile 行 config）：harness 启动时把 settings.yaml
  //      改名为 settings.yaml.imported 并逐段写进行 config；当时本插件因 ctx.settings.register
  //      不存在而没激活，本行的段就留在了那份文档里（密钥都在）。
  // 本行已有用户层就绝不动；来源文件一律保留 —— 宁可留孤儿数据，也不让用户重填密钥。
  // @returns 是否已有结论（false = 本行还没可描述，调用方稍后重试）。
  async function migrateLegacyConfig() {
    try {
      if (typeof ctx.settings?.describe !== "function" || typeof ctx.settings?.update !== "function") return true;
      const user = ownUserLayer();
      if (user === null) return false;
      if (Object.keys(user).length > 0) return true; // 已有用户配置：不动
      const legacy = readLegacySections(dshHome(), [NS, LEGACY_NS]);
      try {
        const rows = ctx.settings.describe() || [];
        for (const ns of [NS, LEGACY_NS]) {
          const section = rows.find((d) => d.ns === ns)?.user;
          if (section && typeof section === "object") legacy[ns] = { ...(legacy[ns] || {}), ...section };
        }
      } catch {
        /* describe 失败：只按文档迁移 */
      }
      const section = mergeSections(legacy[LEGACY_NS], legacy[NS]); // 同名字段以新段为准，逐字段合并
      if (Object.keys(section).length === 0) return true;
      await writeSettings(section);
      ctx.logger?.info?.(`[${NS}] 已把旧 settings 段（${Object.keys(legacy).join("、")}）迁移到本行配置；来源文件保留`);
      return true;
    } catch (error) {
      ctx.logger?.warn?.(`[${NS}] 旧配置迁移失败，保持原样: %s`, error?.message || error);
      return true;
    }
  }

  const disposers = [() => scheduler.dispose()];
  // 本地用量数据：启动时从 DSH 数据目录载入（小时桶），按保留期修剪
  // 改名迁移在前：旧目录 quota-monitor/ 里若还有数据，先搬到 dsh-token-quota/，
  // 拿到的路径再交给 acquireUsageStore 接管（store 内部负责修剪、加锁与错误暴露）。
  // 迁移失败（EXDEV/EPERM/占用）回落旧路径继续读，不删旧数据；status 供诊断。
  const migration = migrateUsageDir(dshHome());
  runtime.usageFile = migration.path;
  if (migration.status === "fallback-legacy") {
    ctx.logger?.warn?.("[dsh-token-quota] 用量目录迁移失败（%s），继续使用旧目录 %s", migration.error, migration.path);
  } else if (migration.status === "migrated") {
    ctx.logger?.info?.("[dsh-token-quota] 用量目录已迁移到 %s", migration.path);
  }
  const usageStore = acquireUsageStore(runtime.usageFile, runtime.config.retentionDays || 7);
  runtime.usageBuckets = usageStore.store.buckets;
  if (usageStore.store.error) ctx.logger?.warn?.("[dsh-token-quota] %s", usageStore.store.error);

  // ---- 自动探测：DSH harness 里已添加的普通 Key 供应商，自动填入（v0.3） ----
  // 探测数据源：ctx.llm 目录/存活路由 + settings 配置节（llm-deepseek / llm-pi-ai）；
  // 「已添加」收紧为 DSH 用户配置文档 user 层有该 profile，或 pi-ai 路由已激活
  // （pi-ai 只为已配置 profile 注册路由；deepseek-official 适配器恒注册，故必须看 user 层）。
  // 填入：autoSource/autoApiKeyEnv 引用 + 探测解析出的密钥本体拷贝进插件 settings
  // （role('secret') 脱敏；仅当插件侧 Key 为空时填，手动 Key / 显式关闭不被覆盖）；
  // 凭据类别守门在 detect.js：Admin/Management 供应商绝不因 DSH 普通聊天 Key 自动启用。
  let tick = 0;
  const stamp = () => new Date().toLocaleTimeString();

  // ---- 扫描协调器（B1/B2）----
  // scan：只负责「读取 + 生成候选」；commit：受版本保护的提交（改 runtime 与自动填入）。
  // 提交前最后一次 isCurrent() 同步校验与 ctx.settings.update 之间不插入 await。
  const scanCoordinator = createScanCoordinator({
    logger: ctx.logger,
    // 测试可注入更短的等待/重试窗口，避免集成用例为「失败返回」等满 30s
    ...(globalThis.__DSH_SCAN_TIMING__ || {}),
    onError(error) {
      // 扫描失败 ≠ 供应商消失：保留上次成功发现的 found/included，仅标记本轮错误与时间
      runtime.detect = {
        ...runtime.detect,
        lastFound: runtime.detect.found || [],
        at: stamp(),
        error: (error?.stack || String(error)).slice(0, 2000),
      };
    },
    async scan() {
      // 测试注入点：真实探测对宿主服务异常是容错的（内部多处 try/catch），
      // 集成测试需要一条能确定性地触发「扫描失败」路径的接缝。
      if (globalThis.__DSH_SCAN_FAIL__) throw new Error("injected scan failure");
      const detected = await detectHarnessSuppliers(ctx, {
        debug: true,
        include: (rec) => {
          // deepseek-official 官方适配器恒注册（live 无信息量）：user 层有配置，
          // 或已在 DSH 凭据库（credentials/文件）存过密钥，才认作「已添加」；
          // 纯环境变量直读（env）且无 user 层不算，避免误启用。
          if (rec.route === "deepseek-official") {
            return settingsUserHas(ctx, rec.ns, rec.path) || rec.keySource === "file" || rec.keySource === "credentials";
          }
          // pi-ai 路由只为已配置 profile 注册：已激活/已配置即已添加（配置文档为事实来源）
          return rec.active || rec.configured || settingsUserHas(ctx, rec.ns, rec.path);
        },
      });
      // 候选阶段：可以记录原始结果供诊断，但不更新 runtime.harness / routeResolver / 可见发现结果
      return detected;
    },
    async commit({ revision, detected, isCurrent }) {
      if (!isCurrent()) return { committed: false, revision };
      scanCoordinator.recordScanResult(detected, revision);

      // 1) 提交路由与「当前发现」（detectedNow 只来自最近成功扫描）
      routeResolver.update(detected.routeSuppliers || {});
      const meta = detected.meta || {};
      runtime.detect = {
        at: stamp(),
        error: null,
        llmPresent: meta.llmPresent,
        credentialsPresent: meta.credentialsPresent,
        directoryEntries: meta.directoryEntries,
        liveRoutes: meta.liveRoutes || [],
        candidates: meta.candidates || [],
        included: detected.map((d) => ({ route: d.route, supplier: d.supplier })),
        found: detected.filter((d) => d.supplier).map((d) => d.supplier),
        unmapped: detected.filter((d) => !d.supplier).map((d) => d.route),
      };
      const harness = {};
      const unmapped = [];
      for (const d of detected) {
        if (d.supplier) {
          harness[d.supplier] = {
            route: d.route,
            baseUrl: d.baseURL,
            apiKeyEnv: d.apiKeyEnv,
            apiKey: d.key,
            keySource: d.keySource,
          };
        } else {
          unmapped.push({ route: d.route, displayName: d.displayName, ns: d.ns, reason: d.reason || null });
        }
      }
      runtime.harness = harness;
      runtime.unmapped = unmapped;

      // 2) 生成自动填入补丁（读最新插件配置；已有密钥/显式关闭不覆盖）
      let ownUser = {};
      try {
        ownUser = ctx.settings.describe({ redactSecrets: true }).find((d) => d.ns === settingsNs)?.user || {};
      } catch {
        ownUser = {};
      }
      const patch = autoFillPatch(
        detected,
        (id) => runtime.config.suppliers?.[id] || {},
        BASE_URL_DEFAULTS,
        { skipSupplier: (id) => ownUser?.suppliers?.[id]?.enabled === false },
      ).patch;
      if (!Object.keys(patch.suppliers || {}).length) return { committed: true, revision, written: false };

      // 3) 串行写入队列：提交调用前再校验一次版本，其间不插入 await
      if (!isCurrent()) return { committed: false, revision };
      const written = await scanCoordinator.enqueueWrite(async () => {
        if (!isCurrent()) return { ok: false, stale: true };
        try {
          // 写进本行 config：volatile 引用随后由 loader 就地更新（runtime.config 每次读都取新值）
          await writeSettings(patch);
        } catch (error) {
          ctx.logger?.warn?.("[dsh-token-quota] 自动填入写入失败: %s", error?.message || error);
          return { ok: false, error };
        }
        return { ok: true };
      });
      return { committed: true, revision, written: true, write: written };
    },
  });

  // 常规入口：启动/周期/拓扑事件都走同一实现（不要求新版本，可复用进行中的扫描）
  const syncHarness = (reason = "periodic") => scanCoordinator.request({ reason });
  // 来源变化：版本 +1 使旧候选失效（路由/凭据/相关配置变化）
  const rescanForSourceChange = (reason) => scanCoordinator.noteSourceChange(reason);
  // 手动重扫：必须等到覆盖本次点击的新扫描结果，超时返回失败（不把旧扫描包装成成功）
  const triggerScan = () => scanCoordinator.request({ reason: "manual", requireFresh: true });

  syncHarness("startup");
  // llm/settings 服务可能晚于插件 apply 就绪：2s 后再探一次（30s 轮询与拓扑事件继续兜底）
  const bootRetry = setTimeout(() => syncHarness("startup-retry"), 2000);
  disposers.push(() => clearTimeout(bootRetry));
  disposers.push(() => scanCoordinator.dispose());

  let ticker = null;
  const startTicker = () => {
    if (ticker) clearInterval(ticker);
    ticker = setInterval(() => {
      tickSuppliers();
      if (usageStore.store.dirty) scheduleUsageSave();
      // 每 30s 复查 harness 配置（settings 热重载）
      if (++tick % 30 === 0) syncHarness();
    }, 1000);
    tickSuppliers();
  };
  startTicker();
  disposers.push(() => clearInterval(ticker));

  // 配置热更新（0.1.7）：本行 config 是 volatile 引用，用户/宿主改配置后 loader 就地提交
  // 并发这个事件——不重挂插件，所以这里要把派生状态（保留期、轮询间隔、探测重扫）重新对齐。
  disposers.push(
    ctx.on("loader/volatile-update", () => {
      usageStore.setRetention(runtime.config.retentionDays || 7);
      scheduler.sync();
      startTicker();
      // 区分「自动填入自身写入」与外部变化：自身写入不增加版本（否则会与扫描互相触发），
      // 外部变化（用户改配置/宿主热重载）才使旧候选失效并重扫。
      if (consumeSelfWrite()) return;
      rescanForSourceChange("settings");
    }) || (() => {}),
  );

  // 迁移排在本行激活之后：apply 执行中本行还在激活过程中，describe() 可能尚看不到自己。
  // 测试可注入更短的重试窗口（与 __DSH_SCAN_TIMING__ 同一模式）。
  const migrationTiming = { initialDelayMs: 250, retryDelayMs: 1_000, maxAttempts: 5, ...(globalThis.__DSH_MIGRATION_TIMING__ || {}) };
  const scheduleLegacyMigration = (attempt = 0) => {
    const timer = setTimeout(async () => {
      if (disposed) return;
      const settled = await migrateLegacyConfig();
      if (settled) return;
      if (attempt >= migrationTiming.maxAttempts) {
        ctx.logger?.warn?.(`[${NS}] 本行配置始终不可描述，跳过旧配置迁移（旧文档原样保留）`);
        return;
      }
      scheduleLegacyMigration(attempt + 1);
    }, migrationTiming.initialDelayMs + attempt * migrationTiming.retryDelayMs);
    timer.unref?.();
    disposers.push(() => clearTimeout(timer));
  };
  scheduleLegacyMigration();

  // ---- 本地用量数据落盘（防抖 2s；dispose 时同步冲刷） ----
  let saveTimer = null;
  let saveDelay = 2000;
  const flushUsage = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!runtime.usageFile) return true;
    const result = usageStore.flush();
    if (!result.ok) ctx.logger?.warn?.("[dsh-token-quota] 用量落盘失败: %s", result.error || result);
    return result.ok;
  };
  const scheduleUsageSave = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (!flushUsage() && !disposed) {
        saveDelay = Math.min(30_000, saveDelay * 2);
        scheduleUsageSave();
      } else { saveDelay = 2000; }
    }, saveDelay);
    saveTimer.unref?.();
  };

  // ---- 当前供应商与当日消耗量：session/event 折叠（票 04 方案） ----
  // DSH 真实事件载荷（对齐 dsh-session / dsh-token-meter）：
  //   request/header   -> data.header.config.provider（请求发起即流量信号，usage 在后续完成事件）
  //   request/context  -> data.provider
  //   assistant/chunk  -> usage 在 data.chunk.usage（chunk.type==='usage'）；chunk 本身不含
  //                       provider，用会话最近路由兜底（request/header 已先置位）
  //   assistant/message-> provider 在 data.message.source.provider，usage 在 data.usage
  //   usage 字段：inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens
  // 同一 (turn, step) 的早期 usage 样本与最终 assistant/message usage 是替换关系
  // （与 dsh-token-meter 的 addReplacing 语义一致），按会话×step 记账避免重复累加。
  const recordUsage = usageStore.store.recordUsage ??= createUsageRecorder(runtime.usageBuckets);
  const sessionSeen = new WeakMap(); // session -> { provider }
  disposers.push(ctx.on("session/event", (session, event) => {
    if (disposed) return;
    runtime.channelAlive = true;
    try {
      const type = event?.type || "";
      const data = event?.data || {};
      const st = sessionSeen.get(session) || { provider: null };
      let provider = null;
      let usage = null;
      let turn = null;
      let step = null;
      if (type === "assistant/message") {
        provider = data?.message?.source?.provider || data?.source?.provider || null;
        usage = data?.usage || null;
        turn = data?.turn ?? null;
        step = data?.step ?? null;
      } else if (type === "assistant/chunk") {
        if (data?.chunk?.type === "usage") usage = data.chunk.usage || null;
        else if (data?.usage) usage = data.usage || null;
        turn = data?.turn ?? null;
        step = data?.step ?? null;
        provider = data?.provider || data?.source?.provider || st.provider || null;
      } else if (type === "request/header") {
        provider = data?.header?.config?.provider || data?.config?.provider || st.provider || null;
      } else if (type === "request/context") {
        provider = data?.provider || st.provider || null;
      } else {
        provider = data?.provider || data?.source?.provider || st.provider || null;
      }
      const route = typeof provider === "string" && provider ? provider : st.provider;
      const isCall = ["request/header", "request/context", "assistant/message", "assistant/chunk"].includes(type);
      if (route && isCall) {
        const seen = runtime.routeSeen[route] || { lastSeenAt: 0, lastModel: null, seq: 0 };
        seen.lastSeenAt = Date.now();
        seen.seq = ++runtime.routeSeq;
        const model =
          data?.config?.model || data?.model || data?.source?.model ||
          data?.message?.source?.model || data?.header?.config?.model || null;
        if (model) seen.lastModel = model;
        runtime.routeSeen[route] = seen;
        // 按会话归集同一份 route/model/seq，供小组件「当前显示页」取数（严格当前页语义）
        const sid = typeof session?.id === "string" && session.id ? session.id : null;
        if (sid) {
          const perSession = runtime.sessionRouteSeen[sid] || (runtime.sessionRouteSeen[sid] = {});
          const prior = perSession[route] || { lastSeenAt: 0, lastModel: null, seq: 0 };
          prior.lastSeenAt = seen.lastSeenAt;
          prior.seq = seen.seq;
          if (model) prior.lastModel = model;
          perSession[route] = prior;
        }
        st.provider = route;
      }
      const supplierId = resolveSupplier(route);
      if (supplierId && usage && typeof usage === "object") {
        // 只有真的改变了小时桶才 markDirty / 排程落盘：同一 (session, turn, step) 的相同最终样本
        // 在流式期间会被反复报告，不重复写盘。setRetention 引起的 dirty 与此无关，仍然生效。
        if (recordUsage(session, supplierId, usage, turn, step) === true) {
          usageStore.markDirty();
          scheduleUsageSave();
        }
      }
      if (session && typeof session === "object") sessionSeen.set(session, st);
    } catch {
      /* 事件折叠失败不影响主流程 */
    }
  }));

  try {
    disposers.push(ctx.on("api-session/removed", (sessionId) => {
      if (typeof sessionId === "string") delete runtime.sessionRouteSeen[sessionId];
    }));
  } catch {
    /* 旧宿主没有会话删除事件时，保留现有会话状态。 */
  }

  try {
    disposers.push(ctx.on("llm/adapters-updated", () => {
      rescanForSourceChange("routes");
      // 拓扑变更 → 重探测；但这不是流量观测信号：channelAlive 只能由真实
      // session/event 置位，冷启动（尚未有任何调用）时小组件按启用清单兜底显示，
      // 避免「详情页有数据、小组件却显示暂无供应商」
      syncHarness();
    }));
  } catch {
    /* 事件名未注册时忽略 */
  }

  try {
    disposers.push(ctx.on("credentials/reference-updated", () => {
      rescanForSourceChange("credentials"); // DSH 侧密钥变更 → 版本 +1 后重解析（不重启插件）
    }));
  } catch {
    /* 事件名未注册时忽略 */
  }

  // ---- HTTP 路由 ----
  const routes = [
    {
      kind: "exact",
      path: `${API_PREFIX}/state`,
      handler: (req, res) => {
        if (!sameOriginGuard(req, res, "GET")) return;
        writeJson(res, 200, buildStatePayload(readSessionQuery(req)));
      },
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/refresh`,
      handler: async (req, res) => {
        if (!sameOriginGuard(req, res, "POST")) return;
        const ids = Object.keys(PROVIDERS).filter((id) => supplierCfg(id).enabled);
        await Promise.allSettled(ids.map((id) => runQuery(id, { force: true })));
        writeJson(res, 200, buildStatePayload(readSessionQuery(req)));
      },
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/test`,
      handler: async (req, res) => {
        if (!sameOriginGuard(req, res, "POST")) return;
        try {
          const body = await readJson(req);
          const id = body?.supplier;
          if (typeof id !== "string" || !Object.hasOwn(PROVIDERS, id)) {
            writeJson(res, 400, { ok: false, error: `未知供应商: ${id}` });
            return;
          }
          if (body.config !== undefined && (!body.config || typeof body.config !== "object" || Array.isArray(body.config))) {
            throw new Error("test config must be an object");
          }
          const config = supplierSchema(id)({ ...supplierCfg(id), ...body.config });
          const result = await PROVIDERS[id].query(config);
          writeJson(res, 200, { ok: result.state !== "err" && result.state !== "off", error: result.error?.message, result });
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error.message, result: null });
        }
      },
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/settings`,
      handler: async (req, res) => {
        if (!sameOriginGuard(req, res, "POST")) return;
        try {
          const patch = await readJson(req);
          if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("settings must be an object");
          for (const id of SUPPLIER_IDS) {
            const supplier = patch.suppliers?.[id];
            if (!supplier || typeof supplier !== "object") continue;
            for (const need of SECRET_NEEDS_BY_SUPPLIER[id]) {
              if (supplier[need.key] === "") delete supplier[need.key];
            }
          }
          await writeSettings(patch); // 深合并；patch 只含 JSON 数据
          writeJson(res, 200, { ok: true });
        } catch (error) {
          writeJson(res, 400, { ok: false, error: error.message });
        }
      },
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/rescan`,
      handler: async (req, res) => {
        if (!sameOriginGuard(req, res, "POST")) return;
        // 手动触发与周期自动探测完全一致的扫描 + autoFillPatch；完成后返回与 /state 相同载荷。
        // 必须等到覆盖本次点击的新扫描：30s 内拿不到就返回失败 +「稍后重试」，后台扫描继续。
        const outcome = await triggerScan();
        if (!outcome?.ok) {
          // 先铺 state 再写失败字段：state 载荷自带 ok:true，顺序反了会把失败改写成成功
          writeJson(res, 200, {
            ...buildStatePayload(readSessionQuery(req)),
            ok: false,
            error: outcome?.disposed ? "插件已卸载" : (outcome?.error || "重新扫描失败"),
            retryable: true,
            revision: outcome?.revision ?? null,
          });
          return;
        }
        writeJson(res, 200, buildStatePayload(readSessionQuery(req)));
      },
    },
  ];
  for (const route of routes) disposers.push(ctx.webServer.register(route));
  disposers.push(() => {
    if (saveTimer) clearTimeout(saveTimer);
    const result = usageStore.release();
    if (!result.ok) ctx.logger?.warn?.("[quota-monitor] %s", result.error);
  });

  return () => {
    disposed = true;
    for (const dispose of disposers.splice(0)) if (typeof dispose === "function") dispose();
  };
}
