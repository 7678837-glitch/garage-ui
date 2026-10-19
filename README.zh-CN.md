<p align="center">
  <img src="web/public/brand/garage-ui.svg" width="80" alt="Garage UI 标志">
</p>

# Garage UI

[![Releases](https://img.shields.io/badge/Releases-GitHub-blue)](https://github.com/xjoker/garage-ui/releases)

**在一个浏览器里管理你的 Garage 集群、存储桶和文件。**

[English](README.md) · 简体中文

Garage UI 是 [Garage](https://garagehq.deuxfleurs.fr/)（Deuxfleurs 开发的 S3 兼容对象存储）的非官方 Web 界面。你可以浏览存储、上传和下载文件、管理访问权限、查看集群状态，不需要在多个工具之间切换。一个 Rust 二进制同时提供 React 界面，并连接你的 Garage Admin API 和 S3 API。界面使用 Radix Themes，并适配窄屏。

本仓库与 [Noooste/garage-ui](https://github.com/Noooste/garage-ui) 是不同的项目。

![Garage UI 对象浏览器](docs/images/objects-desktop.png)

<details>
<summary>在较小的屏幕上</summary>

<img src="docs/images/objects-mobile.png" width="240" alt="窄屏上的 Garage UI 对象浏览器">

</details>

## 快速开始（Docker Compose）

**推荐方式：** 使用带 Compose 的 Docker，并准备一个已有的 Garage v2.3.0 或更新版本的集群。你需要它的 Admin API 地址和令牌、S3 API 地址以及 region。不需要 Git、Rust、Bun，也不需要从源码构建。Docker 会自动选择 amd64 或 arm64 镜像。

### 1. 下载部署文件

在一个新目录中执行：

```sh
mkdir garage-ui
cd garage-ui
curl -fLO https://github.com/xjoker/garage-ui/releases/latest/download/compose.yaml
curl -fL https://github.com/xjoker/garage-ui/releases/latest/download/default.env.example -o .env
chmod 600 .env
```

### 2. 设置 Garage 连接

用编辑器打开 `.env`，填写以下四个必填项：

| 设置项 | 填写内容 |
|---|---|
| `GARAGE_ADMIN_URL` | Garage Admin API 地址，通常是 3903 端口 |
| `GARAGE_ADMIN_TOKEN` | 你的 Garage Admin API 令牌，不是 S3 访问密钥 |
| `S3_ENDPOINT_URL` | Garage S3 API 地址，通常是 3900 端口 |
| `S3_REGION` | 你的 Garage 配置中的 region，通常是 `garage` |

请使用**从容器内部**可以访问的地址。`localhost` 和 `127.0.0.1` 指的是容器本身，不是你的 Garage 服务器。请妥善保管 `.env`，不要外泄。

### 3. 启动并登录

```sh
COOKIE_SECURE=false docker compose up -d
```

打开 **[http://localhost:3909](http://localhost:3909)**，创建第一个管理员。UI 会随 Docker 重启，账号和设置保存在一个命名卷中。不需要额外的数据库或前端服务。

这条命令只绑定本机，并使用 HTTP。如需远程访问，请把 UI 放在 HTTPS 之后，并保持 `COOKIE_SECURE=true`；见 [Deployment](docs/wiki/Deployment.md)。如果 Docker 运行在另一台机器上，初始设置期间请通过 SSH 隧道访问它的本机回环端口。

检查启动状态，或在不删除数据的情况下停止 UI：

```sh
docker compose ps
docker compose logs --tail=100 garage-ui
docker compose down
```

除非你打算删除已保存的 UI 状态，否则不要在停止命令中加 `--volumes`。

### 下一步：上传第一个文件

打开 **概览（Overview）** 检查连接，然后创建一个 **存储桶（Bucket）**，创建一个 S3 **密钥（Key）**，并授予它访问该存储桶的权限。在存储桶的 **对象（Objects）** 标签页中，如有提示请选择该密钥，然后上传文件。具体步骤见[首次使用指南](docs/wiki/Getting-started.md)。

### 还没有 Garage 集群？

[本地演示](docs/wiki/Deployment.md#try-the-bundled-local-garage-demo)会同时启动 Garage 和 UI，生成演示用凭据，并初始化单节点布局。它用于本地评估。

### 其他安装方式

- **不使用 Compose 的 Docker、Linux 二进制和 Kubernetes：** 见 [Deployment](docs/wiki/Deployment.md)。
- **从源码构建：** 见 [Contributing](CONTRIBUTING.md#set-up-local-development)。
- **配置和故障排查：** 见[运维指南](docs/wiki/Home.md)。

发布的镜像和二进制没有签名。每个 release 都包含 SBOM 和 SHA-256 校验和；校验和只能验证完整性，不能验证发布者身份。

## 功能

- **处理文件：** 浏览文件夹，预览媒体和文本，上传文件或文件夹，把选中的内容打包成 ZIP 下载，创建会过期的分享链接。
- **组织存储：** 创建存储桶，管理别名和配额，配置 CORS 和生命周期规则，清理未完成的上传。
- **控制访问：** 管理 Garage 密钥和管理令牌，为 UI 用户分配管理员或只读（viewer）权限，并分别授予只读用户下载和分享权限。
- **关注需要处理的问题：** 查看集群健康状况和容量，管理节点和布局，检查工作线程和数据块错误，运行修复任务。
- **让日常使用更顺手：** 支持浅色或深色模式、英文或简体中文，布局适配桌面和窄屏。

兼容性已在 **Garage v2.3.0 和 v2.4.1** 上测试。稳定 API 的匹配情况、UI 缺口、上游限制和验证边界，见 [Garage 版本支持评估](docs/garage-support.md)（英文）。低于 v2.3.0 的版本无法通过 UI 执行写操作。

## 保护你的数据和凭据

首次访问时会创建一个管理员；身份验证始终开启。Garage 管理令牌只保存在服务器端，浏览器会话使用 HttpOnly cookie。请不要公开暴露 UI，或将其放在 HTTPS 反向代理之后，并使用只包含所需权限范围的 Garage 令牌。

在容器中请持久化并备份 `/data`；直接运行二进制时请持久化并备份 `DATA_DIR`（默认：`./data`）。这个目录包含 UI 账号、会话、审计记录、存储桶到密钥的映射，以及生成的会话密钥。复制该目录前请先停止 UI，以得到一致的备份。实际的对象和集群状态由 Garage 保存：请另行备份 Garage 的数据和配置。删除 Docker 卷会删除其中保存的数据。

## 文档与贡献

以下文档均为英文：

- [运维指南和参考](docs/wiki/Home.md)：部署、配置、存储、权限、集群操作和故障排查。
- [Contributing](CONTRIBUTING.md)：本地开发、针对性验证，以及 AI 辅助的贡献。
- [需求](docs/README.md)：工作规格说明和验收目标。需求不是已完成验证的记录。
- [Garage 版本支持评估](docs/garage-support.md)：支持的版本、上游 API 变化、功能缺口和验证限制。
- [交付状态和路线图](docs/roadmap.md)：已实现的部分、验证限制和推迟的工作。
- [验证证据](docs/README.md#verification-evidence)：带日期的报告、源码标识、限制和复现命令。

CI 只在匹配的版本 tag 上构建 release 镜像和二进制。测试在本地运行；验证报告只适用于其中记录的源码版本和构建产物。

## 许可证

[MIT](LICENSE)。
