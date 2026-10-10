# 已吸收的决定

日期：2026-10-10。决定人：本项目维护者。下文把这些决定写进工作规格，不再把原稿第 7 章的 Go / Node / pnpm 当作当前技术栈。

## 后端用 Rust

项目基础代码用 Rust 撰写，交付物仍是单个二进制内嵌前端单页应用。

由此改写的工程条款见 [engineering.md](engineering.md)：

- 格式化、静态检查、测试、覆盖率、漏洞扫描改为 Rust 工具链。
- S3 客户端使用官方 `aws-sdk-s3`（AWS SDK for Rust）。该 SDK 的文档要求异步运行时，官方示例使用 tokio。
- 密码算法仍是 bcrypt。
- 运行镜像仍是 distroless static 的 nonroot 变体；二进制静态链接，目标机器上不预装 C 运行库或 libsqlite。
- 原稿里的 `gofmt`、`go vet`、`staticcheck`、`go test -race`、`govulncheck`、Go 类型生成不再作为门禁。

功能、安全、正确性、接口路径和验收标准不因换语言而放宽。

## 前端工具链用 Bun

安装依赖、运行脚本、锁定版本都用 Bun。

- 用 `package.json` 的 `packageManager` 字段把 Bun 钉到具体版本。
- 锁文件是 `bun.lock`。CI 使用 `bun install --frozen-lockfile`。
- 不提交 `.nvmrc`，不使用 pnpm，构建脚本不使用 `latest`。
- 生产依赖高危及以上漏洞用 `bun audit --prod --audit-level=high` 阻断；构建期依赖 critical 同样阻断。
- Vitest、Testing Library、Playwright 仍是测试栈，由 Bun 启动。

## 多 Agent 并行

允许多个 Agent 并行开发。

并行时的收口：

- 任务按 [roadmap.md](roadmap.md) 的阶段和章节号拆开。改同一批文件的任务不并行。
- 全量测试和 `git` 提交由主会话收口。并行中的 Agent 不各自跑全量测试，不各自 `git add`。
- 规格与事实冲突时停下来改规格或请示，不为了让测试变绿去改验收标准。
- 安全、持久化和删除类行为以 [security.md](security.md)、[correctness.md](correctness.md) 的验收原文为准。

## 本地容器化 Garage

允许在本机用容器运行 Garage，用来做集成测试、E2E 和人工评估。

- 要覆盖的版本仍是 Garage v2.3.x 与 v2.4.1。compose 示例默认 v2.4.1。
- 容器只作为被测依赖和示例部署。本项目仍不做 Garage 节点的安装、升级或配置文件编辑。
- 示例与镜像里不放真实密钥或可当密钥用的占位私钥。占位符必须在启动检查里被拒绝，规则见 [security.md](security.md) 的 3.14。

## 运行时技术栈

2026-10-10 维护者确认，原话：「可 同意了。」版本对到当天的稳定发布。写 `Cargo.toml` 时锁定下列版本；同一主版本若已有更新的补丁，第一次 `cargo add` 时用更新的补丁，并提交 `Cargo.lock`。不用 nightly，不用尚未发布的主版本。

编译器与异步运行时：

- Rust 1.99.0（2026-10-01）。`rust-toolchain.toml` 写死该版本，不写浮动的 `stable`。新的 stable 与 `cargo update` 放在同一次变更里升。
- tokio 1.53.2，多线程运行时。只开用到的 feature：`macros`、`rt-multi-thread`、`net`、`signal`、`time`、`io-util`、`sync`、`fs`。

HTTP：

- axum 0.8.9。路由参数写成 `/{param}`。
- tower-http 0.7.1。第一次编译若和 axum 的 tower 版本对不上，改用 tower-http 0.6.11，并改本文件。
- axum-extra 0.12.6，用于 cookie 和类型化请求头。
- 不单独钉 hyper，除非编译过不去。
- 显式方法加路径，中间件，流式请求体与响应体，读头超时，空闲超时，优雅关停。上传、下载、ZIP 不设请求总超时。Admin API 不做通配反向代理。

数据与对外调用：

