# Deployment

## Recommended: Docker Compose

Use the [three-step quick start](https://github.com/xjoker/garage-ui/blob/dev/README.md#quick-start-docker-compose). Download `compose.yaml` and `.env.example` from [Releases](https://github.com/xjoker/garage-ui/releases), fill in the Garage connection, and start the UI. The deployment files work in an empty directory: no repository checkout or build toolchain is needed. Docker automatically selects `linux/amd64` or `linux/arm64`.

The Compose service pulls `ghcr.io/xjoker/garage-ui` at the release pinned in the file. Set `GARAGE_UI_VERSION` in `.env` to select another release. It restarts unless explicitly stopped, stores UI state in a named volume, and runs as a non-root user with a read-only root filesystem. A one-shot init container sets the data volume ownership. The UI is one process and port with the browser assets embedded.

Supply these four required values in the private `.env` file:

| Variable | Value |
|---|---|
| `GARAGE_ADMIN_URL` | Garage Admin API URL reachable from the UI container |
| `GARAGE_ADMIN_TOKEN` | Garage Admin API token, not an S3 access key |
| `S3_ENDPOINT_URL` | Garage S3 API URL reachable from the UI container |
| `S3_REGION` | Region configured in Garage |

Keep `.env` out of version control. Docker-network service names work when the UI and Garage share that network. Do not use `localhost` or `127.0.0.1` to reach another container. `S3_PUBLIC_ENDPOINT_URL`, when needed for share links, must instead be reachable by the recipient's browser. See [Configuration](Configuration.md) for secret files, private certificates, and other settings.

For local HTTP:

```sh
COOKIE_SECURE=false docker compose up -d
```

Open [http://localhost:3909](http://localhost:3909) and create the first administrator. For a remote Docker host, keep the loopback binding and forward it over SSH during setup:

```sh
ssh -L 3909:127.0.0.1:3909 your-server
```

Open the same local URL on your workstation. Replace `your-server` with your SSH destination.

## Serve the UI over HTTPS

The supplied Compose file binds to `127.0.0.1:3909`. Put a host HTTPS reverse proxy in front of this address and keep `COOKIE_SECURE=true` (the default). A proxy in another container needs a shared Docker network and must reach the `garage-ui:3909` service address; its loopback address is not the host's.

Only set `TRUSTED_PROXY=true` if your proxy overwrites `X-Forwarded-For`. See [Configuration](Configuration.md) for proxy and cookie settings. Garage Admin and S3 connection addresses remain server-side settings; they need not be public browser endpoints.

## Check startup, restart, or stop

```sh
docker compose ps
docker compose logs --tail=100 garage-ui
docker compose restart garage-ui
docker compose down
```

`down` preserves the data volume. Adding `--volumes` deletes its saved state. If an image pull reports `unauthorized`, first check that you selected a published release and that its GHCR package is public; public release images require no GitHub account or Docker login. A public source repository alone does not make its container package public.

## Try the bundled local Garage demo

For evaluation without an existing Garage cluster, clone the development branch and start the demo:

```sh
git clone --branch dev https://github.com/xjoker/garage-ui.git
cd garage-ui
docker compose -f deploy/compose.yaml up -d
```

Open [http://localhost:3909](http://localhost:3909) and create the first administrator. The example starts Garage v2.4.1 in single-node mode, generates credentials, initializes its layout, and connects the UI to the Admin and S3 APIs. You can then create a bucket and upload a file.

The UI receives only the Admin/metrics tokens in a dedicated secret volume; Garage's RPC secret stays separate. Data lives in named volumes. The example uses loopback ports and HTTP for local evaluation. Configure a browser-reachable `S3_PUBLIC_ENDPOINT_URL` if you need share links outside its Docker network.

## Docker without Compose

Create a private `.env` file with the four Garage settings above, then run:

```sh
docker run -d --name garage-ui --restart unless-stopped \
  --read-only --tmpfs /tmp --env-file .env \
  -p 127.0.0.1:3909:3909 -v garage-ui-data:/data \
  -e COOKIE_SECURE=false ghcr.io/xjoker/garage-ui:20261016.3
```

This uses local HTTP. Open [http://localhost:3909](http://localhost:3909). Use HTTPS and secure cookies for remote access. The image initializes a fresh named volume with the non-root user's ownership; an existing directory or volume must already be writable by UID/GID 65532.

## Download the Linux binary

Choose `garage-ui-linux-amd64` for an x86-64 Linux host or `garage-ui-linux-arm64` for an ARM64 Linux host. These binaries do not run natively on macOS or Windows; use Docker there. Download the binary and `SHA256SUMS` from the same [release](https://github.com/xjoker/garage-ui/releases), then verify:

```sh
sha256sum --check --ignore-missing SHA256SUMS
chmod +x garage-ui-linux-amd64
```

Set the four Garage connection variables in the process environment. For example, with a local Garage and a token stored in a private file:

```sh
export GARAGE_ADMIN_URL=http://127.0.0.1:3903
export API_ADMIN_KEY_FILE="$HOME/.config/garage-ui/admin-token"
export S3_ENDPOINT_URL=http://127.0.0.1:3900
export S3_REGION=garage
export COOKIE_SECURE=false
./garage-ui-linux-amd64
```

Replace the addresses and region with your Garage configuration, create the token file before starting, and use the ARM64 filename on that architecture. The binary defaults to `127.0.0.1:3909` and stores UI state in `./data`. Preserve that directory across upgrades. Binaries and images are unsigned; SHA-256 checksums verify integrity, not publisher identity. Releases also include an SPDX SBOM.

## Build from source

Source builds are for contributors or custom changes. Follow [Contributing](https://github.com/xjoker/garage-ui/blob/dev/CONTRIBUTING.md#set-up-local-development) for the Rust/Bun prerequisites and `scripts/build.sh`. Use `scripts/build.sh --images amd64` or `arm64` to load a local container image; omit the architecture to build both. The image tags default to `garage-ui:<VERSION>-local-<architecture>` and are not pushed.

The existing-cluster Compose file uses published images and has no source build context. To use a custom image with it, tag your image as `ghcr.io/xjoker/garage-ui:local`, set `GARAGE_UI_VERSION=local` in `.env`, and start with `docker compose up -d --pull never`. The bundled demo retains its optional `--build` source-build path.

## Verify the deployed version

```sh
curl --fail --silent http://127.0.0.1:3909/healthz
```

The response includes `version`, `commit`, `status`, and `build_time`. Compare the version and full commit with the release tag. Probe the actual deployment address when verifying a remote instance; a successful push or a running container does not prove that the intended image is in use. **Settings → About** also shows the version.

## Deploy the UI with Helm

The [Helm chart](https://github.com/xjoker/garage-ui/tree/dev/deploy/helm/garage-ui) installs the UI only and expects an existing Garage cluster. Configure `garageAdminUrl`, `s3EndpointUrl`, and `s3Region` in a private values file. Supply `secrets.garageAdminToken` through private deployment configuration. Set `s3PublicEndpointUrl` when sharing is needed. Do not commit secrets.

```sh
helm upgrade --install garage-ui deploy/helm/garage-ui -f private-values.yaml
```

The chart uses the release image by default. Override `image.repository` and `image.tag` for another image, and `persistence.size` for the UI volume. `trustedProxy: true` is appropriate only behind an ingress or proxy that overwrites `X-Forwarded-For`. The TLS settings `tls.caSecret` and `tls.insecure` apply to outgoing Garage connections, not browser HTTPS; arrange ingress TLS separately. Liveness uses the binary's health check, while readiness uses `/readyz`.

## Back up and restore UI state

Preserve **all of `DATA_DIR`**, including `garage-ui.sqlite`, any SQLite WAL/SHM sidecars, and `session.key`. If using `SESSION_KEY_FILE`, preserve that external key separately. A simple consistent filesystem backup is to stop the UI service before copying or snapshotting its volume, then restart it after the backup. Do not copy only the main SQLite file while writes continue.

To restore, stop the UI, restore the complete saved state and key, ensure the runtime user can read/write the data directory, and restart with the intended configuration. Verify that the expected users and audit records appear and Garage connections work. Keep the saved copy until restoration is verified.

UI backups preserve local accounts, sessions, audit, ZIP tokens, and bucket-key selections. Objects, Garage keys/tokens, cluster metadata, and Garage snapshots require Garage's own backup process.

## Upgrade deliberately

Back up UI state first. Set `GARAGE_UI_VERSION` in `.env` to the chosen release tag, then pull and recreate the service with the same volume and configuration:

```sh
docker compose pull garage-ui
COOKIE_SECURE=false docker compose up -d
```

The command above is for local HTTP; omit the `COOKIE_SECURE=false` override behind HTTPS. Check **Settings → About**, verify `/healthz`, and confirm login and a storage operation. Keep your backup until verification succeeds.

## How release artifacts are produced

Build-only CI runs on version tags, following the [release policy](https://github.com/xjoker/garage-ui/blob/dev/docs/engineering.md#79-release-and-images). Ordinary branch pushes and pull requests do not build. Tests run locally before the release tag is pushed.

A valid `YYYYMMDD.N` tag must match `VERSION` and the package manifests. Only then does CI build and verify the amd64/arm64 images and static binaries, generate an SBOM and checksums, and publish the images and GitHub release attachments. `compose.yaml` and `.env.example` are included so users can deploy without cloning the repository.

GHCR visibility is independent of repository visibility. The maintainer must make the package public once; the publication process verifies anonymous access before publishing the release. Images and binaries are unsigned, with signing and build-provenance attestations deferred.
