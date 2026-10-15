# 供应商查询迭代执行记录（方案 2.0 范围收敛版）

范围白名单：`deepseek`、`openrouter`、`openrouter-account`、`opencode`、`commandcode`、`fireworks`、`opendesign`。
状态：`todo` / `doing` / `done` / `blocked`。本文件不含密钥、账户额度或完整本机路径。

## T01 定位工作区与核对环境 — done

- 工作目录为空目录（非 Git 仓库），无既有改动可覆盖 → 原地 `git clone` 目标仓库。
- 目标 HEAD：`afa580913c782d5b0213a5bfb9b42802cd7f9505`（`main`，`package.json` 2.0.4），与方案 2.1 基线一致。
- 参考仓库只读克隆到工作区外的 `.refs/Token-Consumption-Monitoring`，HEAD `fa5508a392d2a61222fb49aa7ed44478d8672898`（1.3.5），不修改。
- 任务分支：`feat/provider-query-iteration`。
- Node `v26.10.0` / npm `11.19.1`；锁文件 `package-lock.json`（npm）。仓库无 `AGENTS.md`，开发规范以 `CONTEXT.md`、`docs/*.md`、现有测试与 `scripts/check-package.mjs` 为准。
- 已安装的生产插件位于 DSH profile（`~/.dsh/profiles/web/node_modules/dsh-token-quota`，2.0.4）；本迭代默认**不替换**该安装、不重启 DSH。
- 本地用量数据目录已有 `usage.json`（既有历史，不删除、不改格式）。

差异表（方案 2.2 对照当前源码）：

| 项 | 当前源码事实 | 本迭代动作 |
|---|---|---|
| 注册表 | `PROVIDERS` 含 13 个 ID，含 `moonshot-cn`/`moonshot-intl`/`zai`/`zai-cn`/`minimax`/`minimax-cn`/`openai-org`/`anthropic-org` | T02 收敛为 7 个活动查询 ID |
| Command Code | `PLAN_MONTHLY_CREDITS` 静态分母 + `/alpha/usage/summary` 倒推月剩余 | T05 删除，改公开规则读取器 |
| OpenCode | allowance 除数 `1_000_000` | T06 集中单位，降级 USD |
| Fireworks / OpenDesign | 无实现 | T07 / T10 新增 |
| 浏览器运行时 | `@playwright/test` 仅在 devDependencies | T09 增加锁定版本 `playwright-core` 生产依赖 |
| 设置 Schema | `suppliers` 由 `needs` 生成，字符串为主 | T03 扩展真实类型（boolean / 枚举 / 账户选择 / 方法开关） |

Gates：无。下一步 T02。

## T02 活动白名单与切断排除查询 — doing

- 新增 `lib/provider-policy.js`（代码级冻结白名单 + 结构化 `unsupported-provider`）。
- 待办：注册表收敛、探测/凭据/调度/刷新/test 全链路校验、被动路由映射与查询映射分离。

## 其余步骤

T03 todo · T04 todo · T05 todo · T06 todo · T07 todo · T08 todo · T09 todo · T10 todo · T11 todo · T12 todo · T13 todo · T14 todo

## T02 活动白名单与切断排除查询 — done

- 新增 `lib/provider-policy.js`：`QUERY_PROVIDER_IDS` 冻结为 7 个 ID；`unsupportedProviderResult()` 给出结构化拒绝；`PASSIVE_ROUTE_MAP` 与查询白名单分离。
- `lib/providers.js` 重写：活动注册表只含 7 个 ID（构造时双向断言，注册表与白名单漂移即抛错）；`OFFICIAL_ENDPOINTS` 只留 deepseek/openrouter/openrouter-account/fireworks。
- 拦截点：`runMethod`、`buildTaskSpecs`、`makeLegacyQuery`、`/refresh`、`/test`、`/settings`（写入被排除 ID 返回 400）、自动探测（被排除路由在**解析凭据之前**返回，`keyPresent` 恒 false，诊断里不暴露密钥引用名）。
- 新增验证组 A：`test/provider-policy.mjs`（10 例，含「旧 enabled=true 全量/手动刷新零调用」「补丁永不含被排除项」「凭据不跨平台」）。
- 命令：`node --test test/provider-policy.mjs` → 10/10 通过。

## T03 最小配置迁移 — done

- `lib/index.js`：迁移前原子写入私有回滚快照（`<DSH_HOME>/dsh-token-quota/config-rollback-*.json`，0o600；写入失败即跳过危险迁移）。
- 迁移只落白名单字段并做真实类型校验（`enabled` 必须 boolean、百分比必须 number、字符串字段必须 string）；被排除项**不写入**、旧文档原样保留（深合并语义下不做整体覆盖）。
- 新增字段：方法开关（`m_<methodId 归一化>`，`z.boolean()`）、`workspaceId`/`accountId`/`statisticsTimeZone`、`consoleEnabled` 总开关。
- 幂等：本行已有用户层即不动；重复迁移不再改写。

## T04 公共传输与结构化结果 — done

