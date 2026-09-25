// lib/client.js — DSH Web 客户端半（浏览器，经 /plugins/dsh-token-quota/client.js 加载）
//
// 渲染契约（v0.2 彻底重构版）：
//   1. 小组件不再扫描/劫持侧边栏 DOM，而是注册进 DSH 官方侧边栏底槽
//      `sidebar.footer.action`（list，keyed id=dsh-token-quota）—— 由侧边栏外壳（
//      @deepseek-ai/dsh-client-ui-sidebar）在脚部区 footArea 内以正常内容流渲染，
//      与其他 footer action（remote-web-ui、cordis-panel 等）并排，永不重叠；
//      侧栏收起为 rail 时外壳会传入 wide=false，小组件自动切换为图标态并保持可用。
//      宽栏紧凑条（v1.2 多行，wayfinder 票 #8/#9）三行：
//        第 1 行 连接状态 · 今日 token 消耗（今日 = 所有 current 供应商 todayTokens 求和）；
//               连接状态 = DSH 事件通道是否活着（state.traffic.channelAlive）× 取数健康度：
//               已连接 / 已连接·降级（有 enabled∧added 供应商标记 err）/ 待命（通道未见过流量但已有配置）
//               / 未连接（通道未见过流量且无任何已配置供应商）。
//        第 2 行 在用供应商 · 模型（当前显示页无调用时显示「暂无调用」，严格不回退其它页）。
//        第 3 行 元信息：相对时间 · 限额状态 · 重置时间（取最紧限额条目的 reset）· ×N 候选；
//               单行省略 + title 兜底全文，容器 < 200px 时整行收起（ResizeObserver 打 .qm-narrow）。
//        布局变体 A（三行堆叠，默认）/ B（点锚供应商行 + 分隔线）/ C（两列网格，今日量右置）
//        经 ?qm-strip=A|B|C 切换，供定稿比较；定稿后删掉未选变体与开关即可。
//      显示页 = Session Controller 的 sessions.list.current（官方服务订阅，切会话即时重渲并按新会话 id 拉 /state），
//      多个会话并行用不同供应商时互不串页。
//   2. 供应商明细 Popover 与详情/设置弹层用 createPortal 挂到 document.body
//      （与官方 dsh-client-ui-cordis / dsh-remote-web-ui 同款），Popover 以
//      「bottom 对齐锚点上方」的官方定位方式展开，带视口钳制 —— 不做 fixed 悬浮
//      小组件、不做 z-index 夸张的贴边浮动层。
//   3. 设置页走官方 `settings.section` 列表槽位（0.1.7 起取代 settings.plugin.item）：
//      本插件自成一页渲染在设置面板内容列，导航项文案由 label thunk 随 locale 重取。
//
// 纯 React.createElement（无构建步骤），样式注入 DSW 主题变量。
(function () {
  window.__ModuleLoader__.load({
    id: "dsh-token-quota",
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

      const React = require("react");
      const { createPortal } = require("react-dom");
      const h = React.createElement;

      const NS = "dsh-token-quota";
      const API = "/api/dsh-token-quota";
      // 按会话页缓存最近一次 /state：切回某页时先显示缓存再后台刷新（切页实时，不闪「暂无调用」）
      const STATE_CACHE_LIMIT = 20;
      const stateCache = new Map(); // sessionKey -> payload
      // 当前「显示页」= Session Controller 的 sessions.list.current；apply 时装配订阅源，
      // 由 FooterSlotWithSession（useSyncExternalStore）消费，切页即时重渲。
      let sessionListSource = null;

      // ---------- 工具 ----------
      const fmtBig = (n) => {
        if (n === null || n === undefined) return "—";
        const v = Number(n);
        if (!Number.isFinite(v)) return "—";
        if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
        if (Math.abs(v) >= 1e3) return `${Math.round(v / 1e3)}K`;
        return String(v);
      };
      // 阈值判定（A3 统一口径）：详情卡、供应商状态药丸、设置页预览与 stateToken 共用这一个纯函数。
      // 默认 80/95；无值/未知值/NaN 一律归为 unknown，绝不折成正常的 0%。
      const WARN_PCT_DEFAULT = 80;
      const CRIT_PCT_DEFAULT = 95;
      const classifyPct = (pct, { warnPct, critPct } = {}) => {
        const value = pct === null || pct === undefined || pct === "" ? NaN : Number(pct);
        if (!Number.isFinite(value)) return "unknown";
        const warn = Number.isFinite(Number(warnPct)) ? Number(warnPct) : WARN_PCT_DEFAULT;
        const crit = Number.isFinite(Number(critPct)) ? Number(critPct) : CRIT_PCT_DEFAULT;
        return value >= crit ? "crit" : value >= warn ? "warn" : "ok";
      };
      const stateClass = (s) => s?.state || "off";
      const stateToken = (s) => {
        if (!s) return "stateOff";
        if (s.state === "err") return "stateErr";
        if (s.state === "off") return "stateOff";
        const pct = Math.max(...(s.entries || []).map((x) => x.pct).filter(Number.isFinite));
        if (Number.isFinite(pct)) {
          const cls = classifyPct(pct, { warnPct: s.warnPct, critPct: s.critPct });
          if (cls === "crit") return "stateCrit";
          if (cls === "warn") return "stateWarn";
        }
        return "stateOk";
      };
      const fmtAge = (ms, t) => {
        const s = Math.max(0, Math.floor(Number(ms) / 1000));
        if (s < 60) return t("justNow");
        const m = Math.floor(s / 60);
        if (m < 60) return t("minAgo", { n: m });
        const h = Math.floor(m / 60);
        if (h < 24) return t("hourAgo", { n: h });
        return t("dayAgo", { n: Math.floor(h / 24) });
      };
      const pctText = (v) => {
        if (v === null || v === undefined) return "—";
        const s = String(v);
        return s.includes("%") ? s : `${s}%`;
      };
      const headlineOf = (s) => {
        if (!s?.headline) return "—";
        return s.headline.kind === "pct" && s.headline.pct !== null && s.headline.pct !== undefined
          ? pctText(s.headline.pct)
          : s.headline.amt || "—";
      };
      // 多行紧凑条：第 1 行取「用量 + 今日消耗」，第 3 行元信息按字段拆成有序数组，
      // 由渲染层决定丢弃顺序（先 ×N，再限额/重置，最后相对时间），避免各处重复判断。
      const metaFieldsOf = (meta) => [
        meta.age,
        meta.stale,
        meta.quota,
        meta.reset,
        meta.count,
      ].filter((x) => x && x.text);
      const metaLineOf = (meta) => metaFieldsOf(meta).map((x) => x.text).join(" · ");
      const metaTitleOf = (meta, extras) => metaFieldsOf(meta).map((x) => x.text).concat(extras || []).filter(Boolean).join(" · ");
      // 「最紧限额条目」= 已用百分比最高的那条；重置时间优先取它的 reset，其次取 headline.reset
      const tightestOf = (entries) => {
        let best = null;
        for (const e of entries || []) {
          if (!Number.isFinite(e?.pct)) continue;
          if (!best || e.pct > best.pct) best = e;
        }
        return best;
      };
      /** 合法重置时刻的下界：epoch-毫秒。低于此值视为「未提供重置时刻」的占位。 */
      const MIN_RESET_EPOCH_MS = 1e9;

      // 重置倒计时：宿主若给了原始时刻（entry.resetAt / headline.resetAt，epoch-毫秒），
      // 由客户端精确算剩余量——< 1 天显示 *h*m，≥ 1 天显示 *d*h。
      // 宿主只给文案（如「约 43 小时后重置」）或没有时刻时不猜：原样回落，绝不推算时刻。
      const fmtCountdown = (resetAt, tr) => {
        const ms = Number(resetAt);
        // 需要的是一个**时刻**：epoch-毫秒必然 > 1e9（2001-09 之后）。
        // 上游偶尔给出 0 / 负值 / 秒级值当作「无重置时刻」的占位（真实样本：
        // Command Code windowLimits 缺失时 resetAt=0）——这类值绝不能拿去算倒计时，
        // 否则会画出「即将重置」这种上游从未说过的结论。
        if (!Number.isFinite(ms) || ms < MIN_RESET_EPOCH_MS) return null;
        const diff = ms - Date.now();
        if (diff <= 0) return tr("resetSoon");
        const totalMin = Math.floor(diff / 60_000);
        const mins = totalMin % 60;
        const hours = Math.floor(totalMin / 60);
        if (hours < 24) return tr("resetInHM", { h: hours, m: String(mins).padStart(2, "0") });
        return tr("resetInDH", { d: Math.floor(hours / 24), h: hours % 24 });
      };
      // 重置时间文本：优先精确倒计时，否则用宿主文案（"—" 视为缺失）
      const resetTextOf = (entry, headline, tr) => {
        const countdown = fmtCountdown(entry?.resetAt ?? headline?.resetAt, tr);
        if (countdown) return countdown;
        const raw = (entry?.reset && entry.reset !== "—" ? entry.reset : null)
          || (headline?.reset && headline.reset !== "—" ? headline.reset : null);
        return raw || null;
      };
      // 小组件第 1 行的连接状态（票 #9 追加口径）= DSH 事件通道是否活着 × 限额取数健康度：
      //   ok   通道已见真实流量事件，且已配置供应商无取数失败
      //   warn 通道活着，但有供应商取数失败（降级）
      //   err  本次启动后通道尚未见到任何流量事件，且没有任何已配置供应商 → 未连接
      //   off  插件已加载、有已配置供应商，但通道还没见到流量 → 待命
      //        （别把「插件刚起来/还没发起调用」谎报成「断开」）
      const connStateOf = (state) => {
        const channelAlive = !!state?.traffic?.channelAlive;
        const suppliers = state?.suppliers || [];
        const failed = suppliers.filter((s) => s.enabled && s.added && s.state === "err").length;
        if (!channelAlive && suppliers.length === 0) return { key: "err", cls: "err", failed: 0 };
        if (!channelAlive) return { key: "off", cls: "off", failed: 0 };
        if (failed > 0) return { key: "warn", cls: "warn", failed };
        return { key: "ok", cls: "ok", failed: 0 };
      };
      // 小组件多行布局变体（A 三行堆叠 / B 点锚供应商行 + 分隔线 / C 两列网格）。
      // 落地期支持 ?qm-strip=A|B|C 在真实 GUI 里切换比较；定稿后保留 A 为默认、其余留作参考。
      const STRIP_DEFAULT = "A";
      let stripVariant = STRIP_DEFAULT;
      const stripListeners = new Set();
      const stripSearch = () => {
        try { return String(globalThis.location?.search || ""); } catch { return ""; }
      };
      const stripFromSearch = (search) => {
        const m = /[?&]qm-strip=([ABC])/i.exec(search || "");
        return m ? m[1].toUpperCase() : STRIP_DEFAULT;
      };
      stripVariant = stripFromSearch(stripSearch());
      const setStripVariant = (v) => {
        if (!["A", "B", "C"].includes(v) || v === stripVariant) return;
        stripVariant = v;
        for (const fn of stripListeners) fn();
      };
      const stripStore = {
        subscribe(fn) {
          stripListeners.add(fn);
          return () => stripListeners.delete(fn);
        },
        getSnapshot: () => stripVariant,
      };
      function useStripVariant() {
        return React.useSyncExternalStore(stripStore.subscribe, stripStore.getSnapshot, stripStore.getSnapshot);
      }

      // ---------- API ----------
      // sessionId undefined = 不按会话（沿用全局最近一次，兼容无 sessions 服务的嵌入场景）；
      // sessionId 为具体 id / 空串 = 严格「当前页」语义（空串即无当前页，显示暂无调用）。
      //
      // 请求生命周期（A1）：
      //   - 每个请求都有「初始等待上限」（超时即 abort 并进入重试），但超时不等于服务端操作失败：
      //     refresh/test 可能在服务端继续跑到 120s，客户端只是先放弃等待。
      //   - 取消一律走 AbortController（释放请求）；「请求代次校验」负责阻止不可取消或
      //     已完成的请求回写 —— 两者不能互相替代。
      //   - 后台 GET 采用「完成后调度」：上一次结束后再等 BACKOFF，而不是固定间隔不断发起。
      const REQUEST_TIMEOUT_MS = 30_000;   // GET /state 的初始等待上限
      const MUTATE_TIMEOUT_MS = 150_000;   // refresh/test：后端最长 120s 查询 + 余量
      const WRITE_TIMEOUT_MS = 30_000;     // settings/rescan：本地写入与扫描
      const POST_TIMEOUT_MS = {
        [`${API}/refresh`]: MUTATE_TIMEOUT_MS,
        [`${API}/test`]: MUTATE_TIMEOUT_MS,
        [`${API}/settings`]: WRITE_TIMEOUT_MS,
        [`${API}/rescan`]: WRITE_TIMEOUT_MS,
      };
      const POLL_BACKOFF_MS = [10_000, 20_000, 40_000, 60_000]; // 后台 GET 成功后复位到 10s
      const backoffDelay = (failures) => POLL_BACKOFF_MS[Math.min(Math.max(failures, 1), POLL_BACKOFF_MS.length) - 1];

      const timeoutController = (signal, ms) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(timeoutError(ms)), ms);
        return { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, clear: () => clearTimeout(timer) };
      };
      const timeoutError = (ms) => {
        const error = new Error(`timeout after ${ms}ms`);
        error.name = "TimeoutError";
        return error;
      };
      // 取消（切页/隐藏/卸载，AbortError）与等待超时（TimeoutError）都释放请求，但语义不同：
      // 取消不计为失败；超时按失败推进退避（10→20→40→60s，见 load 的 catch）。
      const isCancelled = (error) => error?.name === "AbortError";

      const cacheState = (key, payload) => {
        if (stateCache.has(key)) stateCache.delete(key); // 置新后按最近使用排序，淘汰最旧
        stateCache.set(key, payload);
        if (stateCache.size > STATE_CACHE_LIMIT) stateCache.delete(stateCache.keys().next().value);
      };
      const queryOf = (sessionId) => (sessionId === undefined ? "" : `?session=${encodeURIComponent(sessionId || "")}`);

      /** GET /state：校验 HTTP 状态与载荷 ok 字段；signal 释放请求，超时由局部 helper 统一管理。 */
      const getState = async (sessionId, { signal } = {}) => {
        const guard = timeoutController(signal, REQUEST_TIMEOUT_MS);
        try {
          const response = await fetch(`${API}/state${queryOf(sessionId)}`, { cache: "no-store", signal: guard.signal });
          // 显式失败才算失败（ok === false）：保持与 post 同一判定，兼容不带 ok 字段的替身响应
          if (response.ok === false) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json().catch(() => {
            throw new Error("invalid JSON payload");
          });
          if (payload?.ok === false) throw new Error(payload.error || "state unavailable");
          return payload;
        } finally {
          guard.clear(); // 成功、失败、取消都必须释放超时定时器
        }
      };
      const post = async (path, body, sessionId, { signal } = {}) => {
        const guard = timeoutController(signal, POST_TIMEOUT_MS[path] ?? REQUEST_TIMEOUT_MS);
        try {
          const response = await fetch(`${path}${queryOf(sessionId)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body || {}),
            signal: guard.signal,
          });
          const result = await response.json().catch(() => {
            throw new Error(`HTTP ${response.status}`);
          });
          if (response.ok === false || result?.ok === false) throw new Error(result?.error || `HTTP ${response.status}`);
          return result;
        } finally {
          guard.clear();
        }
      };

      /**
       * 会话级请求表：同一会话同时最多一个后台 GET（重复 load 合并到同一 Promise），
       * 切换会话时取消旧请求；手动 refresh 暂停后台轮询并在结束后恢复。
       *
       * 两条独立的作废手段（缺一不可）：
       *   - AbortController：真正释放挂起的请求（网络层取消）；
       *   - inflight 令牌 / 代次：拦住「不可取消、已完成或已超时」的响应回写。
       */
      const requestScheduler = (() => {
        // key -> { controller, generation, stopped, paused, manual, inflight, waiting, visible }
        const entries = new Map();
        const entryOf = (key) => {
          let entry = entries.get(key);
          if (!entry) {
            entry = { controller: null, generation: 0, stopped: false, paused: false, manual: null,
              inflight: null, waiting: null, visible: true };
            entries.set(key, entry);
          }
          return entry;
        };
        /** 页面隐藏：停表并取消在途 GET，但不作废代次（恢复可见后同一循环继续跑）。 */
        const pause = (key) => {
          const entry = entries.get(key);
          if (!entry) return;
          entry.paused = true;
          entry.controller?.abort();
          entry.controller = null;
        };
        /** 回写资格：在途令牌、控制器、代次三者都未被替换，且循环未作废。 */
        const publishable = (entry, token, controller, generation) =>
          entry.inflight === token.promise && entry.controller === controller
          && entry.generation === generation && !entry.stopped;
        return {
          async load(key, generation, { onFailure, onSuccess } = {}) {
            const entry = entryOf(key);
            if (entry.inflight) return entry.inflight; // 同一会话的重复 load 合并
            if (entry.stopped || entry.paused || entry.manual || entry.generation !== generation) {
              return { status: "cancelled" };
            }
            const controller = new AbortController();
            entry.controller = controller;
            // 先在途登记、再启动异步体：若先 await 再登记，快路径下 finally 会先清掉登记，
            // 结果被自己的「在途校验」判成取消（重复 load 合并也因此失效）。
            const token = { controller, generation, promise: null };
            token.promise = (async () => {
              try {
                const payload = await getState(key, { signal: controller.signal });
                if (!publishable(entry, token, controller, generation)) return { status: "cancelled" };
                if (payload?.ok === false) return { status: "failed", error: new Error(payload.error || "state unavailable") };
                onSuccess(payload);
                return { status: "ok", payload };
              } catch (error) {
                if (!publishable(entry, token, controller, generation)) return { status: "cancelled" };
                if (isCancelled(error)) return { status: "cancelled" }; // 切页/隐藏/卸载：不算失败
                onFailure(error); // 超时与网络错误：作为本轮取数失败计入退避
                return { status: "failed", error };
              } finally {
                if (entry.inflight === token.promise) { entry.inflight = null; entry.controller = null; }
              }
            })();
            entry.inflight = token.promise;
            return entry.inflight;
          },
          async refresh(key, { onSuccess } = {}) {
            const entry = entryOf(key);
            if (entry.stopped) return { status: "cancelled" };
            if (entry.manual) return entry.manual; // 合并重复点击的同一次刷新
            entry.controller?.abort();
            entry.controller = null;
            entry.paused = true; // 手动刷新期间暂停后台 GET，避免两路并发回写
            const controller = new AbortController();
            entry.controller = controller;
            const token = { controller, generation: entry.generation, promise: null };
            token.promise = (async () => {
              let payload;
              try {
                payload = await post(`${API}/refresh`, undefined, key, { signal: controller.signal });
              } catch (error) {
                return { status: isCancelled(error) ? "aborted" : "failed", error };
              } finally {
                // 先清登记、再解除暂停：hook 在 await 返回后会立刻 resume()，
                // 若此时 manual 还在，恢复出来的后台 GET 会被当作「重复 load」合并掉。
                if (entry.manual === token.promise) entry.manual = null;
                if (entry.controller === controller) entry.controller = null;
              }
              entry.paused = false; // 完成后恢复后台轮询（由 hook 触发一次「完成后调度」）
              if (!entry.stopped && entry.controller === null && payload?.ok !== false) onSuccess(payload);
              return { status: "ok", payload };
            })();
            entry.manual = token.promise;
            return entry.manual;
          },
          /** 会话切换/卸载：取消在途请求并作废代次（迟到的响应不得回写）。 */
          cancel(key) {
            const entry = entries.get(key);
            if (!entry) return;
            entry.stopped = true;
            entry.generation++;
            entry.controller?.abort();
            entry.controller = null;
          },
          /** 页面隐藏：暂停并释放请求，不作废代次。 */
          pause(key) {
            const entry = entries.get(key);
            entry.visible = false;
            pause(key);
          },
          /** 恢复可见：解除暂停，允许同一循环继续发后台 GET。 */
          unpause(key) {
            const entry = entries.get(key);
            if (!entry) return;
            entry.paused = false;
            entry.visible = true;
          },
          /** 手动刷新是否已在进行（用于合并重复点击）。 */
          busy: (key) => !!entries.get(key)?.manual,
          /** 注册「完成后调度」入口：hook 每次起循环时挂上，手动刷新结束后据此续跑。 */
          attach(key, arm) {
            const entry = entryOf(key);
            entry.waiting = arm;
            entry.stopped = false;
            entry.paused = false;
            entry.generation++;
            return entry.generation; // 本循环的请求代次
          },
          /** 后台循环的续跑登记：hook 在手动刷新结束后调用，触发一次「完成后调度」。
           *  页面仍隐藏时不续跑（arm 自身也会拒绝），避免留下「暂停期间已排定」的定时器。 */
          resume(key) {
            const entry = entries.get(key);
            if (!entry || entry.stopped || !entry.visible) return;
            entry.waiting?.(POLL_BACKOFF_MS[0]);
          },
        };
      })();

      // ---------- 数据 hook（跟随当前会话页；每页拉取互不干扰） ----------
      // 「完成后调度」：每次请求结束（或失败退避）后再排下一次，而不是固定间隔不断发起；
      // 同一时刻最多一个后台 GET，重复 load 合并，切页取消旧请求并立即查询新会话。
      function useQuotaState(sessionId) {
        const key = sessionId;
        const [state, setState] = React.useState(null); // { key, payload }
        const [refreshing, setRefreshing] = React.useState(false);
        const [loadError, setLoadError] = React.useState(null);
        React.useEffect(() => {
          let stopped = false;
          let paused = false;   // 页面隐藏或手动刷新期间暂停后台 GET
          let failures = 0;
          let timer = null;
          const alive = () => !stopped;
          const hidden = () => document.visibilityState === "hidden";
          const arm = (ms) => {
            if (!alive() || paused || hidden() || timer) return;
            timer = setTimeout(() => { timer = null; void cycle(); }, ms);
            timer?.unref?.();
          };
          const generation = requestScheduler.attach(key, arm); // 本循环的请求代次
          const cycle = async () => {
            if (!alive() || paused || hidden()) return;
            const result = await requestScheduler.load(key, generation, {
              onSuccess(payload) {
                failures = 0;
                setLoadError(null); // GET 超时/网络错误只作为 WebUI 获取失败，不改 traffic.channelAlive
                cacheState(key, payload);
                setState({ key, payload });
              },
              onFailure(error) {
                failures += 1;
                setLoadError(error?.message || String(error));
              },
            });
            if (!alive() || result.status === "cancelled") return;
            arm(result.status === "ok" ? POLL_BACKOFF_MS[0] : backoffDelay(failures));
          };
          const onVisibility = () => {
            if (hidden()) {
              // 隐藏：停掉定时器并取消后台 GET；恢复可见时只启动一次查询
              paused = true;
              if (timer) { clearTimeout(timer); timer = null; }
              requestScheduler.pause(key);
              return;
            }
            paused = false;
            requestScheduler.unpause(key); // 解除后台暂停；否则恢复可见后的首次 GET 会被拦掉
            // 撤掉暂停期间残留的定时器，避免「立即刷新」与它各发一次
            if (timer) { clearTimeout(timer); timer = null; }
            void cycle(); // 立即刷新一次
          };
          document.addEventListener("visibilitychange", onVisibility);
          void cycle();
          return () => {
            stopped = true;
            if (timer) { clearTimeout(timer); timer = null; }
            document.removeEventListener("visibilitychange", onVisibility);
            requestScheduler.cancel(key); // AbortController 释放请求 + 代次作废阻止迟到回写
          };
        }, [key]);
        /** 手动刷新：暂停后台 GET、取消旧 GET、合并重复点击；完成后发布结果并恢复后台轮询。 */
        const refresh = React.useCallback(() => {
          if (requestScheduler.busy(key)) return Promise.resolve(); // 合并重复点击的同一次刷新
          return (async () => {
            setRefreshing(true);
            try {
              const result = await requestScheduler.refresh(key, {
                onSuccess(payload) { cacheState(key, payload); setState({ key, payload }); setLoadError(null); },
              });
              if (result.status === "failed") {
                console.error("[dsh-token-quota] refresh failed", result.error);
                setLoadError(result.error?.message || String(result.error));
              }
              return result;
            } finally {
              setRefreshing(false);
              requestScheduler.resume(key); // 恢复后台轮询（一次；不会与在途请求并发）
            }
          })();
        }, [key]);
        // 渲染层按 key 对齐：切页瞬间不残留上一页数据；后台刷新只更新内容，不闪空态
        const shown = state && state.key === key ? state.payload : null;
        return { state: shown, refresh, refreshing, loadError };
      }

      const supplierDraft = (sup) => ({
        enabled: !!sup.enabled, baseUrl: sup.baseUrl || sup.baseUrlDefault || "",
        warnPct: sup.warnPct ?? 80, critPct: sup.critPct ?? 95,
        ...Object.fromEntries((sup.meta?.needs || []).map((need) => [need.key, need.secret ? "" : (sup[need.key] ?? "")])),
      });
      function supplierPatch(sup, form) {
        const patch = { enabled: !!form.enabled, baseUrl: String(form.baseUrl || ""),
          warnPct: Number(form.warnPct), critPct: Number(form.critPct) };
        for (const need of sup.meta?.needs || []) {
          const value = String(form[need.key] ?? "");
          if (!need.secret) patch[need.key] = value;
          else if (value.trim()) patch[need.key] = value.trim();
        }
        return patch;
      }

      // ---------- 数据 hook（跟随当前会话页；每页拉取互不干扰） ----------
      // 见上：useQuotaState 已按 A1 重写为「完成后调度 + 单飞 + 可见性暂停」。

      // ---------- 小组件：侧边栏脚部槽位（sidebar.footer.action） ----------
      // wide=true：多行紧凑条（v1.2，wayfinder 票 #9 定稿候选 A）——
      //   第 1 行：「用量」标题 + 今日 token 消耗（全局今日总量，所有 current 供应商求和）
      //   第 2 行：当前显示页在用供应商 · 模型（无调用时显示「暂无调用」，严格不回退其它页）
      //   第 3 行：元信息（相对时间 · 限额状态 · 重置时间 · ×N 候选），单行省略 + title 兜底全文
      // 布局变体 A/B/C 经 ?qm-strip= 切换（B = 点锚供应商行 + 分隔线；C = 两列网格、今日量右置），
      // 供定稿比较；默认 A。sessionId 由 FooterSlotWithSession 注入（sessions.list.current）；
      // 限额明细仍在 Popover/详情承载。
      // wide=false（rail 窄栏）：图标态按钮，点击打开详情弹层 —— 全部走内容流，
      // 不做任何 fixed/absolute 常驻定位，因此与其他脚部按钮不可能重叠。
      function FooterWidget({ wide, t, sessionId }) {
        const [popover, setPopover] = React.useState(false);
        const [view, setView] = React.useState(null); // 'detail' | 'settings' | null
        const stripRef = React.useRef(null);
        const variant = useStripVariant();
        const { state, refresh, refreshing, loadError } = useQuotaState(sessionId);
        const suppliers = (state?.suppliers || []).filter((s) => s.current);
        const totalToday = suppliers.reduce(
          (sum, s) => sum + (typeof s.todayTokens === "number" ? s.todayTokens : 0),
          0,
        );
        const active = state?.active || null;
        // 主显示：最近一次真实 LLM 调用的供应商（+模型名）；未调用时为「暂无调用」
        const activeText = active
          ? [active.name, active.model].filter(Boolean).join(" · ")
          : null;
        const summary = activeText || t("noneActive");
        const todayText = t("today", { n: fmtBig(totalToday) });
        // 状态点沿用该供应商的限额健康色（未取数/未启用 = off）；没有在用供应商时为 off
        const activeSupplier = active
          ? (state?.suppliers || []).find((s) => s.id === active.supplierId) || null
          : null;
        const dotState = activeSupplier ? stateClass(activeSupplier) : "off";
        const railTitle = `${t("title")}${activeText ? ` · ${activeText}` : ""}`;
        // 第 3 行元信息：各字段带来源，渲染层据此决定丢弃顺序
        const tight = tightestOf(activeSupplier?.entries);
        const resetText = resetTextOf(tight, activeSupplier?.headline, t);
        const meta = {
          // 小组件不显示「最近一次调用」的相对时间：看的是配额与连接，不是调用新鲜度
          // （2026-09-12 用户口径）。age 因此不再入行，fmtAge 仍服务 Popover 之外的既有用途。
          stale: state?.trafficStale ? { key: "stale", text: t("stale", { n: state?.poll?.trafficWindowHours ?? 24 }) } : null,
          quota: activeSupplier ? { key: "quota", text: `${t("quota")} ${headlineOf(activeSupplier)}` } : null,
          reset: resetText ? { key: "reset", text: resetText } : null,
          // ×N 候选计数不在这里：已移到第 1 行「今日用量」之后（2026-09-12 用户口径）
        };
        const countText = suppliers.length > 1 ? t("countBadge", { n: suppliers.length }) : null;
        const metaLine = metaLineOf(meta);
        // 连接状态（第 1 行）：文本 + 语义色，取数失败时在 title 里带上失败个数
        const conn = connStateOf(state);
        const connText = t(conn.key === "ok" ? "connOk" : conn.key === "warn" ? "connWarn" : conn.key === "off" ? "connStandby" : "connDown");
        const connHint = conn.failed > 0 ? t("connFailed", { n: conn.failed }) : "";
        const stripFullTitle = [connHint, metaLine, todayText, countText].filter(Boolean).join(" · ");
        const dot = h("span", { className: `qm-dot ${dotState}` });
        const l1 = h("div", { className: "qm-l1" },
          variant === "A" ? dot : null,
          h("span", { className: `qm-conn qm-conn-${conn.cls}`, title: connHint || connText }, connText),
          h("span", { className: "qm-sep" }, "·"),
          h("span", { className: "qm-today" }, todayText),
          // 候选计数（×N）跟在今日用量之后，与其它信息同字号（不做特例缩小）
          countText ? h("span", { className: "qm-count" }, countText) : null,
        );
        const l2 = h("div", { className: "qm-l2" },
          variant === "B" ? dot : null,
          h("span", { className: "qm-strip-summary", title: summary }, summary),
        );
        const l3 = h("div", { className: "qm-l3", title: metaLine }, metaLine);
        // 侧栏被拖窄（但仍 wide=true）时收起元信息行：三行在 <200px 会被截成半句，
        // 不如只留「今日量 + 在用供应商」。阈值取实测预算（最长行 185px + padding 16px）。
        const narrowRef = React.useRef(null);
        React.useEffect(() => {
          const el = narrowRef.current;
          if (!el || typeof ResizeObserver === "undefined") return undefined;
          const apply2 = (w) => { el.classList.toggle("qm-narrow", w > 0 && w < 200); };
          apply2(el.getBoundingClientRect().width);
          const ro = new ResizeObserver((entries) => {
            for (const e of entries) apply2(e.contentRect?.width ?? 0);
          });
          ro.observe(el);
          return () => ro.disconnect();
        }, [variant]);
        const onOpenDetail = React.useCallback(() => { setPopover(false); setView("detail"); }, []);
        const onOpenSettings = React.useCallback(() => { setPopover(false); setView("settings"); }, []);

        return h(React.Fragment, null,
          !wide ? h("button", {
            type: "button",
            "data-qm-entry": "",
            className: "qm-rail",
            "aria-label": railTitle,
            title: railTitle,
            onClick: () => setView("detail"),
          }, h("span", { className: `qm-dot ${dotState}` })) :
          h("div", { "data-qm-linerow": "" },
            h("button", {
              type: "button",
              ref: stripRef,
              "data-qm-entry": "",
              className: `qm-strip qm-v${variant}${active ? "" : " qm-none"}${state?.trafficStale ? " qm-stale" : ""}`,
              "data-qm-variant": variant,
              "aria-expanded": popover,
              "aria-haspopup": "dialog",
              title: stripFullTitle,
              onClick: () => setPopover((v) => !v),
            },
              // C 是两列网格：左列（标题/供应商/元信息）+ 右列（今日量大字主数）
              variant === "C"
                ? h(React.Fragment, null,
                    h("div", { className: "qm-main", ref: narrowRef }, l1, l2, l3),
                    h("div", { className: "qm-right" },
                      h("span", { className: "qm-today" }, fmtBig(totalToday)),
                      h("span", { className: "qm-todayLab" }, t("todayLabel")),
                    ),
                  )
                : h("div", { className: "qm-main", ref: narrowRef }, l1, l2, l3),
            ),
          ),
          wide && popover
            ? createPortal(h(Popover, {
                anchorRef: stripRef,
                state,
                t,
                onClose: () => setPopover(false),
                onRefresh: refresh,
                refreshing,
                loadError,
                onOpenDetail,
                onOpenSettings,
              }), document.body)
            : null,
          view === "detail"
            ? createPortal(h(DetailModal, { state, t, onClose: () => setView(null), onRefresh: refresh, refreshing, loadError, onOpenSettings }), document.body)
            : null,
          view === "settings"
            ? createPortal(h(SettingsModal, { t, onClose: () => setView(null) }), document.body)
            : null,
        );
      }

      // 注册进槽位的实际组件：跟随当前会话页（sessions.list.current）。sessions 服务
      // 不可用（非会话嵌入场景）时退回不传 sessionId → 宿主给全局最近一次（旧语义）。
      function FooterSlotWithSession(props) {
        const sessionId = sessionListSource
          ? React.useSyncExternalStore(
              sessionListSource.subscribe,
              sessionListSource.getSnapshot,
              sessionListSource.getSnapshot,
            )
          : undefined;
        return h(FooterWidget, Object.assign({}, props, { sessionId }));
      }

      // ---------- Popover：供应商限额汇总（锚定脚部条上方，视口钳制） ----------
      function Popover({ anchorRef, state, t, onClose, onRefresh, refreshing, loadError, onOpenDetail, onOpenSettings }) {
        const cardRef = React.useRef(null);
        const [style, setStyle] = React.useState({});
        React.useLayoutEffect(() => {
          const place = () => {
            const el = anchorRef.current;
            if (!el) return;
            const rect = el.getBoundingClientRect();
            const width = Math.min(320, window.innerWidth - 16);
            const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
            const bottom = window.innerHeight - rect.top + 8; // 官方贴底展开：下缘对齐锚点上沿
            setStyle({ left, bottom, width, maxHeight: Math.max(160, rect.top - 24) });
          };
          place();
          window.addEventListener("resize", place);
          window.addEventListener("scroll", place, true);
          return () => {
            window.removeEventListener("resize", place);
            window.removeEventListener("scroll", place, true);
          };
        }, [anchorRef]);

        const dismiss = React.useCallback((ev) => {
          if (cardRef.current && !cardRef.current.contains(ev.target)) onClose();
        }, [onClose]);
        React.useEffect(() => {
          document.addEventListener("pointerdown", dismiss, true);
          const onKey = (ev) => { if (ev.key === "Escape") onClose(); };
          document.addEventListener("keydown", onKey);
          return () => {
            document.removeEventListener("pointerdown", dismiss, true);
            document.removeEventListener("keydown", onKey);
          };
        }, [dismiss, onClose]);

        const suppliers = (state?.suppliers || []).filter((s) => s.current);
        const totalToday = suppliers.reduce(
          (sum, s) => sum + (typeof s.todayTokens === "number" ? s.todayTokens : 0),
          0,
        );
        const rows = suppliers.map((s) => {
          const entries = (s.entries || []).slice(0, 3);
          const more = (s.entries || []).length - entries.length;
          return h("div", { key: s.id, className: "qm-srow" },
            h("div", { className: "qm-srow-main" },
              h("span", { className: `qm-dot ${stateClass(s)}` }),
              h("span", { className: "qm-srow-name" }, s.name),
              h("span", { className: `qm-srow-head ${stateClass(s)}` }, headlineOf(s)),
              s.todayTokens !== null && s.todayTokens !== undefined
                ? h("span", { className: "qm-srow-today" }, t("today", { n: fmtBig(s.todayTokens) }))
                : null,
            ),
            entries.map((e) => {
              const entryReset = resetTextOf(e, null, t);
              return h("div", { key: e.name, className: "qm-srow-entry" },
                h("span", null, e.name),
                h("span", null,
                  e.pct !== null && e.pct !== undefined ? pctText(e.pct) : e.remain,
                  entryReset ? ` · ${entryReset}` : "",
                ),
              );
            }),
            more > 0 ? h("div", { className: "qm-srow-more" }, `+${more}`) : null,
            s.error ? h("div", { className: "qm-srow-err" }, `⚠ ${s.error.message || s.error.code}`) : null,
          );
        });

        return h("div", { ref: cardRef, className: "qm-pop", role: "dialog", style },
          h("div", { className: "qm-pop-head" },
            h("b", null, t("title")),
            h("span", null,
              totalToday > 0 ? h("span", { className: "qm-pop-today" }, t("today", { n: fmtBig(totalToday) })) : null,
              state?.poll?.intervalSeconds ? t("poll", { n: state.poll.intervalSeconds }) : null,
              h("button", { type: "button", className: "qm-btn", disabled: !!refreshing, onClick: onRefresh },
                refreshing ? t("refreshing") : `⟳ ${t("refresh")}`),
            ),
          ),
          loadError ? h("div", { role: "alert", className: "qm-srow-err" }, `${t("loadFailed")}：${loadError}`) : null,
          state?.trafficStale && suppliers.length > 0
            ? h("div", { className: "qm-stale" }, t("stale", { n: state?.poll?.trafficWindowHours ?? 24 }))
            : null,
          suppliers.length === 0
            ? h("div", { className: "qm-empty" },
                t("noSuppliers"),
                h("button", { type: "button", className: "qm-btn", onClick: onOpenSettings }, t("openSettings")),
              )
            : h("div", { className: "qm-srows" }, rows),
          h("div", { className: "qm-pop-foot" },
            h("span", { className: "qm-pop-time" }, `${t("lastRefresh")} ${state?.now || "—"}`),
            h("span", { className: "qm-pop-actions" },
              h("button", { type: "button", className: "qm-btn", onClick: onOpenDetail }, t("detail")),
              h("button", { type: "button", className: "qm-btn", onClick: onOpenSettings }, t("settings")),
              h("button", { type: "button", className: "qm-btn", onClick: onClose }, t("close")),
            ),
          ),
        );
      }

      // ---------- 详情弹层 ----------
      // 阈值口径统一（A3）：详情卡与设置页预览都显式接收供应商的 warnPct/critPct（不各自硬编码 80/95）。
      function EntryCard({ e, t, warnPct, critPct }) {
        // bal 以「剩余」为主值；usage/cost/win 无百分比时以「已用」为主值
        const fallbackValue = (e.kind === "bal" || !e.used || e.used === "—") ? e.remain || "—" : e.used || "—";
        const pct = e.pct !== null && e.pct !== undefined ? pctText(e.pct) : fallbackValue;
        const cls = classifyPct(e.pct, { warnPct, critPct });
        const tone = cls === "unknown" ? "err" : cls;
        // 重置时间与小组件同口径：有原始时刻就显示精确倒计时，否则回落宿主文案
        const resetText = resetTextOf(e, null, t);
        return h("div", { className: "qm-card-item" },
          h("div", { className: "ci-name" }, h("span", null, e.name), resetText ? h("span", null, resetText) : h("span", null, "—")),
          h("div", { className: `ci-big ${tone}` }, pct),
          h("div", { className: "ci-row" }, h("span", null, `${t("quota")} ${e.limit}`), h("span", null, `${t("usedShort")} ${e.used}`)),
          e.note ? h("div", { className: "ci-row" }, h("span", null, e.note)) : null,
          e.pct === null && e.kind === "bal" ? h("div", { className: "ci-err" }, t("noQuotaConcept")) : null,
        );
      }

      function DetailModal({ state, t, onClose, onRefresh, refreshing, loadError, onOpenSettings }) {
        const dialogRef = useDialog(onClose);
        // R1：详情分栏只显示「已添加」供应商（added 由宿主推导下发）
        const shown = (state?.suppliers || []).filter((s) => s.added !== false);
        const cols = shown.map((s) => {
          const face = s.entries?.length
            ? s.entries
            : [{ name: s.error?.message || t("noData"), limit: "—", used: "—", remain: "—", pct: null, reset: "—", note: "", err: true }];
          return h("div", { key: s.id, className: "qm-col" },
            h("h5", null,
              h("span", null, s.name, s.current ? h("span", { className: "qm-cur" }, " · 当前") : null),
              h("span", { className: `qm-pill ${stateClass(s)}` }, t(stateToken(s))),
            ),
            face.map((e, i) => (e.err ? h("div", { key: i, className: "qm-card-item" }, h("div", { className: "ci-err" }, e.name)) : h(EntryCard, { key: i, e, t, warnPct: s.warnPct, critPct: s.critPct }))),
          );
        });
        const hist = state?.history || [];
        return h("div", { className: "qm-overlay", onClick: (ev) => ev.target === ev.currentTarget && onClose() },
          h("div", { ref: dialogRef, tabIndex: -1, className: "qm-card", role: "dialog", "aria-modal": true, "aria-label": t("detailTitle") },
            h("h3", null, t("detailTitle")),
            h("div", { className: "qm-sub" },
              `${t("detailAdded", { n: shown.length })} · ${t("recentRefresh")} ${state?.now || "—"} · ${t("poll", { n: state?.poll?.intervalSeconds ?? 60 })}`,
            ),
            h("div", { className: "qm-toolbar" },
              h("button", { type: "button", className: "qm-pri", disabled: !!refreshing, onClick: onRefresh },
                refreshing ? t("refreshing") : `⟳ ${t("refresh")}`),
              h("button", { type: "button", onClick: onOpenSettings }, t("settings")),
              h("button", { type: "button", onClick: onClose }, t("close")),
            ),
            state?.storageError ? h("div", { role: "alert", className: "ci-err" }, state.storageError) : null,
            loadError ? h("div", { role: "alert", className: "ci-err" }, `${t("loadFailed")}：${loadError}`) : null,
            h("div", { className: "qm-cols" }, cols),
            h("details", { className: "qm-history" },
              h("summary", null, t("historySummary", { n: Math.min(hist.length, 50) })),
              h("table", null,
                h("thead", null, h("tr", null,
                  h("th", null, t("colTime")), h("th", null, t("colSupplier")),
                  h("th", null, t("colResult")), h("th", null, t("colMain")), h("th", null, t("colNote")),
                )),
                h("tbody", null, hist.map((r, i) =>
                  h("tr", { key: i },
                    h("td", null, r.t), h("td", null, r.supplier),
                    h("td", { className: r.ok ? "h-ok" : "h-bad" }, r.ok ? t("colOk") : t("colFail")),
                    h("td", null, r.summary), h("td", null, r.error || ""),
                  ),
                )),
              ),
            ),
          ),
        );
      }

      // ---------- 设置弹层（自取状态，可从脚部小组件或设置卡片打开） ----------
      // 设置面板本体：设置页 section（variant="page"，嵌在设置面板里）与小组件弹层
      // （variant="dialog"，遮罩 + 对话框语义）共用同一份内容与同一套保存路径。
      function SettingsPanel({ t, onClose, variant = "dialog" }) {
        const dialogRef = useDialog(onClose);
        const [state, setState] = React.useState(null);
        const [view, setView] = React.useState({ name: "main" }); // main | supplier
        const [globalForm, setGlobalForm] = React.useState(null);
        const [editor, setEditor] = React.useState(null); // { supplierId, form }
        const [testState, setTestState] = React.useState({});
        const [saved, setSaved] = React.useState(null); // 'global' | supplierId
        const [saveError, setSaveError] = React.useState(null);
        const [scanBusy, setScanBusy] = React.useState(false); // 重新扫描进行中
        const [freshIds, setFreshIds] = React.useState([]); // 重扫新发现的「可添加」项 id（高亮 + 自动展开）
        const addableRef = React.useRef(null);

        // ---- 异步操作身份（A2）----
        // 关闭/返回目录/切换编辑器都会让在途回调失去回写资格；但已经发出的设置保存仍可能成功，
        // 重新打开时以服务端为准，不自动重试结果不确定的保存。
        const opRef = React.useRef({ editorId: 0, opSeq: 0, revision: 0 }); // 当前编辑器身份 + 操作序号 + 草稿修订号
        const reloadSeq = React.useRef(0);                    // 目录请求序号：旧响应不得覆盖新响应
        const testSeq = React.useRef(0);                      // 连接测试序号（每次发起自增）
        const mountedRef = React.useRef(true);
        React.useEffect(() => () => { mountedRef.current = false; }, []);
        const [opBusy, setOpBusy] = React.useState(false);    // 当前编辑器保存中（同步门上另有 ref）
        const opBusyRef = React.useRef(false);
        const [testBusy, setTestBusy] = React.useState(null); // 正在测试连接的供应商 id
        const [toggling, setToggling] = React.useState({});   // 按供应商的启用开关 pending 标记
        const togglingRef = React.useRef(new Set());
        const nextEditorId = () => { const id = ++opRef.current.editorId; opRef.current.revision = 0; return id; };
        const closeEditor = () => { opRef.current.editorId++; opRef.current.revision = 0; setEditor(null); setView({ name: "main" }); };

        const reload = React.useCallback(async () => {
          const seq = ++reloadSeq.current;
          try {
            const next = await getState();
            if (!mountedRef.current || seq !== reloadSeq.current) return; // 旧目录响应不得覆盖新目录响应
            setState(next);
            // 目录刷新不重新初始化已完成/已有的全局草稿
            setGlobalForm((g) => g || {
              intervalSeconds: next?.poll?.intervalSeconds ?? 60,
              retentionDays: next?.poll?.retentionDays ?? 7,
            });
          } catch (error) {
            console.error("[dsh-token-quota] state fetch failed", error);
          }
        }, []);
        React.useEffect(() => { reload(); }, [reload]);

        // 每个供应商一个独立配置页（参考 Token-Consumption-Monitoring 的页面模型）
        const openSupplier = (id) => {
          const sup = (state?.suppliers || []).find((s) => s.id === id);
          if (!sup) return;
          const form = supplierDraft(sup);
          const editorId = nextEditorId(); // 同一供应商的两次编辑必须能区分
          setEditor({ editorId, supplierId: id, form, revision: 0 });
          setView({ name: "supplier", id });
          setTestState({});
          setSaved(null);
          setSaveError(null);
          setOpBusy(false);
          opBusyRef.current = false;
        };
        const setEditorField = (key, value) => {
          opRef.current.revision++; // ref 先行：异步回调在任何一次渲染之后都能读到最新修订号
          testSeq.current++;        // 已发出的测试结果失效；其「测试中…」提示也不再属于新草稿
          setTestBusy(null);
          setSaved(null);
          setTestState((x) => {
            if (!editor || !(editor.supplierId in x)) return x;
            const next = { ...x };
            delete next[editor.supplierId];
            return next;
          });
          setEditor((e) => (e ? { ...e, form: { ...e.form, [key]: value }, revision: opRef.current.revision } : e));
        };

        const saveGlobal = async () => {
          if (!globalForm) return;
          setSaved(null); setSaveError(null);
          try {
            await post(`${API}/settings`, {
              intervalSeconds: Number(globalForm.intervalSeconds),
              retentionDays: Number(globalForm.retentionDays),
            });
            if (!mountedRef.current) return;
            setSaved("global");
            await reload();
          } catch (error) {
            if (!mountedRef.current) return;
            setSaveError(error.message);
            console.error("[dsh-token-quota] global settings save failed", error);
          }
        };
        const saveSupplier = async () => {
          if (!editor || opBusyRef.current) return; // 保存期间禁用重复保存
          const { editorId, supplierId, form } = editor;
          const sup = (state?.suppliers || []).find((s) => s.id === supplierId);
          if (!sup) return;
          const seq = ++opRef.current.opSeq;
          const latest = () => mountedRef.current && opRef.current.editorId === editorId && opRef.current.opSeq === seq;
          setSaved(null); setSaveError(null);
          opBusyRef.current = true;
          setOpBusy(true);
          try {
            const p = supplierPatch(sup, form); // 表单快照：保存期间的表单变化不进入本次请求
            await post(`${API}/settings`, { suppliers: { [supplierId]: p } });
            if (!latest()) return; // 已返回目录/切换编辑器/重新打开：只刷新目录，不回写 UI
            setSaved(supplierId);
            await reload();        // 成功后可以重新获取供应商目录
            if (!latest()) return;
            setView({ name: "main" });
            setEditor(null);
          } catch (error) {
            if (!latest()) return;
            setSaveError(error.message);
            console.error("[dsh-token-quota] supplier settings save failed", error);
          } finally {
            if (opRef.current.editorId === editorId) {
              opBusyRef.current = false;
              if (mountedRef.current) setOpBusy(false);
            }
          }
        };
        const toggleEnabled = async (sup) => {
          if (togglingRef.current.has(sup.id)) return; // 防止重复点击发出相反状态的并发写入
          togglingRef.current.add(sup.id);
          setToggling((x) => ({ ...x, [sup.id]: true }));
          setSaveError(null);
          try {
            await post(`${API}/settings`, { suppliers: { [sup.id]: { enabled: !sup.enabled } } });
            if (!mountedRef.current) return;
            await reload();
          } catch (error) {
            if (!mountedRef.current) return;
            setSaveError(error.message);
            console.error("[dsh-token-quota] enable toggle failed", error);
          } finally {
            togglingRef.current.delete(sup.id);
            if (mountedRef.current) setToggling((x) => ({ ...x, [sup.id]: false }));
          }
        };
        /** 连接测试：绑定 editorId 与草稿修订号；改了字段后旧结果不得再显示为当前草稿的结果。 */
        const runTest = (id) => {
          const sup = (state?.suppliers || []).find((s) => s.id === id);
          const editing = editor?.supplierId === id ? editor : null;
          const editorId = editing ? opRef.current.editorId : null;
          const revision = editing ? opRef.current.revision : null;
          const config = editing ? supplierPatch(sup, editing.form) : undefined;
          const seq = ++testSeq.current;
          setTestState((x) => ({ ...x, [id]: t("testing") }));
          setTestBusy(id);
          // 判定必须读 ref（发起时的闭包会停留在旧渲染上，读闭包变量会误判为「仍是当前草稿」）
          const stillCurrent = () => mountedRef.current && seq === testSeq.current
            && (!editing || opRef.current.editorId === editorId && opRef.current.revision === revision);
          post(`${API}/test`, { supplier: id, config })
            .then((r) => { if (stillCurrent()) setTestState((x) => ({ ...x, [id]: r })); })
            .catch((error) => { if (stillCurrent()) setTestState((x) => ({ ...x, [id]: { ok: false, error: error.message } })); })
            .finally(() => { if (mountedRef.current && seq === testSeq.current) setTestBusy(null); });
        };

        // R2：手动重新扫描 = 复用宿主周期自动探测（自动启用/官方 BaseURL/密钥拷贝，幂等）
        const runRescan = async () => {
          if (scanBusy) return;
          const prevAddable = new Set((state?.suppliers || []).filter((s) => s.added === false).map((s) => s.id));
          setScanBusy(true);
          try {
            const next = await post(`${API}/rescan`);
            if (!next || next.ok === false) throw new Error((next && next.error) || "rescan failed");
            setState(next);
            const nowAddable = (next.suppliers || []).filter((s) => s.added === false);
            const fresh = nowAddable.filter((s) => !prevAddable.has(s.id)).map((s) => s.id);
            setFreshIds(fresh);
            // 发现新的可添加供应商 → 自动展开列表并高亮新增项
            if (fresh.length) requestAnimationFrame(() => { if (addableRef.current) addableRef.current.open = true; });
          } catch (error) {
            console.error("[dsh-token-quota] rescan failed", error);
            await reload(); // 保留旧状态并刷新一次（标题行将显示 detect.error）
          } finally {
            setScanBusy(false);
          }
        };

        // 字段标签/占位（按供应商 needs 元数据）
        const needsLabel = (sup, need) => {
          if (need.key === "apiKey") return t(sup.meta?.credentialLabelKey || "apiKey");
          if (need.key === "allowanceToken") return t("allowanceToken");
          if (need.key === "orgId") return t("orgId");
          return need.label || need.key;
        };
        const secretPlaceholder = (sup, need) => {
          if (sup[`${need.key}Set`]) return t("keySet");
          if (need.key === "apiKey" && sup.autoDetected && sup.envKeySet) {
            return t("keyAuto", { env: sup.autoEnvName || t("dshKey") });
          }
          return t("keyEmpty");
        };

        if (!state) {
          return h("div", { className: "qm-overlay" },
            h("div", { ref: dialogRef, tabIndex: -1, role: "dialog", "aria-modal": true, "aria-label": t("settingsTitle"), className: "qm-card qm-settings" }, h("h3", null, t("settingsTitle")), h("div", { className: "qm-sub" }, "…")),
          );
        }

        const testResult = (id) => {
          const r = testState[id];
          if (!r) return null;
          if (typeof r === "string") return h("span", { className: "s-test-res bad" }, r);
          return h("span", { className: `s-test-res ${r.ok ? "ok" : "bad"}` }, r.ok ? t("testOk") : (r.error || t("testFail")));
        };
        const savedBanner = saved
          ? h("div", { className: "s-saved", style: { marginBottom: 8 } }, t("saved"))
          : null;

        // ---- 主视图：全局设置 + 供应商页目录（每页进入独立配置） ----
        const renderMain = () => h(React.Fragment, null,
          h("div", { className: "s-group" },
            h("h5", null, h("span", null, t("global"))),
            h("div", { className: "s-grid" },
              h("label", null, t("interval"),
                h("input", { type: "number", min: 10, max: 3600,
                  value: globalForm?.intervalSeconds ?? 60,
                  onChange: (e) => setGlobalForm((g) => ({ ...g, intervalSeconds: e.target.value })) }),
              ),
              h("label", null, t("retention"),
                h("input", { type: "number", min: 1, max: 90,
                  value: globalForm?.retentionDays ?? 7,
                  onChange: (e) => setGlobalForm((g) => ({ ...g, retentionDays: e.target.value })) }),
              ),
            ),
            h("div", { className: "s-row", style: { justifyContent: "flex-end" } },
              h("button", { type: "button", className: "qm-pri", onClick: saveGlobal }, t("save")),
            ),
          ),
          (() => {
            // R1：主目录只列「已添加」（宿主推导 sup.added）；未添加进底部「可添加」折叠列表
            const all = state.suppliers || [];
            const addedList = all.filter((s) => s.added !== false);
            const addableList = all.filter((s) => s.added === false);
            const order = (list) => [...list].sort((a, b) =>
              (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0)
              || ((b.keySet ? 1 : 0) - (a.keySet ? 1 : 0))
              || a.name.localeCompare(b.name));
            const ordered = order(addedList);
            const det = state.detect || {};
            const scanLine = () => {
              const time = det.at ? String(det.at) : null;
              if (scanBusy) return h("span", null, t("scanLineBusy"));
              if (det.error) {
                return h("span", { className: "err", title: String(det.error).slice(0, 300) },
                  t("scanLineFail", { err: String(det.error || "").slice(0, 90) }), time ? ` · ${time}` : "");
              }
              if (!det.at) return h("span", null, t("scanLineIdle"));
              const names = ordered.map((s) => s.name);
              return h("span", null,
                h("b", { className: "ok" }, t("connectedChip", { n: ordered.length })),
                names.length ? h("span", { className: "names", title: names.join("、") }, ` · ${names.join("、")}`) : null,
                addableList.length ? ` · ${t("moreAddable", { n: addableList.length })}` : null,
                ` · ${time}`,
              );
            };
            return h(React.Fragment, null,
              // 标题行（变体 B）：首行 = 标题 +「已接入 N」计数芯片 + ⟳重新扫描；结果独立一行
              h("div", { className: "qm-pages-title qm-head-b" },
                h("b", null, t("supplierPages"),
                  h("span", { className: "qm-added-only" }, t("addedOnly"))),
                h("div", { className: "qm-title-actions" },
                  h("span", { className: "chip" }, t("connectedChip", { n: ordered.length })),
                  h("button", { type: "button", className: `qm-rescan-btn${scanBusy ? " busy" : ""}`,
                    disabled: scanBusy, onClick: runRescan }, `⟳ ${t("rescan")}`),
                ),
              ),
              h("div", { className: "qm-scanline" }, scanLine()),
              ordered.length === 0
                ? h("div", { className: "qm-empty-added" }, t("emptyAdded"))
                : h("div", { className: "qm-page-list" },
                    ordered.map((sup) =>
                      h("div", { key: sup.id, className: "qm-page-row" },
                        h("div", { className: "qm-page-main", role: "button", title: t("openPage"), onClick: () => openSupplier(sup.id) },
                          h("span", { className: `qm-dot ${stateClass(sup)}` }),
                          h("span", { className: "qm-page-name" }, sup.name),
                          h("span", { className: "qm-page-pill" }, t(sup.meta?.credentialLabelKey || "apiKey")),
                          sup.meta?.compat
                            ? h("span", { className: "qm-page-pill ghost" }, t("compatSource"))
                            : null,
                          sup.autoDetected
                            ? h("span", { className: "qm-page-auto" }, sup.enabled ? t("autoDetectedShort") : t("autoSourceShort"))
                            : null,
                        ),
                        h("div", { className: "qm-page-actions" },
                          h("label", { className: "qm-page-toggle" },
                            h("input", { type: "checkbox", checked: !!sup.enabled, disabled: !!toggling[sup.id], onChange: () => toggleEnabled(sup) }),
                            h("span", null, t("enable")),
                          ),
                          h("button", { type: "button", className: "s-test", disabled: testBusy === sup.id, onClick: () => runTest(sup.id) }, testBusy === sup.id ? t("testing") : t("test")),
                          testResult(sup.id),
                          h("button", { type: "button", className: "s-test qm-pri-soft", onClick: () => openSupplier(sup.id) }, t("openPage")),
                        ),
                      ),
                    ),
                  ),
              addableList.length
                ? h("details", { ref: addableRef, className: "qm-addable" },
                    h("summary", null,
                      h("span", null, t("addableTitle")),
                      h("span", { className: "cnt" }, t("addableCount", { n: addableList.length })),
                      h("span", { className: "hint" }, t("addableHint")),
                    ),
                    h("div", { className: "addable-list" },
                      addableList.map((a) =>
                        h("div", { key: a.id, className: `qm-add-row${freshIds.includes(a.id) ? " fresh" : ""}` },
                          h("span", { className: `qm-dot ${stateClass(a)}` }),
                          h("span", { className: "qm-page-name" }, a.name),
                          h("span", { className: "qm-page-pill" }, t(a.meta?.credentialLabelKey || "apiKey")),
                          a.meta?.compat
                            ? h("span", { className: "qm-page-pill ghost" }, t("compatSource"))
                            : null,
                          h("span", { className: "add-why" },
                            a.meta?.credentialClass && a.meta.credentialClass !== "api-key"
                              ? t("manualCredential", { label: t(a.meta.credentialLabelKey || "apiKey") })
                              : t("notInDsh")),
                          h("div", { className: "qm-page-actions" },
                            h("button", { type: "button", className: "s-test qm-pri-soft", onClick: () => openSupplier(a.id) }, t("openConfigAdd")),
                          ),
                        ),
                      ),
                    ),
                  )
                : null,
              state.detectedUnmapped && state.detectedUnmapped.length
                ? h("div", { className: "pnote", style: { marginTop: 8, whiteSpace: "pre-wrap" } },
                    `${t("unmapped")}：${state.detectedUnmapped.map((u) => `${u.displayName || u.route}${u.detail ? t("unmappedDetail", { detail: u.detail }) : ""}`).join("、")}`)
                : null,
            );
          })(),
        );

        // ---- 供应商独立配置页（参考项目的单页表单模型） ----
        const renderSupplierPage = () => {
          const sup = (state?.suppliers || []).find((s) => s.id === view.id);
          if (!sup || !editor) return h("div", { className: "qm-sub" }, "…");
          const f = editor.form;
          const needsInputs = (sup.meta?.needs || []).map((need) =>
            h("label", { key: need.key }, needsLabel(sup, need),
              h("input", {
                type: need.secret ? "password" : "text",
                placeholder: need.secret ? secretPlaceholder(sup, need) : t("keyEmpty"),
                value: f[need.key] || "",
                disabled: opBusy,
                onChange: (e) => setEditorField(need.key, e.target.value),
              }),
            ),
          );
          return h(React.Fragment, null,
            h("div", { className: "qm-page-head" },
              h("button", { type: "button", className: "s-test", onClick: closeEditor }, `← ${t("back")}`),
              h("b", null, sup.name),
              h("span", { className: `qm-pill ${stateClass(sup)}` }, t(stateToken(sup))),
              h("span", { className: "qm-page-pill" }, t(sup.meta?.credentialLabelKey || "apiKey")),
            ),
            sup.autoDetected ? h("div", { className: "pnote", style: { margin: "6px 0" } },
              sup.enabled
                ? t("autoDetectedOn", { source: sup.autoSource || "", env: sup.autoEnvName || (sup.autoKeySource === "env" ? t("env") : t("credentialStore")) })
                : t("autoDetectedOff", { source: sup.autoSource || "" })) : null,
            (sup.meta?.credentialClass && sup.meta.credentialClass !== "api-key")
              ? h("div", { className: "pnote", style: { margin: "6px 0" } },
                  t("manualCredential", { label: t(sup.meta.credentialLabelKey || "apiKey") }))
              : null,
            // 当前额度预览（最近一次取数；与小组件 Popover / 详情卡片同一份服务端条目 → 重置时间三处一致）
            h("div", { className: "s-group qm-quota-preview" },
              h("h5", null, h("span", null, t("currentQuota"))),
              (sup.entries && sup.entries.length)
                ? h("div", { className: "qm-quota-cards" },
                    sup.entries.map((e) => h(EntryCard, { key: e.name, e, t, warnPct: sup.warnPct, critPct: sup.critPct })))
                : h("div", { className: "pnote", style: { whiteSpace: "pre-wrap" } },
                    sup.error?.message ? sup.error.message : t("quotaNotFetched")),
            ),
            h("div", { className: "s-group" },
              h("h5", null, h("span", null, t("credentials"))),
              needsInputs,
              h("label", { className: "qm-inline-toggle" },
                h("input", { type: "checkbox", checked: !!f.enabled, disabled: opBusy, onChange: (e) => setEditorField("enabled", e.target.checked) }),
                h("span", null, t("enable")),
              ),
            ),
            h("div", { className: "s-group" },
              h("h5", null, h("span", null, t("endpoint"))),
              h("label", null, t("baseUrl"),
                h("input", { type: "text", value: f.baseUrl || "", disabled: opBusy, onChange: (e) => setEditorField("baseUrl", e.target.value) }),
              ),
              h("div", { className: "s-grid" },
                h("label", null, t("warnPct"),
                  h("input", { type: "number", min: 1, max: 99, value: f.warnPct, disabled: opBusy, onChange: (e) => setEditorField("warnPct", e.target.value) }),
                ),
                h("label", null, t("critPct"),
                  h("input", { type: "number", min: 1, max: 100, value: f.critPct, disabled: opBusy, onChange: (e) => setEditorField("critPct", e.target.value) }),
                ),
              ),
            ),
            h("div", { className: "s-row" },
              h("button", { type: "button", className: "s-test", disabled: testBusy === sup.id, onClick: () => runTest(sup.id) }, testBusy === sup.id ? t("testing") : `⟳ ${t("test")}`),
              testResult(sup.id),
            ),
            h("div", { className: "s-actions" },
              saved === sup.id ? h("span", { className: "s-saved" }, t("saved")) : null,
              h("button", { type: "button", onClick: closeEditor, disabled: opBusy }, t("cancel")),
              h("button", { type: "button", className: "qm-pri", onClick: saveSupplier, disabled: opBusy }, t("save")),
            ),
          );
        };

        const dialog = variant === "dialog";
        const card = h("div", {
          ref: dialogRef,
          tabIndex: -1,
          ...(dialog ? { role: "dialog", "aria-modal": true, "aria-label": t("settingsTitle") } : {}),
          className: `qm-card qm-settings${dialog ? "" : " qm-settings-page"}`,
        },
          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
            h("h3", null, t("settingsTitle")),
            dialog ? h("button", { type: "button", onClick: onClose, "aria-label": t("close") }, t("close")) : null,
          ),
          h("div", { className: "qm-sub" },
            view.name === "supplier"
              ? `${t("settingsSub")} · ${t("supplierPagesSub")}`
              : t("settingsSub"),
          ),
          savedBanner,
          saveError ? h("div", { role: "alert", className: "ci-err" }, saveError) : null,
          view.name === "supplier" ? renderSupplierPage() : renderMain(),
        );
        return dialog
          ? h("div", { className: "qm-overlay", onClick: (ev) => ev.target === ev.currentTarget && onClose() }, card)
          : card;
      }

      function SettingsModal({ t, onClose }) {
        return h(SettingsPanel, { t, onClose, variant: "dialog" });
      }

      // ---------- 设置页（settings.section 槽位） ----------
      // 0.1.7 的 Settings 面板按 `settings.section` 列表项渲染每一页（导航项由外壳投影：
      // id/order/label），每行 config 的自动表单之外，本插件仍自带供应商目录与逐供应商配置页。
      function SettingsSection(props) {
        const { t, close } = props;
        return h(SettingsPanel, { t, onClose: close, variant: "page" });
      }

      // ---------- 通用小 hook ----------
      function useDialog(onClose) {
        const ref = React.useRef(null);
        const close = React.useRef(onClose);
        close.current = onClose;
        React.useEffect(() => {
          const node = ref.current;
          if (!node) return;
          const previous = document.activeElement;
          const focusable = () => Array.from(node.querySelectorAll(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]',
          )).filter((el) => el.getClientRects().length > 0);
          (focusable()[0] || node).focus();
          const onKey = (event) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); }
            if (event.key !== "Tab") return;
            const items = focusable(), first = items[0], last = items[items.length - 1];
            if (!first) { event.preventDefault(); node.focus(); }
            else if (event.shiftKey && (document.activeElement === first || !node.contains(document.activeElement) || document.activeElement === node)) {
              event.preventDefault(); last.focus();
            } else if (!event.shiftKey && (document.activeElement === last || !node.contains(document.activeElement) || document.activeElement === node)) {
              event.preventDefault(); first.focus();
            }
          };
          document.addEventListener("keydown", onKey, true);
          return () => {
            document.removeEventListener("keydown", onKey, true);
            if (previous?.isConnected) previous.focus();
          };
        }, []);
        return ref;
      }

      // ---------- 本地化 ----------
      const LOCALES = {
        zh: {
          title: "用量",
          connOk: "已连接",
          connWarn: "已连接 · 降级",
          connStandby: "待命",
          connDown: "未连接",
          connFailed: "取数失败 {n} 个",
          resetInHM: "{h}h{m}m 后重置",
          resetInDH: "{d}d{h}h 后重置",
          resetSoon: "即将重置",
          todayLabel: "今日",
          noneActive: "暂无调用",
          justNow: "刚刚",
          minAgo: "{n} 分钟前",
          hourAgo: "{n} 小时前",
          dayAgo: "{n} 天前",
          today: "今日 {n}",
          countBadge: "×{n}",
          refresh: "刷新",
          refreshing: "刷新中…",
          loadFailed: "状态获取失败",
          detail: "详情",
          settings: "设置",
          close: "关闭",
          cancel: "取消",
          save: "保存",
          saved: "已保存 ✓",
          lastRefresh: "上次刷新",
          poll: "每 {n}s",
          noSuppliers: "暂无当前供应商",
          openSettings: "打开设置",
          stale: "近 {n}h 无流量 · 按启用清单显示",
          stateOk: "正常",
          stateWarn: "警告",
          stateCrit: "临界",
          stateErr: "取数失败",
          stateOff: "未配置",
          noData: "无数据",
          quota: "限额",
          usedShort: "已用",
          noQuotaConcept: "无限额概念（余额）",
          detailTitle: "供应商限额明细",
          allConfigured: "全部已配置供应商（共 {n}）",
          recentRefresh: "最近刷新",
          historySummary: "刷新历史（最近 {n} 条）",
          colTime: "时间",
          colSupplier: "供应商",
          colResult: "结果",
          colOk: "成功",
          colFail: "失败",
          colMain: "主指标",
          colNote: "备注",
          settingsTitle: "用量监控设置",
          settingsSub: "密钥保存在 DSH settings（settings.yaml），此处只回显掩码；留空 = 保持原值",
          global: "全局设置",
          supplierPages: "供应商页",
          supplierPagesSub: "每个供应商一页、一种凭据（对应参考项目页面模型）",
          addedOnly: "仅显示已添加",
          rescan: "重新扫描",
          connectedChip: "已接入 {n}",
          scanLineBusy: "正在扫描 DeepSeek Harness…",
          scanLineIdle: "尚未扫描 DSH —— 点「重新扫描」探测已添加的模型供应商",
          scanLineFail: "扫描失败：{err}",
          moreAddable: "另有 {n} 个未接入可添加",
          addableTitle: "可添加供应商",
          addableCount: "{n} 个",
          addableHint: "打开其配置页并保存即完成添加",
          openConfigAdd: "打开配置 → 添加",
          notInDsh: "DSH 未添加 · 可手动配置",
          detailAdded: "已添加 {n} 个供应商（未添加不显示）",
          emptyAdded: "尚未接入任何供应商 —— 点「重新扫描」从 DSH 探测，或展开下方「可添加供应商」手动添加",
          openPage: "打开配置",
          back: "返回",
          credentials: "凭据",
          endpoint: "连接与阈值",
          compatSource: "兼容来源",
          autoDetectedShort: "已自动接入",
          autoSourceShort: "自动探测到",

          enable: "启用",
          test: "测试连接",
          testing: "测试中…",
          testOk: "连接正常",
          testFail: "失败",
          apiKey: "API Key",
          managementKey: "Management Key",
          adminKey: "Admin Key",
          codingPlanKey: "Coding Plan Key",
          tokenPlanKey: "Token Plan Key",
          manualCredential: "需手动填写 {label}（DSH harness 不持有该凭据类别；普通 Key 不会套用）",
          currentQuota: "当前额度（最近一次取数）",
          quotaNotFetched: "尚无取数结果 —— 保存后等待下次轮询，或先点「测试连接」",
          unmappedDetail: "（{detail}）",
          keySet: "已设置（留空保持不变）",
          keyEmpty: "未设置",
          keyAuto: "自动读取 {env}",
          dshKey: "DSH 密钥",
          env: "环境变量",
          credentialStore: "DSH 凭据库",
          allowanceToken: "allowance Token（OAuth）",
          orgId: "org id（可选）",
          baseUrl: "Base URL",
          warnPct: "警告阈值 %",
          critPct: "临界阈值 %",
          interval: "轮询间隔（秒，10–3600）",
          retention: "用量保留期（天，1–90）",
          unmapped: "另探测到 DSH 内已添加但本插件暂不支持的供应商",
          autoDetectedOn: "已自动探测 DSH 的 {source} 配置：已启用、Base URL 与密钥已自动填入（来源 {env}，留空即可使用）",
          autoDetectedOff: "已自动探测 DSH 的 {source} 配置：Base URL 与密钥引用已填入，但密钥暂不可解析，未自动启用",
        },
        en: {
          title: "Usage",
          connOk: "Connected",
          connWarn: "Connected · degraded",
          connStandby: "Standby",
          connDown: "Disconnected",
          connFailed: "{n} fetch failed",
          resetInHM: "resets in {h}h{m}m",
          resetInDH: "resets in {d}d{h}h",
          resetSoon: "resetting now",
          todayLabel: "Today",
          noneActive: "No calls yet",
          justNow: "just now",
          minAgo: "{n} min ago",
          hourAgo: "{n} h ago",
          dayAgo: "{n} d ago",
          today: "Today {n}",
          countBadge: "×{n}",
          refresh: "Refresh",
          refreshing: "Refreshing…",
          loadFailed: "State fetch failed",
          detail: "Details",
          settings: "Settings",
          close: "Close",
          cancel: "Cancel",
          save: "Save",
          saved: "Saved ✓",
          lastRefresh: "Last refresh",
          poll: "every {n}s",
          noSuppliers: "No current suppliers",
          openSettings: "Open settings",
          stale: "No traffic in {n}h · showing enabled list",
          stateOk: "OK",
          stateWarn: "Warning",
          stateCrit: "Critical",
          stateErr: "Fetch failed",
          stateOff: "Not configured",
          noData: "No data",
          quota: "Limit",
          usedShort: "Used",
          noQuotaConcept: "Balance has no quota concept",
          detailTitle: "Supplier quota details",
          allConfigured: "All configured suppliers ({n})",
          recentRefresh: "Last refresh",
          historySummary: "Refresh history (latest {n})",
          colTime: "Time",
          colSupplier: "Supplier",
          colResult: "Result",
          colOk: "OK",
          colFail: "Failed",
          colMain: "Headline",
          colNote: "Note",
          settingsTitle: "Quota monitor settings",
          settingsSub: "Secrets live in DSH settings.yaml; only masked state is echoed here. Leave blank to keep current.",
          global: "Global settings",
          supplierPages: "Supplier pages",
          supplierPagesSub: "One page per supplier and credential (mirrors the reference page model)",
          addedOnly: "Added only",
          rescan: "Rescan",
          connectedChip: "Connected {n}",
          scanLineBusy: "Scanning DeepSeek Harness…",
          scanLineIdle: "Not scanned yet — click Rescan to discover suppliers added in DSH",
          scanLineFail: "Scan failed: {err}",
          moreAddable: "{n} more addable",
          addableTitle: "Addable suppliers",
          addableCount: "{n}",
          addableHint: "Open its config page and save to add",
          openConfigAdd: "Open config → Add",
          notInDsh: "Not added in DSH — configure manually",
          detailAdded: "Added {n} suppliers (not-added ones hidden)",
          emptyAdded: "No suppliers connected yet — click Rescan to discover them in DSH, or expand “Addable suppliers” below",
          openPage: "Configure",
          back: "Back",
          credentials: "Credentials",
          endpoint: "Endpoint & thresholds",
          compatSource: "compat",
          autoDetectedShort: "auto-connected",
          autoSourceShort: "detected",

          enable: "Enable",
          test: "Test connection",
          testing: "Testing…",
          testOk: "Connected",
          testFail: "Failed",
          apiKey: "API Key",
          managementKey: "Management Key",
          adminKey: "Admin Key",
          codingPlanKey: "Coding Plan Key",
          tokenPlanKey: "Token Plan Key",
          manualCredential: "Enter {label} manually (DSH harness holds no such credential class; plain keys are never reused)",
          currentQuota: "Current quota (latest fetch)",
          quotaNotFetched: "No quota fetched yet — save and wait for the next poll, or run a test connection",
          unmappedDetail: "({detail})",
          keySet: "Set (blank keeps current)",
          keyEmpty: "Not set",
          keyAuto: "Auto-read {env}",
          dshKey: "DSH key",
          env: "environment",
          credentialStore: "DSH credential store",
          allowanceToken: "allowance Token (OAuth)",
          orgId: "org id (optional)",
          baseUrl: "Base URL",
          warnPct: "Warn threshold %",
          critPct: "Critical threshold %",
          interval: "Poll interval (s, 10–3600)",
          retention: "Usage retention (days, 1–90)",
          unmapped: "Detected DSH suppliers this plugin does not support yet",
          autoDetectedOn: "Auto-detected DSH {source}: enabled, Base URL and key filled (from {env}; leave blank to use)",
          autoDetectedOff: "Auto-detected DSH {source}: Base URL and key reference filled, but the key is not resolvable yet — not enabled",
        },
      };

      // ---------- 样式（一次性注入，作用域化） ----------
      const CSS = `
[data-qm-entry]{box-sizing:border-box;color:var(--dsw-alias-label-primary,#dbe2ee);
  font-family:var(--dsw-font-family),-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:12px;}
[data-qm-entry] button{font-family:inherit;}
/* 小组件独占一行：宽栏时使 footer.action 所在容器换行，本条目全宽置顶，其它条目自动落下一行 */
div:has(> div[data-slot="sidebar.footer.action"] > [data-qm-linerow]){flex-wrap:wrap;}
[data-qm-linerow]{display:flex;flex:1 1 100%;min-width:100%;box-sizing:border-box;order:-1;margin:2px 0 0;}
[data-qm-linerow] .qm-strip{margin:0;width:100%;}
.qm-strip{flex:1 1 0;min-width:0;display:flex;align-items:center;gap:6px;height:28px;margin:2px;
  padding:0 8px;border:none;border-radius:6px;background:transparent;color:inherit;cursor:pointer;text-align:left;}
.qm-strip:hover{background:var(--dsw-alias-interactive-bg-hover,#20283a);}
.qm-strip:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:-2px;}
.qm-strip .qm-strip-title{flex:none;color:var(--dsw-alias-label-tertiary,#8b94a8);}
.qm-strip .qm-strip-summary{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;}
/* 多行紧凑条（v1.2）：三行各自省略；.qm-l3 是元信息行（相对时间 · 限额 · 重置时间 · ×N） */
.qm-strip.qm-vA,.qm-strip.qm-vB,.qm-strip.qm-vC{height:auto;padding:5px 8px;}
.qm-strip .qm-l1,.qm-strip .qm-l2,.qm-strip .qm-l3{min-width:0;}
.qm-strip .qm-l1{display:flex;align-items:center;gap:6px;line-height:15px;}
.qm-strip .qm-l1 .qm-conn{font-size:11px;flex:none;}
.qm-strip .qm-l1 .qm-sep{color:var(--dsw-alias-label-tertiary,#8b94a8);flex:none;}
/* 候选计数 ×N：与第 1 行其它元素同字号（继承 12px），只降颜色不缩字号 */
.qm-strip .qm-l1 .qm-count{color:var(--dsw-alias-label-tertiary,#8b94a8);flex:none;}
.qm-conn-ok{color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-conn-warn{color:var(--dsw-alias-state-warn-primary,#fbbf24);}
.qm-conn-err{color:var(--dsw-alias-state-error-primary,#f87171);}
.qm-conn-off{color:var(--dsw-alias-label-tertiary,#8b94a8);}
.qm-strip .qm-today{color:var(--dsw-alias-label-primary,#dbe2ee);font-weight:600;
  min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qm-strip .qm-l2{display:flex;align-items:center;gap:6px;line-height:16px;}
.qm-strip .qm-l3{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8b94a8);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
/* A：三行左对齐堆叠；状态点在第 1 行行首（与标题、今日量同排） */
.qm-strip.qm-vA{flex-direction:column;align-items:stretch;gap:1px;}
/* B：状态点锚在「在用供应商」行首；元信息行加分隔线并右端渐隐（提示被截断） */
.qm-strip.qm-vB{flex-direction:column;align-items:stretch;gap:1px;}
.qm-strip.qm-vB .qm-l1{justify-content:space-between;}
.qm-strip.qm-vB .qm-today{margin-left:auto;font-variant-numeric:tabular-nums;}
.qm-strip.qm-vB .qm-l3{padding-top:2px;margin-top:1px;
  border-top:.5px solid var(--dsw-alias-border-l2,#262d3d);
  -webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 22px),transparent);
          mask-image:linear-gradient(90deg,#000 calc(100% - 22px),transparent);}
/* C：两列网格 —— 左列（标题/供应商/元信息），右列今日量大字主数 */
.qm-strip.qm-vC{align-items:center;gap:8px;}
.qm-strip.qm-vC .qm-main{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 auto;}
.qm-strip.qm-vC .qm-l1{gap:6px;line-height:13px;}
.qm-strip.qm-vC .qm-l1 .qm-conn{font-size:10px;letter-spacing:.02em;}
.qm-strip.qm-vC .qm-l2{line-height:16px;}
.qm-strip.qm-vC .qm-right{display:flex;flex-direction:column;align-items:flex-end;flex:none;}
.qm-strip.qm-vC .qm-right .qm-today{font-size:13px;line-height:15px;font-variant-numeric:tabular-nums;}
.qm-strip.qm-vC .qm-todayLab{font-size:9.5px;line-height:11px;color:var(--dsw-alias-label-tertiary,#8b94a8);letter-spacing:.04em;}
/* 暂无调用（当前显示页无映射调用）时第 2 行降为次级色，避免读成「正在用这个供应商」 */
.qm-strip.qm-none .qm-l2 .qm-strip-summary{font-weight:500;color:var(--dsw-alias-label-secondary,#8b94a8);}
/* 近 24h 无流量兜底：元信息行用警告色标注来源，不伪造在用供应商 */
.qm-strip.qm-stale .qm-l3{color:var(--dsw-alias-state-warn-primary,#fbbf24);}
/* 侧栏拖窄（wide=true 但容器 < 200px）：收起元信息行，只留「今日量 + 在用供应商」，
   避免三行各自被截成半句；阈值由 ResizeObserver 打在 .qm-main.qm-narrow 上 */
[data-qm-linerow] .qm-strip:has(.qm-main.qm-narrow) .qm-l3{display:none;}
.qm-rail{width:32px;height:32px;margin:2px;display:flex;align-items:center;justify-content:center;
  border:none;border-radius:8px;background:transparent;color:inherit;cursor:pointer;}
.qm-rail:hover{background:var(--dsw-alias-interactive-bg-hover,#20283a);}
.qm-dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block;}
.qm-dot.ok{background:var(--dsw-alias-state-success-primary,#34d399);}
.qm-dot.warn{background:var(--dsw-alias-state-warn-primary,#fbbf24);}
.qm-dot.crit{background:var(--dsw-alias-state-error-primary,#f87171);}
.qm-dot.err{background:var(--dsw-alias-label-tertiary,#6b7280);}
.qm-dot.off{background:var(--dsw-alias-border-l2,#262d3d);}
.qm-pop{position:fixed;z-index:1200;box-sizing:border-box;
  background:var(--dsw-alias-bg-base,#0b0e13);border:1px solid var(--dsw-alias-border-l2,#262d3d);
  border-radius:10px;padding:12px;box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.5));
  color:var(--dsw-alias-label-primary,#dbe2ee);font-size:12px;font-family:var(--dsw-font-family),sans-serif;
  overflow-y:auto;}
.qm-pop-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;}
.qm-pop-head b{font-size:13px;}
.qm-pop-head>span{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:11px;}
.qm-pop-today{color:var(--dsw-alias-label-primary,#dbe2ee);font-weight:600;}
.qm-pop .qm-stale{color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:10px;margin:2px 0 6px;}
.qm-pop .qm-empty{color:var(--dsw-alias-label-tertiary,#8b94a8);padding:8px 4px;}
.qm-pop .qm-empty .qm-btn{display:block;margin-top:6px;}
.qm-srows{display:flex;flex-direction:column;gap:2px;margin-bottom:8px;}
.qm-srow{padding:6px 8px;border-radius:8px;}
.qm-srow:hover{background:var(--dsw-alias-interactive-bg-hover,#20283a);}
.qm-srow-main{display:flex;align-items:center;gap:8px;min-width:0;}
.qm-srow-name{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;}
.qm-srow-head{flex:none;font-weight:700;}
.qm-srow-head.ok{color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-srow-head.warn{color:var(--dsw-alias-state-warn-primary,#fbbf24);}
.qm-srow-head.crit{color:var(--dsw-alias-state-error-primary,#f87171);}
.qm-srow-head.err{color:var(--dsw-alias-label-tertiary,#6b7280);}
.qm-srow-head.off{color:var(--dsw-alias-label-tertiary,#6b7280);}
.qm-srow-today{flex:none;color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:10px;}
.qm-srow-entry{display:flex;justify-content:space-between;gap:10px;margin-top:2px;padding-left:16px;font-size:12px;
  color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:11px;}
.qm-srow-more{color:var(--dsw-alias-label-tertiary,#5c6577);font-size:10px;padding-left:16px;}
.qm-srow-err{color:var(--dsw-alias-state-error-primary,#f87171);font-size:11px;margin-top:4px;padding-left:16px;}
.qm-pop-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid var(--dsw-alias-border-l1,#262d3d);padding-top:8px;}
.qm-pop-time{color:var(--dsw-alias-label-tertiary,#5c6577);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qm-pop-actions{display:flex;gap:4px;flex:none;}
.qm-btn{background:none;border:none;color:var(--dsw-alias-state-business-primary,#4f8cff);cursor:pointer;font-size:11px;padding:2px 4px;}
.qm-btn:hover{text-decoration:underline;}
.qm-card-btn{border:1px solid var(--dsw-alias-border-l2,#262d3d);background:none;
  color:var(--dsw-alias-label-primary,#dbe2ee);border-radius:8px;padding:6px 12px;cursor:pointer;font-size:12px;font-family:inherit;}
.qm-card-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#20283a);}
.qm-overlay{position:fixed;inset:0;z-index:1500;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;}
.qm-overlay .qm-card{width:min(880px,94vw);max-height:86vh;overflow:auto;
  background:var(--dsw-alias-bg-base,#0b0e13);border:1px solid var(--dsw-alias-border-l2,#262d3d);
  border-radius:14px;padding:16px;color:var(--dsw-alias-label-primary,#dbe2ee);
  font-family:var(--dsw-font-family),sans-serif;box-sizing:border-box;}
.qm-overlay .qm-card h3{margin:0 0 4px;font-size:15px;}
.qm-overlay .qm-sub{color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:11px;margin-bottom:12px;}
/* 设置页版设置面板：已嵌在设置面板内容列里，不再要遮罩/卡片边框与宽度上限 */
.qm-settings-page{color:var(--dsw-alias-label-primary,#dbe2ee);font-family:var(--dsw-font-family),sans-serif;}
.qm-settings-page h3{margin:0 0 4px;font-size:15px;}
.qm-settings-page .qm-sub{color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:11px;margin-bottom:12px;}
.qm-overlay .qm-toolbar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;}
.qm-overlay .qm-toolbar button{border:1px solid var(--dsw-alias-border-l2,#262d3d);background:none;
  color:var(--dsw-alias-label-primary,#dbe2ee);border-radius:8px;padding:4px 12px;cursor:pointer;font-size:12px;font-family:inherit;}
.qm-overlay .qm-toolbar button.qm-pri{background:var(--dsw-alias-button-info-fill,#4f8cff);border-color:transparent;color:#fff;}
.qm-cols{display:flex;gap:12px;overflow-x:auto;padding-bottom:6px;}
.qm-col{flex:1;min-width:210px;border:1px solid var(--dsw-alias-border-l1,#262d3d);border-radius:10px;
  background:var(--dsw-alias-bg-layer-2,#151922);overflow:hidden;}
.qm-col h5{margin:0;padding:8px 10px;font-size:12px;display:flex;justify-content:space-between;align-items:center;
  border-bottom:1px solid var(--dsw-alias-border-l1,#262d3d);}
.qm-col .qm-cur{color:var(--dsw-alias-label-tertiary,#8b94a8);font-weight:400;font-size:10px;}
.qm-card-item{padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#1d2330);}
.qm-card-item:last-child{border-bottom:none;}
.qm-card-item .ci-name{color:var(--dsw-alias-label-secondary,#8b94a8);font-size:11px;display:flex;justify-content:space-between;}
.qm-card-item .ci-big{font-weight:700;font-size:14px;margin:2px 0;}
.qm-card-item .ci-big.ok{color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-card-item .ci-big.warn{color:var(--dsw-alias-state-warn-primary,#fbbf24);}
.qm-card-item .ci-big.crit{color:var(--dsw-alias-state-error-primary,#f87171);}
.qm-card-item .ci-big.err{color:var(--dsw-alias-label-tertiary,#6b7280);}
.qm-card-item .ci-row{display:flex;justify-content:space-between;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b94a8);}
.qm-card-item .ci-err{color:var(--dsw-alias-state-error-primary,#f87171);font-size:11px;margin-top:4px;}
.qm-pill{display:inline-block;padding:0 8px;border-radius:9px;font-size:11px;
  border:1px solid var(--dsw-alias-border-l2,#262d3d);color:var(--dsw-alias-label-secondary,#8b94a8);}
.qm-pill.warn{color:var(--dsw-alias-state-warn-primary,#fbbf24);border-color:var(--dsw-alias-state-warn-primary,#fbbf24);}
.qm-pill.crit{color:var(--dsw-alias-state-error-primary,#f87171);border-color:var(--dsw-alias-state-error-primary,#f87171);}
.qm-pill.err{color:var(--dsw-alias-label-tertiary,#6b7280);}
.qm-pill.ok{color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-pill.off{color:var(--dsw-alias-label-tertiary,#6b7280);}
.qm-history{margin-top:14px;border:1px solid var(--dsw-alias-border-l1,#262d3d);border-radius:10px;
  background:var(--dsw-alias-bg-layer-2,#151922);}
.qm-history summary{cursor:pointer;padding:8px 12px;font-size:12px;color:var(--dsw-alias-label-secondary,#8b94a8);}
.qm-history table{width:100%;border-collapse:collapse;font-size:11px;}
.qm-history td,.qm-history th{padding:4px 8px;border-top:1px solid var(--dsw-alias-border-l1,#1d2330);text-align:left;color:var(--dsw-alias-label-secondary,#8b94a8);}
.qm-history .h-ok{color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-history .h-bad{color:var(--dsw-alias-state-error-primary,#f87171);}
.qm-settings input[type=text],.qm-settings input[type=password],.qm-settings input[type=number]{
  width:100%;box-sizing:border-box;background:var(--dsw-specific-input-major,#1c2230);
  border:1px solid var(--dsw-alias-border-l2,#262d3d);border-radius:8px;color:var(--dsw-alias-label-primary,#dbe2ee);
  padding:6px 8px;font-size:12px;font-family:inherit;margin-top:2px;}
.qm-settings input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:1px;}
.qm-settings label{display:block;margin-bottom:10px;font-size:12px;color:var(--dsw-alias-label-secondary,#8b94a8);}
.qm-settings .s-group{border:1px solid var(--dsw-alias-border-l1,#262d3d);border-radius:10px;padding:10px 12px;margin-bottom:10px;
  background:var(--dsw-alias-bg-layer-2,#151922);}
.qm-settings .s-group h5{margin:0 0 8px;font-size:13px;display:flex;justify-content:space-between;align-items:center;}
.qm-settings .s-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 12px;}
.qm-settings .s-row{display:flex;gap:8px;align-items:center;margin-bottom:6px;}
.qm-settings .s-row input[type=checkbox]{accent-color:var(--dsw-alias-state-business-primary,#4f8cff);}
.qm-settings .s-test{margin-left:8px;border:1px solid var(--dsw-alias-border-l2,#262d3d);background:none;border-radius:6px;
  color:var(--dsw-alias-label-primary,#dbe2ee);cursor:pointer;padding:2px 10px;font-size:11px;font-family:inherit;}
.qm-settings .s-test-res{font-size:11px;margin-left:8px;}
.qm-settings .s-test-res.ok{color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-settings .s-test-res.bad{color:var(--dsw-alias-state-error-primary,#f87171);}
.qm-settings .s-actions{display:flex;gap:8px;justify-content:flex-end;}
.qm-settings .s-actions button{border:1px solid var(--dsw-alias-border-l2,#262d3d);background:none;border-radius:8px;
  color:var(--dsw-alias-label-primary,#dbe2ee);cursor:pointer;padding:5px 14px;font-size:12px;font-family:inherit;}
.qm-settings .s-actions button.qm-pri{background:var(--dsw-alias-button-info-fill,#4f8cff);border-color:transparent;color:#fff;}
.qm-settings .s-saved{color:var(--dsw-alias-state-success-primary,#34d399);font-size:11px;align-self:center;}
.qm-settings .pnote{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b94a8);}

.qm-settings .qm-pages-title{display:flex;justify-content:space-between;margin:4px 0 8px;color:var(--dsw-alias-label-secondary,#8b94a8);font-size:12px;}
.qm-settings .qm-pages-title span{color:var(--dsw-alias-label-tertiary,#5c6577);font-size:10px;}
.qm-page-list{display:flex;flex-direction:column;gap:6px;}
.qm-page-row{display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l1,#262d3d);border-radius:10px;padding:6px 10px;background:var(--dsw-alias-bg-layer-2,#151922);}
.qm-page-main{flex:1 1 0;min-width:0;display:flex;align-items:center;gap:8px;cursor:pointer;}
.qm-page-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qm-page-pill{flex:none;padding:1px 8px;border-radius:8px;font-size:10px;border:1px solid var(--dsw-alias-border-l2,#262d3d);color:var(--dsw-alias-label-secondary,#8b94a8);}
.qm-page-pill.ghost{opacity:.6;}
.qm-page-auto{flex:none;font-size:10px;color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-page-actions{flex:none;display:flex;align-items:center;gap:6px;font-size:11px;}
.qm-page-toggle{display:flex;gap:4px;align-items:center;margin:0;font-size:11px;}
.qm-page-toggle input[type=checkbox]{accent-color:var(--dsw-alias-state-business-primary,#4f8cff);}
.qm-settings .s-test.qm-pri-soft{border-color:var(--dsw-alias-state-business-primary,#4f8cff);color:var(--dsw-alias-state-business-primary,#4f8cff);}
.qm-settings .qm-page-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;}
.qm-settings .qm-page-head b{flex:1 1 0;font-size:14px;}
.qm-settings .qm-inline-toggle{display:flex;align-items:center;gap:6px;margin:8px 0 0;font-size:12px;}
.qm-settings .qm-inline-toggle input[type=checkbox]{accent-color:var(--dsw-alias-state-business-primary,#4f8cff);}
/* v1.1：已添加过滤目录 + 重新扫描标题行 + 可添加折叠列表 */
.qm-settings .qm-pages-title.qm-head-b{align-items:center;}
.qm-settings .qm-pages-title .qm-added-only{margin-left:6px;color:var(--dsw-alias-label-tertiary,#5c6577);font-size:10px;font-weight:400;}
.qm-settings .qm-title-actions{display:flex;align-items:center;gap:8px;flex:none;}
.qm-settings .chip{display:inline-block;padding:1px 8px;border-radius:8px;font-size:10px;border:1px solid var(--dsw-alias-border-l2,#262d3d);color:var(--dsw-alias-label-secondary,#8b94a8);background:var(--dsw-alias-bg-layer-2,#151922);white-space:nowrap;}
.qm-rescan-btn{border:1px solid var(--dsw-alias-border-l2,#262d3d);background:none;border-radius:8px;color:var(--dsw-alias-label-primary,#dbe2ee);cursor:pointer;padding:3px 12px;font-size:11px;font-family:inherit;white-space:nowrap;}
.qm-rescan-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#20283a);}
.qm-rescan-btn:disabled{cursor:default;opacity:.55;}
.qm-settings .qm-scanline{display:flex;justify-content:flex-end;align-items:center;gap:6px;flex-wrap:wrap;min-height:16px;
  margin:-4px 0 8px;color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:11px;}
.qm-settings .qm-scanline b{font-weight:600;}
.qm-settings .qm-scanline .ok{color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-settings .qm-scanline .err{color:var(--dsw-alias-state-error-primary,#f87171);}
.qm-settings .qm-scanline .names{max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:middle;}
.qm-settings .qm-empty-added{color:var(--dsw-alias-label-tertiary,#8b94a8);text-align:center;padding:18px 8px;
  border:1px dashed var(--dsw-alias-border-l1,#262d3d);border-radius:10px;margin-bottom:4px;}
.qm-settings .qm-addable{margin-top:10px;border:1px dashed var(--dsw-alias-border-l2,#262d3d);border-radius:10px;}
.qm-settings .qm-addable summary{cursor:pointer;padding:8px 12px;font-size:12px;color:var(--dsw-alias-label-secondary,#8b94a8);list-style:none;display:flex;align-items:center;gap:8px;user-select:none;}
.qm-settings .qm-addable summary::-webkit-details-marker{display:none;}
.qm-settings .qm-addable summary::before{content:"▸";font-size:10px;color:var(--dsw-alias-label-tertiary,#5c6577);transition:transform .15s;}
.qm-settings .qm-addable[open] summary::before{transform:rotate(90deg);}
.qm-settings .qm-addable .cnt{color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:10px;}
.qm-settings .qm-addable .hint{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-tertiary,#5c6577);}
.qm-settings .addable-list{padding:0 8px 8px;display:flex;flex-direction:column;gap:6px;}
.qm-settings .qm-add-row{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l1,#262d3d);border-radius:8px;padding:5px 8px;background:var(--dsw-alias-bg-layer-2,#151922);}
.qm-settings .qm-add-row.fresh{animation:qm-fresh 1.8s ease-out;}
.qm-settings .qm-add-row .add-why{margin-left:auto;color:var(--dsw-alias-label-tertiary,#5c6577);font-size:10px;flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
@keyframes qm-fresh{from{background:rgba(79,140,255,.30);}to{background:transparent;}}
      `;

      function ensureStyle() {
        const tagId = "dsh-token-quota/widget.css";
        if (document.querySelector(`style[data-plugin-css="${tagId}"]`)) return;
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-token-quota";
        tag.dataset.pluginCss = tagId;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }

      // ---------- 应用入口 ----------
      const inject = ["slots", "locale", "sessions"];

      function apply(ctx) {
        ensureStyle();

        // 多行紧凑条布局变体的 URL 开关：?qm-strip=A|B|C。
        // 只影响宽栏紧凑条的排版，不改数据；定稿后可整体删除（含 STRIP_VARIANTS 与 store）。
        const syncStripVariant = () => setStripVariant(stripFromSearch(stripSearch()));
        syncStripVariant();
        try {
          window.addEventListener("popstate", syncStripVariant);
          window.addEventListener("hashchange", syncStripVariant);
        } catch (error) {
          console.warn("[dsh-token-quota] strip variant listener unavailable", error);
        }

        // 本地化词典（DSH 官方模式：locale.register 后由槽位注入 t）。
        // localeT 是同一份词典的绑定视图：槽位导航项（label thunk）拿不到注入的 t，用它取文案。
        let disposeLocale = null;
        let localeT = null;
        try {
          disposeLocale = ctx.locale.register(NS, LOCALES);
          localeT = typeof ctx.locale.bind === "function" ? ctx.locale.bind(NS) : null;
        } catch (error) {
          console.warn("[dsh-token-quota] locale register failed", error);
        }

        // 装配「当前显示页」订阅源：官方 sessions.list（Session Controller 客户端）。
        // 切页 → sessions.list 变化 → FooterSlotWithSession 即时重渲并带新 sessionId 重新拉 /state。
        sessionListSource = null;
        try {
          const sessions = ctx.get ? ctx.get("sessions") : ctx.sessions;
          const list = sessions?.list;
          if (list && typeof list.subscribe === "function" && typeof list.getSnapshot === "function") {
            sessionListSource = {
              getSnapshot: () => {
                try {
                  const current = list.getSnapshot().current;
                  return typeof current === "string" ? current : "";
                } catch {
                  return "";
                }
              },
              subscribe: (listener) => {
                try {
                  return list.subscribe(listener) || (() => {});
                } catch {
                  return () => {};
                }
              },
            };
          }
        } catch (error) {
          console.warn("[dsh-token-quota] sessions service unavailable, sidebar shows global latest", error);
        }

        // 侧边栏底槽：小组件（list slot，keyed id，官方渲染契约）
        let disposeFooter = null;
        let disposeCard = null;
        try {
          disposeFooter = ctx.slots.inject("sidebar.footer.action", () =>
            ctx.slots.register({
              name: "sidebar.footer.action",
              id: "dsh-token-quota",
              locale: NS,
            }, FooterSlotWithSession),
          );
        } catch (error) {
          console.warn("[dsh-token-quota] sidebar footer slot unavailable", error);
        }

        // DSH 设置面板：本插件自成一页（0.1.7 起 settings.plugin.item 槽位已移除，
        // 列表式 settings.section 取代它；导航项文案随 locale 版本重取）。
        try {
          disposeCard = ctx.slots.inject("settings.section", () =>
            ctx.slots.register({
              name: "settings.section",
              id: NS,
              order: 20,
              label: () => (localeT ? localeT("settingsTitle") : "用量监控设置"),
              locale: NS,
            }, SettingsSection),
          );
        } catch (error) {
          console.warn("[dsh-token-quota] settings section slot unavailable", error);
        }

        ctx.effect(() => () => {
          disposeLocale?.();
          disposeFooter?.();
          disposeCard?.();
          try {
            window.removeEventListener("popstate", syncStripVariant);
            window.removeEventListener("hashchange", syncStripVariant);
          } catch {
            /* 卸载路径尽力而为 */
          }
        }, "dsh-token-quota: slot disposers");
      }

      exports.apply = apply;
      exports.inject = inject;
      return module.exports;
    },
  });
})();
