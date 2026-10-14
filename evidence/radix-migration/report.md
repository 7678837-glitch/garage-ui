# Radix Themes migration evidence

Verified on October 14, 2026. Product build: `a7000a8` (`20261014.2`), with the Vite frontend embedded in the Rust binary and served from one container.

## Build and test results

| Check | Result | Receipt |
|---|---|---|
| Corrected affected frontend tests | 223 passed in 6 files | `garage-ui-radix-call111-affected.log` |
| Frontend production build | Passed | `web-build-responsive.log` |
| Native embedded-asset build | Passed | `native-build-responsive.log` |
| Rust formatting | Passed | `cargo fmt --all --check` |
| Rust clippy | Passed | `clippy.log` |
| Rust library tests | 363 passed; one timing-sensitive quota assertion failed, then its exact retry passed | `rust-tests.log`, `rust-share-focused.log` |
| Load generator | 6 passed | `loadgen.log` |
| Startup configuration | 1 passed | `rust-remaining.log` |
| TLS configuration | 2 passed | `rust-tls.log` |
| Rust documentation tests | Completed; 0 tests | `rust-doc.log` |
| Bun dependency audit | 0 vulnerabilities across 429 packages | `bun-audit.log` |
| Cargo dependency audit | 0 vulnerabilities; one allowed `paste` maintenance warning | `cargo-audit-verified.log` |
| Setup wizard browser flow | 1 passed | `e2e-wizard-final.log` |
| TLS warning browser flow | 1 passed | `e2e-tls-final.log` |
| Public screenshot capture | 1 passed; desktop and mobile images visually reviewed | `public-capture.log`, [screenshot metadata](../../docs/images/README.md) |
| Garage v2.3.0 browser suite | 84 passed in one full run (11.6 minutes) | `e2e-v230-final.log` |
| Garage v2.4.1 browser coverage | 84 unique required cases have passing evidence across runs | `e2e-v241-focused.log`, `e2e-v241-remaining-verified.log`, `e2e-v241-responsive.log`, `e2e-v241-header.log` |

The initial frontend run recorded 481 passes and 14 failures. The six affected files were corrected and rerun: 223 passed. This establishes the corrected affected set, rather than a second all-green full-suite run. The verified Cargo audit used the current lockfile with `rustls` 0.23.46 and the locally available advisory database (`cargo audit --no-fetch`).

The Rust failure was the 200 ms quota-window assertion in `accept::share_presigns_a_question_mark_key`; an exact isolated retry passed. No second full Rust run is claimed.

The final frontend build produced a 208.38 kB gzip JavaScript bundle and retained Vite’s chunk-size warning.

## Container runtime

Both current images were built without cache from `9688809`, whose product code is `a7000a8`; later source changes are test-only. Both use UID/GID `65532:65532` and entrypoint `/garage-ui`.

| Platform | Image ID | Verification |
|---|---|---|
| `linux/arm64` | `453df1479a09` | Build and complete runtime gate passed |
| `linux/amd64` | `66d4605c8037` | Build and read-only `--version` smoke passed |

Build receipts: `container-build-responsive-retry-arm64.log`, `container-build-responsive-retry-amd64.log`. The arm64 runtime gate used a 256 MiB memory and swap limit with a read-only root filesystem:

- Uploaded exactly 5 GiB with HTTP 201 and downloaded the same 5 GiB with HTTP 200.
- Decoded 100 thumbnails from 4096 × 4096 px sources in an actual browser, with 100 image responses.
- Verified that a disconnected upload left no incomplete multipart uploads.
- Streaming a 1 GiB upload grew measured memory by 35,630,613 bytes, below the 64 MiB growth budget.
- The container remained running with `oom_killed=false`; the temporary runtime resources were removed afterward.

Receipt: `container-runtime-responsive.log`, ending with `gate=pass`. This arm64 runtime gate does not establish equivalent live execution on amd64.

## Browser evidence and limits

