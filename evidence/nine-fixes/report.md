# Nine audit fixes

Source fixes through `e4d8919fd0a8d5fc8e9b687e522931bf034632fe` address the nine recommendations recorded in the [Radix migration report](../radix-migration/report.md). The source/native/browser validation below used product version `20261014.2`, with the native binary reporting commit `b5b36810395bb65dc1064f32c74902b141d644aa`. Subsequent changes at `c8ba933` affect the validation harness. Exact versioned Linux artifact identities, checksums, and container runtime results are recorded separately in the matching release notes through the `scripts/release.sh` workflow; this report does not establish those artifact gates or a published release.

## Corrected behavior

| Finding | Behavior after the fix | Source and operator guidance |
|---|---|---|
| B2: failed S3 discovery cached until restart | Unsuccessful discovery is not cached, so the same process can retry after an Admin API outage. Explicit endpoint/region overrides are retained. | [State](../../crates/garage-ui/src/state.rs), [Troubleshooting](../../docs/wiki/Troubleshooting.md#buckets-load-but-objects-fail) |
| B3: credential lock spans network I/O | Credential resolution releases its lock before an S3 operation. Revision checks prevent a forbidden retry from restoring credentials invalidated by a mutation or newer request. | [State](../../crates/garage-ui/src/state.rs), [Troubleshooting](../../docs/wiki/Troubleshooting.md#buckets-load-but-objects-fail) |
| B4: fatal ZIP failure becomes clean EOF | Fatal object-body/archive errors fail the response body. Dropping the body cancels the archive producer and pending S3 work. Recoverable failures opening selected objects still use `_errors.txt`. | [ZIP response](../../crates/garage-ui/src/api/objects.rs), [Downloads](../../docs/wiki/Downloads-and-sharing.md#download-several-objects-as-a-zip) |
| B5: all-node failures lost during normalization | Mixed outcomes return HTTP 502, `garage_partial_failure`, and both node maps. All-failed outcomes use `garage_error`; complete success retains its previous shape. Successful nodes may already have applied a mutation: inspect outcomes before retrying. | [Normalization](../../crates/garage-ui/src/api/workers.rs), [Maintenance](../../docs/wiki/Maintenance.md#handle-an-all-node-failure) |
| B6: upstream rejection audited as success | Non-2xx and per-node-error mutation responses produce error audit records without changing the proxy response or copying raw upstream details into audit. An upstream 200 with node errors can therefore have audit result `error` and status 200. | [Proxy](../../crates/garage-ui/src/proxy.rs), [Audit](../../docs/wiki/Audit.md#find-an-event) |
| B7: stale catalog pagination boundaries | Successful bucket/key catalog mutations invalidate cursors. Refreshing or changing a boundary discards later offsets; older in-flight responses cannot restore invalidated offsets. | [Proxy](../../crates/garage-ui/src/proxy.rs), [Troubleshooting](../../docs/wiki/Troubleshooting.md#preview-download-share-or-upload-fails) |
| B8: formula-leading audit CSV cells | CSV adds a single quote to dangerous text prefixes, including full-width formula markers and leading whitespace/control cases. Stored text and JSON remain unchanged. Spreadsheet save/reopen transformations are outside this guarantee. | [Audit export](../../crates/garage-ui/src/api/audit.rs), [Export guide](../../docs/wiki/Audit.md#export-filtered-records) |
| B9: audit pagination/export buffer all matches | SQL selects only `limit + 1` list rows. Export reads 128-row batches, emits frames up to 64 KiB, and fixes its upper audit ID at export start. Dropping the body drops pending work; no background export task is spawned. This bounds server buffering, not the browser's downloaded-file buffer. | [Audit export](../../crates/garage-ui/src/api/audit.rs), [Export guide](../../docs/wiki/Audit.md#export-filtered-records) |
| F12: artifacts lack source identity | Official build/release scripts pass the full `GIT_COMMIT`. Release checks compare exact final-image `/healthz` version and `commit`. Compose accepts the optional build input and defaults to `unknown`; invalid commit inputs fail the build. | [Build input](../../crates/garage-ui/build.rs), [Deployment](../../docs/wiki/Deployment.md#verify-the-deployed-source-revision) |

## Focused regression evidence

Receipts below are log basenames from the verification run; they are not bundled in this report. Focused pre-fix tests failed on the original behavior and passed after implementation. The audit pagination correctness test already passed before the SQL change; it is not claimed as a red regression.

| Check | Recorded result | Receipts |
|---|---|---|
| B2/B3 regressions | 2 failing pre-fix tests; 13 state tests and 6 affected S3 API tests passed after fixes | `s3-red.log`, `s3-lock-red.log`, `s3-green.log`, six affected object-operation `*-green.log` files |
| B4 regression | 1 failing pre-fix test; 6 archive tests passed | `zip-red.log`, `zip-green.log` |
| B8/B9 regressions | 2 failing pre-fix export tests; 8 audit tests passed | `audit_export_neutralizes_formula_cells_without_changing_evidence-red.log`, `audit_export_yields_bounded_chunks_across_the_entire_filtered_history-red.log`, `audit-green.log` |
| B6/B7 regressions | 6 failing pre-fix tests; 26 proxy tests passed | named audit/catalog `*-red.log`, `proxy-boundary-red.log`, `proxy-green.log` |
| B5 backend outcomes | 2 failing pre-fix tests; 2 tests passed, each covering success, mixed, and all-failed outcomes | `all_node_workers_preserve_node_outcomes-red.log`, `all_node_repair_preserves_node_outcomes-red.log`, `nodes-green.log` |
| B5 frontend behavior | 2 focused tests passed | `nodes-ui-green.log` |
| Build identity regression check | Passed with `sh scripts/check-build-identity.sh` | `identity-edition-green.log` |

## Source, native, and browser validation

| Check | Result | Receipt |
|---|---|---|
| Full frontend unit suite | 497 tests passed across 26 files | `frontend-unit.log` |
| Frontend typecheck, lint, generated API consistency, production build | Passed; build retained Vite's chunk-size warning | `frontend-typecheck.log`, `frontend-lint.log`, `frontend-api.log`, `frontend-api-diff.log`, `frontend-build.log` |
| Full Rust workspace suite | One clean run: 380 library tests, 6 load-generator tests, and 1 startup integration test passed; documentation tests completed with 0 tests | `rust-full-coverage.log` |
| Rust formatting and workspace/all-target clippy | Passed | `fmt-green.log`, `clippy-green.log` |
| Backend workspace line coverage | 20,849 / 22,244 lines = 93.73%, exceeding the 80% target | `coverage.lcov`, `coverage-summary.json` |
| Frozen security source set line coverage | Weighted aggregate: 11,635 / 12,103 lines = 96.13%, exceeding the 95% target | `coverage.lcov`, `coverage-summary.json` |
| Garage v2.3.0 full browser suite | 86 passed in one full run (11.7 minutes), including two all-node failure-handling cases | `e2e-v230.log` |
| Garage v2.4.1 full browser suite | 86 passed in one full run (11.8 minutes), including two all-node failure-handling cases | `e2e-v241.log` |
| Setup wizard and TLS warning browser suites | 1 passed in each suite | `e2e-wizard.log`, `e2e-tls.log` |
| S3 discovery recovery in the browser | At 1280 and 360 px, outage response HTTP 502 `garage_unavailable` recovered to HTTP 200 after clicking Retry in the same UI process; UI upload and byte-exact download passed at both widths | runtime `summary.json`, `s3-runtime-verified.log` |
| Large-catalog first visible row | 10,000 real buckets: maximum 521.5 ms; 100,000 real objects: maximum 232.9 ms; three fresh browser contexts per list, each below 2,000 ms | performance `results.json`, `counts.json` |
| Dependency checks | Cargo: 0 vulnerabilities with the existing allowed `paste` unmaintained warning; Bun production dependencies: 0 vulnerabilities; open Dependabot alerts: 0 | `cargo-audit.log`, `frontend-audit.log`, repository alert review |
| Scoped secret scan | 0 findings | `secret-scan.log` |

Coverage uses cargo-llvm-cov 0.9.1's standard source line metric, including inline `cfg(test)` code, without custom exclusions or denominator changes. The frozen security set under `crates/garage-ui/src/` is `access.rs`, `session.rs`, `password.rs`, `limit.rs`, `proxy.rs`, `redact.rs`, `config.rs`, `db.rs`, `http.rs`, `cli.rs`, and `api/{mod,auth,users,objects,keys,admin_tokens,audit}.rs`. Its percentage is the sum of covered lines divided by the sum of counted lines, rather than an average of file percentages.

The S3 recovery fixture returned controlled HTTP 503 responses for `GetNodeInfo`, then forwarded the real Garage v2.4.1 payload with its Docker endpoint translated to the server-reachable address. The application had no `S3_ENDPOINT_URL` override. The UI process stayed unchanged through the failed and successful requests; both viewports had no horizontal overflow. The temporary objects, bucket, key, and UI data were cleaned up. This tests controlled outage recovery while using real Garage storage for the recovered upload/download, rather than a real cluster-wide outage.

Performance measured navigation start to the first visible data row in a fresh authenticated Chromium context at 1280 × 800 px. Each run rendered 100 rows, made one request to the measured list, made no per-object requests, served stable asset hashes, and had no browser errors. The owned fixture container and volume were cleaned up. These local measurements do not establish remote-network or physical-phone performance.

The two all-node browser failure cases intercept controlled HTTP failure responses at 360 and 1280 px. They verify visible errors and the absence of a repair-completion notice; they do not execute destructive repair against Garage. Native runtime `/healthz` confirmed the full commit and version named above. The [older migration evidence](../radix-migration/report.md) retains its original build identities and results.

## Reproduce the focused checks

Use the pinned toolchains and dependencies in [Contributing](../../CONTRIBUTING.md). Build the browser bundle before Rust checks so the embedded-asset build input exists. Run from a checkout of the intended revision, use isolated test data, and retain command output with the full source commit.

From `web/`:

```sh
bun install --frozen-lockfile
bun run build
bun run test src/Workers.test.tsx -t all-node
```

From the repository root:

```sh
cargo test -p garage-ui --lib state::
cargo test -p garage-ui --lib archive_
cargo test -p garage-ui --lib proxy::
cargo test -p garage-ui --lib audit_
cargo test -p garage-ui --lib all_node_
sh scripts/check-build-identity.sh
```

The state tests include same-process outage recovery and stalled-operation/invalidation concurrency. Archive tests include partial S3 bytes followed by a fatal error and cancellation of a stalled body. Proxy tests cover upstream rejection, mixed audit outcomes, catalog mutations, refreshed boundaries, changed page limits, and older in-flight responses. Audit tests exercise formula prefixes without changing stored evidence, filtered pagination, and a 1,999-record export across multiple bounded frames. All-node tests exercise the three backend outcomes; the two frontend tests ensure failures remain visible and repairs do not report completion.

The six affected S3 regressions can be selected individually from the root:

```sh
for test_name in \
  object_list_retries_once_when_s3_returns_403 \
  object_list_stays_403_when_s3_denies_twice \
  object_put_retries_once_when_s3_returns_403 \
  object_get_download_of_plain_is_an_attachment \
  ranged_object_returns_the_requested_bytes \
  download_drop_cancels_the_s3_get_within_one_second
do
  cargo test -p garage-ui --lib "$test_name" || exit 1
done
```

For broader reproduction, follow [Contributing](../../CONTRIBUTING.md) to build the frontend and debug binary required by the Playwright configuration, then run the Garage v2.3.0/v2.4.1 browser suites against its documented disposable fixtures. Retain results for that exact binary. Verify exact deployed artifact identity with the [deployment procedure](../../docs/wiki/Deployment.md#verify-the-deployed-source-revision); the lightweight build-identity check alone does not validate a container or release binary.

To reproduce the controlled same-process discovery recovery with the validation harness at `c8ba933`, build the debug binary with web dependencies and Chromium installed, arrange the disposable Garage v2.4.1 fixture described in Contributing, and run from the repository root:

```sh
GARAGE_VERSION=v2.4.1 GARAGE_UI_BINARY="$PWD/target/debug/garage-ui" \
  S3_RECOVERY_OUT="$PWD/evidence-local/s3-recovery" \
  bun scripts/s3-recovery-check.ts
```

The harness creates and removes its temporary storage objects and UI state and writes a summary to the chosen output directory. Keep that directory out of version control: raw receipts can contain local fixture addresses and identifiers.
