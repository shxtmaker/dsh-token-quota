# dsh-token-quota (用量监控)

A DeepSeek Harness (DSH) plugin that displays each LLM supplier's available period quota / balance / reported usage & cost. Since v0.3 the data layer tracks Token-Consumption-Monitoring `main` (v1.3.x) [docs/query-coverage.md](http://192.168.3.100:3300/lqy/Token-Consumption-Monitoring/src/branch/main/docs/query-coverage.md): supplier registry is split by **凭据类别 × 地域** (13 entries, metadata-driven), with auto-identification of every plain API key found in the DSH harness. This context covers the plugin's domain: suppliers, credentials classes, quotas, the sidebar strip's current-in-use supplier display, and the widget that shows them.

## Language

**设置行 (Settings Row)**:
One profile row = one configuration form since DSH 0.1.7: the row id (`dsh-token-quota`, from the plugin's own `cordis.patch.yml`) is both the settings namespace and the address writes use (`ctx.settings.update(rowId, patch)`). The row's config arrives as a **volatile reference** (`config.get()`), so saving replaces values in place and never remounts the plugin; fields are only writable when the Config schema marks them volatile. The pre-0.1.7 surface (plugin-registered namespaces in `<DSH_HOME>/settings.yaml`, `settings.plugin.item` cards, `ctx.settings.get(ns)`) no longer exists — the old document survives as `settings.yaml.imported` and is migrated into the row on first boot.
_Avoid_: namespace (0.1.7 起仅指行 id), settings.yaml

**供应商 (Supplier)**:
An LLM API provider whose quota the plugin queries (DeepSeek, OpenAI, Anthropic, OpenRouter, …).
_Avoid_: Provider, service, vendor

**周期限额 (Period Quota)**:
A supplier's allowance measured against a recurring period: 限额 limit / 已用 used / 剩余 remaining / 重置时间 reset time, whichever subset that supplier exposes.
_Avoid_: monthly limit, allowance

**重置倒计时 (Reset Countdown)**:
The remaining time until a **周期限额** window resets, shown in the widget's meta line. Computed client-side from the supplier's **original reset instant** (`resetAt`, epoch-ms, carried per 限额项 and mirrored on the headline) so it reads `2h13` / `1d19h` rather than a rounded「约 N 小时后重置」. Shown identically in **all four** reset surfaces — the widget meta line, the widget Popover, the 详情页 entry card, and the supplier config page's current-quota preview. When a supplier exposes no instant, the host's own text stands unchanged — the plugin never derives an instant to fill the gap.
_Avoid_: 重置时间文案 (that is the pre-rounded host text), 到期时间

**可用周期限额 (Available Quota)**:
The remaining headroom of the current period — what the plugin's display shows as the headline number. Also covers balance (余额) and rate-limit headroom (速率限额余量) since suppliers disagree on what "quota" means; the display normalizes to limit/used/remaining/reset with blanks for what a supplier doesn't expose.

**限额项 (Limit Entry)**:
A supplier's individual quota line — a balance, a rolling/window limit, an allowance meter, or a credit plan. The widget's expandable sub-row and the detail page's grouped rows operate at this granularity.
_Avoid_: quota item, metric row

**余额 (Balance)**:
Remaining prepaid balance on a supplier account (e.g. DeepSeek's topped-up vs granted balance).
_Avoid_: credits (except OpenRouter's own term), wallet

**速率限额 (Rate Limit)**:
Per-window RPM/TPM or per-day request limits, usually reported via response headers rather than an endpoint.
_Avoid_: throttle, 限流 (verb)

**统一查询方法 (Unified Query Methods)**:
The abstraction inherited from the upstream repo that gives every supplier the same query interface; the plugin's data layer is built on it. The port only keeps pure-HTTP methods with strict official host/base-path validation; Windows-only methods (WebView2 console, local SQLite, local Codex CLI login) are dropped.
_Avoid_: adapter layer, provider interface

**凭据类别 (Credential Class)**:
What kind of secret a supplier page needs — 普通 API Key (chat key also queryable for the supplier's own balance/plan windows), 组织 Admin Key (OpenAI/Anthropic org usage & cost), Management Key (OpenRouter account credits). Classes never substitute for one another; the auto-detect layer maps plain DSH chat keys only to api-key-class suppliers.
_Avoid_: key type dropdown, credential kind

**各 API key 自动识别 (Auto-Identify Every API Key)**:
v0.3 auto-detect: every plain API key present in the DSH seam (`llm-deepseek` section + `llm-pi-ai.providers` dictionary, resolved via `ctx.credentials` then `process.env`) is attributed to its supplier by route name (exact/prefix) with an official-host fallback, then enabled with official Base URL + key copy. Admin/Management suppliers are never auto-filled from chat keys — the settings UI marks them "需手动填写"; OpenAI/Anthropic chat routes are detected only to surface that hint.
_Avoid_: guessing by key prefix (upstream forbids it)

**小组件 (Widget)**:
The compact, always-visible DSH GUI display showing the harness's connection to the plugin and which model supplier the currently displayed page is using. Since v0.2 it is embedded through the official `sidebar.footer.action` slot (list, keyed `dsh-token-quota`) rendered by the sidebar shell in the foot area in normal content flow — no DOM scraping, no floating/fixed panel — and switches to an icon-only rail state when the sidebar collapses. Since v1.2 the wide strip is **three lines**: **连接状态** · **当日消耗量** · the candidate count (line 1), the **在用供应商** of the **当前显示页** (line 2; the session selected in the session browser = official `sessions.list.current`; the client subscribes and refetches immediately on page switch), then the page's meta line — quota state and **重置倒计时** (line 3). Its Popover lists **当前供应商** quota entries.
_Avoid_: panel, card

**当前显示页 (Current Page)**:
The one session the user currently views in the web GUI — `ctx.sessions.list.getSnapshot().current` on the client. The compact strip is scoped to it: per-session traffic (`sessionRouteSeen`) selects that page's most recent call, so concurrent sessions using different suppliers never bleed into each other; a page with no calls shows 暂无调用 (never falls back to another page). Absent `?session=` the state endpoint still returns the global latest (legacy).
_Avoid_: active tab in OS browser, foreground window

**详情页 (Detail Page)**:
The full view opened from the widget showing every quota field per supplier in a table, plus refresh history.
_Avoid_: detail view, expanded card

**当前供应商 (Current Supplier)**:
A supplier the harness is actually using now — enabled in the DSH configuration and (when traffic data is observable) with recent LLM calls; the widget filters to these. Falls back to the enabled list when traffic isn't observable.
_Avoid_: active provider, used supplier

**在用供应商 (Active Supplier)**:
The supplier of the **most recent** real LLM call observed within the **当前显示页** from `session/event` (route/model per `session.id` in `sessionRouteSeen`), carrying the model name of that call; this is the **第 2 行** of the wide sidebar compact strip (「在用 DeepSeek · deepseek-chat」), which is why that row carries no quota figures of its own. A page with no calls shows "暂无调用"; independent of the enabled/current filtering that governs the popover list, and of other pages' traffic. (No `?session=` → the API returns the global latest instead.)
_Avoid_: active provider, 当前路由供应商, 正在调用的 provider

**连接状态 (Connection Status)**:
The **第 1 行** headline of the wide compact strip, pairing the plugin's link to the harness with its fetch health: `已连接` (the DSH event channel has seen a real `session/event`, and no **已添加供应商** is failing), `已连接 · 降级` (channel alive, but at least one enabled-and-added supplier is in `err`), `待命` (no traffic event seen yet, but suppliers are configured — a freshly started harness is **not** 「断开」), `未连接` (no traffic event seen and nothing configured). It never claims a disconnection it cannot observe.
_Avoid_: 在线/离线 (implies reachability the plugin cannot test), 健康度 (that is per-supplier quota state)

**当日消耗量 (Daily Usage)**:
Token consumption attributed per supplier from DSH session events, aggregated over the current calendar day (resets at 00:00); suppliers without a DSH route show "—". Backed by the plugin's **本地用量数据** so it survives restarts.
_Avoid_: today's usage, daily token count

**本地用量数据 (Local Usage Data)**:
The plugin's token-consumption statistics persisted as supplier × hourly buckets in `$DSH_HOME/dsh-token-quota/usage.json` (atomic write with a 2s debounce), surviving restarts and pruned by the **保留期**. Distinct from the in-memory **刷新历史**.
_Avoid_: local cache, on-disk history, cloud stats

**保留期 (Retention Window)**:
How far back **本地用量数据** is kept (default 7 days, 1–90 configurable in the plugin settings); older hourly buckets are pruned on load and on every save.
_Avoid_: history days, data range

**刷新 (Refresh)**:
Fetching current quota data; automatic polling on an interval plus a manual refresh action.
_Avoid_: sync, update (verb)

**自动探测 (Auto-detect)**:
The feature that discovers suppliers already added in the DSH harness (via `ctx.llm` registry and `llm-deepseek`/`llm-pi-ai` settings sections) and auto-fills the plugin's settings for supported routes — enabling, Base URL (adopted only when the DSH route address passes the supplier's official host/path whitelist), and the **API key itself** (copied once from DSH's credential seam into the plugin's secret-role settings field; a user-supplied key is never overwritten; an explicitly disabled supplier is never re-enabled).
_Avoid_: auto-config, provider discovery

**已添加供应商 (Added Supplier)**:
A supplier that earns a row in the plugin settings catalog and the detail page columns: DSH auto-detect hit it in the latest scan, **or** it is enabled in the plugin, **or** any secret (apiKey / allowanceToken …) is filled. Merely persisting threshold / Base URL changes without any of the three does **not** count; explicitly disabled but key-set suppliers still count (their enable switch stays reachable); disabled without a key does not. The settings「供应商页目录」and the detail page columns only list added suppliers.
_Avoid_: configured supplier, enabled supplier

**可添加供应商 (Addable Supplier)**:
An entry in the collapsible「可添加供应商」list at the bottom of the settings catalog — a registry-supported supplier that is neither detected by DSH, nor enabled, nor key-set. Clicking its「打开配置 → 添加」opens its standalone config page; saving there makes it an **已添加供应商** (opening without saving does not).
_Avoid_: 未接入供应商, candidate supplier (candidate is a widget/popover term)

**重新扫描 (Rescan)**:
The manual action on the settings catalog title row: it runs the **same** DSH supplier scan and auto-fill as the periodic auto-detect (idempotent; respects manual keys and explicit disable), then refreshes the catalog and shows connected count / names / last scan time on the title row; when new addable suppliers are found it auto-expands and highlights them.
_Avoid_: 手动刷新 (refresh re-queries quota; rescan re-discovers supplier topology)

**官方查询覆盖 (Official Query Coverage)**:
The supplier/endpoint matrix ported from upstream docs/query-coverage.md: DeepSeek multi-currency balance, OpenRouter key quota + daily cost, Moonshot cn/intl balance, Z.ai/智谱 Coding Plan windows, MiniMax Token Plan windows (explicit remaining percent only), OpenAI/Anthropic org usage & cost for the last completed UTC day; OpenCode/Command Code remain private-compat sources. Coverage boundaries (no invented reset times/weekly windows/absolute token counts) carry over.
_Avoid_: adapters, endpoints table