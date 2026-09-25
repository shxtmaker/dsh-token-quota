// test/detect.mjs — 自动探测单元测试（真实 detect.js 逻辑，Mock llm/settings/credentials）
// 覆盖：官方/pi-ai 路由 → 供应商映射（凭据类别 × 地域）、Admin 聊天 Key 不套用组织供应商、
// 官方 Base URL 采纳与兼容来源网关地址、无密钥不启用、手动接管、skipSupplier。
// 用法：node test/detect.mjs
import assert from "node:assert/strict";
import { autoFillPatch, detectHarnessSuppliers } from "../lib/detect.js";
import { PROVIDERS } from "../lib/providers.js";

const BASE_URL_DEFAULTS = Object.fromEntries(Object.keys(PROVIDERS).map((id) => [id, PROVIDERS[id].baseUrlDefault]));

// 0.1.7：settings 按 profile 行 id 描述，每行一个 { ns, value } 视图（旧的 settings.get 已移除）。
const rowsOf = (map) => ({ describe: () => Object.entries(map).map(([ns, value]) => ({ ns, value })) });

// ---- 场景 1：ctx.llm 目录 + 存活路由 + credentials.resolve（凭据库 source=file） ----
const settings1 = rowsOf({
    "llm-deepseek": { baseURL: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY" },
    "llm-pi-ai": {
      providers: {
        deepseek: { baseURL: "https://api.deepseek.com/pi", apiKeyEnv: "DEEPSEEK_API_KEY" }, // 路径越界 → baseUrl 不采纳，但路由仍映射
        "opencode-go": { apiKeyEnv: "OPENCODE_GO_API_KEY" }, // 无 baseURL → 保留插件默认
        "commandcode-goat": { apiKeyEnv: "COMMANDCODE_GOAT_API_KEY", baseURL: "https://api.commandcode.ai/provider/v1" },
        "commandcode-v2": { apiKeyEnv: "COMMANDCODE_V2_API_KEY" }, // 前缀变体，应命中 commandcode 并被去重
        openrouter: { baseURL: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
        "moonshotai-cn": { baseURL: "https://api.moonshot.cn/v1", apiKeyEnv: "MOONSHOT_CN_API_KEY" },
        zai: { baseURL: "https://api.z.ai/api/anthropic", apiKeyEnv: "ZAI_API_KEY" },
        "minimax-cn": { baseURL: "https://www.minimaxi.com", apiKeyEnv: "MINIMAX_CN_API_KEY" },
        openai: { baseURL: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" }, // 普通聊天 Key → 不套用到 openai-org(Admin)
        moonshotai: { displayName: "Moonshot" }, // 只有名字，未配置端点 → 不算已添加
      },
    },
});
const ctx1 = {
  get: (name) => (name === "llm" ? llm1 : name === "credentials" ? credentials1 : undefined),
  settings: settings1,
};
const llm1 = {
  listProviders: () => [
    { id: "deepseek-official" }, { id: "deepseek" }, { id: "opencode-go" },
    { id: "commandcode-goat" }, { id: "commandcode-v2" }, { id: "openrouter" },
    { id: "moonshotai-cn" }, { id: "zai" }, { id: "minimax-cn" }, { id: "openai" },
  ],
  listConfigurableProviders: () => [
    { provider: "deepseek-official", displayName: "DeepSeek", settingsNs: "llm-deepseek", settingsPath: [] },
    { provider: "deepseek", displayName: "DeepSeek (pi)", settingsNs: "llm-pi-ai", settingsPath: ["providers", "deepseek"] },
    { provider: "opencode-go", displayName: "OpenCode (pi)", settingsNs: "llm-pi-ai", settingsPath: ["providers", "opencode-go"] },
    { provider: "commandcode-goat", displayName: "Command Code (pi)", settingsNs: "llm-pi-ai", settingsPath: ["providers", "commandcode-goat"] },
    { provider: "commandcode-v2", displayName: "Command Code v2", settingsNs: "llm-pi-ai", settingsPath: ["providers", "commandcode-v2"] },
    { provider: "openrouter", displayName: "OpenRouter", settingsNs: "llm-pi-ai", settingsPath: ["providers", "openrouter"] },
    { provider: "moonshotai-cn", displayName: "Moonshot CN", settingsNs: "llm-pi-ai", settingsPath: ["providers", "moonshotai-cn"] },
    { provider: "zai", displayName: "Z.ai", settingsNs: "llm-pi-ai", settingsPath: ["providers", "zai"] },
    { provider: "minimax-cn", displayName: "MiniMax CN", settingsNs: "llm-pi-ai", settingsPath: ["providers", "minimax-cn"] },
    { provider: "openai", displayName: "OpenAI", settingsNs: "llm-pi-ai", settingsPath: ["providers", "openai"] },
    { provider: "moonshotai", displayName: "Moonshot", settingsNs: "llm-pi-ai", settingsPath: ["providers", "moonshotai"] },
  ],
};
const credentials1 = {
  resolve: async (ref) => ({ value: "sk-" + ref, source: "file" }),
};

const detected1 = await detectHarnessSuppliers(ctx1, { debug: true });
assert.equal(detected1.meta.llmPresent, true, "debug meta 报告 llm 服务在位");
assert.equal(detected1.meta.credentialsPresent, true);
const bySupplier = new Map(detected1.filter((d) => d.supplier).map((d) => [d.supplier, d]));
assert.deepEqual([...bySupplier.keys()].sort(), [
  "commandcode", "deepseek", "minimax-cn", "moonshot-cn", "opencode", "openrouter", "zai",
], "官方 + pi-ai 普通 Key 路由应全部映射到对应供应商");
const ds = bySupplier.get("deepseek");
assert.equal(ds.route, "deepseek-official", "DeepSeek 官方路由优先");
assert.equal(ds.keySource, "file");
assert.equal(ds.key, "sk-DEEPSEEK_API_KEY");
const oc = bySupplier.get("opencode");
assert.equal(oc.route, "opencode-go");
assert.equal(oc.apiKeyEnv, "OPENCODE_GO_API_KEY");
assert.equal(oc.baseURL, null);
const cc = bySupplier.get("commandcode");
assert.equal(cc.route, "commandcode-goat", "精确名优先；commandcode-v2 被前缀去重");
assert.equal(cc.baseURL, "https://api.commandcode.ai/provider/v1");
assert.equal(bySupplier.get("moonshot-cn").route, "moonshotai-cn", "moonshotai-cn → moonshot-cn（国内）");
assert.equal(bySupplier.get("zai").route, "zai");
assert.equal(bySupplier.get("minimax-cn").route, "minimax-cn");
assert.equal(bySupplier.get("openrouter").key, "sk-OPENROUTER_API_KEY");
const openai = detected1.find((d) => d.route === "openai");
assert.equal(openai.supplier, null, "OpenAI 普通聊天 Key 不得映射到 openai-org（Admin）");
assert.match(openai.reason || "", /Admin Key/);
assert.equal(detected1.some((d) => d.route === "moonshotai"), false, "未配置端点的目录条目不算已添加");

const r1 = autoFillPatch(detected1, () => ({}), BASE_URL_DEFAULTS);
const p1 = r1.patch.suppliers;
assert.equal(p1.deepseek.enabled, true);
assert.equal(p1.deepseek.baseUrl, "https://api.deepseek.com/v1", "官方白名单路径内的 Base URL 跟随 DSH");
assert.equal(p1.deepseek.autoSource, "llm-deepseek");
assert.equal(p1.deepseek.apiKey, "sk-DEEPSEEK_API_KEY", "API Key 自动填入（拷贝 DSH 密钥本体）");
assert.equal(p1.opencode.enabled, true);
assert.equal(p1.opencode.autoSource, "llm-pi-ai");
assert.equal(p1.opencode.autoApiKeyEnv, "OPENCODE_GO_API_KEY");
assert.equal("baseUrl" in p1.opencode, false, "DSH 侧无 baseURL 时保留插件默认");
assert.equal(p1.commandcode.enabled, true);
assert.equal(p1.commandcode.baseUrl, "https://api.commandcode.ai/provider/v1", "兼容来源允许带网关路径的 HTTPS 地址");
assert.equal(p1.openrouter.enabled, true);
assert.equal(p1.openrouter.apiKey, "sk-OPENROUTER_API_KEY");
assert.equal(p1["moonshot-cn"].baseUrl, "https://api.moonshot.cn/v1");
assert.equal(p1.zai.baseUrl, "https://api.z.ai/api/anthropic");
assert.equal("openai-org" in p1, false, "Admin 供应商绝不因普通聊天 Key 自动填入");
assert.ok(r1.unfilled.some((u) => u.route === "openai" && u.detail && u.detail.includes("Admin Key")), "openai 应记 unfilled 提示需要 Admin Key");
console.log("✓ detect：目录+凭据解析、官方优先去重、地域/凭据类别映射、Base URL 采纳规则、Admin 不套用");

// 手动接管：已有 apiKey → 不动
const rManual = autoFillPatch(detected1, () => ({ apiKey: "sk-manual" }), BASE_URL_DEFAULTS);
assert.deepEqual(rManual.patch.suppliers, {});
// 用户显式关闭 → skipSupplier
const rSkip = autoFillPatch(detected1, () => ({}), BASE_URL_DEFAULTS, { skipSupplier: (id) => id === "deepseek" });
assert.equal("deepseek" in rSkip.patch.suppliers, false, "显式关闭的供应商不得再被自动启用");
assert.ok(rSkip.patch.suppliers.opencode && rSkip.patch.suppliers.commandcode, "其余未关闭供应商照常自动填");
console.log("✓ autoFillPatch：手动接管 / skipSupplier");

// ---- 场景 2：无 ctx.llm（配置文档兜底）+ 环境变量密钥 + 国际路由 ----
process.env.DEEPSEEK_API_KEY = "env-sk-ds";
process.env.OPENCODE_GO_API_KEY = "env-sk-oc";
process.env.COMMANDCODE_GOAT_API_KEY = "env-sk-cc";
process.env.OPENROUTER_API_KEY = "env-sk-or";
process.env.MOONSHOT_API_KEY = "env-sk-ms";
process.env.ZAI_CODING_CN_API_KEY = "env-sk-zcn";
const ctx2 = {
  settings: rowsOf({
      "llm-deepseek": { baseURL: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY" },
      "llm-pi-ai": {
        providers: {
          "opencode-go": { apiKeyEnv: "OPENCODE_GO_API_KEY" },
          "commandcode-goat": { apiKeyEnv: "COMMANDCODE_GOAT_API_KEY", baseURL: "https://api.commandcode.ai/provider/v1" },
          openrouter: { baseURL: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
          "moonshotai": { baseURL: "https://api.moonshot.ai/v1", apiKeyEnv: "MOONSHOT_API_KEY" },
          "zai-coding-cn": { baseURL: "https://open.bigmodel.cn/api/anthropic", apiKeyEnv: "ZAI_CODING_CN_API_KEY" },
        },
      },
  }),
};
const detected2 = await detectHarnessSuppliers(ctx2);
const sup2 = new Map(detected2.filter((d) => d.supplier).map((d) => [d.supplier, d]));
assert.deepEqual([...sup2.keys()].sort(), [
  "commandcode", "deepseek", "moonshot-intl", "opencode", "openrouter", "zai-cn",
]);
assert.equal(sup2.get("deepseek").keySource, "env");
assert.equal(sup2.get("moonshot-intl").key, "env-sk-ms");
assert.equal(sup2.get("zai-cn").route, "zai-coding-cn", "zai-coding-cn → zai-cn（智谱国内）");
console.log("✓ detect 兜底：无 llm 服务时按配置节枚举；moonshotai → 国际；zai-coding-cn → 国内");

// ---- 场景 3：无密钥的已配置路由 → 不自动启用但填入引用 ----
const noKey = [{ ...sup2.get("deepseek"), route: "deepseek", ns: "llm-pi-ai", path: ["providers", "deepseek"], key: null, keyPresent: false, keySource: null }];
const r3 = autoFillPatch(noKey, () => ({}), BASE_URL_DEFAULTS);
assert.equal(r3.patch.suppliers.deepseek.enabled, undefined, "无密钥不自动启用");
assert.equal("apiKey" in r3.patch.suppliers.deepseek, false, "无密钥不复制");
assert.equal(r3.patch.suppliers.deepseek.autoSource, "llm-pi-ai");
assert.equal(r3.unfilled[0].reason, "no-key");
console.log("✓ autoFillPatch：无密钥 → 只填引用、不启用，记 unfilled.no-key");

console.log("\n自动探测单元测试全部通过 ✔");
