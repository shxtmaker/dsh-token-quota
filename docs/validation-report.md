# 验证报告

## v2.1.0 供应商查询迭代（范围收敛版）

本轮验证记录见 [供应商迭代执行记录](provider-upgrade-progress.md) 与
[迁移与回滚说明](provider-upgrade-migration.md)。要点摘录：

| 项目 | 值 |
| --- | --- |
| 操作系统 | Ubuntu 26.04.1 LTS（Linux 7.0.0-38-generic，x86_64） |
| Node.js / npm | v26.10.0 / 11.19.1 |
| 数据目录 | 测试使用独立 `mkdtemp` 临时 `DSH_HOME`，不读写真实 `~/.dsh` |

| 命令 | 结果 |
| --- | --- |
| `npm test` | 95 个顶层测试项，95 通过、0 失败 |
| `npm run test:browser` | 25 个 Chromium 测试全部通过 |
| `npm run test:pack` | 通过：65 个文件、237,398 字节 |
| `npm run test:desktop` | **未执行**：需要 Windows 安装版宿主，本机为 Linux |
| `npm run test:lifecycle` | **未执行**：同上（需 `--app` 指向安装版宿主） |

真实账户只读对照（一次，使用 DSH 已配置的授权凭据，未打印密钥）：

| 方法 | 结果 |
| --- | --- |
| `deepseek.balance.api-key` | 通过：返回账户多币种余额 |
| `opencode.rolling-window.api-key` | 通过：返回 5h／周／月窗口百分比与重置时刻 |
| `commandcode.windows.api-key` | 通过：返回 5h／周窗口（cap/used/resetAt） |
| `commandcode.monthly.public-rule` | 通过：官网公开规则读取成功并算出月度进度（`basis=public-rule`） |

未接真实账户的方法（OpenRouter 全部、Fireworks 月消费、四个控制台方法）状态为
「已实现，未真实账户验证」——本机未配置对应凭据或未在宿主机器完成控制台登录。

基准数值（`node scripts/benchmark-storage.mjs`，7 = 当前查询白名单规模）：

```text
保存  7 供应商 /  7 天：  32012 B  p50 1.248 ms  p95 1.610 ms
保存  7 供应商 / 90 天： 408500 B  p50 18.680 ms p95 22.629 ms
今日统计（2160 桶）：24 键 1.95 µs/次 vs 旧式遍历 227.35 µs/次（116.5×）
```

以上为本机合成负载，不代表真实 DSH 服务器或真实会话性能。

---

# 局部重构验证报告（R1–R6）

后续 v2.0.4 重置时间修复的验证记录见 [重置时间修复执行记录](reset-time-fix-execution.md)。

后续 v2.0.3 侧栏用量浮卡的验证记录见 [侧栏用量浮卡执行记录](usage-popover-execution.md)。下文保留 R1–R6 当时的环境与结果，不作为当前版本的实测数值。

实施基线：`9f63a1788557424dd8ace561a3346ee41a6099c2`（v1.2.2，main）。
技术方案：`docs/refactoring-plan.md`（原文归档，R1–R6 批次；sha256 `e812d05d…b17b17b`）。本报告记录**实际执行过的命令与实测数值**，未执行项在「验证边界」中明确列出。

## 1. 环境

| 项目 | 值 |
| --- | --- |
| 操作系统 | Ubuntu 26.04 LTS（Linux 7.0.0-30-generic，x86_64） |
| Node.js | v22.23.2（方案提到的 Windows / Node 24.19.0 环境未在本机复现） |
| npm | 10.9.8 |
| 浏览器 | Chromium（Playwright，`npx playwright install chromium`） |
| 存储介质 | 普通磁盘（虚拟化环境，未做介质类型区分） |
| 数据目录 | 每次测试使用独立 `mkdtemp` 临时 `DSH_HOME`，不读写真实 `~/.dsh` |

## 2. 必跑验证

| 命令 | 结果 |
| --- | --- |
| `npm test` | 57 个顶层测试项，57 通过、0 失败（基线为 33 项） |
| `npm run test:browser` | 6 个 Chromium 测试全部通过（基线 2 个） |
| `npm run test:pack` | 通过：39 个文件、152,007 字节；`lib/scan-coordinator.js` 等运行时模块已在必需文件断言内 |
| `for f in lib/*.js; do node --check $f; done` | 全部通过 |
| `git diff --check` | 无空白错误 |
| GitHub Actions `Verify`（ubuntu + windows） | 本版本提交上两个平台均成功（tag `v1.3.0` = `ba2ee3d`） |

