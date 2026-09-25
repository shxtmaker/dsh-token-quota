# DSH 0.1.7 适配报告（v1.4.0）

基线：v1.3.0（main，插件身份 `dsh-token-quota`）。
目标 harness：**@deepseek-ai/dsh 0.1.7-rc.2**（本机 `~/.npm-global` 全局安装版本，profile `web`）。
本文记录**实际观察到的破坏点、按新契约做的改动、以及在真实 harness 进程上的实测证据**；未执行项在「验证边界」里列明。

## 1. 破坏点（实测，不是推测）

0.1.7 之前插件装进 profile 后，harness 日志只有一行告警，插件整只不激活：

```
dsh: warning: 1 entry did not activate
dsh-token-quota (dsh-token-quota): TypeError: ctx.settings.register is not a function
    at new apply (.../node_modules/dsh-token-quota/lib/index.js:432:30)
```

逐项核对 0.1.7 的 settings / 客户端契约后，确认四处断裂：

| # | 旧契约（≤ 0.1.6） | 0.1.7 现状 | 后果 |
| --- | --- | --- | --- |
| 1 | `ctx.settings.register(ns, Config, { base })` 自注册命名空间，`scope.get()/watch()` 读写 | `settings` 服务改为 `SettingsForms`：只有 `describe()/update()/replace()/mutate()/configure()`，**没有 register** | `apply()` 抛 TypeError，插件整只不激活（连同路由、小组件、探测全没） |
| 2 | 配置随 `settings.yaml` 热重载整只重挂 | 一个 profile 行 = 一张表单；只有 schema 里标 **volatile** 的字段可写，写入由 loader 就地提交（`loader/volatile-update`），不重挂 | 不标 volatile → `update()` 报 `has no volatile fields`；用上游 schemastery 解析 → 拿不到交互引用，变更被静默吞掉 |
| 3 | `ctx.settings.get(ns)` 读 LLM 行（`llm-deepseek` / `llm-pi-ai`） | 无 `get`，只能 `describe()` 里按行 id 取 `value` | 自动探测读不到已添加供应商（`settings.get` 不存在时旧代码会静默降级为空） |
| 4 | 客户端 `settings.plugin.item` 卡片（设置页插件清单内） | 槽位已移除；设置页是 `settings.section` 列表（一页一项）+ `settings.plugins.tab` | 设置入口消失（注册未知槽位不会报错，是静默失效） |

## 2. 改动（宿主半）

- **`Config` 整棵标 volatile**：`lib/index.js` 用 `@deepseek-ai/schemastery`（0.1.7 的 fork，3.18.4；volatile 解析与 `.volatile()` 都在它里面）构造 schema，
  根节点 `.volatile()`。`apply(ctx, config)` 收到的就是 loader 维护的引用，读值统一走 `config.get()`（`runtime.config` 改成派生 getter）。
  实测效果：保存配置**不重挂插件**，扫描版本号、刷新历史、本地用量桶都不清零。
- **写入改 `ctx.settings.update(行 id, patch)`**：行 id = 本插件 `cordis.patch.yml` 插入的 `dsh-token-quota`；行被改名时按值形状认领。
  自身写入用 2s 窗口期在 `loader/volatile-update` 上认领，避免自我触发重扫（旧代码靠 `scope.watch` 的同步时序，0.1.7 不再成立）。
- **一次性旧配置迁移**（`lib/legacy-config.js` + `migrateLegacyConfig()`）：0.1.7 启动时把 `<DSH_HOME>/settings.yaml` 改名成
  `settings.yaml.imported` 再逐段写进行 config；本插件当时没激活，段就留在了那份文档里。现在本行还没有用户层时，
  读回 `dsh-token-quota` / `quota-monitor` 两段（嵌套字典 + 标量子集；结构不符整段丢弃），逐字段深合并后写进本行；
  **来源文件保留**。迁移定时器首发 250ms、失败重试 5 次（apply 期间本行尚未可描述），测试可用
  `globalThis.__DSH_MIGRATION_TIMING__` 压缩窗口。
