# 数据面：桶、对象与桶设置

角色缩写：A=管理员，V=只读。权限位见 [security.md](security.md) 的 3.19。

## 5.1 桶

- 需求：分页列表（名称、别名、对象数、容量、配额使用率）、创建（可选全局别名）、删除（非空时提示）、别名增删（全局/本地）。
- 接口：`GET /api/buckets?offset&limit`（A/V）；`POST /api/buckets`（A）；`DELETE /api/buckets/{id}`（A）；`POST`/`DELETE /api/buckets/{id}/aliases`（A）。
- Garage：`ListBucketsInfo` 或 `ListBuckets` + `GetBucketInfo`、`CreateBucket`、`DeleteBucket`、`AddBucketAlias`、`RemoveBucketAlias`。

验收：仅本地别名的桶出现在列表中并可进入；删除非空桶时返回 Garage 的错误且界面提示。

## 5.2 对象浏览

- 需求：按 `/` 分隔的前缀导航与面包屑；分页（默认 100，上限 1000，续页令牌）；S3 列表只按 key 字典序返回、只支持前缀筛选，因此跨页顺序固定为 key 字典序，按大小、时间排序仅对当前已加载的页生效且界面明示「仅当前页」；前缀内子串搜索（至少 2 字符，最多返回 200 条，最多扫描 20 页）；安全预览；对象元数据与 `InspectObject` 诊断（A）。诊断页面本身在阶段 5，最小版不包含诊断入口。
- 接口：`GET /api/buckets/{id}/objects?prefix&limit&next`；`GET /api/buckets/{id}/objects/{key}`（元数据、view、download）；`GET /api/buckets/{id}/search?q&prefix`；`GET /api/buckets/{id}/inspect/{key}`（A）。
- Garage：S3 `ListObjectsV2`、`HeadObject`、`GetObject`；Admin `InspectObject`。

验收：5000 个对象可翻页浏览；搜索截断时返回原因字段；预览满足 [security.md](security.md) 的 3.3。

## 5.3 上传

- 需求：拖拽或选择多文件、文件夹上传（保留相对路径）；上传队列并发 3、可取消、可重试、显示进度；同名提示覆盖确认；大文件自动分片；单文件上限可配置。
- 接口：`PUT /api/buckets/{id}/objects/{key}`（A）；分片：POST 初始化、PUT 分片、POST 完成、DELETE 中止（A）。
- Garage：S3 `PutObject`、`CreateMultipartUpload`、`UploadPart`、`CompleteMultipartUpload`、`AbortMultipartUpload`。

验收：1 GB 文件上传时服务端常驻内存增长不超过 64 MB；取消后分片被中止。

## 5.4 删除

- 需求：单个删除、多选批量删除（单次最多 1000 个 key）、文件夹递归删除（见 [correctness.md](correctness.md) 的 4.3），均需确认对话框。
- 接口：`DELETE /api/buckets/{id}/objects/{key}[?recursive=true]`；`POST /api/buckets/{id}/objects:delete`（`keys[]`）（A）。
- Garage：S3 `DeleteObject`、`DeleteObjects`、`ListObjectsV2`。

验收：批量 1001 个 key 返回 400；部分失败逐条返回。

## 5.5 分享

最小版本不包含。权限见 [security.md](security.md) 的 3.10。

- 需求：生成预签名 GET 链接（1 小时、24 小时、7 天），桶开启网站访问时同时给出公开网站地址。
- 接口：`POST /api/buckets/{id}/share`（key、expires）（A 或拥有分享权限者）。
- Garage：S3 预签名（使用公共 S3 地址与区域）；网站地址由配置模板生成（模板必须包含 `{bucket}`）。

验收：生成的链接在有效期内可下载，过期后返回 403；审计中可见记录。

## 5.6 批量下载

最小版本不包含。

- 需求：多选对象或文件夹打包成 ZIP 流式下载。先换取一次性令牌（60 秒有效、只能用一次、绑定用户与桶），再下载。ZIP 内路径去掉公共前缀、清理路径穿越与盘符、重名加序号；单个对象失败时写入 ZIP 内的错误清单文件。
- 接口：`POST /api/buckets/{id}/archive-token`（A，或具备下载权限的 V）；`GET /api/buckets/{id}/archive?token=`（同上）。
- Garage：S3 `GetObject`。

