// lib/detect.js — DSH 供应商自动探测（宿主半，范围收敛后）
//
// 读取 DSH LLM 路由注册表（ctx.llm）与提供方设置文档（ctx.settings / ctx.credentials），
// 把 DSH 内已添加/启用的供应商映射到本插件的**查询白名单**供应商，并生成自动填入补丁。
//
// 范围边界（方案 1.2 / 1.3）：
//   - 探测只在 lib/provider-policy.js 的 7 个查询 ID 内产生候选；被排除厂商
//     （OpenAI/Codex、Anthropic、Moonshot、Z.ai、MiniMax 及未列入者）**不解析其凭据**、
//     不生成供应商卡片，只在诊断里给出「不在本轮查询范围」的原因。
//   - 本地 Token 观测映射（PASSIVE_ROUTE_MAP）与被排除厂商无关地继续工作：
//     排除只针对远程查询，不限制模型调用，也不删除本地用量历史。
//   - 凭据类别守门：只有 api-key 类别的供应商才可从普通聊天路由自动接入；
//     management-key（openrouter-account）绝不因普通 Key 命中而自动填入。
//   - opencode / commandcode / fireworks / opendesign 为平台自己的账户／套餐查询：
//     即使承载 GPT/Claude/Gemini/Kimi 等模型，也不顺着模型名称追查上游厂商账户。

import { OFFICIAL_HOSTS, isOfficialBaseUrl, PROVIDERS } from "./providers.js";
import { isQueryProvider, passiveSupplierForRoute } from "./provider-policy.js";

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

/** DSH LLM 路由 id → 活动查询供应商 id（仅白名单；精确匹配优先）。 */
export const DSH_ROUTE_MAP = {
  // deepseek-official = 官方 DeepSeek 适配器；deepseek = llm-pi-ai 同名单路由
  "deepseek-official": "deepseek",
  deepseek: "deepseek",
  openrouter: "openrouter",
  // OpenCode / Command Code / Fireworks / OpenDesign（pi-ai declared / 目录）
  opencode: "opencode",
  "opencode-go": "opencode",
  commandcode: "commandcode",
  "commandcode-goat": "commandcode",
  fireworks: "fireworks",
  "fireworks-ai": "fireworks",
  opendesign: "opendesign",
  "open-design": "opendesign",
};

/** 前缀兜底：pi-ai declared 路由名带变体（commandcode-goat、opencode-xx 等）仍能命中。 */
const ROUTE_PREFIX_MAP = [
  ["commandcode", "commandcode"],
  ["opencode", "opencode"],
];

/**
 * DSH 官方主机 → 查询供应商提示（仅用于 route 名不在精确/前缀表时的兜底归类）。
 * 被排除厂商的主机只给出排除原因，绝不产生候选。
 */
const HOST_HINT = [
  ["deepseek.com", "deepseek"],
  ["opencode.ai", "opencode"],
  ["commandcode.ai", "commandcode"],
  ["openrouter.ai", "openrouter"],
  ["fireworks.ai", "fireworks"],
  ["open-design.ai", "opendesign"],
  // 以下主机属于本轮排除范围：只提示原因，不产生候选、不解析凭据
  ["openai.com", null],
  ["chatgpt.com", null],
  ["anthropic.com", null],
  ["claude.ai", null],
  ["moonshot.cn", null],
  ["moonshot.ai", null],
  ["kimi.com", null],
  ["z.ai", null],
  ["bigmodel.cn", null],
  ["minimax.io", null],
  ["minimaxi.com", null],
  ["googleapis.com", null],
  ["x.ai", null],
];

const EXCLUDED_HOST_REASON = "该厂商不在本轮查询范围（仅 DeepSeek／OpenRouter／OpenCode／Command Code／Fireworks／OpenDesign 参与远程查询）";

/** 主机（含子域）→ 供应商/原因。null = 已知但不在本轮查询范围。 */
export function supplierHintForHost(hostname) {
  if (!hostname) return { supplier: null, reason: null };
  const host = String(hostname).toLowerCase().replace(/\.$/, "");
  for (const [suffix, supplier] of HOST_HINT) {
    if (host === suffix || host.endsWith(`.${suffix}`)) {
      const reason = supplier === null ? EXCLUDED_HOST_REASON : null;
      return { supplier, reason };
    }
  }
  return { supplier: null, reason: null };
}

/** 路由 id → 查询供应商 id（精确表优先，其次前缀；不做主机推断）。 */
export function supplierForRoute(route) {
  if (typeof route !== "string") return null;
  if (Object.hasOwn(DSH_ROUTE_MAP, route)) return DSH_ROUTE_MAP[route];
  for (const [prefix, supplier] of ROUTE_PREFIX_MAP) {
    if (route.startsWith(prefix)) return supplier;
  }
  return null;
}

