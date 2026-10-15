# 供应商查询迭代：迁移与回滚说明

适用范围：`dsh-token-quota` 供应商查询迭代（方案 2.0 范围收敛版）。
本文件不含密钥、Cookie、账户余额或完整本机路径。

## 1. 这一版改了什么

**查询范围收敛为 7 个 ID**：`deepseek`、`openrouter`、`openrouter-account`、`opencode`、
`commandcode`、`fireworks`、`opendesign`。

被排除厂商（OpenAI／ChatGPT／Codex、Anthropic／Claude、Moonshot／Kimi、Z.ai／智谱、
MiniMax 及一切未列入者）不再参与远程查询。拦截发生在**代码层**，不是隐藏卡片：
注册表、自动探测、凭据解析、轮询、手动刷新、`测试连接`、设置写入各环节都校验白名单。

**不受影响**：

- DSH 的模型调用路由、模型选择与凭据：完全不动。
- 被排除厂商的模型：照常可用于聊天和开发。
- 本地 Token 统计：`$DSH_HOME/dsh-token-quota/usage.json` 格式不变，历史小时桶保留，
  被排除厂商的历史用量继续按原机制记录（只影响远程查询，不影响本地观测）。

## 2. 配置迁移行为

升级后首次启动时：

1. 插件等本行配置可被描述后，读取旧 `settings.yaml`／`settings.yaml.imported` 中的
   `dsh-token-quota`／`quota-monitor` 段（与旧版本相同的一次性迁移）。
2. **写入前**先在插件私有数据目录原子保存一份回滚快照：
   `<DSH_HOME>/dsh-token-quota/config-rollback-<时间戳>.json`（权限 `0600`）。
   快照写入失败时**不继续**迁移，用户原配置保持不变。
3. 只把**白名单供应商**的已知字段写入本行配置，并做真实类型校验
   （`enabled` 必须是布尔，百分比必须是数字，字符串字段必须是字符串）。
4. **被排除供应商的旧条目不会被删除**，也不会被读取用于查询。它们继续留在原文档里作为
   惰性历史数据——因为宿主的 `settings.update` 是深合并，用白名单对象整体覆盖 `suppliers`
   会造成不可逆丢失。

迁移是幂等的：本行已有用户层就不再改写；重复启动不会反复迁移。

### 新增字段

| 字段 | 位置 | 默认 | 说明 |
| --- | --- | --- | --- |
| `consoleEnabled` | 全局 | `false` | 控制台取数总开关；关闭时不启动浏览器、不发控制台请求 |
| `m_<方法名>` | 每个供应商 | 按方法定义 | 方法级开关（真实布尔）。控制台方法默认 `false`，HTTP 方法默认 `true` |
| `workspaceId` | `opendesign` | `""` | 工作空间 ID 或控制台链接（只接受单一 `workspaceId` 参数） |
| `accountId` | `fireworks` | `""` | 可选；指定后只查询该账户 |
| `statisticsTimeZone` | `deepseek` | `""` | 可选；控制台「今日」范围的统计时区说明 |

**旧配置无需重填**：白名单供应商的 `enabled`、密钥、阈值、`baseUrl`、`autoSource` 保持原状态；
用户手动关闭的供应商不会被自动探测重新打开。

## 3. 升级步骤

```bash
# 1) 停止在用的插件实例（在 DSH 中卸载/停用该插件行，或退出 DSH）
# 2) 备份当前插件行配置（可选，插件自身也会写回滚快照）
cp "$DSH_HOME/profiles/<profile>/cordis.patch.yml" \
   "$DSH_HOME/profiles/<profile>/cordis.patch.yml.bak-$(date +%Y%m%d%H%M%S)"
# 3) 安装本地产物
npm install --no-audit --no-fund /path/to/dsh-token-quota-2.0.4.tgz
# 或按项目惯例以 link: 形式挂载本目录
# 4) 启动 DSH，打开「设置 → 用量监控」确认只出现 7 个供应商
```

## 4. 回滚步骤

```bash
# 1) 停止插件调度：卸载/停用插件行，取消在途请求并关闭专用浏览器上下文
# 2) 恢复上一个插件包
# 3) 如需恢复配置，从私有快照还原（快照只含插件段）
#    <DSH_HOME>/dsh-token-quota/config-rollback-<时间戳>.json
```

### 回滚前必读

**旧版本可能重新启用被排除厂商的查询。** 当前用户的范围要求是「只查 7 个 ID」，
因此回滚到旧包时，必须在恢复的旧配置里把被排除项设为禁用，并确认旧的自动填充路径
不会再次启用它们；无法确认时，保持旧插件停用，不要为了「完全还原」而静默恢复已被排除的网络查询。

回滚不会删除：

- 本地用量文件 `usage.json`（格式未变，新旧版本都读得懂）；
- 公开规则缓存与浏览器会话目录（独立目录，不影响其他软件 profile）。

## 5. 数据与安全边界

- 控制台会话目录位于插件私有目录（`<DSH_HOME>/dsh-token-quota/browser/`，权限 `0700`），
  按「配置实例 + 平台」哈希隔离；不读取系统浏览器个人资料。
- 配置回滚快照可能含密钥，只落在私有目录（`0600`），**不进入 Git、不进入交付包**。
- 交付包不含配置备份、Cookie、浏览器 profile、真实密钥、HAR 或账户截图
  （由 `npm run test:pack` 的产物级检查保证）。
- 控制台读取脚本随包发布；不接受前端传入任意 URL、JS、Cookie 或目录路径。
