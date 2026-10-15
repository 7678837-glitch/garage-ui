# Deployment

Use the **dev** source branch for the deployment files described here. Build locally; these examples do not depend on a published Garage UI image. Check [Releases](https://github.com/xjoker/garage-ui/releases) for published artifacts; unpublished drafts have no public downloads.

```sh
git clone --branch dev https://github.com/xjoker/garage-ui.git
cd garage-ui
```

## Try the bundled local Garage demo

With Docker and Docker Compose available, run from the repository root:

```sh
docker compose -f deploy/compose.yaml up -d --build
```

Open [the local UI](http://127.0.0.1:3909), create the first administrator, and check **Overview**. The example starts Garage v2.4.1 in single-node mode, initializes its layout, and wires the UI to Garage's admin/S3 services. You do not need an additional layout assign/apply command for this demo.

The UI uses `http://garage:3903` for administration and `http://garage:3900` for S3 with region `garage`. A dedicated UI secret volume receives only admin/metrics tokens, readable by UID 65532. Garage's RPC secret stays separate. Data lives in named volumes.

The example publishes services on loopback only and sets `COOKIE_SECURE=false` for its local HTTP UI. It is a development example, not an Internet-facing HTTPS deployment. For share links, set a public S3 address reachable by the intended recipients.

Inspect startup with:

```sh
docker compose -f deploy/compose.yaml ps
docker compose -f deploy/compose.yaml logs garage-ui garage
```

Preserve volumes when stopping the demo. Removing its data volumes removes its persisted state.

## Connect containers to your existing Garage

Use [deploy/compose.external.yaml](https://github.com/xjoker/garage-ui/blob/dev/deploy/compose.external.yaml). This starts the UI against an existing cluster rather than starting another Garage.

Create a private `.env` file outside version control, supplying these four required variables with your actual cluster settings:

| Variable | Required value |
|---|---|
| `GARAGE_ADMIN_URL` | Admin API address reachable from the UI container |
| `GARAGE_ADMIN_TOKEN` | Actual Garage admin token |
| `S3_ENDPOINT_URL` | S3 API address reachable from the UI container |
| `S3_REGION` | Region configured in Garage |

Then run:

```sh
docker compose --env-file .env -f deploy/compose.external.yaml up -d --build
```

This example keeps secure cookies enabled by default. Serve the UI behind your HTTPS reverse proxy. For an explicitly local HTTP trial only:

```sh
COOKIE_SECURE=false docker compose --env-file .env -f deploy/compose.external.yaml up -d --build
```

Do not use container-local `127.0.0.1` for an API hosted in another container. Use a Docker-network service address or another address reachable from this container. For sharing, configure `S3_PUBLIC_ENDPOINT_URL` independently with an address reachable by browsers.

## Build images for your own registry or cluster

```sh
scripts/build.sh --images amd64
```

This builds and loads `garage-ui:<VERSION>-local-amd64` locally. Choose `arm64` for ARM, or omit the architecture to build both. An explicit `BUILD_VERSION` produces `garage-ui:<BUILD_VERSION>-<architecture>`; see the [stable, development, and local version policy](../engineering.md#79-release-and-images). `scripts/build.sh` passes the full current Git commit as `GIT_COMMIT` to native and image builds; `scripts/release.sh` uses the stable `VERSION` and checks the exact final images against `/healthz` for matching version and commit. The build uses buildx without cache; it does not push images.

The runtime image contains one Rust binary with the browser assets embedded. It serves the UI and API from one process on 0.0.0.0:3909, runs as UID/GID 65532, and has no shell, Bun, or Node.js runtime. It needs no browser CDN or separate frontend deployment. Mount a writable `/data` for its UI database and generated session key; mount secret files read-only. Put a trusted HTTPS proxy in front of externally reachable deployments.

## Verify the deployed source revision

Compare `/healthz` with the full commit used for the build. The response field is `commit`, alongside `version`, `status`, and `build_time`:

```sh
git rev-parse HEAD
curl --fail --silent http://127.0.0.1:3909/healthz
```

The commit must match exactly; matching version numbers alone are insufficient. Run the probe against the actual deployment address when verifying a remote instance. A source archive without Git metadata reports `unknown` unless its builder supplies a valid full hexadecimal `GIT_COMMIT` (40 or 64 characters); malformed values fail the build.

For Compose, source identity is optional. The default is honestly `unknown`. To embed the current revision when building the local demo:

```sh
GIT_COMMIT=$(git rev-parse HEAD) docker compose -f deploy/compose.yaml up -d --build
```

The existing-cluster Compose file accepts the same environment variable. Build from the intended checked-out source; the identifier does not attest to uncommitted edits.

## Deploy the UI with Helm

The [Helm chart](https://github.com/xjoker/garage-ui/tree/dev/deploy/helm/garage-ui) installs the UI only. It expects an existing Garage cluster and an image accessible to your Kubernetes nodes. Load or publish your built image using your cluster's normal workflow before installation.

Create a private values file with your image repository/tag and cluster addresses. Configure `garageAdminUrl`, `s3EndpointUrl`, and `s3Region`; use `s3PublicEndpointUrl` when sharing is needed. Supply `secrets.garageAdminToken` and any metrics or S3 key pair through your private deployment configuration. Do not commit the resulting file.

```sh
helm upgrade --install garage-ui deploy/helm/garage-ui -f private-values.yaml
```

`persistence.size` controls the UI volume request. The chart's TLS settings are for the UI's outgoing Garage connections: `tls.caSecret` mounts a Secret containing `ca.crt`; `tls.insecure` deliberately disables certificate verification. These settings do not provision HTTPS for the browser. Arrange ingress/proxy TLS through your cluster's normal configuration.

The chart uses `/readyz` for readiness and the binary's `-health` check for liveness. Liveness checks whether the UI responds; it is separate from Garage connection status displayed in the console.

## Back up and restore UI state

Preserve **all of `DATA_DIR`**, including `garage-ui.sqlite`, any SQLite WAL/SHM sidecars, and `session.key`. If using `SESSION_KEY_FILE`, preserve that external key separately. A simple consistent filesystem backup is to stop the UI service before copying or snapshotting its volume, then restart it after the backup. Do not copy only the main SQLite file while writes continue.

To restore, stop the UI, restore the complete saved state and key, ensure the runtime user can read/write the data directory, and restart with the intended configuration. Verify that the expected users and audit records appear and Garage connections work. Keep the saved copy until restoration is verified.

UI backups preserve local accounts, sessions, audit, ZIP tokens, and bucket-key selections. Objects, Garage keys/tokens, cluster metadata, and Garage snapshots require Garage's own backup process.

## Upgrade deliberately

Back up state, build the intended source revision, and restart with the same data volume and configuration. Check **Settings → About** and the exact `/healthz` commit, then verify login, health, and an appropriate storage operation against the intended Garage. A version number or a running container alone does not prove the correct browser bundle or cluster connection is in use.

## Prepare release artifacts

Release preparation is a maintainer task. Follow the [development and release identity rules](https://github.com/xjoker/garage-ui/blob/dev/docs/engineering.md#79-release-and-images) before running `scripts/release.sh`. Local artifact preparation does not publish a release or push images.

The repository's [release workflow](https://github.com/xjoker/garage-ui/blob/dev/.github/workflows/release.yml) is manual-only. When explicitly dispatched, it builds unsigned Linux binaries, an SPDX SBOM, and SHA-256 checksums, then creates a fresh unpublished draft for the selected source commit. It refuses to update an existing draft or published release with the same version. It does not automatically publish releases, push tags, or publish container images. Checksums verify file integrity; these artifacts are unsigned. Publication and signing require manual review.

The CI workflow remains disabled during development. A workflow file is not evidence that a build has run; consult revision-specific verification and [Releases](https://github.com/xjoker/garage-ui/releases) for artifacts actually available to users.
