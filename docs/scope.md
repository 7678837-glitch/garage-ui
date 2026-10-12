# Goals, scope, and the minimum version

## 1. Goals and scope

### 1.1 Goals

This project is a self-hosted web admin UI for Garage (an S3-compatible distributed object store). One Rust binary embeds the frontend single-page application. It is for cluster administrators and read-only operators, and it provides day-to-day management of the cluster, the layout, buckets, keys, and objects.

Goals of this phase:

1. Safe by default. Login is required out of the box. No response leaks a cluster secret. Object preview cannot be an entry point for script injection.
2. Correct. Bucket addressing, the credential cache, deletion, capacity, encoding, and the related behavior are implemented as [correctness.md](correctness.md) requires. Each item has an automated test.
3. Aligned with Garage. Support only Garage v2.3.0 and later (v2.4.1 is recommended). Cover all 46 Admin API v2 endpoints, and use the unpublished main-v2 list APIs through a capability probe.
4. Maintainable. Builds are repeatable, toolchain versions are pinned, CI is fully green, dependency vulnerabilities are at zero, and types are generated from the Garage OpenAPI document.

### 1.2 In scope

- Cluster health, status, statistics, and layout (including preview, history, and skipping dead nodes).
- Buckets: create, delete, update, aliases, quotas, website access, CORS, lifecycle, and permissions.
- Keys: create, delete, update, import, allow bucket creation, and expiration.
- Objects: browse, upload, download, delete, bulk actions, sharing, and cleanup of incomplete uploads.
- Operations: Workers, repair tasks, block errors, metadata snapshots, restricted admin tokens, and metrics.
- This project itself: multiple users and roles, sessions, the audit log, configuration, and containerized deployment of the admin UI (`linux/amd64` and `linux/arm64`).

### 1.3 Out of scope

- Do not implement S3 features that Garage does not support (see 5.24 of [features-data.md](features-data.md)).
- Do not install a Garage node, upgrade one, or edit a Garage configuration file. Garage in a local container is only for tests, evaluation, and the example deployment.
- Do not offer an anonymous access mode.
- An external identity source (OIDC or LDAP) is listed as a later option. It is not delivered in this phase.

## 8. The minimum version

The minimum version is the first version that can be delivered outside the project. It may be released once every condition below is met. The other features are delivered in the later phases of [roadmap.md](roadmap.md).

### 8.1 Required features

| Module | Scope |
|---|---|
| Account | Setup wizard, log in and log out, change password. Two roles, administrator and read-only, plus download and share permission bits that can be granted to a read-only user (3.1, 3.4, 3.5, 3.19). |
| Security baseline | Every P0 in [security.md](security.md): authentication by default, secrets are not leaked, examples contain no secrets, the browser does not hold a Garage token, CSRF, rate limiting, an endpoint allowlist proxy, security headers, a request-body limit, and `no-store` on objects. |
| Cluster | Health, status, and cluster statistics (5.9, and 5.10 without the metrics panel). |
| Buckets | Paginated list, create, delete, aliases, quotas, and grant or revoke permissions (5.1, 5.18, 5.19). |
| Keys | Paginated list, create, delete, rename, allow bucket creation, and view the secret (a second confirmation) (5.7). |
| Objects | Paginated browsing, prefix navigation, safe preview, streamed download, streamed upload (including multipart), single and batch delete, and recursive delete (5.2 through 5.4). |
| UI | Navigation and page structure (5.25), shared interaction states (5.26), graded confirmation (5.27), one-time display and copy of a credential (5.31), list filtering and sorting and object multi-select (5.30), the upload panel (5.33), light and dark themes and basic accessibility (5.35). |
| Version | A self-check that v2.3.0 is the minimum version, a capability probe of the list APIs, and an About page that shows the version and the capabilities (5.36). |
| Delivery | A non-root image with a read-only root filesystem (`linux/amd64` and `linux/arm64`), a compose example with no secrets, CI fully green, and E2E against v2.3.x and v2.4.1. |

### 8.2 Not in the minimum version

Layout editing and the change flow (5.28). Admin tokens and the scope picker (5.34). Overview capacity ranking and auto-refresh (5.29; the minimum version does only the health and statistics cards). Range reads and switching in the object preview viewer (5.32; the minimum version does only allowlisted inline preview). Workers, repair, block errors, and snapshots. CORS and lifecycle. Share links. ZIP bulk download. Thumbnails. The audit page (audit writes are still in the minimum version). i18n, Helm, multiple clusters, and an external identity source.

### 8.3 Quality bar for the minimum version

- Every P0 in chapter 3 has an automated test. Backend coverage is at least 80%. Security-related packages are at least 95%.
- Reachable vulnerabilities in Rust dependencies are 0. High and above in frontend production dependencies are 0. The secret scan is 0.
- With simulated data of 10,000 buckets and 100,000 objects under a single prefix, the first screen of a list appears within 2 seconds, and there is no extra request per object.
- A 5 GB upload and a 5 GB download complete under a 256 MB memory limit (the test raises the upload limit explicitly).
- Estimate: 32.75 person-days. The algorithm is at the end of [roadmap.md](roadmap.md). That number comes from the original draft. It was not recomputed for the switch to Rust and Bun. The minimum-version scope is fixed by 8.1. Do not cut it down.