/** 本地观测归集（含被排除厂商的历史连续性）；查询层不使用此结果。 */
export function passiveSupplierForRouteExport(route) {
  return passiveSupplierForRoute(route);
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
 */
function settingsValue(settings, ns) {
  if (!ns) return undefined;
  try {
    return settings?.describe?.()?.find((row) => row?.ns === ns)?.value;
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
 * - 返回记录含 key（仅供宿主侧自动填入使用，严禁经路由/状态暴露给浏览器）。
 * - 只有白名单供应商会解析凭据：被排除路由在解析前即被拦截（keyPresent 恒 false）。
 */
export async function detectHarnessSuppliers(ctx, { include = () => true, debug = false } = {}) {
  const get = typeof ctx?.get === "function" ? ctx.get.bind(ctx) : (name) => ctx?.[name];
  const settings = get("settings");
  if (!settings?.describe) throw new Error("宿主设置服务暂不可用，请稍后重新扫描");
  const llm = get("llm");
  const credentials = get("credentials");
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
    const ds = settingsValue(settings, "llm-deepseek");
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
    const pi = settingsValue(settings, "llm-pi-ai");
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
    const value = settingsValue(settings, ns) ?? settingsValue(settings, FALLBACK_NS[route]);
    const profile = dig(value, path);

    const { apiKeyEnv, baseURL, configured } = profileFields(profile);
    const active = live.has(route);
    if (!active && !configured) continue; // 未添加也未启用 → 不算「已添加」

    // 供应商归属：精确/前缀表 → 已知主机兜底归类（null 时保留原因）
    let supplier = supplierForRoute(route);
    let hostHint = { supplier: null, reason: null };
    const accountRoute = route === "deepseek-account";
    if (!supplier && baseURL && !accountRoute) {
      try {
        hostHint = supplierHintForHost(new URL(baseURL).hostname);
      } catch {
        /* 忽略非法 URL */
      }
    }
    if (!supplier) supplier = hostHint.supplier;
    const reason = accountRoute
      ? "桌面登录凭证不能用于 API Key 余额接口；可在 DeepSeek 配置页填写同一账户的 API Key 查询余额，无需重复添加账户"
      : supplier ? null : hostHint.reason;

    // 查询白名单硬校验：非白名单一律不产生候选项（更不解析凭据）
    if (supplier && !isQueryProvider(supplier)) supplier = null;

    // 凭据类别守门：只有 api-key 类别才可从普通聊天路由**自动填入**。
    // 注意：这里只标记，不把供应商判为未知 —— 控制台会话类（如 OpenDesign）
    // 仍应被识别为「已发现的平台」，由 UI 提示另行填写工作空间；
    // 真正的拦截发生在 autoFillPatch（不把推理 Key 当作控制台认证）。
    const classMismatch = !!supplier
      && !!PROVIDERS[supplier]?.credentialClass
      && PROVIDERS[supplier].credentialClass !== "api-key";

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
        ? "该供应商需要更高凭据类别（Management Key），DSH 普通聊天 Key 不适用"
        : reason,
    };

    // 只有确认属于查询白名单、且凭据类别为 api-key 的候选才解析凭据：
    // 被排除路由与需要 Management/OAuth 类别的来源都到此为止（不读密钥本体）。
    if (apiKeyEnv && rec.supplier && !classMismatch) {
      let resolved;
      let source;
      if (credentials?.resolve) {
        try {
          const hit = await credentials.resolve(apiKeyEnv);
          if (hit && typeof hit === "object" && hit.value) {
            resolved = hit.value;
            source = hit.source || "credentials";
          }
        } catch {
          /* 解析失败 → 环境变量兜底 */
        }
      }
      if (!resolved) {
        try {
          const envValue = typeof process !== "undefined" ? process.env?.[apiKeyEnv] : undefined;
          if (envValue) {
            resolved = envValue;
            source = "env";
          }
        } catch {
          /* 忽略 */
        }
      }
      rec.keyPresent = !!resolved;
      rec.key = resolved || null;
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
        apiKeyEnv: rec.supplier && !classMismatch ? rec.apiKeyEnv : null, // 非白名单/更高类别不暴露密钥引用名
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
 * 只对查询白名单内的供应商、且只对已允许字段做最小补丁；被排除项一律跳过。
 * @returns { patch, applied, unfilled }
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
    // 白名单硬校验：不在查询范围的供应商绝不写入配置补丁
    if (!isQueryProvider(d.supplier)) {
      unfilled.push({ route: d.route, supplier: d.supplier, reason: "out-of-scope", detail: d.reason || null });
      continue;
    }
    if (skipSupplier(d.supplier)) continue;
    // 凭据类别守门：仅 api-key 类别参与自动填入
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
