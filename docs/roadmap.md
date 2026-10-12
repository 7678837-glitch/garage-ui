# Phased delivery

Effort is counted for one developer who knows Rust and React (person-days). The numbers follow the original draft. They were not recomputed because the backend changed to Rust or because the frontend toolchain changed to Bun. Phases are ordered by dependency. A later phase depends only on the output of the phases before it.

A phase is complete when every acceptance criterion this chapter cites has passed. Garage v2.3.x and v2.4.1 in local containers may be used to verify that.

Parallel development is described in [decisions.md](decisions.md). Split work by the items in this chapter. Items that change the same set of files do not run in parallel. The main session closes full-suite tests and commits.

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

## Later

Not in this round: OIDC login (including mapping roles from the identity source, and single logout), bucket-level authorization by team, multi-cluster management, listening on a unix socket and connecting to one, multi-replica deployment, and tracking the next major version of the Garage Admin API.

## Total

P0 is 23 person-days. P1 is 21.5 person-days. P2 is 12 person-days. The total is 56.5 person-days (the later work is not included).

The minimum-version estimate is 32.75 person-days. Phases 0, 1, 2, and 2B are 24 person-days in full. From phase 3, browse is 1.5, upload and download are 2.5, and batch delete is counted as half of the "batch delete and ZIP" item, which is 0.75. The two P0 items in phase 3A total 3, plus 1 for the theme and the About page. The scope follows 8.1 of [scope.md](scope.md).
