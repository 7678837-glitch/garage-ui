# 非功能与工程要求

技术栈以 [decisions.md](decisions.md) 为准。本章把原稿第 6、7 章改写成 Rust 与 Bun 下的同等门禁。功能与安全验收不因换工具链而放宽。

## 6.1 性能

- 首页首屏（健康 + 统计）在本地网络下 1 秒内返回。
- 1 万个桶的列表首页 2 秒内出现（分页）。
- 对象列表单页 1000 条渲染使用虚拟滚动。
- 前端主包（gzip 后）不超过 300 KB，路由级按需加载。

## 6.2 大文件流式处理

- 下载、预览、ZIP 打包全部流式转发，不整体读入内存。
- 上传流式写入 S3，超过阈值（默认 64 MB）自动分片；分片大小默认 16 MB，单个上传同时在途分片数默认 2，全进程上传缓冲总量设硬上限（默认 64 MB，超出时排队），保证「分片大小 × 在途分片数 × 并发上传数」不超过该上限。
- 缩略图：只对白名单位图类型生成；源对象大于可配置上限（默认 20 MB）或像素数超过上限（默认 4000 万）时不生成，直接显示图标；解码前先读取图像头校验尺寸，防止解压炸弹；生成结果按对象 ETag 做有界缓存（LRU，可配置总大小）；同时解码的缩略图任务数有上限（默认 2），超出排队，单个任务内存超过预算即放弃并显示图标。

验收：上传上限配置为不小于 6 GB 时，服务端在 256 MB 内存限制的容器中可完成 5 GB 上传与下载；对 100 张大图浏览缩略图而不被 OOM。

## 6.3 超时与取消

- Garage Admin 客户端：连接超时 5 秒、总超时 30 秒（可配置）。
- S3 调用使用请求上下文，客户端断开即取消对 S3 的请求；长时操作（大文件、ZIP）不设总超时，只设空闲超时。
- 服务端设置读头超时、空闲超时，优雅关停（等待在途请求，默认 30 秒）。

验收：浏览器取消下载后，服务端对 S3 的请求在 1 秒内被取消（日志可见）。

## 6.4 错误处理

- 统一错误结构：`code`（稳定的机器可读码）、`message`（可读文案）、`garageStatus`（如有）。
- 保留真实状态码（[correctness.md](correctness.md) 的 4.8）；Garage 不可达返回 502，超时返回 504。
- 前端统一错误提示，401 跳登录，403 显示无权限，不吞错误。
- 前端遇到过期的分包加载失败时自动刷新一次（带冷却时间）。

## 6.5 可观测性

- 结构化日志（JSON），带请求 ID；日志级别可配置；不记录敏感信息。只输出 stdout/stderr。
- 本项目自身 `/metrics`（受鉴权或独立令牌保护）：请求数、延迟直方图、Garage 调用错误数、在途上传数。
- `/healthz`（存活）与 `/readyz`（就绪：数据库可用、Garage 可达）。
- 二进制提供 `-health` 子命令供容器健康检查使用。

## 6.6 测试数据生成

- 提供开发用的数据生成命令，实现为不打进运行镜像的 Rust 程序。可在测试集群中批量创建桶、密钥与大量对象（可设数量、前缀深度、对象大小分布、断点续跑），用于验证 1 万桶、10 万对象下的分页与性能。
- 被测 Garage 可以用本地容器运行。

验收：CI 的性能冒烟测试使用该命令生成数据。

## 6.7 i18n（可选，P2）

- 文案集中管理，默认英文，提供简体中文；日期、容量单位本地化。

验收：切换语言后无未翻译键（测试检查键集合一致）。

## 7.1 技术栈

- 后端：Rust 1.99.0。单个二进制内嵌前端。HTTP、SQLite、S3、Admin 客户端及其他 crate 见 [decisions.md](decisions.md) 的「运行时技术栈」。
- S3：官方 `aws-sdk-s3`。使用该 SDK 当前推荐的端点配置。运行时是 tokio 多线程。
- 会话库支持数据库存储。SQLite 与用户库存同一库。密码使用 bcrypt。
- 前端界面：React 18、TypeScript 严格模式、Vite、TanStack Query、react-hook-form + zod、Tailwind。不用 daisyUI，不用 zustand。服务端数据用 TanStack Query；界面状态放在组件里。
- 前端工具链：Bun。安装、脚本、锁文件都走 Bun。
- 测试：`cargo test`；Vitest + Testing Library 由 Bun 启动；Playwright 做 E2E。对 Garage v2.3.x 与 v2.4.1 的集成测试允许用本地容器。

## 7.2 依赖与工具链锁版本

