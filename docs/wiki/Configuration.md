# Configuration

Garage UI reads environment variables and a `.env` file in its working directory. Process environment variables override the same names in `.env`. There is no Garage UI TOML configuration loader. Garage's own TOML file belongs to Garage.

Restart the UI after changing server configuration. Browser **Settings** controls appearance and your password, not server connection settings.

## Connect the admin API

| Variable | Default | Meaning |
|---|---|---|
| `API_BASE_URL` | Unset | Garage admin API base address |
| `GARAGE_ADMIN_URL` | Unset | Alias used when `API_BASE_URL` is absent or empty |
| `API_ADMIN_KEY_FILE` | Unset | File containing the Garage admin token; takes priority over the token variable |
| `GARAGE_ADMIN_TOKEN` | Unset | Garage admin token when no token file is configured |
| `METRICS_TOKEN_FILE` | Unset | Metrics token file; takes priority over the token variable |
| `GARAGE_METRICS_TOKEN` | Unset | Token for Garage metrics |
| `GARAGE_ADMIN_CONNECT_TIMEOUT_SECS` | `5` | Connection timeout |
| `GARAGE_ADMIN_TIMEOUT_SECS` | `30` | Admin request timeout |
| `GARAGE_TLS_CA_FILE` | Unset | PEM CA file for Garage TLS connections |
| `GARAGE_TLS_INSECURE` | Unset | Exactly `1` disables Garage certificate verification and displays a notice |

Use addresses reachable from the UI server. In a container, `127.0.0.1` refers to that container. Use the Garage service's network address instead.

Secret files must be readable by the UI process. Token files have trailing line endings removed; tokens must be at least 16 bytes. Known example tokens and all-zero values are rejected. An empty token file does not fall back to `GARAGE_ADMIN_TOKEN`.

## Connect object operations

| Variable | Default | Meaning |
|---|---|---|
| `S3_ENDPOINT_URL` | Unset | S3 API address reachable from the UI server |
| `S3_REGION` | `garage` | Signing region; set it to the region configured in Garage |
| `S3_PUBLIC_ENDPOINT_URL` | Unset | S3 address reachable by recipients of presigned share links |
| `PUBLIC_S3_URL` | Unset | Alias for the public address when the primary variable is absent or empty |
| `S3_ACCESS_KEY_ID_FILE` / `S3_ACCESS_KEY_ID` | Unset | Optional project-wide S3 access key ID |
| `S3_SECRET_ACCESS_KEY_FILE` / `S3_SECRET_ACCESS_KEY` | Unset | Matching project-wide S3 secret |
| `MAX_UPLOAD_SIZE_MB` | `512` | Maximum individual upload size in MiB; accepted setting range 1–10240 |
| `FANOUT_LIMIT` | `8` | Positive concurrency limit for backend fan-out work |

Set both sides of the project S3 key or leave both unset. Each file variable takes priority over its corresponding value variable. A project-wide key takes priority over a selected per-bucket key. It still needs the relevant S3 permissions on each bucket.

Without a project key, the UI can use Garage key credentials and retain the selected key ID for a bucket. If **Bucket key** appears, an administrator selects a key and chooses **Use this key**. See [Keys and permissions](Keys-and-permissions.md).

On Garage v2.3.0 and v2.4.1, explicitly set `S3_ENDPOINT_URL` and `S3_REGION`; those versions lack the newer endpoint-discovery fields. Share links additionally require the public S3 address. A private container hostname in that setting produces links that recipients cannot reach.

## Listener, sessions, and persistence

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | IP address to bind; port is fixed at 3909. The container image sets `0.0.0.0` |
| `GARAGE_HEADER_READ_TIMEOUT_SECS` | `10` | HTTP/1 request-header read timeout in seconds |
| `GARAGE_IDLE_TIMEOUT_SECS` | `60` | Connection inactivity timeout in seconds; successful reads or writes reset it |
| `DATA_DIR` | `./data` | Writable directory for `garage-ui.sqlite` and generated `session.key` |
| `AUDIT_RETENTION_DAYS` | `90` | Automatic audit retention in days; accepts integers from 1 through the signed 64-bit maximum, otherwise uses 90 |
| `BASE_PATH` | Empty | URL prefix, such as `/garage-ui`; affects routes, assets, and cookie path |
| `COOKIE_SECURE` | `true` | Accepts `true` or `false`; keep `true` for HTTPS |
| `SESSION_KEY_FILE` | Unset | Optional session signing key file, at least 32 bytes; otherwise the UI creates a persistent key in `DATA_DIR` |
| `SESSION_ABSOLUTE_SECS` | `86400` | Maximum session age, normally 24 hours |
| `SESSION_IDLE_SECS` | `7200` | Idle session limit, normally 2 hours |
| `TRUSTED_PROXY` | Unset | Exactly `true` trusts forwarded client-address headers for client IP handling |
| `GARAGE_UI_BOOTSTRAP_USERNAME` | Unset | Initial UI administrator username |
| `GARAGE_UI_BOOTSTRAP_PASSWORD_HASH` | Unset | Matching bcrypt password hash; imported only into a database with no users |

Only trust proxy headers when direct access is restricted and your reverse proxy replaces incoming client-address headers. `BASE_PATH` must match the path served by that proxy. A provided session key must be preserved along with the UI database; changing the key prevents existing cookies from authenticating.

Session and timeout durations accept positive seconds up to one year; invalid values fall back to defaults. Invalid upload-size and fan-out settings also fall back to defaults. Invalid `COOKIE_SECURE` values stop startup.

Audit cleanup runs at startup and then every 86400 seconds, deleting records older than `AUDIT_RETENTION_DAYS`. Configure it here and restart the server; the audit UI has no retention setting. See [Audit](Audit.md).

`WEBSITE_ROOT_DOMAIN` is read as an optional website-domain setting. `UPDATE_URL` is read, but the current update-check function performs no network check; it does not enable automatic upgrades.

Authentication is always on. Merely defining `AUTH_DISABLED`, `DISABLE_AUTH`, or `GARAGE_UI_NO_AUTH` stops startup, even with a false-looking value.

Implementation reference: [configuration loader](https://github.com/xjoker/garage-ui/blob/dev/crates/garage-ui/src/config.rs).
