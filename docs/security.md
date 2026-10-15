# Security requirements

Every item is P0 unless it is marked otherwise. Role abbreviations: A = administrator, V = read-only, D = a read-only user who has been granted "download object content", S = a read-only user who has been granted "share".

## 3.1 Default authentication

- There is no mode that skips login. On the first start, when the user store is empty, every page leads to the setup wizard that creates the first administrator. After that finishes, that entry is closed permanently.
- Before setup is finished, every API returns 401 except the setup APIs and the status query.
- Default listen address. When the binary runs directly and nothing is configured explicitly, listen on `127.0.0.1`. When it must be exposed, an operator sets `HOST` explicitly. Inside the container image, listen on `0.0.0.0` by default (if the container listens only on the loopback address, a published port cannot reach it). The compose example maps the port only to the host's `127.0.0.1`. An operator changes that mapping explicitly when it should be reachable from elsewhere.

Acceptance: When the binary runs directly and `HOST` is not set, it is reachable only on `127.0.0.1`. When the container image does not set `HOST`, it listens on `0.0.0.0`. After a start from the compose example, the host can reach `127.0.0.1:3909`, and other addresses on the host cannot. After a fresh start, an unauthenticated `GET /api/keys` returns 401. Submitting setup again after setup has finished returns 409.

## 3.2 Do not leak secrets

- The configuration API returns only the non-sensitive fields the frontend needs (S3 region, website root domain, whether sharing is enabled, version). Emit them from an allowlist struct.
- Never return `rpc_secret`, `admin_token`, `metrics_token`, any RPC address, or the admin listen address.
- Logs, error text, and audit records must not contain a token, a `secretAccessKey`, a password, or a password hash.
- Viewing a `secretAccessKey` is allowed only for an administrator. It requires a second confirmation, and it writes an audit record.

Acceptance: Assert a field allowlist on the configuration API response. A test scans log output for sensitive strings.

## 3.3 Preview XSS protection

- Add `X-Content-Type-Options: nosniff` to every object response.
- Only allowlisted types may be shown inline: common bitmaps (png, jpeg, gif, webp, avif, bmp, ico), `text/plain`, `application/pdf`, mp4 and webm video, and mpeg, ogg, and wav audio. SVG, HTML, XML, and JavaScript are never shown inline.
- Parsing a type ignores parameters and lowercases the type. A parse failure is treated as unsafe.
- For a type outside the allowlist, change `Content-Type` to `application/octet-stream`, add `Content-Disposition: attachment`, and encode the filename with RFC 5987.
- Add a sandbox CSP to object responses (`sandbox; frame-ancestors 'self'`). A PDF may allow scripts, and it must not be granted same origin.
- Site-wide security headers: a strict CSP (its own origin only, by default; `object` is forbidden; `frame-ancestors 'none'`), `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`.
- Optional (P1): serve preview from a presigned address on a separate domain, fully isolated from the admin UI.

Acceptance: Upload objects whose `Content-Type` is `text/html` and `image/svg+xml`. The preview request returns an attachment download and `octet-stream`. In the E2E test, the script does not run.

## 3.4 Sessions and cookies

- Rotate the session ID on a successful login, when setup finishes, when the password is changed, and on logout. On logout, destroy the server session.
- Session cookie: scripts cannot read it, `SameSite=Lax`, and `Path` follows `BASE_PATH`. `Secure` is on by default. It is turned off only when the deployment is explicitly configured as local cleartext.
- The absolute lifetime defaults to 24 hours. The idle timeout defaults to 2 hours. Both can be configured. An illegal value falls back to the default.
- Each request uses the live role and the disabled state from the user store on the server. A role saved in the session is only a display cache.

Acceptance: The session ID is different before and after login. After logout, a request with the old cookie returns 401. After a user is disabled, that user's next request returns 401.

## 3.5 Rate limiting

- One shared rate-limit component. An in-process sliding window, default 10 times per minute.
  - Count login by "client address + lowercased username".
  - Count setup by client address.
  - Count password change by username.
  - Count share-link generation and download tokens by user (P1).
- The client address is the connection address by default. Read the last hop of a trusted proxy header only when that header is configured.
- Over the limit, return 429, with `Retry-After`.
- When the user does not exist, or is disabled, still run one hash comparison of equal duration. The error text is the same, so the account cannot be enumerated.

Acceptance: The 11th request for the same key returns 429. After the window has passed, requests are accepted again. Counts for different usernames do not affect each other.

## 3.6 CSRF

