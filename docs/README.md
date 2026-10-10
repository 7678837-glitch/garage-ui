# 工作规格

本目录是仓库根目录 [`DEV-GUIDE.md`](../DEV-GUIDE.md) 的拆解稿，供实现、并行开发和验收使用。原文保留。两边冲突时以本目录为准。

Garage 端点名与字段名仍以 Garage 源码中的 Admin API v2 定义为准。本目录不包含实现代码。

## 已吸收的决定

| 决定 | 落地位置 |
|---|---|
| 后端用 Rust 撰写 | [decisions.md](decisions.md)、[engineering.md](engineering.md) |
| 前端工具链用 Bun | [decisions.md](decisions.md)、[engineering.md](engineering.md) |
| 允许多 Agent 并行开发 | [decisions.md](decisions.md) |
| 允许本地容器化运行 Garage 做测试和评估 | [decisions.md](decisions.md)、[engineering.md](engineering.md) |
| 运行时栈：Rust 1.99.0、axum 0.8.9、SQLx 0.9 捆绑 SQLite，其余见决定文件 | [decisions.md](decisions.md)、[engineering.md](engineering.md) |
| 管理台自身支持容器化部署（linux/amd64 与 linux/arm64） | [decisions.md](decisions.md)、[engineering.md](engineering.md)、[scope.md](scope.md) |
| 前端去掉 daisyUI 和 zustand | [decisions.md](decisions.md)、[engineering.md](engineering.md) |

界面库是 React 18、TypeScript、Vite、TanStack Query、react-hook-form、zod、Tailwind。Bun 替换的是 Node / pnpm 这一层工具链，当前钉 1.4.2。

## 阅读顺序

1. [decisions.md](decisions.md) — 相对原稿改了什么
2. [scope.md](scope.md) — 目标、范围、最小版本
3. [garage-api.md](garage-api.md) — 版本、能力探测、46 个端点
4. [security.md](security.md) — 安全要求与角色矩阵
5. [correctness.md](correctness.md) — 正确性要求
6. 功能四份：[数据面](features-data.md)、[集群与布局](features-cluster.md)、[身份与审计](features-access.md)、[界面](features-ui.md)
7. [engineering.md](engineering.md) — 非功能与工程要求（已按 Rust / Bun 改写）
8. [roadmap.md](roadmap.md) — 阶段、优先级、人日

章节号沿用原稿，方便对照。例如安全默认鉴权仍是 3.1，桶仍是 5.1。
