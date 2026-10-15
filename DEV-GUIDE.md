# Development guide for the Garage web admin UI (this project)

> For current development commands and AI-assisted contribution guidance, use [Contributing](CONTRIBUTING.md). This historical draft includes superseded Go/pnpm instructions; do not use them to build or test the current Rust/Bun implementation. GitHub Actions are disabled during development.
>
> For implemented areas, outstanding acceptance, and deferred work, use the [delivery roadmap](docs/roadmap.md) and its revision-specific evidence. Historical phase language below does not identify remaining work.
>
> Status: original requirements draft. The working spec is [`docs/README.md`](docs/README.md). When this file conflicts with `docs/`, `docs/` wins.
> Decisions already absorbed: the backend is written in Rust; the frontend toolchain is Bun; multiple agents may develop in parallel; Garage may run in a local container for tests and evaluation. For the runtime crates, containerized deployment of the admin UI itself, and the removal of daisyUI and zustand, see [`docs/decisions.md`](docs/decisions.md).
> Audience: K, the maintainer of this project.
> Basis: the official Garage documentation and the Admin API v2 OpenAPI description in the Garage source (v2.3.0, v2.4.1, and main-v2 commit ced85f8), plus ordinary web security practice.
> This document only says what this project does and how to accept it. It contains no source code. Endpoint names and field names follow the Admin API v2 definition in the Garage source.

---

## 1. Goals and scope

### 1.1 Goals

This project is a self-hosted web admin UI for Garage (an S3-compatible distributed object store). One Go binary embeds the frontend single-page application. It is for cluster administrators and read-only operators, and it provides day-to-day management of the cluster, the layout, buckets, keys, and objects.

Goals of this phase:

1. Safe by default. Login is required out of the box. No response leaks a cluster secret. Object preview cannot be an entry point for script injection.
2. Correct. Bucket addressing, the credential cache, deletion, capacity, encoding, and the related behavior are implemented as chapter 4 requires. Each item has an automated test.
3. Aligned with Garage. Support only Garage v2.3.0 and later (v2.4.1 is recommended). Cover all 46 Admin API v2 endpoints, and use the unpublished main-v2 list APIs through a capability probe.
4. Maintainable. Builds are repeatable, toolchain versions are pinned, CI is fully green, dependency vulnerabilities are at zero, and types are generated from the Garage OpenAPI document.

### 1.2 In scope

- Cluster health, status, statistics, and layout (including preview, history, and skipping dead nodes).
- Buckets: create, delete, update, aliases, quotas, website access, CORS, lifecycle, and permissions.
- Keys: create, delete, update, import, allow bucket creation, and expiration.
- Objects: browse, upload, download, delete, bulk actions, sharing, and cleanup of incomplete uploads.
- Operations: Workers, repair tasks, block errors, metadata snapshots, restricted admin tokens, and metrics.
- This project itself: multiple users and roles, sessions, the audit log, configuration, and deployment.

### 1.3 Out of scope

- Do not implement S3 features that Garage does not support (see 5.24).
- Do not install a Garage node, upgrade one, or edit a Garage configuration file.
- Do not offer an anonymous access mode.
- An external identity source (OIDC or LDAP) is listed as a later option. It is not delivered in this phase.

---

## 2. Compatible Garage versions and Admin API requirements

### 2.1 Versions

| Item | Requirement |
|---|---|
| Minimum supported | Garage v2.3.0 |
| Recommended version | Garage v2.4.1 (the current latest release) |
| Not supported | v2.2.x and earlier (including v1.x and v0.x). When the startup self-check finds a version that is too old, refuse the connection and prompt to upgrade. |
| Ahead of release | Use unpublished main-v2 list APIs through a capability probe (see 2.3). |
| Example deployment | The docs and the compose example use v2.4.1 by default. |

Version facts already checked against the Garage source:

- v2.3.0 and v2.4.1 have the same set of Admin API paths: 46 endpoints under `/v2`, plus `/health`, `/check`, and `/metrics`. `/check` validates a static-website domain. A reverse proxy uses it before issuing a certificate. It is not a connectivity check.
- v2.3.0 already has: `corsRules`, `lifecycleRules`, `websiteAccess`, and `quotas` on `UpdateBucket`; `GetBucketInfo` returns the fields of the same names; `GetClusterStatistics` and `GetNodeStatistics`; `GetClusterHealth` uses `storageNodesUp`. Implement these features directly on the v2.3.0 baseline. Do not branch by version.
- Present only on v2.4.x (probe by field, and hide the matching display when the field is missing):
  - Structured layout-calculation statistics in the `PreviewClusterLayoutChanges` and `ApplyClusterLayout` responses (`statistics`, including per-node and per-zone statistics). On v2.3.0, show only the text Garage returns.
  - The `addr`, `role`, `draining`, `isUp`, `metadataPartition`, and `dataPartition` fields of `GetNodeInfo`.
- Present only on main-v2 (unpublished): `ListBucketsInfo`, `ListKeysInfo`, and the `offset` and `limit` parameters of `ListBuckets` / `ListKeys`. Also `connectionParameters` on `GetNodeInfo`.

Acceptance:

- Run integration tests against both v2.3.x and v2.4.1. The core flows (log in, list buckets, browse, upload, delete, apply layout) all pass.
- On v2.3.x the layout preview page does not error. It shows only the text. When a node-detail field is missing, show "—".

### 2.2 Version self-check

- At startup, and on every reconnect to Garage, call `GetNodeInfo` (`node=self`) and read `garageVersion`. When it is below v2.3.0, show a blocking notice in the UI, and the backend rejects writes.
- Cache the capability-probe result in the process. Probe again after Garage reconnects.
- Acceptance: starting against a v2.2.x instance shows a clear notice, and no frontend exception appears.

### 2.3 main-v2 list APIs (capability probe)

- In main-v2, `ListBuckets` and `ListKeys` add `offset` and `limit`. When `limit` is omitted, they return at most 10000 rows. `ListBucketsInfo` and `ListKeysInfo` are added. One call returns a list that includes details. The default cap is 1000.
- Requirements:
  1. On the first call, probe whether `ListBucketsInfo` and `ListKeysInfo` are available. When they are, use them instead of "`ListBuckets` + `GetBucketInfo` per bucket".
  2. When they are not available (v2.3.x, v2.4.x), use `ListBuckets` plus bounded-concurrency detail calls (see 4.11). Load details lazily per page. Do not fetch details for every bucket at once.
  3. This project's outward list APIs paginate in one way. The frontend paginates, or it uses infinite scroll. It does not load the full set at once.
  4. When the number of rows returned equals `limit`, keep paging, or tell the user "there is more". Do not truncate silently.
- Acceptance: against a simulated Garage response of 12000 buckets, the list can be paged to the last row. Both paths have tests.

### 2.4 Admin API v2 endpoints this project uses

The path form is `/v2/<endpoint name>`.

| Category | Endpoint | Purpose |
|---|---|---|
| Cluster | `GetClusterHealth` | Home-page health card |
| | `GetClusterStatus` | Node list |
| | `GetClusterStatistics` | Cluster capacity and statistics |
| | `ConnectClusterNodes` | Connect nodes |
| Node | `GetNodeInfo` | Node detail and version self-check (v2.4 field probe) |
| | `GetNodeStatistics` | Node statistics |
| | `CreateMetadataSnapshot` | Metadata snapshot |
| | `LaunchRepairOperation` | Repair task |
| Layout | `GetClusterLayout`, `GetClusterLayoutHistory` | Current layout and history |
| | `UpdateClusterLayout`, `PreviewClusterLayoutChanges` | Stage a change and preview (`statistics` is v2.4+) |
| | `ApplyClusterLayout`, `RevertClusterLayout` | Apply or revert |
| | `ClusterLayoutSkipDeadNodes` | Skip dead nodes |
| Admin token | `ListAdminTokens`, `GetAdminTokenInfo`, `GetCurrentAdminTokenInfo` | List, detail, and self-check |
| | `CreateAdminToken`, `UpdateAdminToken`, `DeleteAdminToken` | Management (fields `name`, `expiration`, `scope`) |
| Key | `ListKeys`, `ListKeysInfo` (probe), `GetKeyInfo` | List and detail |
| | `CreateKey`, `ImportKey`, `UpdateKey`, `DeleteKey` | Management (includes `allow.createBucket` and `expiration`) |
| Bucket | `ListBuckets`, `ListBucketsInfo` (probe), `GetBucketInfo` | List and detail (query by id) |
| | `CreateBucket`, `UpdateBucket`, `DeleteBucket` | Management (`websiteAccess`, `quotas`, `corsRules`, `lifecycleRules`) |
| | `CleanupIncompleteUploads` | Clean up incomplete uploads |
| | `InspectObject` | Object diagnostics |
| Permission and alias | `AllowBucketKey`, `DenyBucketKey` | Grant and revoke |
| | `AddBucketAlias`, `RemoveBucketAlias` | Global and local aliases |
| Worker | `ListWorkers`, `GetWorkerInfo` | Worker list and detail |
| | `GetWorkerVariable`, `SetWorkerVariable` | Worker variables |
| Block | `ListBlockErrors`, `GetBlockInfo` | Block errors |
| | `RetryBlockResync`, `PurgeBlocks` | Retry and purge |
| Special | `/metrics` | Prometheus metrics (requires `metrics_token`) |
| | `/health` | Connectivity and read/write quorum check (no token required; returns success when the cluster can read and write) |