- Double-submit cookie. The server sets a random token cookie (a frontend script may read it). Every POST, PUT, PATCH, and DELETE must send an `X-CSRF-Token` header, and the comparison is constant-time.
- Only two APIs are exempt: login and setup.
- This project's own `/api` allows no cross-origin access. That is separate from the CORS rules configured on a Garage bucket in 5.16 of [features-data.md](features-data.md).

Acceptance: A missing header, or a header that does not match, returns 403. A test pins the exemption list.

## 3.7 Endpoint allowlist proxy

- Do not pass the Admin API through on a wildcard. The backend exposes one explicit allowlist. Each record contains the Garage endpoint name, the allowed methods, the required role, and whether the call writes an audit record.
- A path outside the allowlist is always 404.
- Sensitive endpoints (`CreateAdminToken`, `UpdateAdminToken`, `PurgeBlocks`, `LaunchRepairOperation`, `SetWorkerVariable`, `ClusterLayoutSkipDeadNodes`, and `GetKeyInfo` with `showSecretKey`) are available only to an administrator, and they require a second confirmation.
- The backend never forwards the client's query parameters to `GetKeyInfo`. An ordinary query is fixed so that it does not send `showSecretKey`. Viewing a secret goes only through this project's dedicated API (5.7 of [features-access.md](features-access.md)). The backend adds `showSecretKey=true` itself.
- The allowlist must cover every endpoint each feature actually calls: every endpoint in 2.4 of [garage-api.md](garage-api.md), `ListBucketsInfo` and `ListKeysInfo` used by the capability probe, and `/metrics`. In CI, a table-driven test checks that the endpoints each feature declares ⊆ the allowlist.
- If this project uses a restricted admin token, that token's scope must include every endpoint on the allowlist. When the metrics panel is required, the scope must also include the scope value `Metrics` (the endpoint name of `/metrics`), or `metrics_token` is configured on its own. `GetCurrentAdminTokenInfo` can be called with any valid token. It does not have to be listed in the scope.
- Recommended (P1): this project uses a scope-restricted Garage admin token (the scope lists only allowlisted endpoints), not a full-authority `admin_token`. At startup, self-check with `GetCurrentAdminTokenInfo`, and show the token's scope and expiration time in the UI.

Acceptance: A read-only role calling any write endpoint returns 403. Calling an endpoint that is not on the allowlist returns 404. A table-driven test covers the whole allowlist.

## 3.8 Non-root container

- The runtime image uses the nonroot variant of distroless static. It runs as a non-root user. The root filesystem can be used read-only.
- `/data` is the only writable volume.

Acceptance: The id inside the container is not 0. A start with `--read-only` works.

## 3.9 Request body size limit

- Every JSON API shares one upper bound (default 1 MiB), applied in middleware.
- The upload API has its own bound, `MAX_UPLOAD_SIZE_MB` (default 512, configurable). When `Content-Length` is over the bound, return 413 before reading the body. When a streamed read goes over the bound, abort it the same way and return 413.

Acceptance: A 2 MiB JSON request to any API returns 413. An upload over the limit returns 413, and no temporary file is left.

## 3.10 Share link permission

- Generating a presigned link is available only to an administrator by default. It may be granted to a read-only user through the separate "share" permission, and that user must also have the "download object content" permission (3.19). A read-only role cannot generate a link by default.
- The validity choices are 1 hour, 24 hours, and 7 days. The server enforces an upper bound of 7 days.
- Every generation writes an audit record (user, bucket, key, validity).
- When no public S3 address is configured, the feature is off and the API returns 501.

Acceptance: A read-only user requesting a share returns 403. A validity period above the upper bound is truncated to 7 days.

## 3.11 Private objects are not cached for long

- For every authenticated response of object content, metadata, or a ZIP download: `Cache-Control: private, no-store`.
- Frontend static assets: do not cache `index.html`. Cache hashed assets for a long time, and mark them immutable.

Acceptance: Assert `no-store` on the response headers of an object download.

## 3.12 Persisted sessions, and invalidation after a password change

- Store sessions in the database (the same SQLite database as the user store). A restart does not drop the login. The store can keep sessions consistent when several replicas share that database (several replicas are P2).
- When the password is changed, an administrator resets the password, the user is disabled, the user is deleted, or the role is demoted, delete every other session of that user immediately. When the password is changed, keep the current session and rotate its ID.

Acceptance: Browsers A and B log in as the same account. After A changes the password, B's next request returns 401. After the process restarts, a session that has not expired is still valid.

## 3.13 Login audit and IP

