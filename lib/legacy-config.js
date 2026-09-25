// lib/legacy-config.js — 旧 settings 文档读取（宿主半，无宿主依赖，便于单测）
//
// 0.1.7 起 harness 把配置搬到「profile 行 config」（cordis.patch.yml），启动时把旧的
// <DSH_HOME>/settings.yaml 一次性改名成 settings.yaml.imported，再逐段写进行 config。
// 本插件当时没能激活（ctx.settings.register 已移除），本行的段就只留在这份文档里 ——
// 用户的 API Key、启用开关都在其中，所以升级路径必须能把它读回来。
//
// 只认「嵌套字典 + 标量」这一种结构（旧 settings 段的真实形状），遇到别的结构（块标量、
// 流式集合、锚点……）就放弃该段：宁可让用户重填，也不能把密钥解析成错值。
// 纯函数：只读候选文档，不改文件。

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 候选文档：现名在前（改名未发生时仍读 settings.yaml）。 */
const DOCUMENTS = ["settings.yaml.imported", "settings.yaml"];

/** 顶层段的起始行：列 0 上的 `name:`。 */
const topLevelKey = (line) => /^([A-Za-z0-9_.-]+):\s*(#.*)?$/.exec(line)?.[1] ?? null;

/** 取某顶层段的行（不含该段的键行），到下一个顶层键或文件尾为止。 */
function sectionLines(lines, name) {
  const start = lines.findIndex((line) => topLevelKey(line) === name);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (topLevelKey(lines[i]) !== null) { end = i; break; }
  }
  return lines.slice(start + 1, end);
}

/** 去掉缩进后的注释与两端空白；引号内的 `#` 不算注释。 */
function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i);
  }
  return text;
}

/** 标量：引号字符串（含转义）/ 布尔 / null / 数字 / 裸串；无法确定时抛错。 */
function parseScalar(raw) {
  const text = raw.trim();
  if (text === "") return null;
  if (text[0] === '"') {
    if (!text.endsWith('"') || text.length < 2) throw new Error("未闭合的双引号");
    return JSON.parse(text);
  }
  if (text[0] === "'") {
    if (!text.endsWith("'") || text.length < 2) throw new Error("未闭合的单引号");
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[|>&*!%@`[\]{},]/.test(text)) throw new Error(`不支持的 YAML 结构: ${text.slice(0, 12)}`);
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text)) return Number(text);
  return text;
}

/**
 * 解析「嵌套字典 + 标量」的 YAML 子集。
 * @param lines 段内行（不含顶层键行）。
 * @returns 嵌套对象；结构不符合子集时抛错，由调用方丢弃该段。
 */
function parseSection(lines) {
  const root = {};
  // 栈项：{ indent, container, key }；key 为 null 表示该层是数组（旧段里不出现，遇错即抛）
  const stack = [{ indent: -1, container: root }];
  for (const raw of lines) {
    if (!raw.trim() || stripComment(raw).trim() === "") continue;
    const indent = raw.length - raw.trimStart().length;
    const text = stripComment(raw).trim();
    const match = /^([^:]+):(?:\s+(.*))?$/.exec(text);
    if (!match) throw new Error(`不支持的 YAML 行: ${text.slice(0, 20)}`);
    const key = parseScalar(match[1].trim());
    if (typeof key !== "string") throw new Error("键必须是字符串");
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (indent <= parent.indent) throw new Error("缩进不一致");
    const value = match[2];
    if (value === undefined || value.trim() === "") {
      const child = {};
      parent.container[key] = child;
      stack.push({ indent, container: child });
    } else {
      parent.container[key] = parseScalar(value);
    }
  }
  return root;
}

/**
 * 读取旧 settings 文档里指定段的用户配置。
 * @param home DSH 数据目录（storage.dshHome() 的返回值）。
 * @param names 段名，按优先级从低到高（后者覆盖前者）。
 * @returns { [name]: object }，只含成功解析且非空的段；文件缺失/不可读时返回 {}。
 */
export function readLegacySections(home, names) {
  const result = {};
  if (!home || !Array.isArray(names) || names.length === 0) return result;
  for (const doc of DOCUMENTS) {
    let text = null;
    try {
      text = readFileSync(join(home, doc), "utf8");
    } catch {
      continue; // 文档不存在或不可读：换下一个候选
    }
    const lines = text.split(/\r?\n/);
    for (const name of names) {
      try {
        const body = sectionLines(lines, name);
        if (!body || body.length === 0) continue;
        const parsed = parseSection(body);
        if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
          result[name] = { ...(result[name] || {}), ...parsed };
        }
      } catch {
        /* 该段不在支持的子集里：丢弃，绝不让半解析的值进入配置 */
      }
    }
  }
  return result;
}