- **探测改读 `describe()`**：`lib/detect.js` 的 `settingsValue(ctx, ns)` 从行视图取 `value`；适配器声明的 `settingsNs` 就是行 id。
- **清单**：`dsh.engines.dsh` → `>=0.1.7-rc.2`；运行时依赖换成 `@deepseek-ai/schemastery ^3.18.4`；`dsh.client.inject` 去掉
  `dsh-client-ui-settings-plugins`、补 `dsh-client-ui-slots`。

## 3. 改动（客户端半）

- `lib/client.js` 不再注册 `settings.plugin.item`，改注册 **`settings.section`** 列表项（`id: dsh-token-quota`、`order: 20`、
  `label` thunk 随 locale 重取）；面板本体抽成 `SettingsPanel`，设置页用 `variant="page"` 内联渲染（无遮罩/对话框语义），
  小组件里的「设置」入口继续用 `variant="dialog"` 弹层形态，两者共用同一份表单与保存路径。
- 侧边栏 `sidebar.footer.action`（list, keyed）契约未变，`wide` 属性仍在，小组件无需改动。

## 4. 真机实测（隔离实例，不碰现网 profile）

隔离实例：`DSH_HOME=/tmp/dsh-quota-verify`（profile 目录用符号链接复用现网 `node_modules`，仅 `dsh-token-quota` 指向本仓库源码），
overlay 把端口改到 3099；现网 3080 实例全程未重启、未改动。

| 检查项 | 命令/入口 | 实测结果 |
| --- | --- | --- |
| 插件是否激活 | 启动日志 | 无 `did not activate` 告警（对比第 1 节的旧版报错） |
| 状态路由 | `GET /api/dsh-token-quota/state` | `ok:true`；`poll:{intervalSeconds:60,…}`；`detect.llmPresent:true`；`deepseek/opencode` 的 `added:true`（探测正常） |
| 设置写入落行 config | `POST /settings {"intervalSeconds":45,…}` | 返回 `{"ok":true}`；`profiles/web/cordis.patch.yml` 的 `id: dsh-token-quota` 段出现 `intervalSeconds: 45`、`suppliers.deepseek.{enabled:true,apiKey:…}` |
| 热更新不重挂 | 写入前后 `state.scan.revision` | 均为 `{requested:2,completed:2}`（重挂会重置为 1）；自身写入被认领，未额外触发重扫 |
| 密钥不外泄 | `state` 载荷 | `keySet:true` 且载荷中检索不到写入的明文密钥 |
| 旧配置迁移 | 删掉行 config，写入 `settings.yaml.imported`（含 `quota-monitor` 与 `dsh-token-quota` 两段、引号内含冒号的密钥），重启 | 行 config 出现 `intervalSeconds: 121`（新段）+ `suppliers.deepseek.apiKey: sk-legacy-old`（旧段）+ `suppliers.opencode.apiKey: "sk-legacy:quoted"`；`/state` 读到 `intervalSeconds: 121`、opencode `enabled:true/keySet:true`，载荷无明文 |

## 5. 测试

| 命令 | 结果 |
| --- | --- |
| `npm test` | 62 项全绿（新增 `test/migration.mjs`、`test/legacy-config.mjs`；`test/harness.mjs` 提供 0.1.7 settings 契约替身） |
| `npm run test:browser` | 6 项全绿（设置页改为 `settings.section` 内联面板；焦点陷阱用例改从小组件「设置」入口验证弹层形态） |
| `npm run test:pack` | 42 个文件 / 162 KB，`lib/legacy-config.js` 已纳入必查清单 |

## 6. 验证边界（未执行或不适用）

- 未在 Windows / Node 24 上实跑（CI 覆盖，本机为 Ubuntu 26.04 + Node v22.23.2）。
- 未对**现网 profile**（3080）执行安装与重启：本会话即跑在该实例上，重启会打断会话；升级步骤见 README「升级与检查」。
- 未接真实计费账户；供应商查询仍为模拟响应。
- 未验证 0.1.7 之前版本（≤ 0.1.6）的回归：`engines` 已收紧到 `>=0.1.7-rc.2`，旧版不在支持范围内。