- Write an audit record for a successful login, a failed login, a rate-limit hit, logout, setup, and a password change. Include the time (UTC), the username, the client IP, the result, and a reason code.
- An audit record does not contain the password or the request body.

Acceptance: After one failed login, the audit table has one new record, and that record includes the IP.

## 3.14 Examples and images contain no secrets

- The repository, images, the compose example, Helm values, and the docs must not contain any real or "example" private key, signing key, session key, password, or S3 credential. Examples use placeholders only, and they say how to generate the real value.
- When the session signing key, or the session encryption key, is not configured, the first start generates one at random in the data directory and saves it so that only the owner can read it. Do not use a default that was compiled into the binary.
- At startup, check secrets that are already configured. If the length is too short, or the value is the same as a placeholder in the docs, refuse to start.
- CI runs a secret scan over the whole commit history. A hit fails the check. A test fixture needs an explicit allowlist entry, and that entry must say it is a test value.

Acceptance: The secret-scan result is 0. After the data directory is deleted and the process is started again, a new secret is generated, and every old session is invalid.

## 3.15 The browser does not touch the Garage admin token

- The Garage admin token and `metrics_token` exist only on the server. Every Garage call from the frontend goes through this project's backend allowlist proxy.
- The frontend does not store a token or a session credential in `localStorage`, `sessionStorage`, or `IndexedDB`. The session uses only a cookie that scripts cannot read.

Acceptance: E2E checks browser storage and every response body. An admin token does not appear, and a session ID does not appear.

## 3.16 No switch that turns checks off and allows every request

- There is no configuration item that turns authentication off. Any error in the authentication configuration fails startup. It does not let the request through.

Acceptance: Table-driven tests for a missing configuration and for an illegal configuration all exit with a non-zero status.

## 3.17 External TLS (P1)

- When connecting to Garage, and when connecting to an identity source (that source is later), verify the certificate by default. A custom CA file is supported. "Skip verification" can be turned on only by an explicit setting. The startup log and the UI keep showing a warning.

## 3.18 Other hardening (P1)

- Passwords use bcrypt. A password is at least 10 characters, at most 72 bytes, and not entirely whitespace.
- The offline CLI resets a password by reading it from the terminal or from standard input. The password is not passed as a command-line argument. There is no reset entry on the network.
- Self-signed certificates: a custom CA file is supported. "Skip certificate verification" exists only as an explicit switch, and the UI shows a warning.

## 3.19 Role and operation matrix

D and S are independent permissions added on top of V. Both default to off. Granting S requires that the user also has D, because a share link also takes the content out of the admin UI. The UI and the backend both enforce that constraint. "—" means the operation is unavailable, and the UI does not show an entry for it. The backend authorizes from this table and from no other rule.

T is a tenant account (3.20): a `viewer` bound to one Garage access key. Its D and S bits keep the meaning above. In the T column, R and W mean that the bound key holds Garage's `read` or `write` permission on that bucket. Garage enforces R and W on the S3 request, because every S3 request of a tenant is signed with its bound key. "Granted" means the buckets on which the bound key holds any permission. A tenant reaches no other bucket.

| Operation | A | V | V+D | V+D+S | T |
|---|---|---|---|---|---|
| View cluster health, status, nodes, layout, and history | ✔ | ✔ | ✔ | ✔ | — |
| View cluster statistics and node statistics | ✔ | ✔ | ✔ | ✔ | — |
| View the Prometheus metrics panel (summary metrics, with no credentials) | ✔ | ✔ | ✔ | ✔ | — |
| Change the layout, connect nodes, skip dead nodes | ✔ | — | — | — | — |
| View the bucket list and bucket detail (aliases, quotas, website, CORS, lifecycle) | ✔ | ✔ | ✔ | ✔ | Granted (no key list) |
| Create and delete buckets, and change aliases, quotas, website, CORS, and lifecycle | ✔ | — | — | — | — |
| View the keys and permissions on a bucket (the secret is not included) | ✔ | ✔ | ✔ | ✔ | — |
| Grant and revoke bucket permissions | ✔ | — | — | — | — |
| View the key list and key detail (the secret is not included) | ✔ | ✔ | ✔ | ✔ | — |
| View the S3 secret | ✔ (a second confirmation, and an audit record) | — | — | — | — |
| Create, import, change, and delete keys | ✔ | — | — | — | — |
| Browse the object list, metadata, and search | ✔ | ✔ | ✔ | ✔ | R |
| Preview and download an object, download a ZIP, and view thumbnails | ✔ | — | ✔ | ✔ | R + D |
| Upload and delete objects | ✔ | — | — | — | W |
| Clean up incomplete uploads | ✔ | — | — | — | — |
| Generate a share link | ✔ | — | — | ✔ | R + D + S |
| `InspectObject` diagnostics | ✔ | — | — | — | — |
| Workers, repair, block errors, and metadata snapshots (view) | ✔ | — | — | — | — |
| Worker variables, repair, retry, purge blocks, and snapshots (run) | ✔ | — | — | — | — |
| Admin tokens (view and manage) | ✔ | — | — | — | — |
| Audit log (view and export) | ✔ | — | — | — | — |
| User management | ✔ | — | — | — | — |
| Change your own password, and the theme | ✔ | ✔ | ✔ | ✔ | ✔ |

