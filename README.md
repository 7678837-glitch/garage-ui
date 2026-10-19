<p align="center">
  <img src="web/public/brand/garage-ui.svg" width="80" alt="Garage UI logo">
</p>

# Garage UI

[![Releases](https://img.shields.io/badge/Releases-GitHub-blue)](https://github.com/xjoker/garage-ui/releases)

**Your Garage cluster, buckets, and files in one browser.**

English · [简体中文](README.zh-CN.md)

Garage UI is an unofficial web interface for [Garage](https://garagehq.deuxfleurs.fr/), the S3-compatible object store from Deuxfleurs. Browse your storage, upload and download files, manage access, and check your cluster without switching between tools. One Rust binary serves the React interface and connects to your Garage Admin and S3 APIs. The interface uses Radix Themes and adapts to narrow screens.

This repository is a different project from [Noooste/garage-ui](https://github.com/Noooste/garage-ui).

![Garage UI object browser](docs/images/objects-desktop.png)

<details>
<summary>On a smaller screen</summary>

<img src="docs/images/objects-mobile.png" width="240" alt="Garage UI object browser on a narrow screen">

</details>

## Quick start: Docker Compose

**Recommended:** Docker with Compose, plus an existing Garage v2.3.0 or later cluster. You need its Admin API URL and token, S3 API URL, and region. You do not need Git, Rust, Bun, or a source build. Docker selects the amd64 or arm64 image automatically.

### 1. Download the deployment files

In a new directory:

```sh
mkdir garage-ui
cd garage-ui
curl -fLO https://github.com/xjoker/garage-ui/releases/latest/download/compose.yaml
curl -fL https://github.com/xjoker/garage-ui/releases/latest/download/default.env.example -o .env
chmod 600 .env
```

### 2. Set your Garage connection

Open `.env` in your editor and fill in the four required values:

| Setting | What to enter |
|---|---|
| `GARAGE_ADMIN_URL` | Garage Admin API URL, usually port 3903 |
| `GARAGE_ADMIN_TOKEN` | Your Garage Admin API token, not an S3 access key |
| `S3_ENDPOINT_URL` | Garage S3 API URL, usually port 3900 |
| `S3_REGION` | The region in your Garage configuration, often `garage` |

Use addresses reachable **from the container**. `localhost` and `127.0.0.1` refer to that container, not your Garage server. Keep `.env` private.

### 3. Start and sign in

```sh
COOKIE_SECURE=false docker compose up -d
```

Open **[http://localhost:3909](http://localhost:3909)** and create your first administrator. The UI restarts with Docker and saves accounts and settings in a named volume. No additional database or frontend service is needed.

This command binds only to the local machine and uses HTTP. For remote access, put the UI behind HTTPS and keep `COOKIE_SECURE=true`; see [Deployment](docs/wiki/Deployment.md). If Docker runs on another machine, use an SSH tunnel to reach its loopback port during setup.

To check startup or stop the UI without deleting data:

```sh
docker compose ps
docker compose logs --tail=100 garage-ui
docker compose down
```

Do not add `--volumes` to the stop command unless you intend to delete the saved UI state.

### Next: upload your first file

Open **Overview** to check the connection, then create a **Bucket**, create an S3 **Key**, and grant it access to the bucket. In the bucket's **Objects** tab, select that key if prompted and upload a file. See the [first-use guide](docs/wiki/Getting-started.md) for the exact steps.

### No Garage cluster yet?

The [local demo](docs/wiki/Deployment.md#try-the-bundled-local-garage-demo) starts Garage and the UI together, generates the demo credentials, and initializes the single-node layout. It is for local evaluation.

### Other installation options

- **Docker without Compose, Linux binaries, and Kubernetes:** see [Deployment](docs/wiki/Deployment.md).
- **Build from source:** see [Contributing](CONTRIBUTING.md#set-up-local-development).
- **Configuration and troubleshooting:** see the [operator guide](docs/wiki/Home.md).

Release images and binaries are unsigned. Each release includes an SBOM and SHA-256 checksums; checksums verify integrity, not publisher identity.

## What you can do

- **Work with files:** browse folders, preview media and text, upload files or folders, download selections as ZIPs, and create expiring share links.
- **Organize storage:** create buckets, manage aliases and quotas, configure CORS and lifecycle rules, and clean up incomplete uploads.
- **Control access:** manage Garage keys and admin tokens, give UI users administrator or viewer access, and grant viewers download and share permissions separately.
- **See what needs attention:** check cluster health and capacity, manage nodes and layout, inspect workers and block errors, and run repair tasks.
- **Keep daily work comfortable:** use light or dark mode, English or Simplified Chinese, and layouts that adapt to desktop and narrow screens.

Compatibility has been tested with **Garage v2.3.0 and v2.4.1**. See the [Garage release support assessment](docs/garage-support.md) for the stable API match, UI gaps, vendor limits, and verification boundary. Versions older than v2.3.0 cannot perform writes through the UI.

## Keep your data and credentials safe

The first visit creates an administrator; authentication stays enabled. The Garage admin token stays on the server, and browser sessions use an HttpOnly cookie. Keep the UI private or behind an HTTPS reverse proxy, and use a Garage token with only the scopes you need.

Persist and back up `/data` in containers, or `DATA_DIR` when running the binary (default: `./data`). It contains UI accounts, sessions, audit records, bucket-to-key mappings, and the generated session key. Stop the UI before copying this directory for a consistent backup. Garage stores the actual objects and cluster state: back up its data and configuration separately. Removing Docker volumes deletes their persisted data.

## Documentation and contributing

- [Operator guide and reference](docs/wiki/Home.md): deployment, configuration, storage, permissions, cluster operations, and troubleshooting.
- [Contributing](CONTRIBUTING.md): local development, focused verification, and AI-assisted contributions.
- [Requirements](docs/README.md): the working specification and acceptance targets. Requirements are not a record of completed verification.
- [Garage release support assessment](docs/garage-support.md): supported releases, upstream API drift, feature gaps, and validation limits.
- [Delivery status and roadmap](docs/roadmap.md): implemented areas, verification limits, and deferred work.
- [Verification evidence](docs/README.md#verification-evidence): dated reports, source identities, limits, and reproduction commands.

CI builds release images and binaries only for matching version tags. Tests run locally; verification reports apply to their recorded source revisions and artifacts.

## License

[MIT](LICENSE).
