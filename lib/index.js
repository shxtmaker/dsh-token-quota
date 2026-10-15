// lib/index.js — 宿主半（Node 进程内运行）
// dsh-token-quota：供应商可用周期限额监控的数据与调度侧（供应商查询迭代 2.0，范围收敛版）。
//
//   - settings 命名空间 dsh-token-quota（dsh-settings-file，热重载，密钥 role('secret') 自动脱敏；
//     suppliers schema 由 providers.js 注册表的 needs 元数据动态生成，并带真实类型校验）
//   - 活动查询白名单：lib/provider-policy.js 的 QUERY_PROVIDER_IDS（7 个 ID，代码级冻结）。
//     注册、自动探测、凭据解析、轮询、手动刷新与 /test 全部经白名单校验；
//     被排除厂商（Codex/OpenAI、Anthropic、Moonshot、Z.ai、MiniMax 及未列入者）
//     即使旧配置 enabled=true 也不会发出任何查询。
//   - 本地 Token 观测与远程账务查询分离：PASSIVE_ROUTE_MAP 继续按原机制归集用量，
//     不因查询白名单收敛而丢失历史；不删除已有 usage.json。
//   - 方法级调度：configInstanceId + providerId + methodId + resourceScope；
//     HTTP 窗口 60s、余额／月消费 300s、控制台 300s、公开规则 24h；失败有界退避。
//   - 控制台桥接：插件专用浏览器会话（默认关闭，用户显式触发登录）；
//     无浏览器／图形环境时该方法返回可解释的阻塞状态，不影响 HTTP 方法。
//   - /api/dsh-token-quota/{state,refresh,test,settings,rescan,console} 路由（loopback 同源守卫）

import z from "@deepseek-ai/schemastery";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { readLegacySections } from "./legacy-config.js";
import { createScheduler } from "./scheduler.js";
import { createScanCoordinator } from "./scan-coordinator.js";
import { createUsageRecorder } from "./usage.js";
import { createRouteResolver } from "./routes.js";
import { autoFillPatch, DSH_ROUTE_MAP, detectHarnessSuppliers } from "./detect.js";
import { PROVIDERS, SUPPLIER_IDS, buildTaskSpecs, runMethod } from "./providers.js";
import {
  QUERY_PROVIDER_IDS, isQueryProvider, unsupportedProviderResult, methodsOf,
  SCOPE_NOTICE, parseOpenDesignWorkspace, passiveSupplierForRoute,
} from "./provider-policy.js";
import { STATUS } from "./provider-common.js";
import { createConsoleBridge, CONSOLE_REF_ORIGIN_KEY } from "./runtime/console-bridge.js";
import { sumDayTokens, dshHome, acquireUsageStore, migrateUsageDir } from "./storage.js";

// 0.1.7 起 settings 表单按「profile 行 id」寻址（一行 = 一张表），不再是插件自注册的
// 命名空间；本插件 cordis.patch.yml 插入的行 id 就是它，两者同串。
const NS = "dsh-token-quota";
/** 改名前（≤ v1.1.1，0.1.7 前叫 settings 命名空间）的旧段名，仅用于一次性迁移。 */
const LEGACY_NS = "quota-monitor";
const API_PREFIX = "/api/dsh-token-quota";
/** 自身写入后，volatile 更新事件可能先于/晚于 update() 返回到达：用窗口期认领。 */
const SELF_WRITE_WINDOW_MS = 2_000;

// DSH 暴露的 LLM 路由 id → 插件供应商 id（仅查询白名单；本地观测归集另见 provider-policy）。
const ROUTE_TO_SUPPLIER = DSH_ROUTE_MAP;

const BASE_URL_DEFAULTS = Object.fromEntries(Object.keys(PROVIDERS).map((id) => [id, PROVIDERS[id].baseUrlDefault]));
const HISTORY_PER_SUPPLIER = 50;
const HISTORY_GLOBAL = 500;

// ---------- 设置 schema（Schemastery；密钥 role('secret')） ----------
// suppliers 子项由 providers.js 注册表的 needs 元数据动态生成：每把 secret 密钥一个
// role('secret') 字段，非 secret 字段（如 orgId / workspaceId / accountId / 方法开关）
// 使用真实类型校验，绝不把字符串 "false" 当布尔。
//
// 整棵 Config 标记 volatile（0.1.7 契约）：harness 的 loader 把它解析成一个交互引用，
//   * 表单可写 —— SettingsForms.write() 只接受 volatile 字段（否则「no volatile fields」）；
//   * 热更新不重挂 —— 变更走 loader/volatile-update 就地提交，插件内存态（历史、路由观测）
//     与本地用量桶不会被一次保存清空；
//   * 读值统一走 config.get()（见 apply 的 readConfig）。