- Rust：`rust-toolchain.toml` 固定到 1.99.0。新的 stable 与 `cargo update` 放在同一次变更里升。提交 `Cargo.lock`。依赖变更后锁文件与清单一致。
- Bun：`package.json` 的 `packageManager` 字段固定到 1.4.2。提交 `bun.lock`。禁止在构建中使用 `latest`。允许构建脚本的依赖（esbuild、`@swc/core` 等）显式列出。
- 不使用 `.nvmrc` 和 pnpm。
- 镜像基础镜像按摘要固定，不使用浮动标签。
- 依赖更新由自动化机器人每周提交，CI 通过后合并。

## 7.3 构建

- 单命令构建：先用 Bun 构建前端，再嵌入并编译 Rust 二进制；前端产物缺失时构建失败并给出清晰提示。
- 发布目标是 `x86_64-unknown-linux-musl` 与 `aarch64-unknown-linux-musl`，`RUSTFLAGS` 含 `+crt-static`。`arm/v7` 仍是可选项，不进入本次验收。
- 两个架构的发布二进制都用 `ldd` 验收，结果为 `not a dynamic executable`。交叉编译和构建机 C/C++ 编译器的要求见 [decisions.md](decisions.md)。
- 构建可复现：注入版本号、提交号、构建时间。

## 7.4 CI

每次提交与合并请求：

1. `bun install --frozen-lockfile`。
2. 前端：类型检查、lint、单元测试、构建。命令由 Bun 执行。
3. 后端：`cargo fmt --check`、`cargo clippy` 零告警、`cargo test`。
4. 安全：`cargo audit` 可达漏洞为 0；`bun audit --prod --audit-level=high` 为 0；构建期依赖 critical 为 0；密钥扫描；容器镜像扫描。
5. 集成测试：用 Garage v2.3.x、v2.4.1 容器跑 E2E。允许在本机同样用容器跑这些测试做评估。

主分支每晚重建，捕获新披露的漏洞。所有检查均为阻断项。

## 7.5 lint

- ESLint（typescript-eslint 严格规则、react-hooks）零错误零警告；禁止 `any`（生成的类型除外）。
- Rust：`rustfmt`、`clippy` 零告警。

## 7.6 测试覆盖

- 后端语句覆盖率用锁定版本的 `cargo-llvm-cov` 统计，不低于 80%。安全相关包（鉴权、CSRF、限流、代理白名单、对象响应头、配置去敏）不低于 95%。
- 前端覆盖率不低于 70%。
- [security.md](security.md) 与 [correctness.md](correctness.md) 的每一条验收标准都有对应的自动化测试。

原稿的 `go test -race` 不照搬。共享可变状态（会话、限流窗口、凭据缓存、上传缓冲）用针对性并发测试覆盖。

## 7.7 依赖漏洞清零

- 发布前 `cargo audit` 可达漏洞为 0；`bun audit --prod` 的 high 及以上为 0，构建期依赖 critical 为 0。
- 需例外时在仓库中记录原因、影响评估和到期日。

## 7.8 从 Garage OpenAPI 生成类型

- 以 Garage 仓库中的 Admin API v2 OpenAPI 描述（`garage-admin-v2.json`）为唯一来源，生成 TypeScript 类型。Rust 类型可选同样生成。
- 生成脚本、生成器版本与固定的 OpenAPI 文件版本一起提交；CI 检查生成结果与提交一致。
- 升级 Garage 支持版本时重新生成并在变更说明中列出字段差异。

## 7.9 发布与镜像

- 管理台自身以容器镜像发布，和直接运行二进制并列。多阶段构建的分工见 [decisions.md](decisions.md) 的「本项目的容器化部署」。
- 运行镜像：distroless static nonroot，无 shell；用户为非 root；`/data` 为卷；暴露 3909；镜像内默认监听 `0.0.0.0`（[security.md](security.md) 的 3.1）。二进制静态链接。镜像内不安装 shell、Node、Bun、系统 libsqlite、libssl、glibc。CI 构建 `linux/amd64` 与 `linux/arm64`。
- compose 示例的端口映射写成仅绑定宿主机 `127.0.0.1`。验收：按示例启动后，从宿主机其他网卡地址访问 3909 失败，从 `127.0.0.1` 访问成功。
- 健康检查使用二进制自带 `-health`（间隔 30 秒，超时 5 秒，启动宽限 10 秒，重试 3 次），不引入额外工具镜像。
- 发布产物：多架构镜像、各平台二进制、`SHA256SUMS`、签名（镜像用 cosign 无密钥签名或密钥签名；二进制 ed25519 签名），附 SBOM 与构建来源证明。
- 语义化版本；每个版本的变更说明列出所需最低 Garage 版本。
- 提供 compose 示例（Garage v2.4.1 + 本项目）与 Helm Chart（P2）。