- Operations pages (Workers, block errors and block information, metadata snapshots, and repair) are not open to a read-only role for viewing. Only an administrator can use them. These pages are internal diagnostic information. Block information includes the bucket ID, the object key, and the internal version ID. Block errors show disk and data-corruption detail. Worker variables and errors include internal tuning parameters and node paths. A read-only user has no follow-up action they can take after seeing that information. The health information a read-only role needs is already on the cluster health, status, and statistics pages.
- Data model. A user record contains a role (`admin` or `viewer`) and a permission set (two boolean bits, `download` and `share`, default false). For an admin, the two bits mean nothing and are ignored. On save, check that if `share` is true, then `download` must be true. The session does not cache permissions. Each request reads them live from the user store, as 3.4 says. Granting or revoking a permission writes an audit record.

Acceptance: A table-driven test covers every row of this table, across all five columns. A request from V for object preview, download, a thumbnail, or a ZIP token returns 403. After D is granted, those requests succeed. A save that grants S and does not grant D returns 400. After D is revoked, a ZIP token that this user has already exchanged and has not yet used becomes invalid. A request from V to any operations API returns 403.

## 3.20 Tenant accounts

A tenant account lets a business team or tenant use the admin UI for its own buckets only. garage-ui does not keep a second permission model. Garage's own key permissions (`read`, `write`, `owner` per bucket) decide what a tenant reaches.

- Binding. A tenant account is a `viewer` whose user record holds one bound Garage access key ID. An administrator cannot be bound. A `viewer` without a bound key keeps the V columns of 3.19 and sees every bucket. Binding, changing, or removing the bound key writes an audit record and deletes every session of that user (3.12).
- Visible buckets. The bucket list and bucket detail show only the buckets on which the bound key holds at least one of `read`, `write`, or `owner`, read from Garage's `GetKeyInfo`. They are read live on each request and are not cached, so a grant or revoke in Garage takes effect on the next request. Bucket detail for a tenant omits the list of keys on the bucket.
- Other buckets. For a bucket outside that set, every bucket-scoped API (detail, browse, search, preview, download, thumbnail, ZIP, upload, delete, share) returns 404 `not_found`, the same response as a bucket that does not exist. The check runs before any S3 request or bucket-scoped Admin API request for that bucket.
- S3 credential. Every S3 request of a tenant, presigned share links included, is signed with the bound key. A tenant request never uses the project key, a bucket key (4.2 of [correctness.md](correctness.md)), or their shared credential cache. A 403 from Garage is returned as 403 `garage_denied` and is not retried with another credential.
- Missing key. When the bound key no longer exists in Garage, the bucket list and every bucket-scoped API return 403 `tenant_key_unavailable`.
- Caches. A server-side content cache (thumbnails) serves a tenant only after an S3 request signed with the bound key has succeeded for that object.
- `owner`. Garage's `owner` permission does not open bucket settings (aliases, quotas, website, CORS, lifecycle, deletion) in the admin UI. Those stay administrator-only.
- Traceability. Garage logs show the tenant's key on S3 requests. Admin API requests made for a tenant (`GetKeyInfo`) use the admin token. The audit log of 3.13 records the username as for every other account.

Acceptance: A tenant bound to a key with permissions on two of three buckets lists exactly those two. Every bucket-scoped API on the third bucket returns 404, and the fake S3 upstream receives no request for it. S3 requests of a tenant carry the bound key's access key ID, and the project key never appears. A tenant whose key has only `read` gets 403 `garage_denied` on upload, with a single upstream attempt. After the key is deleted in Garage, the tenant's next request returns 403 `tenant_key_unavailable`. A tenant gets 403 on every cluster, key, operations, admin-token, audit, user-management, and raw Admin API proxy route. Changing the bound key ends that user's other sessions.