The focused run used the actual embedded application against Garage v2.4.1. Mobile controls were checked against a minimum 36 px interactive hit area and 16 px input text. Radix TextField wrapper presses were verified to focus their input; geometry and screenshots waited for finite visible animations to finish. Record rows retained positive-height and scroll-container visibility assertions.

Garage v2.4.1 now has passing evidence for all 84 required cases: 7 focused passes; an initial 77-case run with 60 passes and 17 failures; a 38-case affected retake with 36 passes and 2 failures; then both exact remaining retakes passed. This is combined passing coverage, not one clean 84-case run. Garage v2.3.0 passed all 84 cases in one full run. Viewport coverage included 360, 390, 768, and 1280 px widths; the suites exercised English and Simplified Chinese, Light and Dark themes, video Range responses and seeking, ZIP download, and deletion. The separate setup wizard and TLS warning suites each passed one browser flow. Public screenshots capture product `a7000a8` at 1280 × 800 and 360 × 800 px, with a 390 × 800 px check. The mobile capture shows both folders and both objects on the first screen. Disposable sample files, their bucket, and their key were cleaned up after the successful capture. Mobile results refer to CSS viewports in a desktop browser, rather than a physical phone.

Destructive cluster maintenance was inspected through its confirmation and cancellation paths; live repair or destructive maintenance execution is outside this evidence.

## Large-catalog performance

The native embedded product `a7000a8` was measured with 10,000 real buckets and 100,000 zero-byte text objects. Each of three runs per list used a fresh authenticated Chromium context at 1280 × 800 px. Timing ran from navigation start to the first visible data row; the threshold remained 2,000 ms.

| List | Catalog size | Runs | Slowest first row |
|---|---|---|---|
| Buckets | 10,000 | 3 | 685.3 ms |
| Objects | 100,000 | 3 | 253.7 ms |

All six runs rendered 100 rows, made one request to the measured list, made no per-object requests, reported no browser errors, and served identical asset hashes. Upstream logs recorded exactly three S3 list requests across the three object-list runs. The gate returned `pass=true`.

This was a local loopback test; it does not measure remote-network latency or physical-phone performance. Receipts: `results.json`, `counts.json`, and `performance-measure-final.log`; measurement script revision: `c473e9b`. The owned performance fixture containers and volumes were cleaned up and their final inventories were empty (`performance-cleanup-final.log`).

## Remaining recommendations

These nine existing source-audit recommendations remain open; this migration does not establish a defect-free repository. They were not freshly reproduced at runtime here.

| Priority | Finding | Follow-up |
|---|---|---|
| P1 | Failed S3 endpoint probes remain cached until restart | Expire failed probes and verify recovery without restarting |
| P2 | Credential locking spans complete uploads | Release the cache lock before network I/O |
| P2 | ZIP stream failures end as HTTP success | Propagate archive-production failures through the response body |
| P2 | All-node normalization discards individual failures | Preserve mixed and all-failed outcomes |
| P2 | Rejected upstream mutations are audited as successful | Derive audit outcome from upstream status and partial outcomes |
| P2 | Catalog cursors survive mutations and refreshed boundaries | Invalidate stale pagination boundaries |
| P2 | Audit CSV permits spreadsheet-formula prefixes | Neutralize formula-leading exported cells |
| P2 | Audit pagination and export buffer matched history | Paginate in SQL and stream exports |
| P2 | Docker-derived artifacts lack source identity | Pass and verify an explicit source-commit build input |

An approximately seven-second retry delay for an unconfigured bucket key was also observed and remains a separate usability follow-up.

## Reproducing the checks

Run frontend build and affected tests from `web/`, Rust checks from the repository root, and the documented Playwright suites against isolated Garage test instances. Each browser suite creates a fresh UI data directory. Public capture fixtures must be disposable and cleaned up after capture.

```sh
cd web
bun run build
bun run test
bun audit
GARAGE_VERSION=v2.4.1 bun run test:e2e
GARAGE_VERSION=v2.3.0 bun run test:e2e
```

Run the Rust commands from the repository root:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo audit --no-fetch
```
