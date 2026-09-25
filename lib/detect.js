// lib/detect.js — DSH 供应商自动探测（宿主半）
// 读取 DSH LLM 路由注册表（ctx.llm）与提供方设置文档（ctx.settings / ctx.credentials），
// 把 DSH 内已添加/启用的供应商映射到本插件的供应商，并生成「自动填入」设置补丁。
//
// 映射边界（对齐 Token-Consumption-Monitoring docs/query-coverage.md）：
//   - 「已添加」以 DSH 设置行（llm-deepseek / llm-pi-ai 的 profile 行 config）为事实来源，
//     ctx.llm 目录/存活路由作为补充（服务未就绪/异常时探测不受影响）
//   - 供应商按「凭据类别 × 地域」拆分；普通 API Key / Management Key / Admin Key
//     不互相尝试。pi-ai 普通聊天路由（openai / anthropic / openrouter 等）中，
//     openai 与 anthropic 的账务查询需要 Admin Key → 探测时标记 reason，不自动填入；
//     openrouter 普通 Key 可直接用于 Key 额度和今日费用 → 自动填入 openrouter；
//     openrouter-account（Management）/ openai-org / anthropic-org（Admin）仅在有
//     匹配类别的 DSH 密钥时才可能自动填（当前 DSH 无该类接缝 → 手动配置）。
//   - 地域拆分：moonshotai（api.moonshot.ai → 国际）/ moonshotai-cn（国内）、
//     zai（api.z.ai）/ zai-coding-cn（open.bigmodel.cn）、
//     minimax（www.minimax.io）/ minimax-cn（www.minimaxi.com）。
//   - 同一插件供应商命中多条 DSH 路由时按 ROUTE_PRIORITY 去重（官方路由优先）
//   - 补丁含 enabled / baseUrl / autoSource / autoApiKeyEnv / apiKey：
//     密钥本体直接拷贝进插件 settings（role('secret') 自动脱敏）；
//     baseUrl 仅在 DSH 路由地址是该供应商官方地址时采用，否则保留插件官方默认值
//   - 只填用户尚未手动设置过的字段（apiKey 已设 = 手动接管；enabled 显式 false 由调用方跳过）

import { OFFICIAL_HOSTS, isOfficialBaseUrl, PROVIDERS } from "./providers.js";

