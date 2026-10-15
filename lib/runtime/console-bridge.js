// lib/runtime/console-bridge.js — 插件专用控制台会话桥接（宿主机器上的浏览器）
//
// 职责与边界（方案 6.2）：
//   - 只支持固定内部动作：status / login / complete-login / read / logout / dispose。
//   - 浏览器读取脚本来自随包发布的固定代码（lib/runtime/console-readers/*），
//     绝不接受前端传入任意 URL、JS、Cookie、可执行参数或配置目录路径。
//   - 持久化目录位于实际 DSH 数据目录下的插件专属子目录，按「配置实例／平台／工作空间」
//     隔离；文件名使用规范化标识或非秘密哈希，禁止路径穿越。
//   - 浏览器不支持同一 user-data-dir 并发打开：同目录只保留一个上下文，
//     一个引用一个上下文，卸载时全部关闭。
//   - 浏览器运行在 **DSH 宿主机**，不是访问 Web UI 的客户端机器；无图形环境时
//     返回可解释的 environment-unavailable，而不是假装登录成功。
//   - Cookie 与完整会话响应保留在专用浏览器目录与进程内；输出只含归一化业务数据。

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { STATUS, QueryError } from "../provider-common.js";
import { CONSOLE_ORIGINS } from "../provider-policy.js";
import { readerFor } from "./console-readers/index.js";

const READ_TIMEOUT_MS = 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

/** 安全目录名：配置实例／平台标识 → 非秘密哈希（不含用户输入路径片段）。 */
function profileDirName(configInstanceId, ref) {
  const digest = createHash("sha256").update(`${configInstanceId}|${ref}`).digest("hex").slice(0, 32);
  return digest;
}

/**
 * 创建控制台桥接。
 * @param opts.dataDir 插件数据目录（<DSH_HOME>/dsh-token-quota）
 * @param opts.configInstanceId 当前配置实例标识（配置修订时变化，使旧会话目录可分辨）
 * @param opts.logger 宿主 logger（只记录非秘密诊断）
 * @param opts.channel 浏览器渠道（默认自动发现）
 * @param opts.headless 无头模式（读取可用；登录必须可见）
 */
