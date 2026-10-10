# 集群、布局与运维

角色缩写：A=管理员，V=只读。运维页面只对管理员开放，见 [security.md](security.md) 的 3.19。

## 5.8 布局

最小版不包含布局编辑与变更流程（5.28，见 [scope.md](scope.md) 的 8.2）。本条的预览、历史、跳过死节点在阶段 4。

- 需求：节点角色分配与修改（zone、capacity、tags；capacity 为空即网关节点）、移除；布局参数 `zoneRedundancy`（`"maximum"` 或至少 N 个 zone）的查看与修改；暂存变更列表（来自 `GetClusterLayout` 的 `stagedRoleChanges` 与 `stagedParameters`）；应用前必须先调用预览并展示预览结果（v2.4+ 展示结构化统计，v2.3 展示文本）；预览返回错误分支时显示错误并禁止应用；应用（version = 当前 + 1）或撤销全部暂存变更；布局历史；跳过死节点（A，强确认，说明风险；需传入当前版本号，并单独选择是否 `allowMissingData`，选中时再加一次强确认，说明可能丢失数据）。
- 接口：`GET /api/layout`；`POST /api/layout/stage`；`POST /api/layout/preview`；`POST /api/layout/apply`；`POST /api/layout/revert`；`GET /api/layout/history`；`POST /api/layout/skip-dead-nodes`。
- Garage：`GetClusterLayout`、`UpdateClusterLayout`、`PreviewClusterLayoutChanges`、`ApplyClusterLayout`、`RevertClusterLayout`、`GetClusterLayoutHistory`、`ClusterLayoutSkipDeadNodes`。

验收：未执行预览或预览返回错误时「应用」按钮不可用；容量精度满足 [correctness.md](correctness.md) 的 4.4；历史页显示各版本与同步状态。

## 5.9 集群健康

- 需求：首页卡片显示状态、已知节点数、已连接节点数、存储节点数与在线数（`storageNodesUp`）、分区状态；节点列表与连接节点。
- 接口：`GET /api/cluster/health`；`GET /api/cluster/status`；`POST /api/cluster/connect`（A）。
- Garage：`GetClusterHealth`、`GetClusterStatus`、`GetNodeInfo`、`ConnectClusterNodes`。

验收：v2.3.x 与 v2.4.1 下数字均正确；Garage 不可达时显示错误而非白屏。

## 5.10 统计指标

- 需求：集群与节点统计（容量、可用空间、桶数、对象数、总量）；可选的 Prometheus 指标汇总（S3 请求数、错误数、块读写字节）。说明：Garage 的 `/metrics` 在配置了 `metrics_token`（或要求令牌）时，接受 `metrics_token` 或作用域包含 `Metrics`（或 `*`）的管理令牌；两者都未配置时无需令牌。本项目按此顺序取用：单独配置的 `metrics_token`、本项目管理令牌；都不可用时指标面板显示提示。
- 接口：`GET /api/cluster/statistics`；`GET /api/nodes/{id}/statistics`；`GET /api/metrics`。
- Garage：`GetClusterStatistics`、`GetNodeStatistics`、`/metrics`。

验收：Prometheus 文本解析单测；空响应各项为 0。

最小版交付健康、状态、集群统计，不含指标面板。`GET /api/metrics` 与 Prometheus 解析留到阶段 4。

## 5.11 Worker 与修复任务

阶段 5，不在最小版本内。

- 需求：按节点（单个节点 ID 或全部节点）列出 Worker（状态、错误、进度），可只看忙碌或只看出错的；查看详情；读取全部或单个 Worker 变量，设置变量（变量名与值均为字符串，A）；发起修复任务（A，强确认，目标为单个节点或全部节点），类型取自 Garage 定义：`tables`、`blocks`、`versions`、`multipartUploads`、`blockRefs`、`blockRc`、`rebalance`、`aliases`、`clearResyncQueue`，以及 `scrub` 的 `start`、`pause`、`resume`、`cancel`。
- 接口：`GET /api/nodes/{id}/workers`；`GET /api/nodes/{id}/workers/{wid}`；`GET`/`PUT /api/nodes/{id}/worker-variables`；`POST /api/nodes/{id}/repair`。
- Garage：`ListWorkers`、`GetWorkerInfo`、`GetWorkerVariable`、`SetWorkerVariable`、`LaunchRepairOperation`。

验收：设置变量后再次读取为新值；修复任务写审计。

## 5.12 块错误

阶段 5，不在最小版本内。

- 需求：按节点列出块错误；按块哈希查看块信息（需指定节点）；重试同步（指定块哈希，或「全部重试」）；清除块（A，强确认，说明会导致对象数据丢失；一次可提交多个块哈希）。
- 接口：`GET /api/nodes/{id}/block-errors`；`GET /api/nodes/{id}/blocks/{hash}`；`POST /api/nodes/{id}/blocks/retry`；`POST /api/nodes/{id}/blocks/purge`。
- Garage：`ListBlockErrors`、`GetBlockInfo`、`RetryBlockResync`、`PurgeBlocks`。

验收：只读角色调用清除返回 403；清除需要输入块哈希确认。

## 5.13 元数据快照

阶段 5，不在最小版本内。

- 需求：对指定节点或全部节点创建元数据快照（A）。
- 接口：`POST /api/nodes/{id}/metadata-snapshot`。
- Garage：`CreateMetadataSnapshot`。

验收：操作成功提示并写审计。

## 5.28 布局变更流程

依赖 5.8，不在最小版本内。接入工作含在阶段 4 与阶段 3A 的估算中。

- 需求：布局页面按步骤引导：
  1. 查看当前布局（节点、zone、容量、标签、角色）与「暂存变更」列表；
  2. 编辑：分配、修改、移除节点角色，变更进入暂存区，可逐条撤回；
  3. 预览：调用预览接口，展示新布局与数据迁移结果（v2.4+ 用结构化统计做表格，v2.3 显示文本）；
  4. 应用：高风险确认，自动填入当前版本 + 1；
  5. 跟踪：应用后显示进度跟踪（各节点同步到新版本的状态，参照布局历史），直至全部完成；有节点长时间离线时提供「跳过死节点」入口并说明风险。
- 任何时候可「撤销全部暂存变更」。

验收：未预览不可应用；应用后跟踪视图在全部节点同步后显示完成；撤销后暂存区为空。

## 5.29 概览页与容量可视化

最小版只做健康与统计卡片。排行、自动刷新和审计小部件随后续阶段接入。

- 需求：概览页包含健康卡片、集群容量（已用/可用，按节点分布）、桶数量与对象总数、按桶容量排行（前 N 个，其余合并为「其他」，桶多或很小时仍可读）、最近的审计事件（管理员；[features-access.md](features-access.md) 的 5.21 查询接口交付后启用）。
- 按桶容量排行与按容量排序依赖每个桶的详情：能力探测到 `ListBucketsInfo` 时直接使用；否则由后台任务以有界并发（[correctness.md](correctness.md) 的 4.11）定期汇总（默认 10 分钟，可配置）并缓存，界面标注数据时间，不随 30 秒刷新触发全量请求。
- 桶列表与详情显示配额使用率进度条（容量和对象数），达到 80% 和 95% 时分别以警告色和错误色标出。
- 数据自动刷新（默认 30 秒，可暂停），页面不可见时停止刷新。

验收：1000 个桶时排行图仍可读；配额阈值着色有组件测试；切到后台标签页后不再发请求。