验收：无下载权限的只读用户换取令牌返回 403；令牌第二次使用返回 404；其他用户使用返回 403；包含 `../` 的 key 在 ZIP 中被清理；1000 个对象打包时进程内存峰值增长不超过 64 MB。

## 5.14 清理未完成上传

最小版本不包含。

- 需求：在桶详情中列出未完成分片上传（key、uploadId、开始时间），可中止单个或全部；提供「清理早于 N 小时的未完成上传」。
- 接口：`GET /api/buckets/{id}/multipart`；`DELETE /api/buckets/{id}/multipart`；`POST /api/buckets/{id}/cleanup-uploads`（`olderThanSecs`）。
- Garage：S3 `ListMultipartUploads`、`AbortMultipartUpload`；Admin `CleanupIncompleteUploads`。

验收：清理后列表中不再出现超过阈值的条目，返回清理数量。

## 5.16 CORS 与生命周期

最小版本不包含。

- 需求：在桶设置中编辑 CORS 规则（ID、来源、方法、头、暴露头、缓存秒数）和生命周期规则（ID、启用状态、过期天数或过期日期二选一、前缀与对象大小上下限过滤、中止未完成上传天数）；表单校验；保存前展示差异。
- 说明：通过 Admin `UpdateBucket` 写入（与 S3 的同名接口作用于同一配置）；`corsRules`、`lifecycleRules` 为整组替换：不传表示不变，传空数组即清空。并发编辑时以保存前重新读取的版本做差异提示。
- 接口：`GET`/`PUT /api/buckets/{id}/cors`；`GET`/`PUT /api/buckets/{id}/lifecycle`。
- Garage：`GetBucketInfo`（`corsRules`、`lifecycleRules`）、`UpdateBucket`（`corsRules`、`lifecycleRules`），v2.3.0 起均可用。

验收：保存后 `GetBucketInfo` 返回一致；浏览器跨域预检符合配置。本项目自身的 `/api` 不开放跨域，见 [security.md](security.md) 的 3.6。

## 5.17 网站访问

- 需求：开关网站访问，设置索引文档与错误文档；开启时确认对话框提示数据将公开；按模板展示公开地址。
- 接口：`PUT /api/buckets/{id}/website`。
- Garage：`UpdateBucket.websiteAccess`（`enabled`、`indexDocument`、`errorDocument`；另有 `routingRules`，本轮只读显示，不提供编辑，保存时原样回传）。

验收：开启后公开地址可访问；关闭后返回 Garage 的拒绝响应。

[scope.md](scope.md) 的 8.1 没有把网站访问列入最小版必含项，8.2 的排除列表也没有点名 5.17。[roadmap.md](roadmap.md) 的阶段表没有单独估算行。本条需求与验收保留，不在拆解时改派到某个阶段。

## 5.18 配额

- 需求：设置或清除桶的最大容量（`maxSize`）与最大对象数（`maxObjects`），显示当前使用率。
- 接口：`PUT /api/buckets/{id}/quotas`。
- Garage：`UpdateBucket.quotas`。
- 说明：`UpdateBucket` 的 `quotas` 为整体替换：不传 `quotas` 表示不变；传入时 `maxSize`、`maxObjects` 两项都会被写入，置 null 即清除该项。前端修改一项时必须同时回传另一项的当前值。

验收：只改 `maxSize` 时 `maxObjects` 保持原值；两项都置 null 后配额被清除；容量单位换算无精度损失。

## 5.19 权限

- 需求：列出桶上的 key 与 read/write/owner 权限；授权、撤销（校验见 [correctness.md](correctness.md) 的 4.6；撤销后凭据缓存失效见 4.2）。
- 接口：`POST`/`DELETE /api/buckets/{id}/permissions`。
- Garage：`AllowBucketKey`、`DenyBucketKey`、`GetBucketInfo`。

验收：撤销后界面与 Garage 一致。

## 5.24 明确不支持的 S3 特性

以下特性 Garage 不支持（或仅返回固定值），本项目界面不提供入口，相关文档写明：

- 对象版本控制（`ListObjectVersions` 返回未实现；仅可读取版本控制状态，恒为未启用）。
- 对象锁、保留期锁定与法律保留。
- 桶策略与对象 ACL（权限一律通过 Garage key 授权）。
- 服务端加密配置（SSE-C 除外，本项目不做管理界面）。
- 桶复制、请求者付费、对象标签管理、存储类别切换、事件通知。

验收：界面无上述入口；文档「已知限制」章节列出。