- 新增 `lib/provider-common.js`：稳定状态枚举、`QueryError`、有界 `httpJson`/`httpText`（4 MB 上限、重定向拒绝、Retry-After、取消上抛）、`num/bool/safeInt/epochMs/isoOrEpochMs/secondsToMs`、结构化 `item/result/failure`、`projectEntries/projectHeadline/projectLegacy`、`sharedResponse`（多能力复用一次请求）。
- 缺失/未知一律 `null`，不转 0；格式化只发生在投影层。

## T05 Command Code 修正 — done

- 删除 `PLAN_MONTHLY_CREDITS` 静态分母与 `/alpha/usage/summary` 倒推月剩余路径。
- `lib/providers/commandcode.js`：`/alpha/whoami` → `credits`/`subscriptions`；身份失败不静默改查默认组织；200 下 `success:false`/`UNAUTHORIZED` 按业务错误处理；窗口别名 `limit|cap`、`used`、`remaining`、`reset|resetAt`；分母不完整时百分比保持 null。
- 新增 `lib/quota-reference/commandcode-monthly.js`：公开规则读取（24h 缓存 + 5min 退避、4 MB 上限、无凭据、不执行下载脚本），月进度仅在「有效订阅 + 有效账期 + 有效规则」同时成立时输出，`basis: public-rule`。

## T06 OpenCode 修正 — done

- `lib/providers/opencode.js`：单位集中为 `MICRO_CENTS_PER_USD = 10_000_000`（唯一常量 + 唯一换算函数）；`UNIT_VERIFIED = false`，`raw.unit = microCents` 保留原始整数，USD 仅作带标注估算，**不设置 currency: USD**。
- 两方法（api-key 滚动窗口 / oauth allowance）完全隔离，一种失败不掩盖另一种。

## T07 DeepSeek／OpenRouter 保留 + Fireworks 新增 — done

- DeepSeek：余额多币种保留（非法币种/缺失金额报结构错误，不转零、不换汇）。
- OpenRouter：Key 额度与 UTC 今日费用共享一次 `/api/v1/key`（`sharedResponse`）；`openrouter-account` 独立 Management Key 走 `/api/v1/credits`。
- Fireworks：`lib/providers/fireworks.js` 月消费逐账户独立（`usage` 即消费，绝不 `value - usage` 当余额）、账户名严格校验、分页上限/去重/游标保护、分页未完成不发布部分汇总；控制台余额需 API Key 核对账户归属。

## T08 唯一调度器（方法／资源粒度） — done

- `lib/scheduler.js` 重写：任务键 `configInstanceId + providerId + methodId + resourceScope`；缓存身份含端点/凭据版本/范围/解析器版本；身份变化取消在途 + 清可见数据 + 版本 +1 丢弃迟到响应；429 尊重 Retry-After；显式无数据清除旧窗口；失败保留同身份旧值但不推进成功时间。
- 保留旧接口语义（`getState(providerId)` 聚合、并发 `run()` 返回同一 Promise），既有 5 个调度用例继续通过。
- 默认间隔：HTTP 窗口 60s、余额/月消费 300s、控制台 300s、公开规则 24h；HTTP 最多 4 在途，控制台串行。

## T09 生产控制台桥接 — done（代码完成；真实登录未验证）

- `lib/runtime/console-bridge.js`：`playwright-core` 惰性加载（生产依赖）、持久化上下文按「配置实例 + 平台」哈希目录（0o700，无路径穿越）、固定动作白名单 `status/login/complete-login/read/logout`、读取脚本只来自随包发布注册表（调用方传入的 script/nonce/url 一律忽略）、卸载关闭全部上下文。
- `lib/runtime/console-readers/`：三个平台的固定页面内读取器（DeepSeek 用量/费用、Fireworks Credits 唯一区域、OpenDesign Design Plan）。

## T10 / T11 平台控制台接入 — done（代码完成；真实会话未验证）

- OpenDesign：workspace 严格解析（单一 `workspaceId`，拒绝用户信息/端口/片段/额外参数）、`workspaces/current` 成员校验、`coding-plan-usage` 窗口解析（拒绝重复 policyId、非法时长、非正限额）；`eligible:false` → no-data（不是 0%）；不查钱包与估算接口。
- DeepSeek 控制台：用量与费用各自独立成功/失败；桶时间按秒→毫秒明确换算；桶越界报结构错误；时区由宿主生成并随范围展示。
- Fireworks 控制台余额：API Key 核对账户归属，指定账户不完全一致 → forbidden。

## T13 验证 — doing

- `npm test`：93/93 通过（含新增验证组 A）。
- 被排除厂商相关断言已改写为新需求；未删除任何仍有价值的测试。

## T12 UI／设置与 T14 打包 — todo（下一步）

## T12 UI、设置与最小诊断 — done

- `lib/client.js`：供应商配置页新增「查询方法」分组的真实布尔开关（配置键 `m_<归一化 methodId>`，与服务端 schema 一致）、控制台登录／注销按钮、登录状态与阻塞原因提示；新增中英文文案。
- 供应商列表、详情与设置页保持原有结构，只渲染服务端下发的 7 个 ID（客户端完全数据驱动，无需硬编码清单）。
- `/state` 新增 `scope.providerIds` 与 `console`（总开关 + 各控制台会话状态）；被排除路由改由 `excluded` 数组提示原因，不生成卡片。
- 设置接口拒绝写入非白名单供应商（400 + 原因）。

