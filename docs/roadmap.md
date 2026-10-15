# Delivery status and roadmap

The implementation now covers areas across the original phases. Phase order is a historical implementation breakdown, not a list of wholly outstanding work. Requirements in the [working spec](README.md) remain acceptance targets; implemented controls and earlier passing checks do not establish that every acceptance criterion has passed on the current source revision.

## Implemented areas and recorded evidence

| Area | Implemented scope | Source and evidence |
|---|---|---|
| Build and deployment | Embedded React/Rust binary, pinned toolchains, non-root images, Compose examples, UI-only Helm chart, and development data generator | [Build script](../scripts/build.sh), [deployment files](../deploy), [load generator](../crates/garage-loadgen), [operator deployment guide](wiki/Deployment.md) |
| Local authentication and access | Setup, local accounts, persisted sessions, role/download/share permissions, user administration, and offline account recovery | [Authentication API](../crates/garage-ui/src/api/auth.rs), [access rules](../crates/garage-ui/src/access.rs), [CLI](../crates/garage-ui/src/cli.rs), [account guide](wiki/Users-and-authentication.md) |
| Storage and objects | Bucket/key management, object browsing, upload/download/ZIP, previews, sharing, CORS/lifecycle settings, and incomplete-upload cleanup | [Bucket UI](../web/src/Buckets.tsx), [object UI](../web/src/Objects.tsx), [bucket guide](wiki/Buckets.md), [object guide](wiki/Objects.md) |
| Cluster and operations | Health/metrics, nodes/layout, admin tokens, workers/repair, block errors, snapshots, object inspection, and audit filtering/export | [API modules](../crates/garage-ui/src/api), [cluster guide](wiki/Cluster-and-layout.md), [maintenance guide](wiki/Maintenance.md), [audit guide](wiki/Audit.md) |
| Interface | Radix controls, responsive navigation, light/dark themes, English/Simplified Chinese, and keyboard interaction | [Application](../web/src/App.tsx), [theme](../web/src/theme.tsx), [localization](../web/src/i18n.tsx), [migration report](../evidence/radix-migration/report.md) |
| Audit corrections | S3 recovery/cache behavior, ZIP error propagation/cancellation, node outcomes, proxy auditing/catalog cursors, audit CSV/export buffering, and build identity | [Nine-fix report](../evidence/nine-fixes/report.md) records focused regressions and revision-specific source/native/browser checks |

The [remaining-improvement convergence report](../evidence/convergence/report.md) records the current development checkpoint, including combined Rust/browser retakes and local arm64 image validation. Consult the separate [official Garage support check](garage-support.md) for upstream support evidence; application test results alone do not establish upstream support policy.

The reports retain exact build identities, Garage versions, test results, and limits. They are the evidence for those checkpoints; they do not validate later changes. In particular, controlled browser failures do not establish successful live destructive maintenance, and local performance checks do not establish remote-network or physical-phone performance.

## Outstanding acceptance and distribution

