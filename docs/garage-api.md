# Garage 版本与 Admin API

端点名与字段名以 Garage 源码中的 Admin API v2 定义为准。路径形式为 `/v2/<端点名>`。

## 2.1 版本

| 项 | 要求 |
|---|---|
| 最低支持 | Garage v2.3.0 |
| 推荐版本 | Garage v2.4.1（当前最新发布） |
| 不支持 | v2.2.x 及更早版本（含 v1.x、v0.x）；启动自检发现版本过低时拒绝连接并提示升级 |
| 前瞻 | main-v2 未发布的列表接口按能力探测使用（见 2.3） |
| 示例部署 | 文档与 compose 示例默认使用 v2.4.1 |

已从 Garage 源码核对的版本事实：

- v2.3.0 与 v2.4.1 的 Admin API 路径集合相同：`/v2` 下 46 个端点，另有 `/health`、`/check`、`/metrics`（`/check` 是静态网站域名校验，供反向代理签发证书前使用，不是连通性检查）。
- v2.3.0 已具备：`UpdateBucket` 的 `corsRules`、`lifecycleRules`、`websiteAccess`、`quotas`；`GetBucketInfo` 返回同名字段；`GetClusterStatistics`、`GetNodeStatistics`；`GetClusterHealth` 使用 `storageNodesUp`。这些功能按 v2.3.0 基线直接实现，不做版本分支。
- 仅 v2.4.x 才有（必须按字段探测，缺失时隐藏对应展示）：
  - `PreviewClusterLayoutChanges` 与 `ApplyClusterLayout` 响应中的结构化布局计算统计（`statistics`，含按节点、按 zone 的统计）；v2.3.0 下只显示 Garage 返回的文本信息。
  - `GetNodeInfo` 的 `addr`、`role`、`draining`、`isUp`、`metadataPartition`、`dataPartition` 字段。
- 仅 main-v2（未发布）：`ListBucketsInfo`、`ListKeysInfo`，以及 `ListBuckets` / `ListKeys` 的 `offset`、`limit` 参数；`GetNodeInfo` 的 `connectionParameters`。

验收：

- 对 v2.3.x 与 v2.4.1 两个版本跑集成测试，核心流程（登录、列桶、浏览、上传、删除、布局应用）全部通过。本地用容器运行这两个版本的 Garage 是允许的测试方式。
- v2.3.x 下布局预览页不报错，只显示文本信息；节点详情缺字段时显示「—」。

## 2.2 版本自检

- 启动时及每次重连 Garage 时调用 `GetNodeInfo`（`node=self`）读取 `garageVersion`，低于 v2.3.0 时在界面显示阻断提示，后端拒绝写操作。
- 能力探测结果缓存在进程内，Garage 重连后重新探测。

验收：对 v2.2.x 实例启动时出现明确提示，不出现前端异常。

## 2.3 main-v2 列表接口

- main-v2 中 `ListBuckets`、`ListKeys` 新增 `offset` 与 `limit`；未传 `limit` 时最多返回 10000 条。新增 `ListBucketsInfo`、`ListKeysInfo`，一次返回带详情的列表，默认上限 1000。
- 要求：
  1. 首次调用时探测 `ListBucketsInfo`、`ListKeysInfo` 是否可用；可用则用它替代「`ListBuckets` + 每桶 `GetBucketInfo`」。
  2. 不可用时（v2.3.x、v2.4.x）用 `ListBuckets` 加有界并发的详情调用（见 [correctness.md](correctness.md) 的 4.11），详情按页懒加载，不对全部桶一次性取详情。
  3. 本项目对外列表接口统一分页，前端分页或无限滚动，不一次性全量加载。
  4. 返回条数等于 `limit` 时必须继续翻页或提示「还有更多」，不得静默截断。

验收：模拟 12000 个桶的 Garage 响应，列表可翻到最后一条；两条路径都有测试。

## 2.4 端点清单

| 分类 | 端点 | 用途 |
|---|---|---|
| 集群 | `GetClusterHealth` | 首页健康卡片 |
| | `GetClusterStatus` | 节点列表 |
| | `GetClusterStatistics` | 集群容量与统计 |
| | `ConnectClusterNodes` | 连接节点 |
| 节点 | `GetNodeInfo` | 节点详情、版本自检（v2.4 字段探测） |
| | `GetNodeStatistics` | 节点统计 |
| | `CreateMetadataSnapshot` | 元数据快照 |
| | `LaunchRepairOperation` | 修复任务 |
| 布局 | `GetClusterLayout`、`GetClusterLayoutHistory` | 当前布局与历史 |
| | `UpdateClusterLayout`、`PreviewClusterLayoutChanges` | 暂存变更与预览（`statistics` 为 v2.4+） |
| | `ApplyClusterLayout`、`RevertClusterLayout` | 应用或撤销 |
| | `ClusterLayoutSkipDeadNodes` | 跳过死节点 |
| 管理令牌 | `ListAdminTokens`、`GetAdminTokenInfo`、`GetCurrentAdminTokenInfo` | 列表与详情、自检 |
| | `CreateAdminToken`、`UpdateAdminToken`、`DeleteAdminToken` | 管理（字段 `name`、`expiration`、`scope`） |
| 密钥 | `ListKeys`、`ListKeysInfo`（探测）、`GetKeyInfo` | 列表与详情 |
| | `CreateKey`、`ImportKey`、`UpdateKey`、`DeleteKey` | 管理（含 `allow.createBucket`、`expiration`） |
| 桶 | `ListBuckets`、`ListBucketsInfo`（探测）、`GetBucketInfo` | 列表与详情（按 id 查询） |
| | `CreateBucket`、`UpdateBucket`、`DeleteBucket` | 管理（`websiteAccess`、`quotas`、`corsRules`、`lifecycleRules`） |
| | `CleanupIncompleteUploads` | 清理未完成上传 |
| | `InspectObject` | 对象诊断 |
| 权限与别名 | `AllowBucketKey`、`DenyBucketKey` | 授权与撤销 |
| | `AddBucketAlias`、`RemoveBucketAlias` | 全局与本地别名 |
| Worker | `ListWorkers`、`GetWorkerInfo` | Worker 列表与详情 |
| | `GetWorkerVariable`、`SetWorkerVariable` | Worker 变量 |
| 块 | `ListBlockErrors`、`GetBlockInfo` | 块错误 |
| | `RetryBlockResync`、`PurgeBlocks` | 重试与清除 |
| 特殊 | `/metrics` | Prometheus 指标（需 `metrics_token`） |
| | `/health` | 连通性与读写法定数检查（无需令牌；集群可读写时返回成功） |

不使用：`CheckDomain`（由 Garage 网站服务自用）。

白名单必须覆盖本表全部端点、能力探测用的 `ListBucketsInfo` 与 `ListKeysInfo`，以及 `/metrics`。规则见 [security.md](security.md) 的 3.7。
