# Troubleshooting

Capture the visible error message/code, the affected task, and the UI/Garage versions before retrying. Keep tokens, passwords, and object content out of screenshots and issue reports.

## The UI does not start

| Symptom | Check |
|---|---|
| Secret-file error | The file exists and is readable by the runtime user, including UID 65532 in the container |
| Secret rejected | Supply the real token/key; documented placeholder values, all-zero values, and short keys are rejected |
| Bootstrap import error | Set username and bcrypt hash together; use a valid username and hash |
| Object-key configuration error | Set both S3 access key ID and secret, or neither |
| Authentication-disabled setting | Remove `AUTH_DISABLED`, `DISABLE_AUTH`, and `GARAGE_UI_NO_AUTH` entirely |
| Data directory not writable | Make `DATA_DIR` or its mounted volume writable by the runtime user |
| Listener error | `HOST` must be an IP address, and port 3909 must be available |

The local health probe is:

```sh
./target/release/garage-ui --health
```

It checks `/healthz` on 127.0.0.1:3909 and exits successfully when the probe succeeds. A successful UI liveness check does not prove that Garage is reachable or all S3 operations work.

## Login loops or setup reappears

For intentional local HTTP, set `COOKIE_SECURE=false`. For HTTPS keep it true, and make sure the proxy serves the configured `BASE_PATH` consistently. Secure cookies should not be weakened to fix a production proxy error.

A lost data volume can make setup reappear because the UI has no users. Stop and restore the intended state before creating a new account if that is unexpected. Do not delete the database to recover a password; use [the recovery commands](Users-and-authentication.md#recover-access-from-the-command-line).

Session expiry, a password reset, account disablement, or a permission change can invalidate a login. Sign in again once the account and permissions are correct.

## Garage is unavailable or operations are disabled

Check the admin URL from the UI server's network, the configured token/scopes, and Garage's TLS certificate. Use `GARAGE_TLS_CA_FILE` for a private CA. The UI clearly warns when `GARAGE_TLS_INSECURE=1`; this setting disables certificate verification.

Garage older than v2.3.0 is blocked from writes. A scoped Garage admin token may permit overview reads but deny layout, key, or token operations. A UI administrator still needs the server's Garage token to permit the requested endpoint.

Metrics have their own token and unavailable notice. Repair the metrics configuration separately if cluster health is available but metrics are not.

## Buckets load but objects fail

Verify `S3_ENDPOINT_URL` and `S3_REGION` against Garage's S3 configuration. Explicit settings are necessary for v2.3.0 and v2.4.1. The S3 endpoint must be reachable by the UI process, not merely by your browser.

Choose a **Bucket key** when prompted, or check the configured project-wide S3 key. Verify Read/Write grants for that bucket. A project-wide key overrides a per-bucket choice. An admin token is not an S3 credential. After restoring an unavailable Garage Admin API, retry the object operation in the same UI process: failed S3 discovery probes are not retained until restart. Explicit endpoint/region settings still take precedence.

A pending credential lookup, upload, or read releases the shared credential-cache lock before network I/O, allowing other buckets and permission changes to proceed. When a key changes during credential loading, object operations and share-link signing reload their credentials before filling the cache. A revoked or replaced credential cannot be restored by an in-flight forbidden retry. Check current grants and retry with the intended key. This does not cancel an operation Garage has already accepted.

## Preview, download, share, or upload fails

| Task | Check |
|---|---|
| Preview/download missing for a viewer | The viewer needs Download permission; unsupported content types are not inline previews |
| Share unavailable | Viewer needs both Download and Share; server needs a public S3 endpoint |
| Share link cannot open | Use a recipient-reachable public S3 hostname, the correct region, and an unexpired link |
| ZIP link fails or its stream is interrupted | Check Garage/S3 connectivity and prepare a new ZIP link; discard an incomplete archive. Tokens are short-lived, single-use, and session-user-bound |
| Upload fails | Check file limit, bucket quota, Write grants, connectivity, and queue destination; use Retry after fixing the cause |
| Upload appears in another location | Individual-file keys use filenames; folder uploads use relative folder paths rather than the currently browsed prefix |
| Deletion partially fails | Read remaining per-key errors and the refreshed list before retrying |

Bucket/key catalog mutations invalidate cached pagination boundaries. Refreshing a boundary also discards later offsets; an older in-flight response cannot restore an invalidated cursor. Refresh the list after a change before relying on a later page.

Size/time sorting and many list filters apply to loaded rows or the current page. Use pagination or load more; narrow an object search if it reports truncation.

For a cluster-wide partial failure, follow [Maintenance](Maintenance.md#handle-an-all-node-failure) before retrying successful nodes.

## Report a reproducible problem

Include what you tried, expected and actual results, exact non-secret error text, UI version/source commit, Garage version, browser, and whether deployment is a binary, Compose, or Helm. Add only the relevant redacted settings. Use the [repository issue tracker](https://github.com/xjoker/garage-ui/issues).