Not used: `CheckDomain` (Garage's website service uses it itself).

---

## 3. Security requirements

Every item is P0 unless it is marked otherwise.

### 3.1 Default authentication

- Requirement: there is no "skip login" mode. On the first start, when the user store is empty, every page leads to the setup wizard that creates the first administrator. After that finishes, that entry is closed permanently.
- Before setup is finished, every API returns 401 except the setup APIs and the status query.
- Default listen address. When the binary runs directly and nothing is configured explicitly, listen on `127.0.0.1`. When it must be exposed, an operator sets `HOST` explicitly. Inside the container image, listen on `0.0.0.0` by default (if the container listens only on the loopback address, a published port cannot reach it). The compose example maps the port only to the host's `127.0.0.1`. An operator changes that mapping explicitly when it should be reachable from elsewhere.
- Acceptance: when the binary runs directly and `HOST` is not set, it is reachable only on `127.0.0.1`. When the container image does not set `HOST`, it listens on `0.0.0.0`. After a start from the compose example, the host can reach `127.0.0.1:3909`, and other addresses on the host cannot. After a fresh start, an unauthenticated `GET /api/keys` returns 401. Submitting setup again after setup has finished returns 409.

### 3.2 Do not leak secrets

- The configuration API returns only the non-sensitive fields the frontend needs (S3 region, website root domain, whether sharing is enabled, version). Emit them from an allowlist struct.
- Never return `rpc_secret`, `admin_token`, `metrics_token`, any RPC address, or the admin listen address.
- Logs, error text, and audit records must not contain a token, a `secretAccessKey`, a password, or a password hash.
- Viewing a `secretAccessKey` is allowed only for an administrator. It requires a second confirmation, and it writes an audit record.
- Acceptance: assert a field allowlist on the configuration API response. A test scans log output for sensitive strings.

### 3.3 Preview XSS protection

- Add `X-Content-Type-Options: nosniff` to every object response.
- Only allowlisted types may be shown inline: common bitmaps (png, jpeg, gif, webp, avif, bmp, ico), `text/plain`, `application/pdf`, mp4 and webm video, and mpeg, ogg, and wav audio. SVG, HTML, XML, and JavaScript are never shown inline.
- Parsing a type ignores parameters and lowercases the type. A parse failure is treated as unsafe.
- For a type outside the allowlist, change `Content-Type` to `application/octet-stream`, add `Content-Disposition: attachment`, and encode the filename with RFC 5987.
- Add a sandbox CSP to object responses (`sandbox; frame-ancestors 'self'`). A PDF may allow scripts, and it must not be granted same origin.
- Site-wide security headers: a strict CSP (its own origin only, by default; `object` is forbidden; `frame-ancestors 'none'`), `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`.
- Optional (P1): serve preview from a presigned address on a separate domain, fully isolated from the admin UI.
- Acceptance: upload objects whose `Content-Type` is `text/html` and `image/svg+xml`. The preview request returns an attachment download and `octet-stream`. In the E2E test, the script does not run.

### 3.4 Sessions and cookies

- Rotate the session ID on a successful login, when setup finishes, when the password is changed, and on logout. On logout, destroy the server session.
- Session cookie: scripts cannot read it, `SameSite=Lax`, and `Path` follows `BASE_PATH`. `Secure` is on by default. It is turned off only when the deployment is explicitly configured as local cleartext.
- The absolute lifetime defaults to 24 hours. The idle timeout defaults to 2 hours. Both can be configured. An illegal value falls back to the default.
- Each request uses the live role and the disabled state from the user store on the server. A role saved in the session is only a display cache.
- Acceptance: the session ID is different before and after login. After logout, a request with the old cookie returns 401. After a user is disabled, that user's next request returns 401.

### 3.5 Rate limiting

- One shared rate-limit component. An in-process sliding window, default 10 times per minute.
  - Count login by "client address + lowercased username".
  - Count setup by client address.
  - Count password change by username.
  - Count share-link generation and download tokens by user (P1).
- The client address is the connection address by default. Read the last hop of a trusted proxy header only when that header is configured.
- Over the limit, return 429, with `Retry-After`.
- When the user does not exist, or is disabled, still run one hash comparison of equal duration. The error text is the same, so the account cannot be enumerated.
- Acceptance: the 11th request for the same key returns 429. After the window has passed, requests are accepted again. Counts for different usernames do not affect each other.

### 3.6 CSRF

- Double-submit cookie. The server sets a random token cookie (a frontend script may read it). Every POST, PUT, PATCH, and DELETE must send an `X-CSRF-Token` header, and the comparison is constant-time.
- Only two APIs are exempt: login and setup.
- This project's own `/api` allows no cross-origin access. That is separate from the CORS rules configured on a Garage bucket in 5.16.
- Acceptance: a missing header, or a header that does not match, returns 403. A test pins the exemption list.

### 3.7 Endpoint allowlist proxy

- Do not pass the Admin API through on a wildcard. The backend exposes one explicit allowlist. Each record contains the Garage endpoint name, the allowed methods, the required role, and whether the call writes an audit record.
- A path outside the allowlist is always 404.
- Sensitive endpoints (`CreateAdminToken`, `UpdateAdminToken`, `PurgeBlocks`, `LaunchRepairOperation`, `SetWorkerVariable`, `ClusterLayoutSkipDeadNodes`, and `GetKeyInfo` with `showSecretKey`) are available only to an administrator, and they require a second confirmation.
- The backend never forwards the client's query parameters to `GetKeyInfo`. An ordinary query is fixed so that it does not send `showSecretKey`. Viewing a secret goes only through this project's dedicated API (5.7). The backend adds `showSecretKey=true` itself.
- The allowlist must cover every endpoint each feature actually calls: every endpoint in the table in 2.4, `ListBucketsInfo` and `ListKeysInfo` used by the capability probe, and `/metrics`. In CI, a table-driven test checks that the endpoints each feature declares ⊆ the allowlist.
- If this project uses a restricted admin token, that token's scope must include every endpoint on the allowlist. When the metrics panel is required, the scope must also include the scope value `Metrics` (the endpoint name of `/metrics`), or `metrics_token` is configured on its own. `GetCurrentAdminTokenInfo` can be called with any valid token. It does not have to be listed in the scope.
- Recommended (P1): this project uses a scope-restricted Garage admin token (the scope lists only allowlisted endpoints), not a full-authority `admin_token`. At startup, self-check with `GetCurrentAdminTokenInfo`, and show the token's scope and expiration time in the UI.
- Acceptance: a read-only role calling any write endpoint returns 403. Calling an endpoint that is not on the allowlist returns 404. A table-driven test covers the whole allowlist.

### 3.8 Non-root container

- The runtime image uses the nonroot variant of distroless static. It runs as a non-root user. The root filesystem can be used read-only.
- `/data` is the only writable volume.
- Acceptance: the id inside the container is not 0. A start with `--read-only` works.

### 3.9 Request body size limit

- Every JSON API shares one upper bound (default 1 MiB), applied in middleware.
- The upload API has its own bound, `MAX_UPLOAD_SIZE_MB` (default 512, configurable). When `Content-Length` is over the bound, return 413 before reading the body. When a streamed read goes over the bound, abort it the same way and return 413.
- Acceptance: a 2 MiB JSON request to any API returns 413. An upload over the limit returns 413, and no temporary file is left.

### 3.10 Share link permission

- Generating a presigned link is available only to an administrator by default. It may be granted to a read-only user through the separate "share" permission, and that user must also have the "download object content" permission (3.19). A read-only role cannot generate a link by default.
- The validity choices are 1 hour, 24 hours, and 7 days. The server enforces an upper bound of 7 days.
- Every generation writes an audit record (user, bucket, key, validity).
- When no public S3 address is configured, the feature is off and the API returns 501.
- Acceptance: a read-only user requesting a share returns 403. A validity period above the upper bound is truncated to 7 days.

### 3.11 Private objects are not cached for long

- For every authenticated response of object content, metadata, or a ZIP download: `Cache-Control: private, no-store`.
- Frontend static assets: do not cache `index.html`. Cache hashed assets for a long time, and mark them immutable.
- Acceptance: assert `no-store` on the response headers of an object download.

### 3.12 Persisted sessions, and invalidation after a password change

- Store sessions in the database (the same SQLite database as the user store). A restart does not drop the login. The store can keep sessions consistent when several replicas share that database (several replicas are P2).
- When the password is changed, an administrator resets the password, the user is disabled, the user is deleted, or the role is demoted, delete every other session of that user immediately. When the password is changed, keep the current session and rotate its ID.
- Acceptance: browsers A and B log in as the same account. After A changes the password, B's next request returns 401. After the process restarts, a session that has not expired is still valid.

### 3.13 Login audit and IP

- Write an audit record for a successful login, a failed login, a rate-limit hit, logout, setup, and a password change. Include the time (UTC), the username, the client IP, the result, and a reason code.
- An audit record does not contain the password or the request body.
- Acceptance: after one failed login, the audit table has one new record, and that record includes the IP.

### 3.14 Examples and images contain no secrets (P0)

- The repository, images, the compose example, Helm values, and the docs must not contain any real or "example" private key, signing key, session key, password, or S3 credential. Examples use placeholders only, and they say how to generate the real value.
- When the session signing key, or the session encryption key, is not configured, the first start generates one at random in the data directory and saves it so that only the owner can read it. Do not use a default that was compiled into the binary.
- At startup, check secrets that are already configured. If the length is too short, or the value is the same as a placeholder in the docs, refuse to start.
- CI runs a secret scan over the whole commit history. A hit fails the check. A test fixture needs an explicit allowlist entry, and that entry must say it is a test value.
- Acceptance: the secret-scan result is 0. After the data directory is deleted and the process is started again, a new secret is generated, and every old session is invalid.

### 3.15 The browser does not touch the Garage admin token (P0)

- The Garage admin token and `metrics_token` exist only on the server. Every Garage call from the frontend goes through this project's backend allowlist proxy.
- The frontend does not store a token or a session credential in `localStorage`, `sessionStorage`, or `IndexedDB`. The session uses only a cookie that scripts cannot read.
- Acceptance: E2E checks browser storage and every response body. An admin token does not appear, and a session ID does not appear.

### 3.16 No switch that turns checks off and allows every request (P0)

- There is no configuration item that turns authentication off. Any error in the authentication configuration fails startup. It does not let the request through.
- Acceptance: table-driven tests for a missing configuration and for an illegal configuration all exit with a non-zero status.

### 3.17 External TLS (P1)

- When connecting to Garage, and when connecting to an identity source (that source is later), verify the certificate by default. A custom CA file is supported. "Skip verification" can be turned on only by an explicit setting. The startup log and the UI keep showing a warning.

### 3.18 Other hardening (P1)

- Passwords use bcrypt. A password is at least 10 characters, at most 72 bytes, and not entirely whitespace.
- The offline CLI resets a password by reading it from the terminal or from standard input. The password is not passed as a command-line argument. There is no reset entry on the network.
- Self-signed certificates: a custom CA file is supported. "Skip certificate verification" exists only as an explicit switch, and the UI shows a warning.

### 3.19 Role and operation matrix

A = administrator. V = read-only. D = a read-only user who has been granted the "download object content" permission. S = a read-only user who has been granted the "share" permission. D and S are independent permissions added on top of V. Both default to off. Granting S requires that the user also has D, because a share link also takes the content out of the admin UI. The UI and the backend both enforce that constraint. "—" means the operation is unavailable, and the UI does not show an entry for it. The backend authorizes from this table and from no other rule.

| Operation | A | V | V+D | V+D+S |
|---|---|---|---|---|
| View cluster health, status, nodes, layout, and history | ✔ | ✔ | ✔ | ✔ |
| View cluster statistics and node statistics | ✔ | ✔ | ✔ | ✔ |
| View the Prometheus metrics panel (summary metrics, with no credentials) | ✔ | ✔ | ✔ | ✔ |
| Change the layout, connect nodes, skip dead nodes | ✔ | — | — | — |
| View the bucket list and bucket detail (aliases, quotas, website, CORS, lifecycle) | ✔ | ✔ | ✔ | ✔ |
| Create and delete buckets, and change aliases, quotas, website, CORS, and lifecycle | ✔ | — | — | — |
| View the keys and permissions on a bucket (the secret is not included) | ✔ | ✔ | ✔ | ✔ |
| Grant and revoke bucket permissions | ✔ | — | — | — |
| View the key list and key detail (the secret is not included) | ✔ | ✔ | ✔ | ✔ |
| View the S3 secret | ✔ (a second confirmation, and an audit record) | — | — | — |
| Create, import, change, and delete keys | ✔ | — | — | — |
| Browse the object list, metadata, and search | ✔ | ✔ | ✔ | ✔ |
| Preview and download an object, download a ZIP, and view thumbnails | ✔ | — | ✔ | ✔ |
| Upload and delete objects, and clean up incomplete uploads | ✔ | — | — | — |
| Generate a share link | ✔ | — | — | ✔ |
| `InspectObject` diagnostics | ✔ | — | — | — |
| Workers, repair, block errors, and metadata snapshots (view) | ✔ | — | — | — |
| Worker variables, repair, retry, purge blocks, and snapshots (run) | ✔ | — | — | — |
| Admin tokens (view and manage) | ✔ | — | — | — |
| Audit log (view and export) | ✔ | — | — | — |
| User management | ✔ | — | — | — |
| Change your own password, and the theme | ✔ | ✔ | ✔ | ✔ |

- Operations pages (Workers, block errors and block information, metadata snapshots, and repair) are not open to a read-only role for viewing. Only an administrator can use them. Reason: these pages are internal diagnostic information, not a status overview. Block information includes the bucket ID, the object key, and the internal version ID. Block errors show disk and data-corruption detail. Worker variables and errors include internal tuning parameters and node paths. A read-only user has no follow-up action they can take after seeing that information. The health information a read-only role needs is already on the cluster health, status, and statistics pages.
- Data model. A user record contains a role (`admin` or `viewer`) and a permission set (two boolean bits, `download` and `share`, default false). For an admin, the two bits mean nothing and are ignored. On save, check that if `share` is true, then `download` must be true. The session does not cache permissions. Each request reads them live from the user store, as 3.4 says. Granting or revoking a permission writes an audit record.
- Acceptance: a table-driven test covers every row of this table, across all four columns. A request from V for object preview, download, a thumbnail, or a ZIP token returns 403. After D is granted, those requests succeed. A save that grants S and does not grant D returns 400. After D is revoked, a ZIP token that this user has already exchanged and has not yet used becomes invalid. A request from V to any operations API returns 403.

---

## 4. Correctness requirements

Each item states the requirement, then the acceptance criteria. The default priority is P1, except where an item is marked otherwise.

### 4.1 Address buckets by bucket ID, not by a global alias (P0)

- Requirement: every bucket API (detail, browse, upload, delete, share, permissions) addresses the bucket by its Garage bucket ID. An alias is for display only. A bucket that has only a local alias, or no global alias at all, must still support the full set of operations.
- Acceptance: create a bucket that has only a local alias. Browse, upload, and delete succeed. An alias that contains `&` or `=` does not affect the operation.

### 4.2 Credential cache and permission revocation take effect promptly

- Requirement:
  1. The S3 credentials used to browse objects prefer a key reserved for this project (configurable). Only when that key is absent does an administrator explicitly choose one for the bucket. The product no longer implicitly picks an arbitrary read-write key.
  2. When no usable credential can be found, do not cache an empty result. Return a clear error at once (412, with the message "This bucket has no usable read-write key").
  3. The credential-cache TTL is at most 60 seconds. After this project runs `AllowBucketKey`, `DenyBucketKey`, `DeleteKey`, or `UpdateKey`, clear the related cache immediately.
  4. When S3 returns 403, clear the cache and retry once.
- Acceptance: after a key is revoked, the next browse does not use that key. Grant access when there was no key, and browse works immediately.

### 4.3 Recursive delete pages until every object is deleted (P0)

- Requirement: when deleting a "folder", list every object under the prefix, one page at a time (at most 1000 per page), and call batch delete in batches until the listing is finished. Return the deleted count and a per-object error list (the error list is always an array). On a partial failure, return 207, or 200 plus the error details. Do not report "all succeeded".
- Acceptance: all 2500 objects under the prefix are deleted, and the response is `deleted=2500`. When 3 of those objects are injected as failures, the response contains 3 errors.

### 4.4 Capacity precision (P0)

- Requirement: node capacity uses bytes as the internal unit. Display it in the unit the user chose, with at least two decimal places. When the edit form writes the value back, do not round half up and do not floor it to an integer unit. A node whose capacity was not changed must not be rewritten.
- Acceptance: open the editor for a 1.8 TB node, save with no changes, and the `capacity` submitted to `UpdateClusterLayout` is byte-for-byte equal to the original value.

### 4.5 URL-encode object keys

- Requirement: when the frontend builds a path, encode the key by segment. The backend decodes it and passes the original value to S3. Write the download filename into `Content-Disposition` with RFC 5987 encoding. A folder name forbids only control characters and `/`. `=`, `#`, `?`, `%`, spaces, and non-ASCII characters are allowed.
- Acceptance: objects named `a?b#c%20d=e` and 中文名 can be browsed, previewed, downloaded, deleted, and shared.

### 4.6 Validate when assigning a key

- Requirement: in the grant dialog, the submit button is disabled when no key is selected or no permission is checked. When the request fails, show the error. Do not report success.
- Acceptance: frontend component tests cover both "empty selection" and "request failure".

### 4.7 Do not write a success response after a request error

- Requirement: every handler stops immediately after it writes an error response. It must not write a status code again or append to the response body. Use one response helper. A repeated write fails immediately in test mode.
- Acceptance: when `HeadObject` fails, the response body contains only the error JSON, and the log has no duplicate-write warning.

### 4.8 Preserve the real status code

- Requirement: when Garage or S3 returns a non-JSON error body, pass through the original status code and place the truncated text in the unified error structure. A missing object returns 404, not 500.
- Acceptance: when Garage returns 403 as plain text, this project returns 403. HEAD of a missing object returns 404.

### 4.9 Trailing slash on endpoint URLs

- Requirement: when parsing `API_BASE_URL`, `S3_ENDPOINT_URL`, and `S3_PUBLIC_ENDPOINT_URL`, strip a trailing slash. Join paths with a URL join function. A value that contains only slashes counts as unset.
- Acceptance: with and without a trailing slash on the configured value, the request targets the same address.

### 4.10 Handling of upload temporary files

- Requirement: an upload streams to S3 by default and does not land in a temporary file. When it must be written to disk, write it only in the configurable temporary directory (`/data/tmp` inside the image, or a mounted tmpfs). Delete it when the request ends, on success or on failure. A large file uses S3 multipart upload. Abort the multipart upload on failure.
- Acceptance: with the upload limit set to at least 3 GB, a 2 GB upload succeeds in a container whose root filesystem is read-only. After a disconnect midway, no temporary file and no incomplete multipart upload remain (or the incomplete upload is visible under "incomplete uploads" and can be cleaned up).

### 4.11 Concurrency cap

- Requirement: every fan-out call to Garage (per-bucket detail, per-node info) uses bounded concurrency. The default is 8, and it is configurable. The frontend upload queue defaults to 3 concurrent uploads.
- Acceptance: with 1000 buckets, at most 8 `GetBucketInfo` requests are in flight at the same time.

### 4.12 BASE_PATH handling

- Requirement: a subpath deployment uses relative asset paths in the build output, and the server injects the base metadata. Do not replace strings inside JS text. Normalize `BASE_PATH` so that it starts with `/` and does not end with `/`. A request to the root path returns 301 to `BASE_PATH`. The cookie `Path` follows `BASE_PATH`. Compute the injected value once at startup.
- Acceptance: under both `BASE_PATH=/admin` and an empty value, refreshing any deep route loads, and no static asset returns 404.

### 4.13 Strip newlines when reading a secret file

- Requirement: every sensitive setting supports a `*_FILE` variant (`API_ADMIN_KEY_FILE`, `METRICS_TOKEN_FILE`, S3 credential files, and the same pattern for the other sensitive settings). The `_FILE` variant takes priority. After a read, strip trailing CR/LF and keep the content in the middle. Read once at startup. On a read failure, the error includes only the path and does not print the contents.
- Acceptance: when the file ends with CRLF, the Bearer header is correct. When the file does not exist, startup fails and the error text contains no secret.

### 4.14 The update source is configurable

- Requirement: the update check is off by default. Configuration or build parameters set both the check address and the release-signing public key. They belong to this project's own release source. When they are not configured, hide the feature.
- Acceptance: when no update source is configured, the product makes no outbound request.

### 4.15 Other

- A config file that fails to parse behaves the same as a missing file. Both cases log a warning and fall back to environment variables. When a required item is missing, report a clear startup error. Do not exit by crashing.
- The auth-status API returns whether the caller is logged in. It must not be constantly true.
- The `Content-Type` a thumbnail declares matches the actual encoding.
- Read the S3 endpoint and region from configuration first. When Garage provides `GetNodeInfo.connectionParameters` (the main-v2 capability probe), that value may fill them in.
- Use the endpoint configuration that the S3 SDK currently recommends, so the deprecation warning is gone.

---

## 5. Feature list

Each item contains the requirement, the external API (under this project's `/api`), the corresponding Garage endpoint, and the acceptance criteria. Role abbreviations: A = administrator, V = read-only.

### 5.1 Buckets

- Requirement: a paginated list (name, alias, object count, capacity, quota usage), create (an optional global alias), delete (prompt when the bucket is not empty), and add or remove aliases (global and local).
- API: `GET /api/buckets?offset&limit` (A/V); `POST /api/buckets` (A); `DELETE /api/buckets/{id}` (A); `POST`/`DELETE /api/buckets/{id}/aliases` (A).
- Garage: `ListBucketsInfo` or `ListBuckets` + `GetBucketInfo`, `CreateBucket`, `DeleteBucket`, `AddBucketAlias`, `RemoveBucketAlias`.
- Acceptance: a bucket with only a local alias appears in the list and can be opened. Deleting a non-empty bucket returns Garage's error, and the UI shows that error.

### 5.2 Browsing objects

- Requirement: prefix navigation and breadcrumbs, split on `/`. Pagination (default 100, maximum 1000, continuation token). An S3 list returns keys only in lexicographic order and supports only a prefix filter, so the order across pages is fixed as key lexicographic order. Sort by size or by time applies only to the page already loaded, and the UI states "this page only". Substring search inside a prefix (at least 2 characters, at most 200 hits, at most 20 pages scanned). Safe preview. Object metadata and `InspectObject` diagnostics (A).
- API: `GET /api/buckets/{id}/objects?prefix&limit&next`; `GET /api/buckets/{id}/objects/{key}` (metadata, view, download); `GET /api/buckets/{id}/search?q&prefix`; `GET /api/buckets/{id}/inspect/{key}` (A).
- Garage: S3 `ListObjectsV2`, `HeadObject`, `GetObject`; Admin `InspectObject`.
- Acceptance: 5000 objects can be browsed page by page. When a search is truncated, the response includes a reason field. Preview meets 3.3.

### 5.3 Upload

- Requirement: drag and drop, or pick multiple files. Folder upload keeps relative paths. The upload queue runs 3 at a time, can be cancelled, can be retried, and shows progress. A same-name object prompts for overwrite confirmation. A large file uses multipart upload automatically. The per-file limit is configurable.
- API: `PUT /api/buckets/{id}/objects/{key}` (A). Multipart: POST to start, PUT for a part, POST to complete, DELETE to abort (A).
- Garage: S3 `PutObject`, `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload`.
- Acceptance: while a 1 GB file is uploading, server resident memory grows by at most 64 MB. After cancel, the multipart upload is aborted.

### 5.4 Delete

- Requirement: delete one object, batch-delete a multi-selection (at most 1000 keys per call), and recursively delete a folder (see 4.3). Each one requires a confirmation dialog.
- API: `DELETE /api/buckets/{id}/objects/{key}[?recursive=true]`; `POST /api/buckets/{id}/objects:delete` (`keys[]`) (A).
- Garage: S3 `DeleteObject`, `DeleteObjects`, `ListObjectsV2`.
- Acceptance: a batch of 1001 keys returns 400. A partial failure is returned object by object.

### 5.5 Sharing

- Requirement: generate a presigned GET link (1 hour, 24 hours, or 7 days). When the bucket has website access enabled, also give the public website address. Permissions are in 3.10.
- API: `POST /api/buckets/{id}/share` (key, expires) (A, or a caller who has the share permission).
- Garage: S3 presigning (uses the public S3 address and region). The website address is generated from a configuration template (the template must contain `{bucket}`).
- Acceptance: the generated link can be used to download within its validity period, and returns 403 after it expires. A record is visible in the audit log.

### 5.6 Bulk download

- Requirement: pack selected objects, or a folder, into a ZIP and download it as a stream. First exchange a one-time token (valid for 60 seconds, usable only once, bound to the user and the bucket), then download. Inside the ZIP, drop the common prefix, clean path traversal and drive letters, and append a sequence number when names collide. When a single object fails, write an error-list file inside the ZIP.
- API: `POST /api/buckets/{id}/archive-token` (A, or a V who has the download permission); `GET /api/buckets/{id}/archive?token=` (the same callers).
- Garage: S3 `GetObject`.
- Acceptance: a read-only user without the download permission gets 403 when exchanging a token. A second use of a token returns 404. Another user using the token returns 403. A key that contains `../` is cleaned inside the ZIP. When packing 1000 objects, the process peak memory grows by at most 64 MB.

### 5.7 Keys

- Requirement: a paginated list. Create (a new name is limited to letters, digits, `_`, and `-`. The name of an imported key, or of a key that already exists, is shown as-is and is not validated). Import. Rename. Set an expiration time, or set the key to never expire (`neverExpires`). A switch for allowing bucket creation (`allow.createBucket`). Delete. View the secret (A, a second confirmation, and an audit record).
- API: `GET`/`POST /api/keys`; `GET`/`PATCH`/`DELETE /api/keys/{id}`; `POST /api/keys/import`; `POST /api/keys/{id}/secret` (A).
- Garage: `ListKeysInfo` or `ListKeys`, `GetKeyInfo`, `CreateKey`, `ImportKey`, `UpdateKey` (`name`, `expiration`, `allow.createBucket`, `deny.createBucket`), `DeleteKey`.
- Acceptance: after allowing bucket creation is turned on, that key can create a bucket through S3. After the key is deleted, the browse credential cache is invalid (see 4.2).

### 5.8 Layout

- Requirement: assign and change node roles (zone, capacity, tags; an empty capacity means a gateway node), and remove a role. View and change the layout parameter `zoneRedundancy` (`"maximum"`, or at least N zones). A list of staged changes (from `stagedRoleChanges` and `stagedParameters` on `GetClusterLayout`). Before apply, call preview and show the preview result (v2.4 and later show structured statistics, v2.3 shows text). When preview returns the error branch, show the error and forbid apply. Apply (version = current + 1), or revert every staged change. Layout history. Skip dead nodes (A, a strong confirmation, and a statement of the risk. Pass the current version. Separately choose whether `allowMissingData` is set. When it is selected, add one more strong confirmation that says data may be lost).
- API: `GET /api/layout`; `POST /api/layout/stage`; `POST /api/layout/preview`; `POST /api/layout/apply`; `POST /api/layout/revert`; `GET /api/layout/history`; `POST /api/layout/skip-dead-nodes`.
- Garage: `GetClusterLayout`, `UpdateClusterLayout`, `PreviewClusterLayoutChanges`, `ApplyClusterLayout`, `RevertClusterLayout`, `GetClusterLayoutHistory`, `ClusterLayoutSkipDeadNodes`.
- Acceptance: the "Apply" button is disabled when preview has not been run, or when preview returns an error. Capacity precision meets 4.4. The history page shows each version and its sync status.

### 5.9 Cluster health

- Requirement: the home-page card shows status, the number of known nodes, the number of connected nodes, the number of storage nodes and how many are up (`storageNodesUp`), and partition status. A node list, and connect nodes.
- API: `GET /api/cluster/health`; `GET /api/cluster/status`; `POST /api/cluster/connect` (A).
- Garage: `GetClusterHealth`, `GetClusterStatus`, `GetNodeInfo`, `ConnectClusterNodes`.
- Acceptance: the numbers are correct on both v2.3.x and v2.4.1. When Garage is unreachable, show an error instead of a blank screen.

### 5.10 Statistics

- Requirement: cluster and node statistics (capacity, free space, bucket count, object count, total amount). An optional Prometheus metrics summary (S3 request count, error count, block read and write bytes). Note: when Garage's `/metrics` is configured with `metrics_token` (or requires a token), it accepts `metrics_token` or an admin token whose scope contains `Metrics` (or `*`). When neither is configured, no token is required. This project tries them in this order: a separately configured `metrics_token`, then this project's admin token. When neither can be used, the metrics panel shows a notice.
- API: `GET /api/cluster/statistics`; `GET /api/nodes/{id}/statistics`; `GET /api/metrics`.
- Garage: `GetClusterStatistics`, `GetNodeStatistics`, `/metrics`.
- Acceptance: a unit test parses Prometheus text. Every field of an empty response is 0.

### 5.11 Workers and repair tasks

- Requirement: list Workers by node (one node ID, or every node), with status, errors, and progress. The list can show only busy workers, or only workers in error. View detail. Read every Worker variable, or one Worker variable, and set a variable (the variable name and the value are both strings, A). Start a repair task (A, a strong confirmation, targeted at one node or every node). The type comes from the Garage definition: `tables`, `blocks`, `versions`, `multipartUploads`, `blockRefs`, `blockRc`, `rebalance`, `aliases`, `clearResyncQueue`, and `start`, `pause`, `resume`, and `cancel` of `scrub`.
- API: `GET /api/nodes/{id}/workers`; `GET /api/nodes/{id}/workers/{wid}`; `GET`/`PUT /api/nodes/{id}/worker-variables`; `POST /api/nodes/{id}/repair`.
- Garage: `ListWorkers`, `GetWorkerInfo`, `GetWorkerVariable`, `SetWorkerVariable`, `LaunchRepairOperation`.
- Acceptance: after a variable is set, reading it again returns the new value. A repair task writes an audit record.

### 5.12 Block errors

- Requirement: list block errors by node. View block information by block hash (a node must be specified). Retry resync (a specified block hash, or "retry all"). Purge blocks (A, a strong confirmation, stating that object data will be lost. One request may submit multiple block hashes).
- API: `GET /api/nodes/{id}/block-errors`; `GET /api/nodes/{id}/blocks/{hash}`; `POST /api/nodes/{id}/blocks/retry`; `POST /api/nodes/{id}/blocks/purge`.
- Garage: `ListBlockErrors`, `GetBlockInfo`, `RetryBlockResync`, `PurgeBlocks`.
- Acceptance: a read-only role calling purge returns 403. Purge requires typing the block hash to confirm.

### 5.13 Metadata snapshots

- Requirement: create a metadata snapshot for a specified node, or for every node (A).
- API: `POST /api/nodes/{id}/metadata-snapshot`.
- Garage: `CreateMetadataSnapshot`.
- Acceptance: a successful operation shows a notice and writes an audit record.

### 5.14 Clean up incomplete uploads

- Requirement: on the bucket detail page, list incomplete multipart uploads (key, uploadId, start time). Abort one, or abort all. Provide "clean up incomplete uploads older than N hours".
- API: `GET /api/buckets/{id}/multipart`; `DELETE /api/buckets/{id}/multipart`; `POST /api/buckets/{id}/cleanup-uploads` (`olderThanSecs`).
- Garage: S3 `ListMultipartUploads`, `AbortMultipartUpload`; Admin `CleanupIncompleteUploads`.
- Acceptance: after cleanup, entries older than the threshold no longer appear in the list, and the response returns the number cleaned up.

### 5.15 Restricted admin tokens

- Requirement: list, create, update, and delete Garage admin tokens (`name`, `expiration`, `scope`). On create, the secret is shown only once. A token whose scope contains `CreateAdminToken` or `*` is clearly warned as equivalent to full authority. Show the information of the token this project is currently using. A scope value is an Admin API endpoint name, `Metrics`, or `*`. `ListAdminTokens` lists `admin_token` and `metrics_token` from the configuration file as read-only entries. The UI labels them "from the configuration file" and does not offer update or delete.
- API: `GET`/`POST /api/admin-tokens`; `GET`/`PATCH`/`DELETE /api/admin-tokens/{id}`; `GET /api/admin-tokens/current`.
- Garage: `ListAdminTokens`, `GetAdminTokenInfo`, `CreateAdminToken`, `UpdateAdminToken`, `DeleteAdminToken`, `GetCurrentAdminTokenInfo`.
- Acceptance: only an administrator can see them. A token secret does not appear in any later response or in the logs.

### 5.16 CORS and lifecycle

- Requirement: in bucket settings, edit CORS rules (ID, allowed origins, methods, headers, exposed headers, max-age seconds) and lifecycle rules (ID, enabled state, exactly one of expiry days or an expiry date, a prefix filter and lower and upper object-size filters, and the number of days after which an incomplete upload is aborted). Validate the form. Show the diff before saving.
- Note: writes go through Admin `UpdateBucket` (the S3 API of the same name acts on the same configuration). `corsRules` and `lifecycleRules` are replaced as a whole set. Omitting a set means no change. Passing an empty array clears it. On a concurrent edit, show the diff against the version read again just before save.
- API: `GET`/`PUT /api/buckets/{id}/cors`; `GET`/`PUT /api/buckets/{id}/lifecycle`.
- Garage: `GetBucketInfo` (`corsRules`, `lifecycleRules`) and `UpdateBucket` (`corsRules`, `lifecycleRules`). Both are available from v2.3.0 on.
- Acceptance: after a save, `GetBucketInfo` returns the same values. A browser cross-origin preflight matches the configuration.

### 5.17 Website access

- Requirement: turn website access on or off. Set the index document and the error document. When turning it on, the confirmation dialog says the data will become public. Show the public address from the template.
- API: `PUT /api/buckets/{id}/website`.
- Garage: `UpdateBucket.websiteAccess` (`enabled`, `indexDocument`, `errorDocument`. There is also `routingRules`. This round displays it read-only, does not offer an editor, and sends the original value back unchanged on save).
- Acceptance: after it is turned on, the public address can be reached. After it is turned off, the response is Garage's denial response.

### 5.18 Quotas

- Requirement: set or clear the bucket maximum size (`maxSize`) and the maximum object count (`maxObjects`). Show the current usage.
- API: `PUT /api/buckets/{id}/quotas`.
- Garage: `UpdateBucket.quotas`.
- Note: `quotas` on `UpdateBucket` is replaced as a whole. Omitting `quotas` means no change. When `quotas` is sent, both `maxSize` and `maxObjects` are written. Null clears that field. When the frontend changes one field, it must also send the current value of the other field.
- Acceptance: changing only `maxSize` leaves `maxObjects` at its original value. Setting both to null clears the quota. Converting capacity units loses no precision.

### 5.19 Permissions

- Requirement: list the keys on a bucket and their read/write/owner permissions. Grant and revoke (validation is in 4.6; after a revoke, credential-cache invalidation is in 4.2).
- API: `POST`/`DELETE /api/buckets/{id}/permissions`.
- Garage: `AllowBucketKey`, `DenyBucketKey`, `GetBucketInfo`.
- Acceptance: after a revoke, the UI matches Garage.

### 5.20 Multiple users and roles

- Requirement: an SQLite user store. A setup wizard. Roles `admin` and `viewer`, plus "download object content" and "share" permissions that can be assigned to a viewer (the data model and the constraints are in 3.19). Create, delete, and update users, disable a user, rename a user, and reset a password. Lockout protection (you cannot delete, demote, or disable yourself, and you cannot remove the last enabled administrator). An offline CLI (list users, reset a password, create an administrator, version, health check). On first start, bcrypt accounts from environment variables may be imported once.
- API: `GET`/`POST /api/users`; `PATCH`/`DELETE /api/users/{id}`; `POST /api/users/{id}/reset-password`; `POST /api/auth/login|logout|change-password`; `GET /api/auth/status`; `GET`/`POST /api/setup`.
- Garage: none.
- Acceptance: tests cover granting a permission bit, revoking one, and the "share depends on download" constraint. Each lockout-protection rule has a test. A user response never contains a hash. A role change takes effect immediately (3.4).

### 5.21 Audit log

- Requirement: every write (including writes that were rejected), login-related events, viewing a secret, and generating a share link are written to the audit table. Fields: time, user, IP, method, path, target resource (bucket ID, key, node ID, and other resource identifiers of the same kind), result status code, and reason. Optionally also write to standard output (JSON lines). The UI provides filters (user, time range, action type) and CSV export. The retention period is configurable (default 90 days).
- API: `GET /api/audit?user&from&to&action&offset&limit` (A); `GET /api/audit/export` (A).
- Garage: none.
- Acceptance: each kind of event has one integration test that asserts an audit record. Records past the retention period are cleaned up on a schedule.

### 5.22 Pagination

- Requirement: every list API in this project (buckets, keys, objects, users, audit, admin tokens, block errors) uses one pagination contract: `offset`/`limit`, or a continuation token. The response carries `next` or `hasMore`. The frontend uses one pagination component.
- Garage: `offset` and `limit` of `ListBucketsInfo` / `ListKeysInfo` (capability probe), and the S3 continuation token.
- Acceptance: every list API normalizes an out-of-range `limit` (default 100, maximum 1000).

### 5.23 Settings and About

- Requirement: change your own password, switch the theme, and show the version. The update check is off by default, and its source is configurable (4.14).
- Acceptance: when the update check is not turned on, there is no outbound request.

### 5.24 S3 features this project explicitly does not support

Garage does not support the following features, or it returns only a fixed value. This project's UI offers no entry for them, and the related docs say so.

- Object versioning (`ListObjectVersions` returns not implemented. Only the versioning state can be read, and it is always disabled).
- Object Lock, a retention-period lock, and a legal hold.
- Bucket policies and object ACLs (permissions are granted only through a Garage key).
- Server-side encryption configuration (SSE-C is the exception. This project does not provide a management UI for it).
- Bucket replication, requester pays, object-tag management, switching storage class, and event notifications.
- Acceptance: the UI has none of the entries above. The "Known limitations" section of the docs lists them.

### 5.25 Navigation and page structure

- Requirement: a fixed navigation on the left (on a narrow screen it collapses to a drawer). The top-level entries, in order, are Overview, Buckets, Keys, Nodes and layout, Operations (Workers, block errors, snapshots, repair), Admin tokens, Audit, and Settings. A read-only role does not see an entry it is not allowed to use.
- Each resource uses a list page, then a detail page (tabs). Bucket detail contains Overview, Objects, Permissions, Settings (website, quotas, CORS, lifecycle), and incomplete uploads. Key detail contains Overview, the buckets it can access, and Settings. Node detail contains information, statistics, Workers, block errors, and maintenance actions.
- The top shows breadcrumbs, the current user and role, the connected Garage version, and a health-status badge.
- Every detail page, tab, and object prefix has its own address that can be shared and refreshed. Browser back and forward keep the state.
- Acceptance: in E2E, opening any deep address directly renders it correctly. A read-only account's navigation has no entry for a write action. On a narrow screen the navigation can be expanded and collapsed.

### 5.26 Shared interaction states

- Requirement: every data block must implement four states.
  1. Loading. The first screen uses a skeleton placeholder. A later refresh shows only a light progress hint and does not clear data already on screen.
  2. Empty. Say why it is currently empty, and give the next action (for example "Create the first bucket"). A read-only role does not show a create button.
  3. Error. The block shows an error bar with a readable explanation, an error code, and a "Retry" button. When Garage is unreachable, show one global banner instead of an error on every block.
  4. Partial result. When pagination is truncated, a search hits its cap, or a missing capability is detected, state the reason explicitly.
- Writes: while a submit is in progress, disable the button and show progress. After success, tell the user with a non-blocking notice and refresh the related data. On failure, keep the form input and show the error.
- A settings form shows its save state (unsaved, saving, saved, failed). Leaving a page that has unsaved changes prompts the user.
- Acceptance: frontend component tests cover loading, empty, and error for every list component. When Garage is simulated as disconnected, a global banner appears.

### 5.27 Graded confirmation

- Requirement: split write actions into three levels by risk.
  1. Low risk (rename, change a quota, change the website document). No confirmation. The change can be undone, or it can be edited again.
  2. Medium risk (delete a single object, revoke a permission, delete an empty bucket, delete a key). A modal confirmation states the object name and the consequence. The default focus is "Cancel".
  3. High risk (recursive delete, batch delete, purge blocks, skip dead nodes, apply a layout, turn on public website access, create a full-authority admin token). The user can confirm only after typing the target name (or the block hash, or the layout version). State the irreversible consequence and the scope of impact (object count, capacity).
- The confirmation dialog supports the keyboard (Esc cancels. Enter takes effect only after the typed value matches).
- Acceptance: a table-driven test fixes the risk level of every write action. For a high-risk action, the confirm button is disabled when the input does not match.

### 5.28 Layout change flow

- Requirement: the layout page guides the user through steps.
  1. View the current layout (nodes, zone, capacity, tags, role) and the "staged changes" list.
  2. Edit. Assign, change, or remove a node role. The change enters the staging area and can be withdrawn one by one.
  3. Preview. Call the preview API. Show the new layout and the data-migration result (v2.4 and later use structured statistics as a table, v2.3 shows text).
  4. Apply. A high-risk confirmation. Fill in the current version + 1 automatically.
  5. Track. After apply, show progress tracking (each node's status of syncing to the new version, following layout history) until every node is done. When a node stays offline for a long time, offer a "skip dead nodes" entry and state the risk.
- At any time, "revert all staged changes" is available.
- Acceptance: apply is not available before preview. After apply, the tracking view shows complete once every node has synced. After revert, the staging area is empty.

### 5.29 Overview page and capacity visualization

- Requirement: the overview page contains a health card, cluster capacity (used and free, distributed by node), the bucket count and the total object count, a ranking of buckets by capacity (the top N, with the rest merged as "Other", still readable when there are many buckets or when the buckets are very small), and recent audit events (administrators; enabled after the query API in 5.21 is delivered).
- Ranking buckets by capacity, and sorting by capacity, depend on each bucket's detail. When the capability probe finds `ListBucketsInfo`, use it directly. Otherwise a background task summarizes on a schedule with bounded concurrency (4.11), default 10 minutes, configurable, and caches the result. The UI labels the time of the data. A 30-second refresh does not trigger a full fetch.
- The bucket list and the bucket detail show a quota-usage progress bar (capacity and object count). At 80% mark it with the warning color. At 95% mark it with the error color.
- Data refreshes automatically (default 30 seconds, and the refresh can be paused). When the page is not visible, stop refreshing.
- Acceptance: with 1000 buckets, the ranking chart is still readable. Quota-threshold colors have a component test. After switching to a background tab, no further request is sent.

### 5.30 Filtering, sorting, and selection on lists

- Requirement: the bucket, key, node, admin-token, and user lists support filtering by name, and sorting by columns such as name, creation time, and capacity. The default sort is fixed and is explained. Sort and filter state is written into the address. Sorting the bucket list by capacity uses the summary cache in 5.29.
- The object list supports multi-select (including holding Shift to select a range, and selecting every row on the current page). After a selection, a bulk-action bar appears (delete, download ZIP, copy path). There is no cross-page "select all". To act on a whole prefix, use the folder recursive operation (4.3 and 5.6).
- Acceptance: after a refresh, the sort and the filter remain. The bulk-action bar appears only when something is selected.

### 5.31 Showing and copying credentials

- Requirement: after a key or an admin token is created, show the full credential once in the result dialog. Provide one-click copy (a successful copy has visible feedback) and an "I have saved it" confirmation. After the dialog is closed, an admin token cannot be viewed again. An S3 secret requires the second confirmation again.
- Credential fields are masked by default. Showing one requires an explicit click. In a non-secure context, copy degrades to text that can be selected.
- How this relates to 3.15: 3.15 constrains the token this project itself uses to connect to Garage. That token never enters the browser. An admin token or S3 secret that a user creates in the UI is a result to hand to that user. It may appear only in the one response that creates it, or in the one response that views it after a second confirmation. That response sets `no-store`. It is not written into logs or into audit content.
- Acceptance: after the dialog is closed, the admin-token secret no longer appears in the response or on the page. The copy button has a component test.

### 5.32 Object preview viewer

- Requirement: the object-detail sidebar shows metadata (size, type, ETag, modification time, custom metadata). Allowlisted types preview in the viewer: images, audio and video (seeking by dragging the progress bar is supported, which means the backend supports a byte-range read and returns a stream), PDF, and plain text (above a configurable size, show only the beginning). Inside the same directory, the Left and Right keys move to the previous object and the next object.
- A type outside the allowlist shows "Download" instead of a preview, and follows 3.3. Preview, download, and thumbnails all require the download permission in 3.19. A read-only user without that permission sees only metadata. The UI shows no preview entry and no download entry.
- How this relates to 3.3: images, audio, and video point a media element directly at the object address. The frontend reads text and renders it as plain text. Neither is affected by the sandbox CSP on the object response. A PDF is placed in a sandboxed iframe. Only scripts are allowed, and same origin is not granted. A range-read response also carries `nosniff` and `no-store`.
- Acceptance: a video can be dragged to any position and played. Large text loads only the beginning. Switching objects cancels the previous load that has not finished.

### 5.33 Upload panel

- Requirement: the drop zone covers the object list. The upload panel lists each file's progress, speed, and state (queued, uploading, completed, failed, cancelled). It supports cancelling one file, retry, and clear all. If an upload is still running when the user leaves the page, prompt the user. For an object of the same name, ask with the choices "overwrite", "skip", and "overwrite all".
- Acceptance: E2E uploads 3 files and cancels 1 of them. The panel state is correct, and the cancelled parts have been aborted.

### 5.34 Admin-token scope picker

- Requirement: when creating or editing an admin token, list Admin API endpoint checkboxes grouped by function (cluster, node, layout, bucket, key, permission, Worker, block, admin token). A whole group can be checked at once. Checking "all", or including permission to create an admin token, shows a prominent warning that the result is equivalent to full authority. An expiration time can be set (including "never expires", which needs an extra confirmation).
- Acceptance: the groups cover all 46 endpoints of Garage v2.4.1, plus `Metrics` (a test checks them against the OpenAPI file). A full-authority combination shows the warning.

### 5.35 Appearance and accessibility

- Requirement: three themes, light, dark, and follow the system. The choice is stored in a local preference (data that is not sensitive). Every color meets WCAG AA contrast. A state is not conveyed by color alone (an icon or text is present as well). Every interactive element can be reached from the keyboard and has a visible focus. An icon button has a readable label. The layout is usable on a screen that is 360 pixels wide.
- Acceptance: an automated accessibility check (such as axe) reports zero serious problems on the main pages. Screenshot tests pass under both themes.

### 5.36 Version and capability notice

- Requirement: "About" on the Settings page shows this project's version, the build information, the connected Garage version, and the capability-probe result (which v2.4 fields are available, and whether the list APIs are available). When the connected Garage is below the minimum version, a site-wide banner says so.
- Acceptance: against a v2.3.x instance and a v2.4.1 instance, the capability list displays correctly.

---

## 6. Non-functional requirements

### 6.1 Performance

- The first screen of the home page (health + statistics) returns within 1 second on a local network.
- The first page of a 10,000-bucket list appears within 2 seconds (paginated).
- Rendering one object-list page of 1000 rows uses virtual scrolling.
- The frontend main bundle, after gzip, is at most 300 KB. Routes load on demand.

### 6.2 Streaming large files

- Download, preview, and ZIP packaging all stream through. Do not read the whole payload into memory.
- An upload streams into S3. Above the threshold (default 64 MB) it switches to multipart automatically. The part size defaults to 16 MB. One upload defaults to 2 parts in flight at a time. The process-wide upload buffer has a hard cap (default 64 MB). Above that cap, uploads queue. Part size × in-flight part count × concurrent upload count must stay within that cap.
- Thumbnails are generated only for allowlisted bitmap types. When the source object is above the configurable limit (default 20 MB), or the pixel count is above the limit (default 40 million), do not generate a thumbnail. Show the icon directly. Before decoding, read the image header and check the dimensions, to stop a decompression bomb. Cache the result by object ETag in a bounded cache (LRU, configurable total size). The number of thumbnail tasks decoding at once has a cap (default 2). Further tasks queue. If one task's memory exceeds its budget, abandon that task and show the icon.
- Acceptance: when the upload limit is configured to at least 6 GB, the server completes a 5 GB upload and a 5 GB download in a container limited to 256 MB of memory. Browsing thumbnails for 100 large images does not OOM.

### 6.3 Timeouts and cancellation

- Garage Admin client: connect timeout 5 seconds, total timeout 30 seconds (configurable).
- S3 calls use the request context. When the client disconnects, cancel the request to S3. A long operation (a large file, or a ZIP) has no total timeout, only an idle timeout.
- The server sets a header-read timeout and an idle timeout, and shuts down gracefully (wait for in-flight requests, default 30 seconds).
- Acceptance: after the browser cancels a download, the server's request to S3 is cancelled within 1 second (visible in the log).

### 6.4 Error handling

- One error structure: `code` (a stable machine-readable code), `message` (readable text), and `garageStatus` (when Garage returned one).
- Keep the real status code (4.8). When Garage is unreachable, return 502. On timeout, return 504.
- The frontend shows errors in one place. 401 goes to the login page. 403 shows that the caller has no permission. Do not swallow an error.
- When the frontend fails to load a stale code-split chunk, it refreshes once automatically (with a cooldown).

### 6.5 Observability

- Structured logs (JSON), with a request ID. The log level is configurable. Do not record sensitive information.
- This project's own `/metrics` (protected by authentication, or by a separate token) exposes request count, a latency histogram, the Garage call error count, and the in-flight upload count.
- `/healthz` (liveness) and `/readyz` (readiness: the database is available and Garage is reachable).
- The binary provides a `-health` subcommand for the container health check.

### 6.6 Test data generation

- Requirement: provide a development command that generates data (it is not part of the runtime image). It can create buckets, keys, and many objects in bulk on a test cluster (count, prefix depth, object-size distribution, and resume from a checkpoint are configurable). Use it to check pagination and performance at 10,000 buckets and 100,000 objects.
- Acceptance: the CI performance smoke test uses this command to generate data.

### 6.7 i18n (optional, P2)

- Keep copy in one place. The default language is English, and Simplified Chinese is provided. Localize dates and capacity units.
- Acceptance: after a language switch, no key is untranslated (a test checks that the key sets match).

---

## 7. Engineering requirements

### 7.1 Technology stack

- Backend: the Go standard library for the network service and routing (method + wildcard routes), an S3 SDK (`aws-sdk-go-v2`, the latest patch), a session library that supports database storage, SQLite through a pure Go driver (no CGO), and bcrypt.
- Frontend: React 18, TypeScript strict mode, Vite, TanStack Query, react-hook-form + zod, Tailwind + daisyUI, and zustand.
- Tests: Go's own tests (with `-race`), vitest + Testing Library, and Playwright for E2E.

### 7.2 Pin dependency and toolchain versions

- Node: 22 LTS. Pin the major version with `.nvmrc` and `package.json` `engines`.
- pnpm: pin a specific version with the `packageManager` field in `package.json` (a verified version in 9.x or 10.x). Do not use `latest` in a build. Dependencies of the build scripts (esbuild, `@swc/core`, and the same kind of package) may be listed explicitly.
- Go: pin the `go` and `toolchain` directives in `go.mod` to the latest patch (at release time, not below a version that fixes a known standard-library vulnerability). After `go mod tidy`, there is no diff.
- Pin each base image by digest. Do not use a floating tag.
- An automation bot opens dependency updates every week. Merge them after CI passes.

### 7.3 Build

- One-command build. Build the frontend first, then embed it and compile the backend. If the frontend output is missing, the build fails and prints a clear message.
- Support `linux/amd64` and `linux/arm64` (`arm/v7` is optional).
- The build is reproducible. Inject the version, the commit, and the build time.

### 7.4 CI

- On every commit and every merge request:
  1. Install dependencies (the lockfile is frozen).
  2. Frontend: type check, lint, unit tests, and build.
  3. Backend: a `gofmt` check, `go vet`, `staticcheck`, and `go test -race`.
  4. Security: `govulncheck`, `pnpm audit` (production dependencies), a secret scan, and a container image scan.
  5. Integration tests: run E2E against Garage v2.3.x and v2.4.1 containers.
- The main branch rebuilds every night and catches newly disclosed vulnerabilities.
- Every check is a blocking check (lint is no longer "advisory only").

### 7.5 lint

- ESLint (typescript-eslint strict rules, react-hooks) has zero errors and zero warnings. `any` is forbidden (except generated types).
- Go: `gofmt`, `go vet`, and `staticcheck` have zero warnings.

### 7.6 Test coverage

- Backend statement coverage is at least 80%. Security-related packages (authentication, CSRF, rate limiting, the proxy allowlist, object response headers, and config redaction) are at least 95%.
- Frontend coverage is at least 70%.
- Every acceptance criterion in chapters 3 and 4 has a matching automated test.

### 7.7 Zero dependency vulnerabilities

- Before a release, reachable vulnerabilities from `govulncheck` are 0. High and above from `pnpm audit` on production dependencies are 0. Critical vulnerabilities in build-time dependencies are 0.
- When an exception is required, record the reason, the impact assessment, and the expiry date in the repository.

### 7.8 Generate types from the Garage OpenAPI document

- The only source is the Admin API v2 OpenAPI description in the Garage repository (`garage-admin-v2.json`). Generate TypeScript types from it. The backend may also generate Go types the same way.
- Commit the generator script and the pinned OpenAPI file version together. CI checks that the generated output matches the commit.
- When the supported Garage version is raised, regenerate and list the field differences in the change notes.

### 7.9 Release and images

- Runtime image: distroless static nonroot, with no shell. The user is not root. `/data` is a volume. Expose 3909. Inside the image, listen on `0.0.0.0` by default (3.1).
- Write the compose example's port mapping so that it binds only the host `127.0.0.1`. Acceptance: after a start from the example, reaching 3909 from another address on the host fails, and reaching it from `127.0.0.1` succeeds.
- The health check uses the binary's own `-health` subcommand (interval 30 seconds, timeout 5 seconds, start grace 10 seconds, 3 retries). Do not bring in an extra tool image.
- Release artifacts: a multi-arch image, a binary for each platform, `SHA256SUMS`, and signatures (sign the image with cosign keyless signing or with a key; sign the binary with ed25519), plus an SBOM and a proof of build provenance.
- Use semantic versions. The change notes for each version list the minimum Garage version required.
- Provide a compose example (Garage v2.4.1 + this project) and a Helm Chart (P2).

---

## 8. Minimum version (MVP)

The minimum version is the first version that can be delivered outside the project. It may be released once every condition below is met. The other features are delivered in the later phases of chapter 9.

### 8.1 Required features

| Module | Scope |
|---|---|
| Account | Setup wizard, log in and log out, change password. Two roles, administrator and read-only, plus download and share permission bits that can be granted to a read-only user (3.1, 3.4, 3.5, 3.19). |
| Security baseline | Every P0 item in chapter 3: authentication by default, secrets are not leaked, examples contain no secrets, the browser does not hold a Garage token, CSRF, rate limiting, an endpoint allowlist proxy, security headers, a request-body limit, and `no-store` on objects. |
| Cluster | Health, status, and cluster statistics (5.9, and 5.10 without the metrics panel). |
| Buckets | Paginated list, create, delete, aliases, quotas, and grant or revoke permissions (5.1, 5.18, 5.19). |
| Keys | Paginated list, create, delete, rename, allow bucket creation, and view the secret (a second confirmation) (5.7). |
| Objects | Paginated browsing, prefix navigation, safe preview, streamed download, streamed upload (including multipart), single and batch delete, and recursive delete (5.2 through 5.4). |
| UI | Navigation and page structure (5.25), shared interaction states (5.26), graded confirmation (5.27), one-time display and copy of a credential (5.31), list filtering and sorting and object multi-select (5.30), the upload panel (5.33), light and dark themes and basic accessibility (5.35). |
| Version | A self-check that v2.3.0 is the minimum version, a capability probe of the list APIs, and an About page that shows the version and the capabilities (5.36). |
| Delivery | A non-root image with a read-only root filesystem, a compose example with no secrets, CI fully green, and E2E against v2.3.x and v2.4.1. |

### 8.2 Not in the minimum version

Layout editing and the change flow (5.28). Admin tokens and the scope picker (5.34). Overview capacity ranking and auto-refresh (5.29; the minimum version does only the health and statistics cards). Range reads and switching in the object preview viewer (5.32; the minimum version does only allowlisted inline preview). Workers, repair, block errors, and snapshots. CORS and lifecycle. Share links. ZIP bulk download. Thumbnails. The audit page (audit writes are still in the minimum version). i18n, Helm, multiple clusters, and an external identity source.

### 8.3 Quality bar for the minimum version

- Every P0 in chapter 3 has an automated test. Backend coverage is at least 80%. Security-related packages are at least 95%.
- Reachable vulnerabilities from `govulncheck` are 0. High and above in production dependencies are 0. The secret scan is 0.
- With simulated data of 10,000 buckets and 100,000 objects under a single prefix, the first screen of a list appears within 2 seconds, and there is no extra request per object.
- A 5 GB upload and a 5 GB download complete under a 256 MB memory limit (the test raises the upload limit explicitly).
- Estimate: 32.75 person-days (summed item by item from chapter 9: phases 0, 1, 2, and 2B are 24 person-days in full; from phase 3, browse is 1.5, upload and download are 2.5, and batch delete is counted as half of the "batch delete and ZIP" item, which is 0.75; the two P0 items in phase 3A total 3, together with 1 for the theme and the About page). The minimum-version scope is fixed by 8.1. Do not cut it down.

## 9. Phased delivery plan and priority

Effort is counted for one developer who knows Go and React (person-days). Phases are ordered by dependency. A later phase depends only on the output of the phases before it.

### Phase 0: Buildable, and a baseline (P0, about 4 person-days)

| Item | Estimate |
|---|---|
| Pin the Node, pnpm, and Go versions, and build the image | 0.5 |
| Non-root distroless image, with a built-in health check | 0.5 |
| CI skeleton (build, lint, test, vulnerability scan) | 1 |
| OpenAPI type generation (7.8; the allowlist and the scope picker depend on it) | 1 |
| Test-data generation command (6.6; the performance bar in 8.3 depends on it) | 1 |

### Phase 1: Security (P0, about 7.5 person-days)

| Item | Estimate |
|---|---|
| User store, setup wizard, default authentication, default local listen (3.1) | 1.5 |
| Config redaction, log redaction, examples with no secrets, and self-generated secrets (3.2, 3.14 through 3.16) | 1 |
| Preview protection and security headers, object `no-store` (3.3, 3.11) | 0.5 |
| Persist sessions, rotate them, invalidate them on password change, cookie attributes (3.4, 3.12) | 1.5 |
| Rate limiting, CSRF, request-body limit (3.5, 3.6, 3.9) | 1 |
| Endpoint allowlist proxy and the role matrix (3.7, 3.19) | 1.5 |
| Login audit and the audit table (3.13, the basic part of 5.21) | 0.5 |

### Phase 2: Correctness and compatibility (P0 and P1, about 7 person-days)

| Item | Priority | Estimate |
|---|---|---|
| Address by bucket ID, paged recursive delete, capacity precision (4.1, 4.3, 4.4) | P0 | 1.5 |
| Credential cache and invalidation, key encoding, grant validation (4.2, 4.5, 4.6) | P1 | 1.5 |
| Error responses and status codes, trailing slash, `BASE_PATH`, secret files, update source (4.7 through 4.9, 4.12 through 4.15) | P1 | 1.5 |
| Version self-check and v2.4 field probe (2.1, 2.2) | P0 | 0.5 |
| List-API capability probe (`ListBucketsInfo`, `ListKeysInfo`) (2.3, 5.22) | P0 | 1 |
| Concurrency cap, timeouts, and cancellation (4.11, 6.3) | P1 | 1 |

### Phase 2B: Basic management pages (P0, about 5.5 person-days)

| Item | Estimate |
|---|---|
| Bucket list, create, delete, aliases (5.1) | 1 |
| Quotas and permissions (5.18, 5.19) | 1 |
| Key list, create, import, delete, `UpdateKey` (rename, expiration, allow bucket creation), view the secret (5.7) | 1 |
| Cluster health, status, and statistics cards (5.9, and 5.10 without the metrics panel) | 1 |
| Basic user management: create and delete, disable, change role, reset password, and lockout protection (the core part of 5.20) | 1 |
| Download and share permission bits: data model, authorization check, UI switch, and tests (3.19) | 0.5 |

### Phase 3: Object experience (P1, about 8 person-days)

| Item | Estimate |
|---|---|
| Paginated browse, search, and sort (5.2, the object part of 5.22) | 1.5 |
| Streamed upload, multipart, upload queue, temporary-file handling, streamed download, and byte-range reads (5.3, 4.10, 6.2, the backend part of 5.32) | 2.5 |
| Batch delete and bulk ZIP download (5.4, 5.6) | 1.5 |
| Sharing and permissions (5.5, 3.10) | 1 |
| Cleanup of incomplete uploads (5.14) | 0.5 |
| Bounded thumbnails (6.2) | 1 |

### Phase 3A: UI and interaction (P0 and P1, about 6 person-days)

| Item | Priority | Estimate |
|---|---|---|
| Navigation and page structure, shared interaction states, graded confirmation (5.25 through 5.27) | P0 | 2 |
| List filtering, sorting, and multi-select, copying a credential, upload panel (5.30, 5.31, 5.33) | P0 | 1 |
| Theme and accessibility, version and capability notice (5.35, 5.36) | P1 | 1 |
| Layout change flow and tracking, overview visualization and auto-refresh (5.28, 5.29) | P1 | 1.5 |
| Admin-token scope picker, preview-viewer enhancements (5.34, 5.32) | P1 | 0.5 |

### Phase 4: Garage v2.3 and v2.4 management capabilities (P1, about 6.5 person-days)

| Item | Estimate |
|---|---|
| CORS and lifecycle (5.16) | 2 |
| Metrics panel (5.10) | 1 |
| Layout preview, history, skip dead nodes (5.8) | 1.5 |
| Restricted admin tokens, and a self-check of this project's token (5.15, the recommended item in 3.7) | 2 |

### Phase 5: Operations capabilities (P2, about 6 person-days)

| Item | Estimate |
|---|---|
| Workers and repair tasks (5.11) | 2 |
| Block errors and metadata snapshots (5.12, 5.13) | 1.5 |
| Audit log page, filter and export, retention (5.21) | 1.5 |
| `InspectObject` diagnostics (5.2) | 1 |

### Phase 6: Extensions and distribution (P2, about 6 person-days)

| Item | Estimate |
|---|---|
| Complete user management, and the offline CLI (5.20) | 1.5 |
| Signed releases, SBOM, multi-arch (7.9) | 1.5 |
| i18n (6.7) | 1.5 |
| Helm Chart, and the self-signed certificate option | 1.5 |

Note: items in phase 3A that depend on a later phase (5.28 depends on the layout API from phase 4, 5.34 depends on 5.15, and the audit widget in 5.29 depends on 5.21) are wired in after that dependency is delivered. The wiring work is already included in the estimates for those items.

### Later (not in this round)

- OIDC login (including mapping roles from the identity source, and single logout), bucket-level authorization by team, multi-cluster management, listening on a unix socket and connecting to one, multi-replica deployment, and tracking the next major version of the Garage Admin API.

Total: P0 is 23 person-days, P1 is 21.5 person-days, P2 is 12 person-days, and the total is 56.5 person-days (the later work is not included). A phase is complete when every acceptance criterion this chapter cites has passed.