- SQLx 0.9.0。feature 取「捆绑并静态链接 SQLite」的那个：文档里的名字是 `sqlite`；若 0.9 清单写成 `sqlite-bundled`，以捆绑静态为准。不用 `sqlite-unbundled`。不用要求编译期 `DATABASE_URL` 的 `query!`，除非先配好 sqlx offline。短查询不占住运行时；审计 CSV 导出保持流式。
- 会话和用户库存同一个 SQLite。会话用 SQLx 写，不引入会话框架。
- CSRF 按 [security.md](security.md) 自己做双提交 cookie，比较用常量时间。
- S3：aws-sdk-s3 1.152.0，默认 rustls。aws-config 1.12.0，使用 `behavior-version-latest`。
- Admin API：reqwest 0.13.5，feature 为 `json` 与 rustls，不用 native-tls。
- 密码：bcrypt crate 0.19.3。算法仍是 bcrypt。0.19.2 起已修非 ASCII 哈希导致的 panic。
- 前端资源：rust-embed 8.13.0。发布构建嵌入文件，开发时从磁盘读。作者仍是 Peter John，仓库在 pyrossh.dev。
- serde 1.0.229、serde_json 1.0.151。留在 1.0。
- 日志：tracing 0.1.44、tracing-subscriber 0.3.23，JSON 打到 stdout/stderr。
- 错误：anyhow 1.0.104。不低于 1.0.103，该版修了 `Error::downcast_mut` 的问题。
- 指标：metrics 0.24.6、metrics-exporter-prometheus 0.18.3。不加 OpenTelemetry。不用 tikv 的 `prometheus` crate。
- 命令行：clap 4.6.7 derive，覆盖 `-health` 和阶段 6 的离线管理命令。
- 限流：governor 0.10.4。
- ZIP：crates.io 上的 `zip` 9.0.0，仓库是 zip-rs/zip2。解压路径穿越在 2.3.0 起已修。不要用已归档的 zip-rs/zip。
- 缩略图：image 0.25.10，有界且先读图像头。

静态链接：

- 发布目标：`x86_64-unknown-linux-musl`、`aarch64-unknown-linux-musl`。`RUSTFLAGS` 含 `+crt-static`。
- 验收：两个架构上 `ldd` 都报告 `not a dynamic executable`。
- 交叉编译用 musl 工具链（cargo-zigbuild，或同时支持 amd64 与 arm64 宿主机的 musl 构建镜像）。不用宿主机 clang 链接 musl。
- 构建机需要 C/C++ 编译器：捆绑的 SQLite 是 C，aws-sdk 默认的 rustls 会拉 aws-lc-rs。运行镜像不包含、也不依赖系统 libsqlite、libssl、glibc。TLS 走 rustls。

前端工具链钉 Bun 1.4.2。`packageManager` 写这个版本。2026-10-10 时 1.5 还没发布，不提前钉。

## 前端界面

2026-10-10 维护者确认，原话：「可以，去掉 daisyUI 和 zustand。前端越简单越强大就行。」

- 界面库：React 18、TypeScript 严格模式、Vite、TanStack Query、react-hook-form + zod、Tailwind。
- 不用 daisyUI，不用 zustand，也不再加别的界面库。
- 服务端数据用 TanStack Query。登录、建桶、密钥这类表单用 react-hook-form 和 zod。主题、侧栏开关这类界面状态放在组件里。
- 样式只用 Tailwind。浅色和深色主题仍按 [features-ui.md](features-ui.md) 的 5.35 做。
- 前端仍打进同一个 Rust 二进制，不单独部署。

## 维护核对

2026-10-10 核对了本节点名的 crate，以及仍留在规格里的前端库：React、TypeScript、Vite、TanStack Query、react-hook-form、zod、Tailwind、Vitest、Testing Library、Playwright。依据是 crates.io 或 npm 的最新非撤回版本、仓库是否归档、最近推送，以及 RustSec 有没有把该库标成无人维护。

选用的库都没有这条标记，选用的仓库也都没有归档。发版间隔较长、仓库仍有提交的是 governor（发版 2025-12-16，提交 2026-08-24）、image（发版 2026-03-10，提交 2026-09-15）、axum（发版 2026-04-14，提交 2026-10-09）。这三份留在栈里。

React 18 停在功能维护之外。最新稳定版仍是 18.3.1（2024-04-26）。React 19 发布之后，18 只保留安全修复策略，而且之后没有再发过 18 的版本。规格继续钉 React 18。

传递依赖里和静态链接、TLS 相关的 hyper 1.12.0、rustls 0.23.45、aws-lc-rs 1.18.1、libsqlite3-sys 0.38.2 同样在维护中。

## 本项目的容器化部署

2026-10-10 维护者确认，原话：「本项目还要支持容器化部署哦。」这是管理台自己的发布方式。上一节的 Garage 容器只负责被测集群和示例里的 Garage。

- 多阶段镜像。构建阶段包含 Rust 1.99.0、C/C++ 编译器、上一节的 musl 工具链、Bun 1.4.2。Bun 只出现在构建阶段。
- 运行阶段用 distroless static 的 nonroot 变体：静态链接的单个二进制，无 shell，无 Node，无 Bun，无系统 libsqlite、libssl、glibc。
- 端口 3909。镜像内未设置 `HOST` 时监听 `0.0.0.0`。compose 示例把宿主机端口写成 `127.0.0.1:3909`。数据卷是 `/data`。健康检查用二进制的 `-health`。监听与映射的验收原文在 [security.md](security.md) 的 3.1。
- CI 构建 `linux/amd64` 与 `linux/arm64`。基础镜像按摘要固定。
- compose 示例可以同时启动 Garage v2.4.1，只供本地评估。本项目不安装、不升级、不编辑 Garage 节点配置。
