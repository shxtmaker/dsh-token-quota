# dsh-token-quota（用量监控）

当前版本：**v1.4.0**（2026-09-25）。要求 DSH **≥ 0.1.7-rc.2**。

DeepSeek Harness 插件：显示各供应商**可用周期限额 / 余额 / 报告用量费用**——sidebar 脚部小组件 + 详情页。

查询覆盖随 [Token-Consumption-Monitoring](http://192.168.3.100:3300/lqy/Token-Consumption-Monitoring)（`main`，v1.3.x）的
[docs/query-coverage.md](http://192.168.3.100:3300/lqy/Token-Consumption-Monitoring/src/branch/main/docs/query-coverage.md)
重构，供应商注册表按「凭据类别 × 地域」拆分（与上游「一个页面保存一种凭据」一致；普通 API Key、Management Key、Admin Key 不互相尝试）：

| 供应商 | 查询方法（端点） | 凭据类别 | 密钥来源 |
|---|---|---|---|
| DeepSeek | 账户余额 `/user/balance`（多币种保留，严格官方地址） | 普通 API Key | DSH 自动识别 |
| OpenRouter | 当前 Key 周期额度 + 今日费用 `/api/v1/key` | 普通 API Key | DSH 自动识别 |
| OpenRouter 账户 | 账户 credits `/api/v1/credits`（total_credits − total_usage） | Management Key | 手动 |
| OpenAI 组织 | 用量 `/v1/organization/usage/completions` + 费用 `/v1/organization/costs`（最近完整 UTC 日，分页+去重游标） | 组织 Admin Key | 手动 |
| Anthropic 组织 | 用量 `/v1/organizations/usage_report/messages` + 费用 `/v1/organizations/cost_report`（美分→USD） | 组织 Admin Key | 手动 |
| Moonshot 国内 | 余额 `/v1/users/me/balance`（api.moonshot.cn，CNY） | 普通 API Key | DSH 自动识别 |
| Moonshot 国际 | 余额 `/v1/users/me/balance`（api.moonshot.ai，USD） | 普通 API Key | DSH 自动识别 |
| Z.ai | Coding Plan 窗口 `/api/monitor/usage/quota/limit`（api.z.ai；Authorization 原样不带 Bearer） | 普通 API Key | DSH 自动识别 |
| 智谱 Coding Plan | 同上（open.bigmodel.cn） | 普通 API Key | DSH 自动识别 |
| MiniMax 国际 | Token Plan 窗口 `/v1/token_plan/remains`（www.minimax.io；显式剩余百分比，不猜旧计数） | 普通 API Key | DSH 自动识别 |
| MiniMax 国内 | 同上（www.minimaxi.com） | 普通 API Key | DSH 自动识别 |
| OpenCode（兼容） | 5h/周/月窗口 `/zen/go/v1/usage` + allowance `/api/go/status`（OAuth + x-org-id） | 普通 API Key / OAuth | DSH 自动识别 / 手动 |
| Command Code（兼容） | 5h/周窗口 + 套餐月额度 `/alpha/billing/*`（plan 表随上游；网关 baseURL 收敛到同源根路径） | 普通 API Key | DSH 自动识别 |

官方方法只接受对应 HTTPS 主机 + 已知基础路径（拒绝端口/用户信息/查询串/重定向），地址不匹配不发请求；
无限额度 / 未知余额 / 缺字段保留未知，不冒充零值；分页失败不发布部分总数；不同币种、窗口、来源不相加。
Windows 专属方法（WebView2 控制台、本地 SQLite、本机 Codex CLI 登录）按规格丢弃——Codex 需本机 CLI 登录态，不适用于服务端 DSH，不注册。

## v1.4.0 新增（适配 DSH 0.1.7 的 Settings 与配置面）

0.1.7 把「插件自注册 settings 命名空间」换成了「一个 profile 行 = 一张配置表单」，并移除了若干旧接口。
本版本按新契约重做了宿主半的配置接入与客户端设置页落点：

- **配置来自行 config（volatile 引用）**：`Config` 整棵标 `volatile`，`apply(ctx, config)` 收到的就是 loader 维护的引用，
  读值统一走 `config.get()`。用户保存配置时 **不再重挂插件**（loader 就地提交并发 `loader/volatile-update`），
  路由观测、刷新历史与本地用量桶不会被一次保存清空。
- **写入走行 id**：`ctx.settings.register(...)` 在 0.1.7 已不存在（旧版会直接 `TypeError` 让插件整只不激活）。
  现在用 `ctx.settings.update(<行 id>, patch)` 深合并写入；行 id 就是本插件 `cordis.patch.yml` 插入的 `dsh-token-quota`，
  行被改名时按值形状认领自己的那一行。
- **0.1.7 前的配置自动迁移**：harness 启动时把 `<DSH_HOME>/settings.yaml` 改名成 `settings.yaml.imported` 并逐段写进行 config；
  本插件当时没激活，段就留在了那份文档里。启动后（本行还没有用户层时）读回 `dsh-token-quota` / `quota-monitor` 两段
  （含 API Key、启用开关、Base URL 覆写），逐字段深合并后写进本行；**来源文件一律保留**。
- **设置页落点换了槽位**：`settings.plugin.item` 已移除，改注册 `settings.section` 列表项（本插件自成一页，
  渲染在设置面板内容列；小组件里的「设置」入口仍打开同一面板的弹层形态）。
- **探测改读 `describe()`**：`ctx.settings.get(ns)` 在 0.1.7 不再提供，LLM 行（`llm-deepseek` / `llm-pi-ai`）
  改从 `ctx.settings.describe()` 的 `value` 读取；凭据解析仍走 `ctx.credentials.resolve(ref)`。
- **依赖与门槛**：运行时依赖 `@deepseek-ai/schemastery`（0.1.7 的 volatile 解析在它里面，用上游 schemastery 会被静默吞掉变更）；
  `dsh.engines.dsh` 提到 `>=0.1.7-rc.2`。

## v1.1.2 新增

- **插件改名**：`dsh-usage-monitor` → **`dsh-token-quota`**（npm / GitHub / Gitea 三处均可用，未与既有两个同类插件 `dsh-quota-monitor`、`dsh-quota-panel` 重名）。随之变更的运行标识：client 模块 id、`sidebar.footer.action` 槽位 key、`settings.plugin.item` key、HTTP 前缀 `/api/dsh-token-quota/*`、settings 命名空间 `dsh-token-quota`、用量目录 `<DSH_HOME>/dsh-token-quota/`。
- **改名自动迁移（旧数据不丢）**：启动时 ① 用量目录 `<DSH_HOME>/quota-monitor/` → `<DSH_HOME>/dsh-token-quota/`（只在「旧目录存在且新目录不存在」时搬一次；搬不动则回落旧路径继续读，下次启动再试，绝不删旧数据）；② settings 命名空间 `quota-monitor` → `dsh-token-quota`（新命名空间为空且旧的有用户配置时整段拷贝，含已填密钥；**旧命名空间保留**，可确认无误后手动清理）。
- **修复：倒计时小时档漏掉分钟单位**：`5h07 后重置` → **`5h07m 后重置`**（`resetInHM` 词条补 `m`；`*d*h` 档保持不带分钟）。
- **修复：占位重置时刻**：上游在「没有重置时刻」时用 `0` 占位（真实样本：Command Code `windowLimits` 缺失时 `resetAt: 0`）。此前该值会被当作 1970 年的合法时刻，画出「即将重置」这种上游从未说过的结论；现在 `resetAtMs()` 只接受 epoch-毫秒（> 1e9），占位值等价于「没给」，客户端回落宿主文案。

## v1.1.1 新增

- **小组件多行化**：宽栏紧凑条由单行改为**三行**——① 连接状态 · 今日 token 消耗（· `×N` 候选计数）② 在用供应商 · 模型 ③ 限额状态 · 重置倒计时。第 2/3 行同字号（12px，层级靠颜色）、单行省略 + `title` 兜底全文；**容器宽 < 200px**（侧栏被拖窄）时自动收起第 3 行。不再显示「最近一次调用」的相对时间。
- **连接状态（第 1 行）**：`已连接` / `已连接 · 降级`（有已添加供应商取数失败，个数进 title）/ `待命`（事件通道尚未见到流量但已有配置——不把「插件刚起来」谎报成断开）/ `未连接`（通道无流量且无任何配置）。判定依据 = `state.traffic.channelAlive` × 供应商 `state === "err"` 计数（只算 `enabled ∧ added`）。
- **重置倒计时（四处一致）**：宿主新增下发**原始重置时刻** `entries[].resetAt` / `headline.resetAt`（epoch-毫秒，仅供应商确实给出时刻时存在），客户端据此精确计算 **`*h*m`**（< 1 天，如 `2h13`）/ **`*d*h`**（≥ 1 天，如 `1d19h`），已过期显示「即将重置」；无原始时刻时**原样回落**宿主文案，绝不推算时刻。小组件第 3 行 / Popover / 详情页卡片 / 供应商配置页预览**四处同源同格式**。
- **排版细节**：Popover 限额行与供应商/模型行同字号（12px）；详情卡片缺重置文本时显式显示 `—`。

## v1.1 新增

- **设置页「仅显示已添加」**：供应商目录与详情页分栏只显示**已添加供应商**——服务端推导（最新 DSH 探测命中 ∨ 已启用 ∨ 任一密钥已填；仅改阈值/Base URL 不算；显式停用但有密钥仍显示）。未添加的收进目录底部**「可添加供应商」折叠列表**，每项「打开配置 → 添加」，保存后即加入主目录。
- **重新扫描按钮（标题行）**：设置目录标题行显示「已接入 N」计数芯片 + **⟳ 重新扫描**，结果独立一行（接入名单 / 最近扫描时间 / 失败原因）。按钮触发 `POST /api/dsh-token-quota/rescan`，与周期自动探测完全一致（幂等自动填入、尊重手动密钥与显式关闭）；发现新的可添加供应商时**自动展开并高亮**。重扫必须等到**覆盖本次点击**的新扫描：扫描失败或 30s 内拿不到结果时返回 `ok:false` + 「稍后重试」（后台扫描继续），**不把点击前的旧扫描包装成成功**。
- **窗口用量重置时间补齐（Command Code）**：5h / 周窗口的 `resetAt`（真实契约 = epoch-毫秒，已用真实账户复核）经宽容解析显示「约 X 小时后重置 / M月D日 重置」；月额度显示订阅周期结束 `currentPeriodEnd`（缺省如实标注，绝不把 `currentPeriodStart` 当重置）；窗口确实未提供重置时刻的行如实标注「未提供重置时刻」，不伪造。
- **供应商配置页「当前额度」预览**：独立配置页展示最近一次取数的限额条目（含重置时间），与小组件 Popover / 详情卡片同一份数据、同一套**重置倒计时**（`*h*m` / `*d*h`，无原始时刻时回落宿主文案）→ **四处一致**。

## 功能

- **小组件（sidebar 脚部）**：**经 DSH 官方槽位 `sidebar.footer.action` 嵌入**侧边栏底部，与其他脚部按钮/组件同处内容流、并排渲染，**不扫描/不劫持 DOM、不做 fixed 悬浮**。v1.1.1 起宽栏紧凑条为**三行**：① **连接状态 · 今日 token 消耗**（· `×N` 候选计数，仅当候选 > 1）——今日 = 所有 current 供应商当日消耗求和（自然日重置）；连接状态 = DSH 事件通道是否活着（`state.traffic.channelAlive`，本次启动后是否真收到 `session/event`）× 限额取数健康度，取值 `已连接` / `已连接 · 降级`（有 `enabled ∧ added` 供应商取数失败，个数进 title）/ `待命`（通道尚未见过流量，但已有已配置供应商——**不把「插件刚起来」谎报成断开**）/ `未连接`（通道未见过流量且无任何已配置供应商）；② **在用供应商 · 模型**——显示页 = 侧栏会话列表当前选中的会话（官方 `sessions.list.current`），取该会话**最近一次**真实 LLM 调用的供应商 + 模型名；③ **元信息**——限额状态（该供应商 `headline`）· **重置倒计时**；**不显示「最近一次调用」的相对时间**（小组件看的是配额与连接，不是调用新鲜度）。`×N` 候选计数跟在第 1 行「今日用量」之后（与其它信息同字号，不缩小）。倒计时由宿主下发的**原始重置时刻**（`entries[].resetAt` / `headline.resetAt`，epoch-毫秒，仅供应商确实给出时刻时存在）在客户端精确计算：**< 1 天 → `*h*m`**（如 `2h13`）、**≥ 1 天 → `*d*h`**（如 `1d19h`），已过期显示「即将重置」；宿主只给文案、没有时刻时**原样回落**（如「约 43 小时后重置」），绝不推算时刻——`formatReset` 的整小时四舍五入不再限制展示精度。第 2/3 行同字号（12px，层级靠颜色不靠字号）、单行省略，完整内容在各自 `title` 与按钮 `title` 里兜底；**容器宽 < 200px**（侧栏被拖窄）时自动收起第 3 行。多会话并行用不同供应商时**各页互不串**，切会话经 sessions 订阅即时重拉；同页内后台刷新为**完成后调度**（每次请求结束再等 10s，失败按 10→20→40→60s 退避），同一时刻最多一个后台 GET，页面隐藏时暂停、恢复可见时立即刷新一次；当前页尚无调用（含新会话/空页）第 2 行严格显示「暂无调用」，不回退其它页。点击展开 Popover 查看各供应商限额；rail 窄栏自动切换图标态。弹层列表仍显示**当前供应商**（DSH 启用 ∩ 近期流量；组织账务等无 DSH 路由的供应商恒为候选；冷启动或近 24h 无流量时按启用清单兜底并标注）
- **详情页**：供应商分栏（kanban 风，仅已添加供应商），栏头状态胶囊 + 限额/用量/费用条目卡片；刷新历史默认收起；刷新全部 / 设置入口
- **设置**：原生设置卡片 + 详情页内面板；配置界面为「**供应商页目录（仅显示已添加）→ 每个供应商独立配置页**」——目录行内可直接启停/测试连接，点「打开配置」进入该供应商单页（凭据类别徽标、**当前额度预览**、按 needs 动态渲染的密钥字段、Base URL/警告·临界阈值、测试连接、保存）；目录底部「可添加供应商」折叠列表提供手动添加入口；标题行含 **⟳ 重新扫描** 与最近扫描结果；全局轮询间隔/保留期单独一组；OpenCode 页含 allowance Token 与 org id
- **调度**：默认 60s 轮询（10–3600 可配）；同供应商 in-flight 合并去重；失败指数退避（30s→1m→2m→4m→10m；401/403 → 30min）；手动刷新立即执行
- **历史**：每供应商最近 50 条、全局 500 条（内存，重启即清）
- **本地用量数据**：当日 token 消耗按「供应商 × 小时桶」落盘（`$DSH_HOME/dsh-token-quota/usage.json`，原子写、防抖 2s），按保留期修剪（默认 7 天，1–90 可配）
- **密钥**：DSH settings 命名空间 `dsh-token-quota`（`role('secret')` 脱敏、热重载、原子写）
- **各 API key 自动识别（v0.3 起）**：启动 / settings 热重载 / `llm/adapters-updated` / `credentials/reference-updated` 时，以 **DSH 接缝为准**探测 `llm-deepseek` 配置节与 `llm-pi-ai.providers` 字典（`ctx.llm` 目录/存活路由补充，凭据经 `ctx.credentials` 解析后回退 `process.env`），把每把普通 Key 归属到对应供应商（路由名精确/前缀 + 官方主机兜底归类）→ 自动启用 + 官方 Base URL（DSH 路由地址在白名单内才采用）+ **API Key 本体拷贝**（仅插件侧为空时填写，手动 Key 不覆盖、显式关闭不复活）。凭据类别守门：**DSH 普通聊天 Key 绝不套用到需要 Admin/Management Key 的组织/账户供应商**——OpenAI/Anthropic 聊天路由探测后仅提示「需 Admin Key 手动配置」；此类页面出现时设置面板标注手动填写。

## 客户端渲染契约

浏览器半 `lib/client.js` 不操作侧边栏 DOM，全部走 DSH 官方客户端注入面：

| 槽位 | 注册 id/key | 内容 |
|---|---|---|
| `sidebar.footer.action`（list） | `id: dsh-token-quota` | 小组件主体：宽栏紧凑条三行（连接状态 · 今日 token / 在用供应商 · 模型 / 元信息）+ rail 图标态；跟随 `sessions.list.current` 切页即时重拉；Popover 与弹层经 `createPortal` 挂 body |
| `settings.section`（list） | `id: dsh-token-quota`、`order: 20` | 设置页「用量监控」整页：全局设置 + 供应商目录（已添加 / 可添加）+ 逐供应商配置页与当前额度预览；导航文案由 `label` thunk 随 locale 重取 |

宽栏紧凑条支持布局变体 `?qm-strip=A|B|C`（A 三行堆叠，默认；B 状态点锚供应商行 + 元信息分隔线；C 两列网格、今日量右置）用于定稿比较；**定稿后删除未选变体与该开关**。

依赖声明只列 boot graph 内真实存在的包；Popover 采用官方「贴底展开」定位；详情/设置是居中 overlay。客户端代码由宿主按 rev 重新下发，覆盖文件后刷新浏览器即可生效（无需重新构建插件）。

## 结构

```
lib/index.js      宿主半：行 config（volatile schema，按供应商 needs 生成）、轮询调度、当前供应商/当日消耗量折叠、
                  自动探测接入、/api 路由（含 /rescan）、每供应商 added/addedReason 推导
lib/detect.js     DSH 路由→供应商识别（凭据类别×地域、官方主机/路径判定、Admin 不套用）与自动填入补丁
lib/providers.js  数据层：供应商注册表（13 项，元数据驱动 needs/baseUrl/官方端点白名单）+ 全部查询方法
                  （含重置时间宽容解析：ISO / epoch-毫秒；窗口缺 resetAt 如实标注）
lib/scheduler.js  查询调度、失败退避、并发合并与配置版本失效
lib/scan-coordinator.js 扫描协调：目标/完成版本、单实例并发、手动重扫等待、设置写入串行队列
lib/usage.js      会话步骤用量替换记账（跨小时保留首次报告小时）
lib/storage.js    本地用量数据（小时桶、保留期、增量合并、写入锁与恢复保护）
lib/routes.js     自动探测与事件记账共用的供应商路由归属
lib/legacy-config.js 旧 settings 文档（settings.yaml[.imported]）读取：嵌套字典+标量子集，结构不符整段丢弃
lib/client.js     客户端半：脚部槽位小组件（sessions.list 跟随当前显示页）/ Popover / 详情页 /
                  设置面板（已添加过滤目录 + 可添加列表 + 标题行重新扫描 + 配置页当前额度预览）
test/smoke.mjs    数据层冒烟（Mock fetch：全部官方方法 + 端点校验 + 多币种/分页 + CC 重置时间）
test/detect.mjs   自动探测单元测试（路由/地域/凭据类别/去重/无密钥/手动接管）
test/harness.mjs  0.1.7 settings 契约的测试替身（行视图 / update / volatile 引用 + 事件）
test/mock-dsh.mjs 宿主半集成冒烟（Mock ctx + fetch；含 added 推导与 /rescan）
test/migration.mjs 旧配置迁移（改名 + settings.yaml.imported → 行 config）
test/legacy-config.mjs 旧文档解析子集与「宁可读不到也不读错」
test/scan-coordinator.mjs 扫描协调器单测 + 真实装配（版本门禁、手动重扫、发现状态）
test/client-lifecycle.mjs 客户端请求生命周期（慢请求、超时退避、切页、隐藏、卸载、手动刷新）
test/usage-saves.mjs 用量落盘去重（相同样本不再写盘）
test/browser/edit-identity.spec.mjs 浏览器端编辑器身份与阈值一致性
test/storage.mjs  本地用量数据存储单元测试
```

宿主路由（loopback 同源守卫）：`GET /api/dsh-token-quota/state[?session=<会话id>]`（含探测诊断 detect、每供应商 needs/meta 元数据与 `added/addedReason`；带 `?session=` 时 `active` 为该会话页最近一次调用，空串/未知会话=暂无，缺参=全局最近一次）·
`POST /refresh`（同样支持 `?session=` 保持会话范围）· `POST /test`（`{supplier}`）· `POST /settings`（深合并，密钥留空 = 不变）·
`POST /rescan`（手动触发与周期自动探测一致的 DSH 扫描 + 自动填入，返回与 /state 相同载荷）。

## 安装

请先安装 Git、Node.js 与 DSH，并确认 `dsh --version` 可以正常运行。以下命令使用 `web` profile；其他 profile 请替换命令中的名称。当前验证环境为 Node.js 24.19.0、DSH 0.1.2-rc.1。

快速添加（源码目录即本仓库，或 `npm pack` 出的压缩包）：

```bash
# link 安装：直接用源码目录（目录需保留）
dsh plugin --profile web add "link:$(pwd)"
#   或压缩包安装
dsh plugin --profile web add "$(pwd)/dsh-token-quota-1.4.0.tgz"
```

### 从源码安装

Linux / macOS：

```bash
git clone https://github.com/shxtmaker/dsh-token-quota.git
cd dsh-token-quota
npm ci
dsh plugin --profile web add "link:$(pwd)"
dsh --profile web
```

Windows PowerShell：

```powershell
git clone https://github.com/shxtmaker/dsh-token-quota.git
Set-Location dsh-token-quota
npm ci
$pluginDirectory = (Get-Location).Path
dsh plugin --profile web add "link:$pluginDirectory"
dsh --profile web
```

`link:` 安装直接使用该源码目录，请保留目录。若 DSH 已在运行，请先结束当前任务并退出，再重新启动；重启会中断尚未完成的会话任务。

### 从压缩包安装

在源码目录执行 `npm pack`，得到 `dsh-token-quota-1.4.0.tgz`。也可以使用已有的同名安装包。传给 DSH 的文件路径应为绝对路径，避免 profile 工作目录影响相对路径解析。

Linux / macOS（安装包位于当前目录）：

```bash
dsh plugin --profile web add "$(pwd)/dsh-token-quota-1.4.0.tgz"
```

Windows PowerShell：

```powershell
$archivePath = (Resolve-Path ./dsh-token-quota-1.4.0.tgz).Path
dsh plugin --profile web add $archivePath
```

安装后重新启动 `dsh --profile web`。压缩包不包含 DSH 与第三方依赖，首次安装仍可能需要联网下载依赖。

装好后在 DSH 设置页（插件清单 → 用量监控卡片）配置各供应商密钥，或点小组件「详情 → 设置」。


### 升级与检查

源码链接安装：在源码目录执行 `git pull --ff-only` 和 `npm ci`，然后重启 DSH 并刷新浏览器。压缩包安装：用新版本安装包的绝对路径重新执行上述 `add` 命令，再重启。

**DSH 0.1.7 起**：配置不再写进 `settings.yaml`，而是本插件 profile 行的 config（`profiles/<profile>/cordis.patch.yml`）。
升级到 v1.4.0 后首次启动会把旧文档里的 `dsh-token-quota` / `quota-monitor` 两段自动读回并写进行 config（旧文档保留）；
若行里已有用户配置则不再迁移。运行 `dsh --profile web --dump-config | grep -A5 dsh-token-quota` 可直接看到本行生效配置。

**从旧包名升级（v1.1.1 及更早）**：本插件在 v1.1.2 改名为 `dsh-token-quota`（旧名 `dsh-usage-monitor`，更早为 `dsh-quota-monitor`）。旧包与新包**不要同时保留**：先 `dsh plugin --profile web list --depth 0` 确认旧包存在，再 `dsh plugin --profile web remove <旧包名>`，最后按上述步骤安装新包。首次启动会自动迁移旧数据：用量目录 `<DSH_HOME>/quota-monitor/` → `<DSH_HOME>/dsh-token-quota/`，settings 命名空间 `quota-monitor` → `dsh-token-quota`（含已填密钥；旧命名空间保留，确认无误后可手动清理）。

执行 `dsh plugin --profile web list --depth 0` 应能看到 `dsh-token-quota`；启动后侧边栏底部应出现用量小组件，设置面板左侧导航里应出现「用量监控设置」一页。没有配置密钥或当前会话尚无调用时，空状态属于正常行为。


## 测试

```bash
npm test                # 单元测试与宿主集成回归
npm run test:pack        # 安装包入口与文件清单验证
npx playwright install chromium
npm run test:browser     # Chromium 键盘、表单失败与窄屏交互
node test/smoke.mjs      # 数据层：13 供应商解析 / 端点校验 / 多币种 / 分页 / 401 / CC 重置时间
node test/detect.mjs     # 自动探测：路由映射 / 地域 / 凭据类别守门 / 去重
node test/mock-dsh.mjs   # 宿主半：路由 / 事件折叠 / 设置热更新 / 自动填入 / added 推导 / /rescan / 退避
node --test test/scan-coordinator.mjs   # 扫描协调：版本门禁、手动重扫、发现状态
node --test test/client-lifecycle.mjs   # 客户端请求生命周期（慢请求 / 退避 / 切页 / 隐藏 / 卸载）
node scripts/benchmark-storage.mjs      # 存储基准（--quick 快速档）
node scripts/benchmark-runtime.mjs      # 运行时基准（状态端点 / 事件循环 / 句柄）
node test/storage.mjs    # 本地用量数据存储
```

## 仓库

源码：[github.com/shxtmaker/dsh-token-quota](https://github.com/shxtmaker/dsh-token-quota)
内网镜像：[http://192.168.3.100:3300/lqy/dsh-token-quota](http://192.168.3.100:3300/lqy/dsh-token-quota)
上游查询覆盖：[Token-Consumption-Monitoring docs/query-coverage.md](http://192.168.3.100:3300/lqy/Token-Consumption-Monitoring/src/branch/main/docs/query-coverage.md)

## 已知限制与后续

- 密钥**清除**需直接编辑本插件 profile 行的 config（`$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里 `id: dsh-token-quota` 那一段；界面只支持留空不改）
- OpenAI / Anthropic 组织与 OpenRouter 账户（Management）供应商依赖 DSH 之外的更高凭据类别 → 不自动填，仅手动；真实账户联调尚未用真实 Admin/Management Key 验证（与上游验证记录一致）
- Codex（本机 CLI 登录）不注册；OpenCode / Command Code 独立 CLI 直连（不经 DSH 路由）的用法仍不可观测 → 恒候选、当日消耗显示 —
- Z.ai / 智谱 等仅返回百分比（无任何时刻字段）的行如实标注、不显示重置时间（不推断、不伪造）；Command Code 窗口重置时间为真实 `resetAt`（epoch-毫秒，已复核）
- 刷新历史仅内存；多日历史/趋势不在范围（本地用量数据小时桶可作后续趋势源）；响应头速率限额余量、GitHub/Cursor/云厂商（Vertex/Azure/Bedrock/百炼/方舟等）为后续项
- 阈值语义：百分比越大越紧（用量/限额）；余额类无限额概念，恒为正常态

## 开发验证

在仓库目录执行：

```bash
npm ci --ignore-scripts
npm test              # 57 个顶层测试项
npm run test:browser  # 6 个 Chromium 测试（首次需 npx playwright install chromium）
npm run test:pack
```

按需运行基准（不进入默认测试）：

```bash
node scripts/benchmark-storage.mjs   # 1/13 供应商 × 7/90 天的保存耗时与今日统计对照
node scripts/benchmark-runtime.mjs   # /state 延迟、事件循环延迟、查询并发与句柄收尾
```

测试包括供应商查询解析、自动探测、存储恢复与跨进程合并、宿主路由与会话隔离、调度取消、用量替换、客户端保存失败，以及 added 推导和重新扫描回归。v1.4.0 起另增：0.1.7 settings 契约（行视图 / volatile 引用 / 写入落行 id）、旧配置迁移（改名段 + `settings.yaml.imported` → 行 config）、旧文档解析子集。v1.3.0 起另增：客户端请求生命周期（慢请求不丢结果、并发上限 1、超时退避、切页/隐藏/卸载）、编辑器身份（保存中切换编辑器不清除新草稿、旧测试结果不回写）、阈值一致性、扫描协调版本门禁与手动重扫、用量落盘去重、官方地址集合契约、Windows 目录迁移回落。供应商响应均为模拟数据，不访问真实账户。浏览器测试使用真实 React、插件 HTTP 路由和隔离的数据目录；真实 DSH 的安装及槽位接入另行验收。CI 在 Windows 与 Linux 上运行单元、打包及 Chromium 测试。

查询切换配置或卸载插件时会取消旧请求；整次查询最长 120 秒，单个 HTTP 请求最长 20 秒。自动扫描共享同一调度入口；已删除会话的索引随宿主删除事件回收。

用量文件采用同进程共享、跨进程短写锁和增量合并。读取损坏文件或不支持的版本时保留原文件，并在详情中显示存储错误；修复文件后可重试保存。写入失败不会清除尚未保存的内存增量。异常退出若遗留 `usage.json.lock`，请先确认使用该数据目录的 DSH 进程均已停止，再移除该锁文件并重启。退出时仍无法写入的增量不能保证保留。

查询配置变化会清除该供应商的旧结果；旧请求完成后不再发布数据。失败刷新保留同一配置下的旧数据并标记失败。
同一会话、同一轮次与步骤的用量更新替换此前样本；跨小时及跨午夜时仍归入首次报告的小时。
HTTP 路由仅接受约定的 GET/POST 方法；带 Origin 的浏览器请求必须与本机宿主的协议、主机和端口一致。
通过反向代理访问时需另外设计受信任的公开来源配置，本版本不会信任转发头。
Anthropic 组织响应若声明仍有后续分页，会报告失败，避免将首页数据当作完整总数。