const secretNeeds = (id) => (PROVIDERS[id]?.needs || []).filter((n) => n.secret);

/** 方法开关：每个方法一个真实布尔字段（默认值按方法定义）。 */
function methodSchema(id) {
  const shape = {};
  for (const method of methodsOf(id)) {
    // Scheduler 里 switch 用的键名：方法 ID 去掉点号，避免深层嵌套；保留原名映射
    const key = methodKey(method.methodId);
    shape[key] = z.boolean().default(method.defaultEnabled === true);
  }
  return shape;
}

/** 方法 ID → 配置字段名（点号换下划线；与 methodKeyOf 互逆）。 */
function methodKey(methodId) {
  return `m_${String(methodId).replace(/[^A-Za-z0-9]+/g, "_")}`;
}

function methodIdFromKey(key) {
  for (const id of SUPPLIER_IDS) {
    for (const method of methodsOf(id)) {
      if (methodKey(method.methodId) === key) return method.methodId;
    }
  }
  return null;
}

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
  // 账户／工作空间选择与方法开关（真实类型）
  if (id === "fireworks") shape.accountId = z.string().default("");
  if (id === "opendesign") {
    shape.workspaceId = z.string().default("");
    shape.statisticsTimeZone = z.string().default("");
  }
  if (id === "deepseek") shape.statisticsTimeZone = z.string().default("");
  return z.object({ ...shape, ...methodSchema(id) });
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
  consoleEnabled: z.boolean().default(false), // 控制台取数总开关（默认关闭；登录需用户主动触发）
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
  // 异步回调可能跨越插件激活阶段；每次通过公开服务查询获取当前实现。
  const getSettings = () => typeof ctx.get === "function" ? ctx.get("settings") : ctx.settings;
  let disposed = false;
  const routeResolver = createRouteResolver();
  const resolveSupplier = (route) => routeResolver.resolve(route);
  /** 配置实例标识：本行配置每次被外部改动都换一个（凭据版本的一部分，不透出明文）。 */
  let configInstanceId = `i${Date.now().toString(36)}`;

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
      const rows = getSettings()?.describe?.() || [];
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
    const settings = getSettings();
    if (!settings?.update) throw new Error("宿主设置服务暂不可用，请稍后重试");
    settingsNs = resolveSettingsNs();
    markSelfWrite();
    return settings.update(settingsNs, patch);
  }

  const runtime = {
    // 只读派生：每次读都取引用当前值，配置热更新后无需任何刷新动作
    get config() { return readConfig(); },
    history: [], // 全局环形 [{t, supplier, methodId, ok, error, summary}]
    routeSeen: {}, // routeId -> { lastSeenAt, lastModel, seq }（seq 为单调事件序号，同毫秒事件也严格有序）
    routeSeq: 0,
    sessionRouteSeen: {}, // sessionId -> routeId -> {...}（「当前显示页」按会话归集）
    usageBuckets: {}, // supplierId -> { "YYYYMMDDHH": tokens }（本地用量数据，落盘）
    usageFile: null, // <DSH_HOME>/dsh-token-quota/usage.json
    channelAlive: null, // null=未知(兜底启用清单) true=已观测到事件 false=不可用
    harness: {}, // supplierId -> { route, baseUrl, apiKeyEnv, apiKey, keySource }（密钥仅宿主内存）
    unmapped: [], // 探测到但不在查询范围的路由（仅提示，不含密钥）
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
    console: null, // 控制台桥接（惰性创建）
  };

  // ---------- 控制台桥接（专用浏览器会话，默认关闭） ----------

  const consoleDataDir = () => runtime.usageFile
    ? runtime.usageFile.replace(/[/\\][^/\\]+$/, "")
    : dshHome();

  function consoleBridge() {
    if (!runtime.console) {
      runtime.console = createConsoleBridge({
        dataDir: consoleDataDir(),
        configInstanceId,
        logger: ctx.logger,
      });
    }
    return runtime.console;
  }

  // ---------- 供应商配置解析 ----------

  /** 方法开关：从配置字段还原为 { methodId: boolean }。 */
  const readMethodFlags = (raw) => {
    const flags = {};
    for (const [key, value] of Object.entries(raw || {})) {
      const methodId = methodIdFromKey(key);
      if (methodId) flags[methodId] = value === true;
    }
    return flags;
  };

  // 解析供应商配置；apiKey 为空时若命中自动探测（autoSource），回退使用宿主内存解析的 DSH 密钥
  const supplierCfg = (id) => {
    if (!isQueryProvider(id)) return { enabled: false, excluded: true };
    const c = runtime.config.suppliers?.[id] || {};
    let apiKey = c.apiKey || "";
    if (!apiKey && c.autoSource) {
      apiKey = runtime.harness[id]?.apiKey || "";
    }
    const methods = readMethodFlags(c);
    return {
      ...c,
      apiKey,
      methods,
      baseUrl: c.baseUrl || PROVIDERS[id]?.baseUrlDefault || "",
      warnPct: c.warnPct ?? 80,
      critPct: c.critPct ?? 95,
    };
  };

  /** 凭据版本的 opaque 标识：只暴露「是否变化」，不暴露明文或可猜测指纹。 */
  const credentialVersion = (id) => {
    const c = runtime.config.suppliers?.[id] || {};
    const material = [c.apiKey ? "k" : "-", c.allowanceToken ? "a" : "-", c.workspaceId || "", c.accountId || "", c.orgId || ""].join("");
    let hash = 0;
    for (let i = 0; i < material.length; i++) hash = (hash * 31 + material.charCodeAt(i)) | 0;
    return `${id}:${hash.toString(36)}`;
  };

  /** DSH settings 全局描述里，某命名空间 user 层在 path 处是否有值（= 用户真正配置过）。 */
  function settingsUserHas(ns, path) {
    if (!ns) return false;
    try {
      const desc = getSettings()?.describe?.({ redactSecrets: true })?.find((d) => d.ns === ns);
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

  // ---------- 取数调度（方法／资源粒度） ----------

  const DEFAULT_INTERVALS = {
    "deepseek.balance.api-key": 300_000,
    "openrouter.key-quota.api-key": 60_000,
    "openrouter.daily-cost.api-key": 60_000,
    "openrouter.credits.management-key": 300_000,
    "opencode.rolling-window.api-key": 60_000,
    "opencode.allowance.oauth": 60_000,
    "commandcode.windows.api-key": 60_000,
    "commandcode.monthly.public-rule": 24 * 3600_000,
    "fireworks.monthly-cost.api-key": 300_000,
    "fireworks.balance.console": 300_000,
    "opendesign.windows.console": 300_000,
  };

  const scheduler = createScheduler({
    providers: PROVIDERS,
    getConfig: supplierCfg,
    onRecord: pushHistory,
    getTaskSpecs: (providerId, cfg) => {
      // 控制台总开关关闭时不下发控制台任务（不发请求、不启动浏览器）
      const consoleAllowed = runtime.config.consoleEnabled === true;
      const specs = buildTaskSpecs(providerId, cfg, {
        configInstanceId,
        credentialVersion: credentialVersion(providerId),
        console: consoleAllowed ? consoleBridge() : null,
        intervalFor: (method) => method.transport === "console" && !consoleAllowed
          ? Infinity
          : DEFAULT_INTERVALS[method.methodId],
      });
      return specs.filter((spec) => {
        if (spec.method.transport !== "console") return true;
        return consoleAllowed;
      });
    },
  });

  /** 执行某供应商的全部已启用方法（手动/周期刷新共用）。 */
  const runQuery = (id, options) => {
    if (!isQueryProvider(id)) return Promise.resolve(unsupportedProviderResult(id));
    return scheduler.runProvider(id, options);
  };

  function tickSuppliers() {
    for (const id of SUPPLIER_IDS) {
      if (!supplierCfg(id).enabled) {
        scheduler.sync();
        continue;
      }
      scheduler.runProvider(id).catch(() => {});
    }
  }

  // ---------- 当前供应商（Q11=C）与当日消耗量 ----------

  // 某供应商在当前观测里命中的 DSH 路由 id（真实事件优先，精确表兜底）；无 → null
  const routeForSupplier = (id) =>
    Object.keys(runtime.routeSeen).filter((r) => resolveSupplier(r) === id)
      .sort((a, b) => runtime.routeSeen[b].lastSeenAt - runtime.routeSeen[a].lastSeenAt)[0] ||
    Object.keys(ROUTE_TO_SUPPLIER).find((r) => ROUTE_TO_SUPPLIER[r] === id) ||
    null;

  function collectTraffic() {
    const enabledIds = SUPPLIER_IDS.filter((id) => supplierCfg(id).enabled);
    let currentIds = enabledIds.filter((id) => {
      const routeId = routeForSupplier(id);
      if (!routeId) return true; // 无 DSH 路由 → 恒候选
      if (runtime.channelAlive === null) return true; // 接缝未知 → 启用清单兜底
      const seen = runtime.routeSeen[routeId];
      if (!seen) return false;
      return Date.now() - seen.lastSeenAt <= (runtime.config.trafficWindowHours || 24) * 3600_000;
    });
    // 兜底：没有任何供应商有近期流量时，小组件按启用清单显示，避免数据健康却渲染成空态
    const trafficStale = enabledIds.length > 0 && currentIds.length === 0;
    if (trafficStale) currentIds = enabledIds;
    // 今日统计只读当天 24 个本地小时键（不再随历史长度遍历整份桶表）；
    // 自然日边界在 buildStatePayload 开始时捕获一次，本轮所有供应商共用。
    const now = new Date();
    const todayOf = (id) => sumDayTokens(runtime.usageBuckets[id], now);
    return { currentIds, todayOf, trafficStale };
  }

  // ---------- 「当前在用」供应商（小组件紧凑条主显示） ----------

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
    if (!origin) {
      // 无 Origin 不等于天然可信：必须证明这次调用没有跨网络。
      //   - 有 socket：只接受回环地址（127.0.0.1 / ::1）；
      //   - 完全没有 socket：请求由进程内直接调用（嵌入/测试），本身未经网络。
      const socket = req.socket;
      if (!socket) return true;
      const remote = socket.remoteAddress || "";
      if (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1") return true;
      writeJson(res, 403, { ok: false, error: "forbidden" });
      return false;
    }
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

  /** 控制台方法当前是否可用（供 UI 显示登录状态与阻塞原因）。 */
  function consoleStatus() {
    const enabled = runtime.config.consoleEnabled === true;
    const refs = {};
    for (const id of SUPPLIER_IDS) {
      for (const method of methodsOf(id)) {
        if (method.transport !== "console") continue;
        refs[method.consoleRef] = runtime.console?.status?.(method.consoleRef) || { ref: method.consoleRef, open: false, visible: false, openedAt: null, lastError: null };
      }
    }
    return { enabled, refs: Object.values(refs) };
  }

  function buildStatePayload(session = null) {
    const { currentIds, todayOf, trafficStale } = collectTraffic();
    // 当前发现集合：最近一次「成功」扫描的结果。扫描失败不清空（保留上次成功发现），
    // 失败由 detect.error + 最后成功时间标明「未刷新」；只有一次成功的空扫描才移除发现状态。
    const currentFound = runtime.detect.error ? (runtime.detect.lastFound || []) : (runtime.detect.found || []);
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
      suppliers: SUPPLIER_IDS
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
      scope: {
        providerIds: [...QUERY_PROVIDER_IDS],
        notice: SCOPE_NOTICE,
      },
      active: session === null ? computeActiveSupplier() : computeActiveSupplierFor(String(session)),
      activeScope: session === null ? null : String(session),
      trafficStale: !!trafficStale,
      traffic: trafficDiag,
      now: new Date().toLocaleTimeString(),
      poll: {
        intervalSeconds: runtime.config.intervalSeconds,
        trafficWindowHours: runtime.config.trafficWindowHours,
        retentionDays: runtime.config.retentionDays || 7,
        consoleEnabled: runtime.config.consoleEnabled === true,
      },
      console: consoleStatus(),
      suppliers: SUPPLIER_IDS.map((id) => {
        const s = scheduler.getState(id);
        const c = supplierCfg(id);
        const rawC = runtime.config.suppliers?.[id] || {}; // 原始存储（不含环境密钥回退）
        const meta = PROVIDERS[id];
        const needSets = {};
        for (const need of meta?.needs || []) {
          if (need.key !== "apiKey" && need.secret) needSets[`${need.key}Set`] = !!rawC[need.key];
        }
        const needValues = {};
        for (const need of meta?.needs || []) {
          if (!need.secret && need.key !== "apiKey") needValues[need.key] = c[need.key] ?? "";
        }
        const anyKeySet = !!rawC.apiKey || Object.values(needSets).some(Boolean);
        // detectedNow 只表示「当前发现」（最近一次成功扫描的结果）
        const detectedNow = !!runtime.harness[id] || currentFound.includes(id);
        const added = detectedNow || !!c.enabled || anyKeySet;
        const addedReason = detectedNow ? "detected" : c.enabled ? "enabled" : anyKeySet ? "keySet" : null;
        // 方法开关与阻塞原因（供 UI 显示；不含秘密）
        const methodFlags = readMethodFlags(rawC);
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
          autoDetected: detectedNow,
          autoSource: c.autoSource || null,
          autoEnvName: c.autoApiKeyEnv || null,
          autoKeySource: c.autoSource ? runtime.harness[id]?.keySource || null : null,
          envKeySet: !!(c.autoSource && runtime.harness[id]?.apiKey),
          warnPct: c.warnPct,
          critPct: c.critPct,
          baseUrl: c.baseUrl,
          baseUrlDefault: meta.baseUrlDefault,
          methods: methodsOf(id).map((m) => ({
            methodId: m.methodId,
            transport: m.transport,
            kinds: m.kinds,
            defaultEnabled: m.defaultEnabled !== false,
            enabled: m.transport === "console"
              ? (methodFlags[m.methodId] === true && runtime.config.consoleEnabled === true)
              : methodFlags[m.methodId] !== false,
            needsConsole: m.transport === "console",
          })),
          meta: {
            credentialClass: meta.credentialClass || "api-key",
            credentialLabelKey: meta.credentialKey || "apiKey",
            credentialLabel: meta.credentialLabel || "API Key",
            official: meta.official || null,
            compat: meta.compat || null,
            needs: (meta.needs || []).map((n) => ({ key: n.key, label: n.label, secret: !!n.secret })),
          },
          ...(s.last
            ? s.last
            : { state: "off", status: STATUS.DISABLED, error: { code: "no-run", message: "尚未取数" }, headline: { kind: "amt", amt: "—" } }),
          // 成功数据时间独立于 fetchedAt；失败尝试只更新状态，不能冒充新数据。
          ...(s.lastSuccessAt != null ? { lastSuccessAt: s.lastSuccessAt } : {}),
          ...(s.methods ? { methodStates: s.methods } : {}),
        };
      }),
      history: runtime.history.slice(-50),
      storageError: usageStore.store.error,
      // 被排除／未映射的路由：只提示，不生成供应商卡片，也不含任何凭据
      excluded: runtime.unmapped.map((u) => ({
        route: u.route,
        displayName: u.displayName,
        ns: u.ns,
        reason: u.detail || u.reason || null,
      })).slice(0, 20),
      detectedUnmapped: runtime.unmapped.map((u) => ({ route: u.route, displayName: u.displayName, ns: u.ns, detail: u.detail || u.reason || null })).slice(0, 20),
      detect: runtime.detect,
      scan: scanCoordinator.revision,
    };
  }

  // ---------- 主入口 ----------

  /** 本行的用户层（= 用户真正配置过的字段）；行还不可描述时返回 null（未知，稍后重试）。 */
  function ownUserLayer() {
    try {
      const row = getSettings()?.describe?.({ redactSecrets: true })?.find((d) => d.ns === settingsNs);
      return row ? (row.user || {}) : null;
    } catch {
      return null;
    }
  }

  // 一次性配置迁移，覆盖两次来源变更（插件改名、0.1.7 表单改造）。
  // 本行已有用户层就绝不动；来源文件一律保留 —— 宁可留孤儿数据，也不让用户重填密钥。
  //
  // 范围收敛的迁移策略（方案 7.2）：
  //   - 被排除供应商的旧条目作为**惰性历史配置**原样保留（settings.update 是深合并，
  //     整体覆盖 suppliers 会造成不可逆丢失），只在生效视图与查询层过滤；
  //   - 白名单供应商的旧条目不需要重填，enabled/密钥/阈值保持原状态；
  //   - 新增字段（方法开关、工作空间、账户）采用真实类型默认值，不写入字符串布尔。
  async function migrateLegacyConfig() {
    try {
      const settings = getSettings();
      if (!settings) return false;
      if (typeof settings.describe !== "function" || typeof settings.update !== "function") return true;
      const user = ownUserLayer();
      if (user === null) return false;
      if (Object.keys(user).length > 0) return true; // 已有用户配置：不动
      const legacy = readLegacySections(dshHome(), [NS, LEGACY_NS]);
      try {
        const rows = settings.describe() || [];
        for (const ns of [NS, LEGACY_NS]) {
          const section = rows.find((d) => d.ns === ns)?.user;
          if (section && typeof section === "object") legacy[ns] = { ...(legacy[ns] || {}), ...section };
        }
      } catch {
        /* describe 失败：只按文档迁移 */
      }
      const section = mergeSections(legacy[LEGACY_NS], legacy[NS]); // 同名字段以新段为准，逐字段合并
      if (Object.keys(section).length === 0) return true;
      // 迁移前原子保存私有回滚快照（仅含本插件段，落在受限数据目录，不进仓库）
      saveRollbackSnapshot(section);
      // 只迁移白名单供应商的已知字段：被排除项原样留在旧文档/惰性配置里
      const filtered = filterMigratedSection(section);
      if (Object.keys(filtered.suppliers || {}).length || Object.keys(filtered).some((k) => k !== "suppliers")) {
        await writeSettings(filtered);
      }
      ctx.logger?.info?.(`[${NS}] 已把旧 settings 段（${Object.keys(legacy).join("、")}）迁移到本行配置；被排除供应商条目保留为惰性历史`);
      return true;
    } catch (error) {
      ctx.logger?.warn?.(`[${NS}] 旧配置迁移失败，保持原样: %s`, error?.message || error);
      return true;
    }
  }

  /** 迁移过滤：只保留白名单供应商的已知字段；未列入者不进生效配置。 */
  function filterMigratedSection(section) {
    const out = {};
    for (const [key, value] of Object.entries(section || {})) {
      if (key !== "suppliers") {
        out[key] = value;
        continue;
      }
      const suppliers = {};
      for (const [id, cfg] of Object.entries(value || {})) {
        if (!isQueryProvider(id)) continue; // 被排除项：不写入（旧配置仍在原文档中保留）
        const allowed = new Set(["enabled", "apiKey", "baseUrl", "warnPct", "critPct", "autoSource", "autoApiKeyEnv", "allowanceToken", "orgId", "workspaceId", "accountId", "statisticsTimeZone"]);
        const picked = {};
        for (const [field, fieldValue] of Object.entries(cfg || {})) {
          // 真实类型校验：布尔字段只接受布尔，字符串字段只接受字符串
          if (!allowed.has(field)) continue;
          if (["enabled"].includes(field) && typeof fieldValue !== "boolean") continue;
          if (["warnPct", "critPct"].includes(field) && typeof fieldValue !== "number") continue;
          if (["apiKey", "baseUrl", "autoSource", "autoApiKeyEnv", "allowanceToken", "orgId", "workspaceId", "accountId", "statisticsTimeZone"].includes(field) && typeof fieldValue !== "string") continue;
          picked[field] = fieldValue;
        }
        if (Object.keys(picked).length) suppliers[id] = picked;
      }
      if (Object.keys(suppliers).length) out.suppliers = suppliers;
    }
    return out;
  }

  /**
   * 迁移前写入私有回滚快照。仅保存在受限数据目录（0o600），不写入仓库或交付文档。
   * 权限设置失败时不继续危险迁移（抛错由调用方处理）。
   */
  function saveRollbackSnapshot(section) {
    try {
      const dir = `${dshHome()}/dsh-token-quota`;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = `${dir}/config-rollback-${Date.now()}.json`;
      writeFileSync(path, JSON.stringify(section, null, 2), { mode: 0o600 });
      chmodSync(path, 0o600);
      ctx.logger?.info?.(`[${NS}] 已保存配置回滚快照（私有目录）`);
    } catch (error) {
      // 快照失败：不继续危险迁移（旧文档本身仍在，用户配置未被修改）
      throw new Error(`配置回滚快照写入失败，已跳过迁移：${error?.message || error}`);
    }
  }

  const disposers = [() => scheduler.dispose(), () => runtime.console?.dispose?.()];
  let saveTimer = null;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const release of disposers.splice(0)) {
      if (typeof release !== "function") continue;
      try { release(); }
      catch (error) { ctx.logger?.warn?.("[dsh-token-quota] 清理资源失败: %s", error?.message || error); }
    }
  };
  // Cordis 将普通函数作为构造函数调用，此时返回的清理函数不会自动收集。
  // 在资源初始化前登记 effect，使停用、重启和启动失败均归宿主生命周期管理。
  if (typeof ctx.effect === "function") ctx.effect(() => dispose, "dsh-token-quota:cleanup");
  // 本地用量数据：启动时从 DSH 数据目录载入（小时桶），按保留期修剪
  const migration = migrateUsageDir(dshHome());
  runtime.usageFile = migration.path;
  if (migration.status === "fallback-legacy") {
    ctx.logger?.warn?.("[dsh-token-quota] 用量目录迁移失败（%s），继续使用旧目录 %s", migration.error, migration.path);
  } else if (migration.status === "migrated") {
    ctx.logger?.info?.("[dsh-token-quota] 用量目录已迁移到 %s", migration.path);
  }
  const usageStore = acquireUsageStore(runtime.usageFile, runtime.config.retentionDays || 7);
  disposers.push(() => {
    if (saveTimer) clearTimeout(saveTimer);
    const result = usageStore.release();
    if (!result.ok) ctx.logger?.warn?.("[quota-monitor] %s", result.error);
  });
  runtime.usageBuckets = usageStore.store.buckets;
  if (usageStore.store.error) ctx.logger?.warn?.("[dsh-token-quota] %s", usageStore.store.error);

  // ---- 自动探测 ----
  let tick = 0;
  const stamp = () => new Date().toLocaleTimeString();

  const scanCoordinator = createScanCoordinator({
    logger: ctx.logger,
    ...(globalThis.__DSH_SCAN_TIMING__ || {}),
    onError(error) {
      runtime.detect = {
        ...runtime.detect,
        lastFound: runtime.detect.found || [],
        at: stamp(),
        error: (error?.stack || String(error)).slice(0, 2000),
      };
    },
    async scan() {
      if (globalThis.__DSH_SCAN_FAIL__) throw new Error("injected scan failure");
      const detected = await detectHarnessSuppliers(ctx, {
        debug: true,
        include: (rec) => {
          if (rec.route === "deepseek-official") {
            return settingsUserHas(rec.ns, rec.path) || rec.keySource === "file" || rec.keySource === "credentials";
          }
          return rec.active || rec.configured || settingsUserHas(rec.ns, rec.path);
        },
      });
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
        if (d.supplier && isQueryProvider(d.supplier)) {
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
        ownUser = getSettings().describe({ redactSecrets: true }).find((d) => d.ns === settingsNs)?.user || {};
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

  const syncHarness = (reason = "periodic") => scanCoordinator.request({ reason });
  const rescanForSourceChange = (reason) => scanCoordinator.noteSourceChange(reason);
  const triggerScan = () => scanCoordinator.request({ reason: "manual", requireFresh: true });

  syncHarness("startup");
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
      if (consumeSelfWrite()) return;
      // 外部变化（用户改配置/宿主热重载）：配置实例 +1 使在途结果失效，并重扫
      configInstanceId = `i${Date.now().toString(36)}`;
      scheduler.setConfigInstanceId(configInstanceId);
      rescanForSourceChange("settings");
    }) || (() => {}),
  );

  // 迁移排在本行激活之后：apply 执行中本行还在激活过程中，describe() 可能尚看不到自己。
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

  // ---- 当前供应商与当日消耗量：session/event 折叠 ----
  const recordUsage = usageStore.store.recordUsage ??= createUsageRecorder(runtime.usageBuckets);
  const sessionSeen = new WeakMap();
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
      // 本地用量归集：resolveSupplier 只覆盖查询白名单；被排除厂商的本地统计
      // 继续通过 passiveSupplierForRoute 记录（历史连续性），但不产生远程查询。
      const supplierId = resolveSupplier(route) || passiveSupplierForRoute(route);
      if (supplierId && usage && typeof usage === "object") {
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
      syncHarness();
    }));
  } catch {
    /* 事件名未注册时忽略 */
  }

  try {
    disposers.push(ctx.on("credentials/reference-updated", () => {
      rescanForSourceChange("credentials");
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
        // 只刷新白名单内且已启用的供应商；被排除项即使 enabled=true 也不进入
        const ids = SUPPLIER_IDS.filter((id) => supplierCfg(id).enabled);
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
          // 白名单硬拦截：被排除/未知 ID 返回结构化 unsupported-provider，绝不发请求
          if (!isQueryProvider(id)) {
            const unsupported = unsupportedProviderResult(id);
            writeJson(res, 200, {
              ok: false,
              error: unsupported.error.message,
              status: STATUS.UNSUPPORTED_PROVIDER,
              excluded: true,
              result: null,
            });
            return;
          }
          if (body.config !== undefined && (!body.config || typeof body.config !== "object" || Array.isArray(body.config))) {
            throw new Error("test config must be an object");
          }
          const merged = { ...supplierCfg(id), ...body.config };
          const config = supplierSchema(id)(merged);
          // 逐个已启用方法测试（控制台方法需总开关）
          const methods = methodsOf(id).filter((m) => m.transport !== "console" || runtime.config.consoleEnabled === true);
          const results = await Promise.all(methods.map((m) => runMethod(id, m.methodId, { ...config, methods: readMethodFlags(config) }, {
            configInstanceId,
            console: runtime.config.consoleEnabled === true ? consoleBridge() : null,
          })));
          const ok = results.some((r) => r.status === STATUS.OK);
          writeJson(res, 200, {
            ok,
            error: ok ? undefined : results.map((r) => r.error?.message).filter(Boolean).join("；"),
            results: results.map((r) => ({ methodId: r.methodId, status: r.status, items: r.items })),
            result: results.length === 1 ? results[0] : null,
          });
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
          // 白名单校验：patch 里出现非白名单供应商一律拒绝（防止经设置接口扩大范围）
          for (const id of Object.keys(patch.suppliers || {})) {
            if (!isQueryProvider(id)) {
              writeJson(res, 400, { ok: false, error: `供应商 ${id} 不在本轮查询范围内` });
              return;
            }
          }
          for (const id of SUPPLIER_IDS) {
            const supplier = patch.suppliers?.[id];
            if (!supplier || typeof supplier !== "object") continue;
            // 空白密钥编辑 = 清除（显式语义），与「保留」区分：调用方用独立字段表达
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
        const outcome = await triggerScan();
        if (!outcome?.ok) {
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
    {
      kind: "exact",
      path: `${API_PREFIX}/console`,
      handler: async (req, res) => {
        if (!sameOriginGuard(req, res, "POST")) return;
        try {
          const body = await readJson(req);
          const action = body?.action;
          const allowed = ["status", "login", "complete-login", "read", "logout"];
          if (!allowed.includes(action)) throw new Error(`不支持的控制台动作 ${action}`);
          if (runtime.config.consoleEnabled !== true) {
            writeJson(res, 200, { ok: false, status: STATUS.DISABLED, error: "控制台取数未启用（需显式开启）" });
            return;
          }
          const bridge = consoleBridge();
          if (action === "status") {
            writeJson(res, 200, { ok: true, ...consoleStatus() });
            return;
          }
          // 控制台引用由**服务端**按供应商 ID 推导（客户端只传 supplier + action），
          // 杜绝前端指定任意引用／URL／JS。
          const supplierId = body?.supplier;
          if (!isQueryProvider(supplierId)) {
            writeJson(res, 200, { ok: false, status: STATUS.UNSUPPORTED_PROVIDER, error: unsupportedProviderResult(supplierId).error.message });
            return;
          }
          const consoleMethods = methodsOf(supplierId).filter((m) => m.transport === "console");
          const ref = consoleMethods[0]?.consoleRef || null;
          if (typeof ref !== "string" || !CONSOLE_REF_ORIGIN_KEY.originKeyOf(ref)) {
            writeJson(res, 200, { ok: false, status: STATUS.SCHEMA_MISMATCH, error: `供应商 ${supplierId} 没有可用的控制台方法` });
            return;
          }
          const probe = await bridge.probe();
          if (!probe.available) {
            writeJson(res, 200, { ok: false, status: STATUS.ENVIRONMENT_UNAVAILABLE, error: probe.error.message });
            return;
          }
          if (action === "login") {
            const params = consoleParams(ref, body?.params);
            writeJson(res, 200, { ok: true, ...(await bridge.login(ref, params)) });
            return;
          }
          if (action === "logout") {
            writeJson(res, 200, await bridge.logout(ref));
            return;
          }
          const params = consoleParams(ref, body?.params);
          const observation = action === "complete-login"
            ? await bridge.completeLogin(ref, params)
            : await bridge.read(ref, params);
          writeJson(res, 200, { ok: true, ref, observation });
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error.message, status: error.status || STATUS.NETWORK_ERROR });
        }
      },
    },
  ];
  try {
    for (const route of routes) disposers.push(ctx.webServer.register(route));
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}

/**
 * 控制台动作参数：只允许业务上必要的固定字段。
 * OpenDesign 的 workspace 需通过策略校验；DeepSeek 的时间范围由宿主按时区生成。
 */
function consoleParams(ref, raw) {
  if (ref === "opendesign-windows") {
    const input = String(raw?.workspace ?? "");
    const { workspace, error } = parseOpenDesignWorkspace(input);
    if (error) throw Object.assign(new Error(error), { status: STATUS.SCHEMA_MISMATCH });
    return { workspace };
  }
  if (ref === "deepseek-usage") {
    const timeZone = typeof raw?.timeZone === "string" && raw.timeZone ? raw.timeZone : undefined;
    const now = new Date();
    const offsetMinutes = typeof raw?.offsetMinutes === "number" ? raw.offsetMinutes : -now.getTimezoneOffset();
    const nowMs = now.getTime();
    const offsetMs = offsetMinutes * 60_000;
    const dayStartLocal = Math.floor((nowMs + offsetMs) / 86_400_000) * 86_400_000;
    const startMs = dayStartLocal - offsetMs;
    return {
      startSec: Math.floor(startMs / 1000),
      endSec: Math.floor(nowMs / 1000),
      tzSec: offsetMinutes * 60,
      timeZone,
    };
  }
  return {};
}