/** 兼容来源（无官方端点白名单）的 Base URL 采纳门槛：仅要求安全的 HTTPS 形态。 */
function isSafeHttpsBaseUrl(baseUrl) {
  try {
    const url = new URL(String(baseUrl || "").trim());
    const defaultPort = !url.port || (url.protocol === "https:" && url.port === "443");
    return url.protocol === "https:" && defaultPort && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/** DSH LLM 路由 id → 本插件供应商 id（官方/pi-ai 目录路由，精确匹配优先）。 */
export const DSH_ROUTE_MAP = {
  // deepseek-official = 官方 DeepSeek 适配器；deepseek = llm-pi-ai 同名单路由
  "deepseek-official": "deepseek",
  deepseek: "deepseek",
  // pi-ai 官方目录路由（普通 Key 可直接用于对应账务/额度接口）
  openrouter: "openrouter",
  moonshotai: "moonshot-intl",
  "moonshotai-cn": "moonshot-cn",
  zai: "zai",
  "zai-coding-cn": "zai-cn",
  minimax: "minimax",
  "minimax-cn": "minimax-cn",
  // OpenCode / Command Code 兼容来源（pi-ai declared / 目录）
  opencode: "opencode",
  "opencode-go": "opencode",
  commandcode: "commandcode",
  "commandcode-goat": "commandcode",
};

/** 前缀兜底：pi-ai declared 路由名带变体（commandcode-goat、opencode-xx 等）仍能命中。 */
const ROUTE_PREFIX_MAP = [
  ["commandcode", "commandcode"],
  ["opencode", "opencode"],
];

/**
 * DSH 官方主机 → 供应商提示（仅用于 route 名不在精确/前缀表时的兜底归类；
 * 不以密钥前缀、不以普通聊天 Key 推断 Admin/Management 账务）。
 */
const HOST_HINT = [
  ["deepseek.com", "deepseek"],
  ["opencode.ai", "opencode"],
  ["commandcode.ai", "commandcode"],
  ["openrouter.ai", "openrouter"],
  ["moonshot.cn", "moonshot-cn"],
  ["moonshot.ai", "moonshot-intl"],
  ["api.z.ai", "zai"],
  ["z.ai", "zai"],
  ["bigmodel.cn", "zai-cn"],
  ["minimax.io", "minimax"],
  ["minimaxi.com", "minimax-cn"],
  // openai / anthropic 普通聊天 Key 无法查询组织账务（需 Admin Key）→ 只提示原因
  ["openai.com", null],
  ["anthropic.com", null],
];

/** 主机（含子域）→ 供应商/原因。null = 已知主机但需要更高凭据类别。 */
export function supplierHintForHost(hostname) {
  if (!hostname) return { supplier: null, reason: null };
  const host = String(hostname).toLowerCase().replace(/\.$/, "");
  for (const [suffix, supplier] of HOST_HINT) {
    if (host === suffix || host.endsWith(`.${suffix}`)) {
      const reason = supplier === null
        ? "已知官方主机；组织账务查询需要 Admin Key（DSH 普通聊天 Key 不适用）"
        : null;
      return { supplier, reason };
    }
  }
  return { supplier: null, reason: null };
}

/** 路由 id → 插件供应商 id（精确表优先，其次前缀；不做主机推断）。 */
export function supplierForRoute(route) {
  if (typeof route !== "string") return null;
  if (Object.hasOwn(DSH_ROUTE_MAP, route)) return DSH_ROUTE_MAP[route];
  for (const [prefix, supplier] of ROUTE_PREFIX_MAP) {
    if (route.startsWith(prefix)) return supplier;
  }
  return null;
}

/** 同供应商多路由并存时的优先序（越小越优先；缺省 99）。 */
const ROUTE_PRIORITY = {
  "deepseek-official": 1,
  deepseek: 2,
};

/** 无 ctx.llm 时按已知适配器家族兜底读取的 settings 行 id。 */
const FALLBACK_NS = {
  "deepseek-official": "llm-deepseek",
  deepseek: "llm-pi-ai",
};

/** 按 settingsPath 下钻：[] → 整个 section，['providers','x'] → 逐个取键。 */
function dig(obj, path) {
  let cur = obj;
  for (const key of path || []) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * 读取某个 settings 行的生效值（0.1.7：settings.describe() 按 profile 行 id 列出各表单，
 * 每个描述符带脱敏后的 value/base/user；旧的 settings.get(ns) 已不存在）。
 * 宿主内调用不带 redactSecrets，拿得到密钥字段本身；行不存在/描述失败一律 undefined。
 */
function settingsValue(ctx, ns) {
  if (!ns) return undefined;
  try {
    return ctx?.settings?.describe?.()?.find((row) => row?.ns === ns)?.value;
  } catch {
    return undefined;
  }
}

/** 提取 provider profile 的凭据引用与端点（apiKeyEnv/baseURL 为 DSH 适配器统一拼写）。 */
function profileFields(profile) {
  if (!profile || typeof profile !== "object") return { apiKeyEnv: null, baseURL: null, configured: false };
  const apiKeyEnv =
    typeof profile.apiKeyEnv === "string" && profile.apiKeyEnv.trim() ? profile.apiKeyEnv.trim() : null;
  const baseURL =
    typeof profile.baseURL === "string" && profile.baseURL.trim() ? profile.baseURL.trim() : null;
  return { apiKeyEnv, baseURL, configured: !!(apiKeyEnv || baseURL) };
}

/**
 * 探测 DSH 内已添加/启用的供应商。
 * - 数据源（设置文档优先，llm 目录补充）：
 *     1) listConfigurableProviders()/listProviders()（ctx.llm，异常不影响）；
 *     2) settings.describe() 里 'llm-deepseek' 整行、'llm-pi-ai' 行的 providers 字典。
 * - 密钥值通过 ctx.credentials.resolve(ref) 解析（失败时退回 process.env 直读）；
 *   返回记录含 key（仅供宿主侧自动填入使用，严禁经路由/状态暴露给浏览器）。
 * - include(rec) 可由调用方过滤（如只认 DSH user 层已配置的路由）。
 * - debug=true 时结果数组挂 meta（llmPresent / liveRoutes / directoryEntries / candidates），
 *   供运行诊断；candidates 只含非密钥字段。
 * @param ctx  Cordis ctx（llm/credentials 为可选服务，用 ctx.get 获取）
 */
export async function detectHarnessSuppliers(ctx, { include = () => true, debug = false } = {}) {
  const get = typeof ctx?.get === "function" ? ctx.get.bind(ctx) : () => undefined;
  const llm = get("llm") || ctx?.llm;
  const credentials = get("credentials") || ctx?.credentials;
  const meta = {
    llmPresent: !!llm,
    credentialsPresent: !!credentials,
    directoryEntries: 0,
    liveRoutes: [],
    candidates: [],
  };

  const live = new Set();
  try {
    for (const p of llm?.listProviders?.() ?? []) {
      if (p && p.id) live.add(p.id);
    }
  } catch { /* llm 异常 → 按设置文档兜底 */ }
  meta.liveRoutes = [...live];

  const entries = new Map();
  try {
    for (const entry of llm?.listConfigurableProviders?.() ?? []) {
      if (entry && entry.provider) entries.set(entry.provider, entry);
    }
  } catch { /* llm 异常 → 按设置文档兜底 */ }

  // 设置文档兜底：无论 ctx.llm 是否可用/就绪，配置节里已添加的供应商都纳入候选
  try {
    const ds = settingsValue(ctx, "llm-deepseek");
    if (profileFields(ds).configured) {
      entries.set("deepseek-official", {
        provider: "deepseek-official",
        displayName: "DeepSeek",
        settingsNs: "llm-deepseek",
        settingsPath: [],
      });
    }
  } catch { /* 忽略 */ }
  try {
    const pi = settingsValue(ctx, "llm-pi-ai");
    for (const [provider, profile] of Object.entries(pi?.providers || {})) {
      if (profile && typeof profile === "object") {
        entries.set(provider, {
          provider,
          displayName: profile.displayName || provider,
          settingsNs: "llm-pi-ai",
          settingsPath: ["providers", provider],
          declared: true,
        });
      }
    }
  } catch { /* 忽略 */ }

  meta.directoryEntries = entries.size;
  const routes = [...entries.keys()].sort(
    (a, b) => (ROUTE_PRIORITY[a] ?? 99) - (ROUTE_PRIORITY[b] ?? 99) || a.localeCompare(b),
  );

  const raw = [];
  for (const route of routes) {
    const entry = entries.get(route) || {};
    const ns = entry.settingsNs || FALLBACK_NS[route];
    const path = entry.settingsPath || [];
    // 0.1.7：适配器声明的 settingsNs 就是 profile 行 id，describe() 里按 id 找那一行。
    // 无路径信息时退回该家族已知的兜底行（llm-deepseek / llm-pi-ai）。
    const value = settingsValue(ctx, ns) ?? settingsValue(ctx, FALLBACK_NS[route]);
    const profile = dig(value, path);

    const { apiKeyEnv, baseURL, configured } = profileFields(profile);
    const active = live.has(route);
    if (!active && !configured) continue; // 未添加也未启用 → 不算「已添加」

    // 供应商归属：精确/前缀表 → 已知主机兜底归类（null 时保留 reason）
    let supplier = supplierForRoute(route);
    let hostHint = { supplier: null, reason: null };
    if (!supplier && baseURL) {
      try {
        hostHint = supplierHintForHost(new URL(baseURL).hostname);
      } catch {
        /* 忽略非法 URL */
      }
    }
    if (!supplier) supplier = hostHint.supplier;
    const reason = supplier ? null : hostHint.reason;

    // 凭据类别守门：只有凭据类别为 api-key 的供应商才可从普通聊天路由自动接入；
    // admin-key / management-key 供应商绝不因普通 Key 命中而自动填入。
    let classMismatch = false;
    if (supplier) {
      const cls = PROVIDERS[supplier]?.credentialClass;
      if (cls && cls !== "api-key") {
        classMismatch = true;
        supplier = null;
      }
    }

    const rec = {
      route,
      supplier,
      displayName: entry.displayName || route,
      ns: ns || null,
      path: [...(entry.settingsPath || [])],
      active,
      configured,
      declared: entry.declared || null,
      apiKeyEnv,
      keyPresent: false,
      keySource: null, // 'credentials' | 'file' | 'env' | null
      key: null,
      baseURL,
      reason: classMismatch
        ? "该供应商需要更高凭据类别（Admin/Management Key），DSH 普通聊天 Key 不适用"
        : reason,
    };

    if (apiKeyEnv) {
      let value;
      let source;
      if (credentials?.resolve) {
        try {
          const hit = await credentials.resolve(apiKeyEnv);
          if (hit && typeof hit === "object" && hit.value) {
            value = hit.value;
            source = hit.source || "credentials";
          }
        } catch {
          /* 解析失败 → 环境变量兜底 */
        }
      }
      if (!value) {
        try {
          const envValue = typeof process !== "undefined" ? process.env?.[apiKeyEnv] : undefined;
          if (envValue) {
            value = envValue;
            source = "env";
          }
        } catch {
          /* 忽略 */
        }
      }
      rec.keyPresent = !!value;
      rec.key = value || null;
      rec.keySource = source || null;
    }

    if (debug) {
      meta.candidates.push({
        route: rec.route,
        supplier: rec.supplier,
        displayName: rec.displayName,
        active: rec.active,
        configured: rec.configured,
        ns: rec.ns,
        apiKeyEnv: rec.apiKeyEnv,
        baseURL: rec.baseURL,
        keyPresent: rec.keyPresent,
        keySource: rec.keySource,
        reason: rec.reason || null,
      });
    }
    if (!include(rec)) continue;
    raw.push(rec);
  }

  // 同供应商多路由去重：官方路由优先（routes 已按 ROUTE_PRIORITY 排序）
  const picked = new Map();
  const rest = [];
  for (const rec of raw) {
    if (rec.supplier && picked.has(rec.supplier)) continue;
    if (rec.supplier) picked.set(rec.supplier, rec);
    else rest.push(rec); // 未映射路由全部保留（供 UI 提示）
  }
  const result = [...picked.values(), ...rest];
  result.routeSuppliers = Object.fromEntries(raw.filter((r) => r.supplier).map((r) => [r.route, r.supplier]));
  if (debug) result.meta = meta;
  return result;
}

/**
 * 由探测结果生成设置补丁（不复制密钥）。
 * @param detected        detectHarnessSuppliers(ctx) 的结果
 * @param getCurrent      (supplierId) => 当前插件设置（enabled/apiKey/baseUrl…）
 * @param baseUrlDefaults { supplierId: 插件默认 baseUrl }
 * @param opts.skipSupplier (supplierId) => boolean  用户显式关闭等情形跳过自动填入
 * @returns { patch, applied, unfilled }
 *   patch.suppliers[id] 含 enabled/baseUrl/autoSource/autoApiKeyEnv/apiKey（密钥为探测解析值）；
 *   applied: [{ supplier, fields }]；
 *   unfilled: [{ supplier 或 route, reason: 'no-key' | 'unsupported' | string }]
 */
export function autoFillPatch(detected, getCurrent, baseUrlDefaults, { skipSupplier = () => false } = {}) {
  const patch = { suppliers: {} };
  const applied = [];
  const unfilled = [];
  for (const d of detected) {
    if (!d.supplier) {
      unfilled.push({
        route: d.route,
        displayName: d.displayName,
        reason: "unsupported",
        detail: d.reason || null,
      });
      continue;
    }
    if (skipSupplier(d.supplier)) continue;
    // 凭据类别守门：仅 api-key 类别（含私有兼容）参与自动填入
    if (PROVIDERS[d.supplier]?.credentialClass && PROVIDERS[d.supplier].credentialClass !== "api-key") {
      unfilled.push({ supplier: d.supplier, route: d.route, reason: "class-mismatch", detail: "需要更高凭据类别，请手动配置" });
      continue;
    }
    const cur = getCurrent(d.supplier) || {};
    if (cur.apiKey) continue; // 已手动设置密钥 → 手动接管，不动
    const fields = [];
    const p = {};
    const defaultBase = baseUrlDefaults[d.supplier];
    const currentBase = String(cur.baseUrl || "");
    // baseUrl 采纳：官方供应商要求 DSH 路由地址即其官方地址（路径白名单）；
    // 私有兼容来源（opencode/commandcode）只要求安全 HTTPS 形态（可带网关路径）
    const adoptableBase = OFFICIAL_HOSTS[d.supplier]
      ? isOfficialBaseUrl(d.supplier, d.baseURL)
      : isSafeHttpsBaseUrl(d.baseURL);
    if ((!currentBase || currentBase === defaultBase) && d.baseURL && d.baseURL !== currentBase
      && adoptableBase) {
      p.baseUrl = d.baseURL;
      fields.push("Base URL");
    }
    if (d.ns && (cur.autoSource || "") !== d.ns) {
      p.autoSource = d.ns;
      fields.push("来源");
    }
    if ((cur.autoApiKeyEnv || "") !== (d.apiKeyEnv || "")) {
      p.autoApiKeyEnv = d.apiKeyEnv || "";
      fields.push("密钥引用");
    }
    const keyOk = d.keyPresent && !!d.key;
    if (keyOk && !cur.apiKey) {
      // API Key 自动填入：拷贝探测解析出的 DSH 密钥本体（role('secret') 脱敏保存）
      p.apiKey = d.key;
      fields.push("API Key");
    }
    if (keyOk && !cur.enabled) {
      p.enabled = true;
      fields.push("启用");
    } else if (!keyOk) {
      unfilled.push({ supplier: d.supplier, route: d.route, reason: "no-key" });
    }
    if (fields.length) {
      patch.suppliers[d.supplier] = p;
      applied.push({ supplier: d.supplier, fields });
    }
  }
  return { patch, applied, unfilled };
}

// 供外部诊断使用（保留原语义导出）
export const OFFICIAL_HOSTS_FOR_DETECT = OFFICIAL_HOSTS;