## T13 必要验证 — done（离线全绿；真实账户部分见下）

命令与结果：

| 命令 | 结果 |
| --- | --- |
| `npm test` | 93/93 通过（含新增验证组 A `test/provider-policy.mjs` 10 例） |
| `npm run test:browser` | 25/25 通过 |
| `npm run test:pack` | 通过（64 个文件，产物级禁止项与排除厂商校验通过） |
| `npm run test:desktop` | **blocked**：需要 Windows 安装版 `DeepSeek Harness.exe`，本机为 Linux |
| `npm run test:lifecycle` | **blocked**：同上（需 `--app` 指向安装版宿主） |

四组最小检查对照（方案第 10 节）：

- **A 范围与凭据**：通过。7 个 ID 白名单；旧 `enabled=true` 的被排除项在调度与注册表两层零调用零任务；自动探测不解析其凭据、补丁不含其字段；`/test`、`/settings` 绕过路径均被拦截；凭据不跨平台。
- **B 关键解析**：通过。Command Code 未知套餐／规则失效不产生虚假百分比、缺 resetAt 如实标注、静态套餐分母已删除；OpenCode 单位降级（`microCents` 原始单位，不伪装 USD）、单源失败不掩盖另一源；Fireworks 消费≠余额、分页失败不发布部分汇总；OpenDesign 非法 workspace 预先拒绝；DeepSeek 多币种与缺失字段不转零；DeepSeek／OpenRouter 正常样本回归通过。
- **C 迁移与生命周期**：通过。配置保存／重启／重复迁移、本地历史不丢、一个方法失败隔离、迟到响应丢弃、卸载取消浏览器与请求。
- **D 一次集成与产物**：部分完成。
  - 隔离宿主冒烟：把 `.tgz` 安装到独立目录后导入成功；schema 恰好 7 个供应商、无被排除项、方法开关为真实布尔、控制台方法默认关闭；控制台桥接探测到可用浏览器并拒绝未知读取器引用。
  - 真实账户只读对照（一次，使用 DSH 已配置的授权凭据，未打印密钥）：见下节。

### 真实账户只读对照结果

| 方法 | 状态 | 说明 |
| --- | --- | --- |
| `deepseek.balance.api-key` | **真实环境验证通过** | 返回账户余额（CNY），多币种结构正确 |
| `opencode.rolling-window.api-key` | **真实环境验证通过** | 返回 5h／周／月滚动窗口百分比与重置时刻 |
| `commandcode.windows.api-key` | **真实环境验证通过** | 返回 5h／周窗口（含 cap/used/resetAt） |
| `commandcode.monthly.public-rule` | **真实环境验证通过** | 官网公开规则读取成功并算出月度进度（basis=public-rule），账期结束作为重置 |

未具备条件（**已实现，未真实账户验证**，非失败）：

- `openrouter.*`、`openrouter-account`：本机未配置对应凭据。
- `fireworks.monthly-cost.api-key`：本机未配置 Fireworks API Key。
- `deepseek.console-*`、`fireworks.balance.console`、`opendesign.windows.console`：需要先在宿主机器完成控制台登录（用户主动操作），本轮未执行。

## T14 打包、文档与回滚 — done

- 新增 `docs/provider-upgrade-migration.md`（迁移与回滚说明、新增字段表、回滚安全警告）。
- README 的「支持的供应商」重写为 7 个 ID 表格 + 明确排除清单 + 方法与单位口径。
- `package.json`：`playwright-core@^1.63.0` 升为**生产依赖**（控制台取数在安装版需要它）；`files` 纳入迁移文档。
- `scripts/check-package.mjs`：新增模块逐个断言、生产依赖断言、产物禁止项（依赖目录／会话目录／凭据／HAR／usage.json／配置快照）与被排除厂商文件名校验。
- 版本：`2.1.0`（供应商范围收敛 + 方法级调度 + 控制台会话）。
- 本地产物：`.scratch/dist/dsh-token-quota-2.1.0.tgz`
  sha256 `f36f97e5a906d918324dc551a775a8a3774119cf6eeccf446b3230fa8db2fa56`（237398 字节，65 个文件）。
- `.scratch/` 已在 `.gitignore` 中，产物与隔离验证目录不进入版本库。

### 收尾复核（T13/T14 之后再做的一轮独立检查）

独立范围审计脚本确认：

- 白名单恰好 7 个、`Object.freeze` 生效（运行期 push 抛错）；
- 11 个被排除／未知名在注册表、方法矩阵、白名单三处均无痕迹；
- 7 个供应商共 **13 个方法全部接线**（此轮审计发现 DeepSeek 两个控制台方法原先只有矩阵条目、
  没有运行器，已补实现并新增回归用例，防止「空实现占位」再次出现）；
- 隔离安装版验收：schema 恰好 7 个供应商、13 个方法开关全为真实布尔、
  控制台与 DeepSeek 控制台方法默认关闭、桥接拒绝任意读取器引用。
