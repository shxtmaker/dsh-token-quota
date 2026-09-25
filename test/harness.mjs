// test/harness.mjs — 0.1.7 settings 契约的最小实现（测试共用）
//
// 0.1.7 起 settings 表单按「profile 行 id」寻址（一个行 = 一张表单），写入走
// settings.update(rowId, patch)，且只有 schema 里标了 volatile 的字段可写、可热更新：
// loader 把行 config 解析成交互引用，变更就地提交并广播 loader/volatile-update。
// 这个模块把这三件事都模拟出来，供各测试直接 mount 插件：
//   - settings.describe()：行视图（ns/schema/value/base/user/revision）
//   - settings.update()  ：深合并进 user 层、推进 revision、触发 volatile 更新与事件
//   - config 引用         ：apply(ctx, config) 的第二参数（.get() 每次取当前值）
import assert from "node:assert/strict";

/** 深合并（对象逐键递归，数组/标量整体替换）——与 settings.update 的语义一致。 */
export function mergeDeep(target, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      target[key] = mergeDeep(target[key] && typeof target[key] === "object" ? target[key] : {}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

/**
 * settings 服务的最小实现。
 * @param ns       本插件所在的行 id。
 * @param base     行的组合基线层（patch 文件里的 config）。
 * @param user     行的用户层（settings.update 写入的地方）。
 * @param schema   Config schema（用于把原始配置解析成生效值，含 volatile 引用展开）。
 * @param foreign  其它行的视图（如 llm-deepseek / llm-pi-ai），原样进入 describe()。
 * @param inactive true = 本行还没激活（describe 看不到自己），用于迁移重试路径。
 */
export function createSettingsMock({ ns = "dsh-token-quota", base = {}, user = {}, schema, foreign = [], inactive = false } = {}) {
  const state = { revision: 1 };
  const userLayer = user === undefined ? {} : structuredClone(user);
  const writes = [];
  const listeners = [];
  const value = () => {
    const raw = mergeDeep(structuredClone(base), structuredClone(userLayer));
    if (!schema) return raw;
    const parsed = schema(raw);
    return parsed && typeof parsed.get === "function" ? parsed.get() : parsed;
  };
  const describe = (options = {}) => {
    const own = inactive ? [] : [{
      ns,
      autoGenerate: true,
      schema: schema?.toJSON?.() ?? {},
      value: value(),
      base: structuredClone(base),
      user: structuredClone(userLayer),
      revision: state.revision,
      applies: "live",
      ...(options.redactSecrets ? { secrets: [] } : {}),
    }];
    return own.concat(foreign);
  };
  return {
    service: {
      describe,
      update: async (target, patch) => {
        assert.equal(target, ns, `写入必须落在本行 id（${ns}），实际写的是 ${target}`);
        writes.push({ ns: target, patch: structuredClone(patch) });
        mergeDeep(userLayer, patch);
        state.revision++;
        for (const listener of listeners) listener();
      },
    },
    /** apply 的第二参数：模拟 loader 的 volatile 引用。 */
    ref: { get: value },
    writes,
    userLayer,
    foreign,
    activate: () => { inactive = false; },
    onUpdate: (listener) => listeners.push(listener),
    get revision() { return state.revision; },
  };
}

/**
 * 最小 Cordis ctx + settings mock + 路由/事件收集。
 * 同时注册 volatile 更新的广播：settings.update 之后调用 loader/volatile-update，
 * 与 harness 的 loader 行为一致（不重挂插件，只更新引用并发事件）。
 */
export function createCtx({ config = {}, user, schema, foreign = [], inactive = false, logger } = {}) {
  const settings = createSettingsMock({ base: config, user, schema, foreign, inactive });
  const routes = new Map();
  const events = new Map();
  const ctx = {
    settings: settings.service,
    webServer: {
      register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path); },
    },
    on: (name, fn) => {
      const list = events.get(name) ?? [];
      list.push(fn);
      events.set(name, list);
      // 与宿主一致：解绑后该事件不再在 ctx 上留痕（空键也删掉，便于断言「dispose 后不监听」）
      return () => {
        const rest = (events.get(name) || []).filter((f) => f !== fn);
        if (rest.length) events.set(name, rest);
        else events.delete(name);
      };
    },
    get: (name) => (name === "credentials" ? { resolve: async () => null } : undefined),
    logger: logger ?? { info() {}, warn() {}, error() {} },
  };
  settings.onUpdate(() => {
    for (const fn of events.get("loader/volatile-update") ?? []) fn([]);
  });
  return {
    ctx,
    settings,
    routes,
    events,
    configRef: settings.ref,
    /** 触发某事件的全部监听者（测试里模拟宿主事件）。 */
    emit: (name, ...args) => { for (const fn of events.get(name) ?? []) fn(...args); },
    /** 同步读取某路由的 JSON 响应（GET/简化 POST）。 */
    call: async (path, body) => {
      const handler = routes.get(path);
      if (!handler) throw new Error(`未注册路由 ${path}`);
      let payload;
      const res = { writeHead() {}, end(text) { payload = JSON.parse(text); } };
      const req = body === undefined
        ? { method: "GET", headers: {}, url: "/" }
        : Object.assign(new (await import("node:stream")).PassThrough(), { method: "POST", headers: {}, url: "/" });
      const done = handler(req, res);
      if (body !== undefined) { req.end(JSON.stringify(body)); await done; }
      return payload;
    },
  };
}
