// lib/runtime/console-readers/index.js — 控制台读取器注册表
//
// 读取器是**随包发布的固定代码**：每个引用对应一个确定的页面来源、确定的取数路径与
// 固定的归一化逻辑。桥接不接受外部传入 URL／JS，参数只允许业务上必要的固定字段
// （如 OpenDesign 的 workspace、DeepSeek 的时间范围），并在此处做白名单校验。

import * as deepseek from "./deepseek-usage.js";
import * as fireworks from "./fireworks-balance.js";
import * as opendesign from "./opendesign-windows.js";

export const READERS = Object.freeze({
  "deepseek-usage": Object.freeze({
    id: "deepseek-usage",
    providerId: "deepseek",
    /** @param params { startSec, endSec, tzSec } */
    build(params) {
      const startSec = requireInt(params?.startSec, "startSec");
      const endSec = requireInt(params?.endSec, "endSec");
      const tzSec = requireInt(params?.tzSec, "tzSec", { min: -16 * 3600, max: 16 * 3600 });
      if (endSec <= startSec) throw new Error("控制台读取范围无效");
      return {
        url: deepseek.CONSOLE_URL,
        script: deepseek.readScript({ startSec, endSec, tzSec }),
      };
    },
  }),
  "fireworks-balance": Object.freeze({
    id: "fireworks-balance",
    providerId: "fireworks",
    build() {
      return { url: fireworks.CONSOLE_URL, script: fireworks.readScript() };
    },
  }),
  "opendesign-windows": Object.freeze({
    id: "opendesign-windows",
    providerId: "opendesign",
    /** @param params { workspace } */
    build(params) {
      const workspace = String(params?.workspace ?? "");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspace)) throw new Error("OpenDesign 工作空间标识无效");
      return {
        url: opendesign.dashboardUrl(workspace),
        script: opendesign.readScript({ workspace }),
      };
    },
  }),
});

export function readerFor(ref) {
  return Object.hasOwn(READERS, ref) ? READERS[ref] : null;
}

function requireInt(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`控制台读取参数 ${name} 无效`);
  return parsed;
}