- The CI workflow remains disabled during development. The separate [manual release workflow](../.github/workflows/release.yml) prepares unpublished drafts. Workflow files and local results do not establish running remote CI or its release gates.
- The [release script](../scripts/release.sh) prepares local Linux artifacts, checksums, and an SBOM. Signing and build provenance in [release requirements](engineering.md#79-release-and-images) remain distribution requirements; local artifact preparation does not establish publication. Consult [Releases](https://github.com/xjoker/garage-ui/releases) for published artifacts.
- Re-run affected acceptance checks for the exact source/artifacts being reviewed. The [contributor guide](../CONTRIBUTING.md#verify-the-affected-behavior) owns verification commands and fixture prerequisites. Full-phase acceptance is not inferred from feature presence or older reports.
- For private Garage certificates, the implemented path is a configured CA file or the explicit insecure option described in [Configuration](wiki/Configuration.md). The old phase-6 certificate item is not evidence of browser-facing certificate provisioning.

## Deferred scope

OIDC login and identity-provider role mapping/single logout, team-based bucket authorization, multi-cluster management, Unix-socket listeners/connections, multi-replica deployment, and the next major Garage Admin API remain outside this delivery. No new schedule or effort estimate is assigned here.

## Original phase breakdown and estimates (historical)

The tables below preserve the original single-developer Rust/React planning estimates and phase dependencies. They were not recomputed after the stack changes or reconciled against delivered work, and must not be used as remaining-effort estimates. The original phase-completion rule required every cited acceptance criterion to pass. For current status, use the sections above and revision-specific evidence.

Parallel changes still require non-overlapping ownership and coordinated fixtures, service ports, test runs, and integration, as described in [Contributing](../CONTRIBUTING.md#use-ai-assistance-within-a-bounded-task).

## Phase 0: Buildable, and a baseline (P0, about 4 person-days)

| Item | Estimate |
|---|---|
| Pin the Rust toolchain and the Bun version, and build the image | 0.5 |
| Non-root distroless image, with built-in `-health` | 0.5 |
| CI skeleton (build, lint, test, `cargo audit`, `bun audit`) | 1 |
| OpenAPI type generation (7.8 of [engineering.md](engineering.md); the allowlist and the scope picker depend on it) | 1 |
| Test-data generation command (6.6; the minimum-version performance bar depends on it; it is not built into the runtime image) | 1 |

The runtime stack and containerized deployment are already written in [decisions.md](decisions.md). This phase pins `rust-toolchain.toml` and Bun 1.4.2 from that decision, and produces the `linux/amd64` and `linux/arm64` runtime images and CI. The service process is written starting in phase 1.

## Phase 1: Security (P0, about 7.5 person-days)

| Item | Estimate |
|---|---|
| User store, setup wizard, default authentication, default local listen (3.1) | 1.5 |
| Config redaction, log redaction, examples with no secrets, and self-generated secrets (3.2, 3.14 through 3.16) | 1 |
| Preview protection and security headers, object `no-store` (3.3, 3.11) | 0.5 |
| Persist sessions, rotate them, invalidate them on password change, cookie attributes (3.4, 3.12) | 1.5 |
| Rate limiting, CSRF, request-body limit (3.5, 3.6, 3.9) | 1 |
| Endpoint allowlist proxy and the role matrix (3.7, 3.19) | 1.5 |
| Login audit and the audit table (3.13, the basic part of 5.21) | 0.5 |

## Phase 2: Correctness and compatibility (P0 and P1, about 7 person-days)

| Item | Priority | Estimate |
|---|---|---|
| Address by bucket ID, paged recursive delete, capacity precision (4.1, 4.3, 4.4) | P0 | 1.5 |
| Credential cache and invalidation, key encoding, grant validation (4.2, 4.5, 4.6) | P1 | 1.5 |
| Error responses and status codes, trailing slash, `BASE_PATH`, secret files, update source (4.7 through 4.9, 4.12 through 4.15) | P1 | 1.5 |
| Version self-check and v2.4 field probe (2.1, 2.2) | P0 | 0.5 |
| List-API capability probe (`ListBucketsInfo`, `ListKeysInfo`) (2.3, 5.22) | P0 | 1 |
| Concurrency cap, timeouts, and cancellation (4.11, 6.3) | P1 | 1 |

## Phase 2B: Basic management pages (P0, about 5.5 person-days)

| Item | Estimate |
|---|---|
| Bucket list, create, delete, aliases (5.1) | 1 |
| Quotas and permissions (5.18, 5.19) | 1 |
| Key list, create, import, delete, `UpdateKey` (rename, expiration, allow bucket creation), view the secret (5.7) | 1 |
| Cluster health, status, and statistics cards (5.9, and 5.10 without the metrics panel) | 1 |
| Basic user management: create and delete, disable, change role, reset password, and lockout protection (the core part of 5.20) | 1 |
| Download and share permission bits: data model, authorization check, UI switch, and tests (3.19) | 0.5 |

## Phase 3: Object experience (P1, about 8 person-days)

| Item | Estimate |
|---|---|
| Paginated browse, search, and sort (5.2, the object part of 5.22) | 1.5 |
| Streamed upload, multipart, upload queue, temporary-file handling, streamed download, and byte-range reads (5.3, 4.10, 6.2, the backend part of 5.32) | 2.5 |
| Batch delete and bulk ZIP download (5.4, 5.6) | 1.5 |
| Sharing and permissions (5.5, 3.10) | 1 |
| Cleanup of incomplete uploads (5.14) | 0.5 |
| Bounded thumbnails (6.2) | 1 |

## Phase 3A: UI and interaction (P0 and P1, about 6 person-days)

| Item | Priority | Estimate |
|---|---|---|
| Navigation and page structure, shared interaction states, graded confirmation (5.25 through 5.27) | P0 | 2 |
| List filtering, sorting, and multi-select, copying a credential, upload panel (5.30, 5.31, 5.33) | P0 | 1 |
| Theme and accessibility, version and capability notice (5.35, 5.36) | P1 | 1 |
| Layout change flow and tracking, overview visualization and auto-refresh (5.28, 5.29) | P1 | 1.5 |
| Admin-token scope picker, preview-viewer enhancements (5.34, 5.32) | P1 | 0.5 |

## Phase 4: Garage v2.3 and v2.4 management capabilities (P1, about 6.5 person-days)

| Item | Estimate |
|---|---|
| CORS and lifecycle (5.16) | 2 |
| Metrics panel (5.10) | 1 |
| Layout preview, history, skip dead nodes (5.8) | 1.5 |
| Restricted admin tokens, and a self-check of this project's token (5.15, the recommended item in 3.7) | 2 |

## Phase 5: Operations capabilities (P2, about 6 person-days)

| Item | Estimate |
|---|---|
| Workers and repair tasks (5.11) | 2 |
| Block errors and metadata snapshots (5.12, 5.13) | 1.5 |
| Audit log page, filter and export, retention (5.21) | 1.5 |
| `InspectObject` diagnostics (5.2) | 1 |

## Phase 6: Extensions and distribution (P2, about 6 person-days)

| Item | Estimate |
|---|---|
| Complete user management, and the offline CLI (5.20) | 1.5 |
| Signed releases, SBOM, multi-arch (7.9) | 1.5 |
| i18n (6.7) | 1.5 |
| Helm Chart, and the self-signed certificate option | 1.5 |

Items in phase 3A that depend on a later phase (5.28 depends on the layout API from phase 4, 5.34 depends on 5.15, and the audit widget in 5.29 depends on 5.21) are wired in after that dependency is delivered. The wiring work is already included in the estimates for those items.

Section 5.17, website access, has a requirement and acceptance in the original draft. 8.1, 8.2, and the phase table above do not give it a row of its own. When the work is broken down, do not assign it to a phase.

## Originally excluded scope

The original plan excluded: OIDC login (including mapping roles from the identity source, and single logout), bucket-level authorization by team, multi-cluster management, listening on a unix socket and connecting to one, multi-replica deployment, and tracking the next major version of the Garage Admin API.

## Original estimate totals (historical)

P0 is 23 person-days. P1 is 21.5 person-days. P2 is 12 person-days. The total is 56.5 person-days (the later work is not included).

The minimum-version estimate is 32.75 person-days. Phases 0, 1, 2, and 2B are 24 person-days in full. From phase 3, browse is 1.5, upload and download are 2.5, and batch delete is counted as half of the "batch delete and ZIP" item, which is 0.75. The two P0 items in phase 3A total 3, plus 1 for the theme and the About page. The scope follows 8.1 of [scope.md](scope.md).
