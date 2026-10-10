# 身份、密钥、令牌与审计

角色缩写：A=管理员，V=只读。

## 5.7 密钥

- 需求：分页列表、创建（新建时名称限字母数字 `_` `-`；导入或已有密钥的名称原样显示，不做校验）、导入、改名、设置过期时间或设为永不过期（`neverExpires`）、允许建桶（`allow.createBucket`）开关、删除、查看 secret（A，二次确认，审计）。
- 接口：`GET`/`POST /api/keys`；`GET`/`PATCH`/`DELETE /api/keys/{id}`；`POST /api/keys/import`；`POST /api/keys/{id}/secret`（A）。
- Garage：`ListKeysInfo` 或 `ListKeys`、`GetKeyInfo`、`CreateKey`、`ImportKey`、`UpdateKey`（`name`、`expiration`、`allow.createBucket`、`deny.createBucket`）、`DeleteKey`。

验收：开启允许建桶后，该 key 可通过 S3 创建桶；删除 key 后浏览凭据缓存失效（见 [correctness.md](correctness.md) 的 4.2）。

最小版的密钥范围以 [scope.md](scope.md) 的 8.1 为准：分页列表、创建、删除、改名、允许建桶、查看 secret。阶段 2B 的估算行还写了导入和过期时间；8.1 写明最小版范围按该表定稿。验收最小版时以 8.1 这几项为准。

## 5.15 受限管理令牌

不在最小版本内。

- 需求：列出、创建、修改、删除 Garage 管理令牌（`name`、`expiration`、`scope`）；创建时 secret 只显示一次；对 scope 包含 `CreateAdminToken` 或 `*` 的令牌明确警示其等同全权；显示本项目当前所用令牌的信息。scope 取值为 Admin API 端点名、`Metrics` 或 `*`。`ListAdminTokens` 会把配置文件中的 `admin_token`、`metrics_token` 作为只读条目列出：界面标注「来自配置文件」，不提供修改和删除。
- 接口：`GET`/`POST /api/admin-tokens`；`GET`/`PATCH`/`DELETE /api/admin-tokens/{id}`；`GET /api/admin-tokens/current`。
- Garage：`ListAdminTokens`、`GetAdminTokenInfo`、`CreateAdminToken`、`UpdateAdminToken`、`DeleteAdminToken`、`GetCurrentAdminTokenInfo`。

验收：仅管理员可见；令牌 secret 不出现在后续任何响应与日志中。

## 5.20 多用户与角色

- 需求：SQLite 用户库；初始化向导；角色 `admin`、`viewer`，另加可分配给 viewer 的「下载对象内容」和「分享」权限（数据模型与约束见 [security.md](security.md) 的 3.19）；用户增删改、禁用、改名、重置密码；防锁死（不能删除、降级、禁用自己，不能移除最后一个启用的管理员）；离线 CLI（列出用户、重置密码、创建管理员、版本、健康检查）；首次启动可一次性导入环境变量中的 bcrypt 账号。
- 接口：`GET`/`POST /api/users`；`PATCH`/`DELETE /api/users/{id}`；`POST /api/users/{id}/reset-password`；`POST /api/auth/login|logout|change-password`；`GET /api/auth/status`；`GET`/`POST /api/setup`。
- Garage：无。

验收：权限位的授予、撤销与「分享依赖下载」约束有测试；防锁死规则逐条测试；用户响应永不含哈希；角色变更立即生效（3.4）。

最小版包含 8.1 的账户项，以及阶段 2B 的用户增删、禁用、改角色、重置密码与防锁死。离线 CLI 在阶段 6。已登录管理员调用 `POST /api/users/{id}/reset-password` 属于上述用户管理，与 3.18 的离线 CLI 是两条路径。

## 5.21 审计日志

- 需求：所有写操作（含被拒绝的）、登录相关事件、查看 secret、生成分享链接写入审计表，字段：时间、用户、IP、方法、路径、目标资源（桶 ID、key、节点 ID 等）、结果状态码、原因；同时可选输出到标准输出（JSON 行）；界面提供筛选（用户、时间段、操作类型）和导出 CSV；保留期可配置（默认 90 天）。
- 接口：`GET /api/audit?user&from&to&action&offset&limit`（A）；`GET /api/audit/export`（A）。
- Garage：无。

验收：每类事件均有一条集成测试断言审计记录；超过保留期的记录被定期清理。

最小版包含审计写入（登录相关见 3.13，写操作与查看 secret 写入审计表）。审计页面、筛选、导出和保留期清理界面在阶段 5。最小版仍须把记录写入表，并满足「失败登录后审计表有一条带 IP 的记录」。

## 5.23 设置与关于

- 需求：修改自己的密码、主题切换、显示版本；更新检查默认关闭且源可配置（[correctness.md](correctness.md) 的 4.14）。

验收：未开启更新检查时无对外请求。

## 5.31 凭据显示与复制

- 需求：新建密钥或管理令牌后，在结果对话框中一次性显示完整凭据，提供一键复制（复制成功有视觉反馈）与「我已保存」确认；关闭后不可再次查看（管理令牌）或需再次走二次确认（S3 secret）。
- 凭据字段默认遮挡，显示时需主动点击；复制功能在非安全上下文下降级为可选中文本。
- 与 3.15 的关系：3.15 约束的是本项目自身连接 Garage 所用的令牌，它永不进入浏览器。用户在界面上新建的管理令牌或 S3 secret 是要交给使用者的结果，只允许出现在创建（或二次确认后查看）的那一次响应中，该响应设置 `no-store`，不写日志与审计内容。

验收：关闭对话框后响应与页面中不再出现管理令牌 secret；复制按钮有组件测试。

最小版包含本条里新建密钥和查看 S3 secret 的行为。管理令牌的一次性显示随 5.15 交付。

## 5.34 管理令牌作用域选择器

依赖 5.15，不在最小版本内。

- 需求：创建或编辑管理令牌时，按功能分组（集群、节点、布局、桶、密钥、权限、Worker、块、管理令牌）列出 Admin API 端点复选框，支持整组勾选；勾选「全部」或包含创建管理令牌权限时显示等同全权的醒目警示；可设置到期时间（含「永不过期」需额外确认）。

验收：分组覆盖 Garage v2.4.1 的全部 46 个端点以及 `Metrics`（有测试对照 OpenAPI 文件）；全权组合出现警示。