新增/扩展的测试覆盖：

| 文件 | 覆盖的验收项 |
| --- | --- |
| `test/storage.mjs` | C4 迁移成功/幂等/新旧并存/目标空目录/EXDEV/EPERM/恢复重试；C1 当日 24 键、跨日、非法键、90 天历史、双时区进程 |
| `test/usage.mjs` | C2 相同样本不计变更、最终数量/供应商/跨午夜替换、未标识事件不去重、无效输入不污染 |
| `test/usage-saves.mjs` | C2 集成：首个样本保存一次、相同样本重复 300 次零写盘、新 step 与保留期变化仍保存 |
| `test/client-lifecycle.mjs` | A1：慢请求三轮都发布、并发上限 1、30s 取消+退避、A/B 切页迟到响应、隐藏/恢复、卸载释放、手动刷新 >10s、重复点击合并 |
| `test/client.mjs` | A3：默认阈值与 50/70 下 49/50/60/70 的详情卡色调与状态药丸一致；null/NaN/undefined 不折成正常 |
| `test/scan-coordinator.mjs` | B1/B2/B3：周期复用、版本门禁、手动重扫等待与超时失败、失败保留发现、有界追赶、卸载释放、自身写入识别、设置写入串行 |
| `test/browser/edit-identity.spec.mjs` | A2/A3：保存中切换编辑器不清除新草稿、保存失败保留草稿并重开以服务端为准、旧测试结果不回写、阈值在详情与预览一致 |
| `test/provider-contracts.mjs` | C3：每个官方供应商的主机/基础路径集合一致，非法地址一律拒绝且零网络调用 |
| `test/mock-dsh.mjs` | B1：rescan 返回的 `scan.completed === scan.requested`；B3：用户手填密钥不被自动填入覆盖 |

## 3. 存储基准（`scripts/benchmark-storage.mjs`，默认档）

本机合成负载：每个供应商每桶 10,000 tokens，每档 10 次完整同步 `flush()`。

| 供应商 | 历史 | 文件字节 | 保存 p50 | 保存 p95 | 保存 max |
| --- | --- | --- | --- | --- | --- |
| 1 | 7 天 | 4,640 | 0.654 ms | 1.209 ms | 1.209 ms |
| 1 | 90 天 | 58,424 | 3.752 ms | 4.485 ms | 4.485 ms |
| 13 | 7 天 | 59,387 | 2.788 ms | 3.151 ms | 3.151 ms |
| 13 | 90 天 | 758,579 | 38.495 ms | 42.048 ms | 42.048 ms |

今日统计读取成本（每供应商一次求和）：

| 桶数 | 24 键口径 | 旧式遍历口径 | 倍率 |
| --- | --- | --- | --- |
| 168（7 天） | 2.5 µs | 18.5 µs | 7.4× |
| 2160（90 天） | 2.6 µs | 281.0 µs | 109.8× |

结论与门槛对照：

- C1 的算法工作量由「随历史长度增长」变为常数（最多 24 次键查询），实测与历史长度基本无关。
- 90 天 / 13 供应商的完整同步保存 p50 为 38.5 ms，**超过方案 6.2 中「同步段 p95 持续超过 20 ms」的建议门槛**；但该组数据是「每轮都改动桶并强制落盘」的最坏合成负载，且本机为虚拟化磁盘。按方案要求，异步持久化专项需在**真实宿主**确认该耗时与状态响应/事件循环尖峰相关后再启动，本轮不启动。运行时基准显示同一环境下 `/state` p50 < 0.5 ms、事件循环 p95 < 2 ms，未见与该耗时相关的可感知停顿。

## 4. 运行时基准（`scripts/benchmark-runtime.mjs`，默认矩阵）

真实插件装配 + 固定供应商响应（不访问真实计费账户），每用例预热 1s、采样 2s，1 个供应商、90 天保留期。