export function createConsoleBridge({
  dataDir,
  configInstanceId = "default",
  logger = null,
  channel = null,
  headless = null,
  launcher = null, // 测试注入：{ launch(opts) } 替代 playwright-core
} = {}) {
  /** ref -> { context, page, loginWindow, loginPending, lastError, profileDir } */
  const sessions = new Map();
  let playwrightModule = null;
  let playwrightError = null;
  let disposed = false;

  const log = (level, message) => {
    try {
      logger?.[level]?.(`[dsh-token-quota] ${message}`);
    } catch {
      /* 日志失败不影响主流程 */
    }
  };

  /** 惰性加载 playwright-core（生产依赖；缺失时给出明确阻塞状态）。 */
  async function loadPlaywright() {
    if (playwrightModule) return playwrightModule;
    if (playwrightError) throw playwrightError;
    if (launcher) {
      playwrightModule = launcher;
      return playwrightModule;
    }
    try {
      playwrightModule = await import("playwright-core");
      return playwrightModule;
    } catch (error) {
      playwrightError = new QueryError(
        STATUS.ENVIRONMENT_UNAVAILABLE,
        `浏览器运行时不可用（需要生产依赖 playwright-core）：${error?.message || error}`,
      );
      throw playwrightError;
    }
  }

  function profileDir(ref) {
    const dir = join(dataDir, "browser", profileDirName(configInstanceId, ref));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /**
   * 发现可用浏览器：优先宿主已安装且通过验证的 Edge／Chrome 渠道，
   * 其后回退 playwright 自带 chromium；都不存在时返回 null（不自动下载）。
   */
  async function resolveLaunchOptions() {
    const pw = await loadPlaywright();
    if (channel) return { channel };
    for (const candidate of ["msedge", "chrome"]) {
      try {
        const executable = pw.chromium.executablePath({ channel: candidate });
        if (executable) return { channel: candidate };
      } catch {
        /* 该渠道不存在：尝试下一个 */
      }
    }
    try {
      const executable = pw.chromium.executablePath();
      if (executable) return { executablePath: executable };
    } catch (error) {
      throw new QueryError(STATUS.ENVIRONMENT_UNAVAILABLE, `未找到可用的系统浏览器：${error?.message || error}`);
    }
    throw new QueryError(STATUS.ENVIRONMENT_UNAVAILABLE, "未找到可用的系统浏览器");
  }

  /** 浏览器是否可用（只做探测，不启动上下文）。 */
  async function probe() {
    try {
      await resolveLaunchOptions();
      return { available: true, error: null };
    } catch (error) {
      return { available: false, error: { code: error.status || STATUS.ENVIRONMENT_UNAVAILABLE, message: error.message } };
    }
  }

  async function ensureSession(ref, { visible }) {
    if (disposed) throw new QueryError(STATUS.ENVIRONMENT_UNAVAILABLE, "插件已卸载，控制台桥接不可用");
    const existing = sessions.get(ref);
    if (existing?.context) {
      if (visible && existing.context.headless) {
        // 同一 dir 不允许并发第二份上下文：先关旧的无头上下文再开可见窗口
        await closeSession(ref);
      } else {
        return existing;
      }
    }
    const options = await resolveLaunchOptions();
    const pw = await loadPlaywright();
    const dir = profileDir(ref);
    const useHeadless = visible ? false : (headless ?? true);
    let context;
    try {
      context = await pw.chromium.launchPersistentContext(dir, {
        ...options,
        headless: useHeadless,
        locale: "zh-CN",
        // 只读控制台取数：不注入任何凭据；会话由用户登录产生
        args: ["--no-first-run", "--no-default-browser-check"],
      });
    } catch (error) {
      throw new QueryError(STATUS.ENVIRONMENT_UNAVAILABLE, `浏览器上下文启动失败：${error?.message || error}`);
    }
    const session = {
      context,
      page: context.pages()[0] || (await context.newPage()),
      loginPending: null,
      visible: useHeadless === false,
      lastError: null,
      openedAt: Date.now(),
    };
    context.on("close", () => {
      // 外部关闭（用户关窗）时清理登记，下次读取会重新打开
      const current = sessions.get(ref);
      if (current === session) sessions.delete(ref);
    });
    sessions.set(ref, session);
    return session;
  }

  async function sessionPage(ref, { visible = false } = {}) {
    const session = await ensureSession(ref, { visible });
    if (session.page?.isClosed?.()) {
      session.page = await session.context.newPage();
    }
    return session;
  }

  /**
   * 打开登录窗口（用户主动触发）。窗口保持打开直到 complete-login 或超时。
   * @returns { ok, ref, url }
   */
  async function login(ref) {
    const origin = CONSOLE_ORIGINS[originKeyOf(ref)];
    if (!origin) throw new QueryError(STATUS.SCHEMA_MISMATCH, `未知的控制台引用 ${ref}`);
    const { page } = await sessionPage(ref, { visible: true });
    await page.goto(origin.loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    await page.bringToFront?.().catch(() => {});
    return { ok: true, ref, origin: origin.page, loginUrl: origin.loginUrl };
  }

  /**
   * 完成登录：用一次真实读取验证会话确实可用（而不是只看窗口是否存在）。
   * @returns 归一化观察载荷（成功）或抛 QueryError
   */
  async function completeLogin(ref, params = {}) {
    const observation = await read(ref, params);
    return observation;
  }

  /**
   * 读取控制台数据。
   * **脚本只来自随包发布的读取器注册表**：调用方（供应商模块）传入的 script／nonce／url
   * 一律忽略，避免出现第二份可被改写的页面代码。调用方只能提供业务上必要的固定参数
   * （OpenDesign 的 workspace、DeepSeek 的时间范围）与取消／超时控制。
   * @param ref    控制台引用（deepseek-usage / fireworks-balance / opendesign-windows）
   * @param params 固定参数
   */
  async function read(ref, params = {}) {
    const reader = readerFor(ref);
    if (!reader) throw new QueryError(STATUS.SCHEMA_MISMATCH, `未知的控制台读取器 ${ref}`);
    const { page } = await sessionPage(ref, { visible: false });
    const { url, script } = reader.build(params);

    // 页面不在目标来源时先导航（读取需要页面上下文与 cookie）
    const current = page.url?.() || "";
    const origin = CONSOLE_ORIGINS[originKeyOf(ref)]?.page;
    if (!origin || !current.startsWith(origin)) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((error) => {
        throw new QueryError(STATUS.NETWORK_ERROR, `控制台页面加载失败：${error?.message || error}`);
      });
    }

    const result = await runScript(page, script, params.signal);
    const observation = result?.observation ?? result;
    if (!observation || typeof observation !== "object") {
      throw new QueryError(STATUS.SCHEMA_MISMATCH, "控制台读取器未返回数据");
    }
    return observation;
  }

  /**
   * 在页面上下文执行固定读取脚本。
   * 脚本直接在页面内完成全部取数与归一化，并返回观察载荷（不做跨进程消息回传，
   * 避免把会话数据散落到宿主其它通道）；读取受 READ_TIMEOUT_MS 与调用方 signal 双重约束。
   */
  async function runScript(page, script, signal) {
    if (signal?.aborted) throw new QueryError(STATUS.NETWORK_ERROR, "已取消");
    let abortListener = null;
    try {
      const evaluation = page.evaluate(script);
      const timeout = new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new QueryError(STATUS.NETWORK_ERROR, "控制台读取超时")), READ_TIMEOUT_MS);
        timer.unref?.();
        abortListener = () => {
          clearTimeout(timer);
          reject(new QueryError(STATUS.NETWORK_ERROR, "已取消"));
        };
        signal?.addEventListener("abort", abortListener, { once: true });
      });
      const value = await Promise.race([evaluation, timeout]);
      return value && typeof value === "object" ? { observation: value } : null;
    } catch (error) {
      if (signal?.aborted) throw new QueryError(STATUS.NETWORK_ERROR, "已取消");
      throw error instanceof QueryError ? error : new QueryError(STATUS.NETWORK_ERROR, error?.message || "控制台读取失败");
    } finally {
      if (abortListener) signal?.removeEventListener("abort", abortListener);
    }
  }

  /** 注销：清除插件专用会话目录（不触碰系统浏览器资料）。 */
  async function logout(ref) {
    await closeSession(ref, { removeProfile: true });
    return { ok: true, ref };
  }

  async function closeSession(ref, { removeProfile = false } = {}) {
    const session = sessions.get(ref);
    if (!session) {
      if (removeProfile) await removeProfileDir(ref);
      return;
    }
    sessions.delete(ref);
    try {
      await session.context.close();
    } catch (error) {
      log("warn", `控制台上下文关闭失败（${ref}）：${error?.message || error}`);
    }
    if (removeProfile) await removeProfileDir(ref);
  }

  async function removeProfileDir(ref) {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(profileDir(ref), { recursive: true, force: true });
    } catch (error) {
      try {
        logger?.warn?.(`[dsh-token-quota] 控制台会话目录清理失败：${error?.message || error}`);
      } catch { /* ignore */ }
    }
  }

  /** 会话状态（只含非秘密字段，供 UI 显示登录状态）。 */
  function status(ref) {
    const session = sessions.get(ref);
    return {
      ref,
      open: !!session?.context,
      visible: !!session?.visible,
      openedAt: session?.openedAt ?? null,
      lastError: session?.lastError ?? null,
    };
  }

  /** 卸载：取消在途读取并关闭全部上下文（浏览器资源必须释放）。 */
  async function dispose() {
    if (disposed) return;
    disposed = true;
    const refs = [...sessions.keys()];
    await Promise.allSettled(refs.map((ref) => closeSession(ref)));
    sessions.clear();
  }

  return { probe, login, completeLogin, read, logout, status, dispose, refs: () => [...sessions.keys()] };
}

/** 控制台引用 → CONSOLE_ORIGINS 键。 */
function originKeyOf(ref) {
  if (ref === "deepseek-usage") return "deepseek";
  if (ref === "fireworks-balance") return "fireworks";
  if (ref === "opendesign-windows") return "opendesign";
  return null;
}

export const CONSOLE_REF_ORIGIN_KEY = { originKeyOf };