| 客户端 | 事件速率 | /state p50 | /state p95 | /state p99 | 事件循环 p95 | 查询并发峰 | 用量文件重写 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0/s | 0.497 ms | 0.660 ms | 0.784 ms | 1.494 ms | 1 | 0 |
| 1 | 100/s | 0.375 ms | 0.582 ms | 0.672 ms | 1.324 ms | 1 | 0 |
| 5 | 100/s | 0.443 ms | 0.567 ms | 0.655 ms | 1.213 ms | 1 | 0 |
| 20 | 100/s | 0.416 ms | 0.525 ms | 0.570 ms | 1.494 ms | 1 | 0 |

- 生命周期：5 轮挂载/卸载后活动句柄 0 → 3，RSS 78.9 → 87.3 MB。句柄数不随轮次线性增长，RSS 增长符合 V8 堆未及时回收的常态，**不据此判定泄漏**。
- 「空闲且配置未变时保存次数为 0」在本矩阵中成立（`用量文件重写 0`：采样窗口内文件字节数未变化，即无写盘）。
- 同一环境、同一负载的**改动前对照**未执行（需检出基线提交后重跑）；因此这里只报告改动后数值，不宣称相对提升幅度。

## 5. 需求追踪对照

| 审查发现 | 实现 | 权威证据 | 状态 |
| --- | --- | --- | --- |
| 慢轮询持续丢弃结果、请求积累 | A1 | `test/client-lifecycle.mjs`：三轮 15s 慢 GET 都发布、并发上限 1、30s 取消 + 退避 | 通过 |
| 旧保存清除新草稿 | A2 | `edit-identity.spec.mjs`：A 保存中切换 B，B 草稿与页面不受影响 | 通过 |
| 自定义阈值显示不一致 | A3 | `test/client.mjs` + `edit-identity.spec.mjs`：49/50/60/70 在详情与预览同判定 | 通过 |
| 首次自动填入旧来源 | B1/B2 | `test/scan-coordinator.mjs`：来源变化作废旧候选；`test/mock-dsh.mjs`：手填密钥不被覆盖 | 通过 |
| 手动重扫返回点击前结果 | B1 | `test/scan-coordinator.mjs`：目标版本严格大于完成版本，超时返回「稍后重试」 | 通过 |
| 历史来源被算作当前接入 | B3 | `test/scan-coordinator.mjs`：失败保留发现、成功空扫描移除、`autoDetected` 表示当前发现 | 通过 |
| 今日统计随历史长度增长 | C1 | `test/storage.mjs` + 存储基准（最多 24 键、约 110×） | 通过 |
| 相同样本重复写入 | C2 | `test/usage.mjs` + `test/usage-saves.mjs`（300 次重复零写盘） | 通过 |
| 官方地址策略重复维护 | C3 | `test/provider-contracts.mjs`：集合一致 + 拒绝样本零网络调用 | 通过 |
| Windows 目录迁移失败 | C4 | `test/storage.mjs`：目标不存在才 rename、空目标目录回落、EXDEV/EPERM 回落、恢复重试 | 通过（Linux 模拟） |
| 重构是否降低真实资源开销 | 第 6 节 | 存储/运行时基准数值（缺改动前对照） | 部分 |

## 6. 验证边界（未执行或不适用）

- **未在本机 Windows 上运行**：Windows 的「目标目录已存在时 rename 失败」语义以 `syncBuiltinESMExports` 注入 `EPERM`/`EXDEV` 覆盖，并在真实临时目录上验证回落读与恢复重试。
  **远端 CI 已在真实 Windows 上验证通过**：`.github/workflows/verify.yml`（`ubuntu-latest` + `windows-latest`）在本版本提交上全部成功。
  该矩阵同时也是 C4 的实证：同一套 `test/storage.mjs` 在基线提交 `9f63a178` 上 `windows-latest` 失败（`AssertionError: 应返回新目录路径`，即「预先创建目标目录再 rename」在 Windows 必然失败），修复后通过。
- **未接入真实 DSH 实例**：未做安装加载、官方槽位、两会话切换、超时与设置保存失败的真机验收；真实宿主接入不代表真实计费接口已验证。
- **未访问真实供应商账户**：全部查询使用替身响应。
- **未做改动前/后同环境对照基准**：需要检出基线提交重跑同一脚本；本报告只给改动后实测值。
- **未覆盖方案第 6 节的异步持久化专项**：按门槛未启动（见 §3 结论）。
- **本轮不涉及发布**：未执行 `npm publish`、未推送远端、未在生产环境安装。
