# Remaining-improvement convergence

This checkpoint closes the recorded documentation, interface, verification-harness, secret-scanning, and build-identity improvements relative to formal baseline `6b621b1e13ddba0b0a83c4068138686c49fd28dd`. Verification covers source through `84a24711d8c8c57854c7878dab89fa1d2cca80ed`. It does not establish a published release, a single clean full Rust/browser run, or completion of every working-spec acceptance criterion.

## Scope and source identities

| Checkpoint | Identity | Meaning |
|---|---|---|
| Formal baseline | `6b621b1e13ddba0b0a83c4068138686c49fd28dd` | Comparison base for this development work |
| Source/test checkpoint | `84a24711d8c8c57854c7878dab89fa1d2cca80ed` | Includes the final verification-harness changes |
| Native runtime | `23528d6817123af1f4e479eb13442638d6a212e8` | `/healthz`: `20261015.1-local`, full commit, status `ok` |
| Local Linux arm64 image | `503cd311f1356f0fb1e0a7f0f4eb8da3a50b1a52` | `/healthz`: `20261015.1-local`, full commit, status `ok` |

Later changes between these runtime builds and the source/test checkpoint affect documentation, tests, and verification tooling; production application source is unchanged. The formal `VERSION`, `main`, and existing release draft were not advanced by this phase. The latest published release must not be assumed to contain these development changes.

## Final behavior

| Improvement | Result and source |
|---|---|
| Documentation and release status | Stable-release badges link to the project Releases index; living operator pages describe implementation behavior without a fixed release label. The [documentation map](../../docs/README.md), [delivery status](../../docs/roadmap.md), and [contributor guide](../../CONTRIBUTING.md) distinguish requirements, current implementation, and revision-specific evidence, including bounded AI contributions. |
| Deferred interface loading | Nine management-page modules load on demand through React lazy imports, with an accessible section-loading state. [Application](../../web/src/App.tsx) |
| Shared secret interaction | Keys and admin tokens use the same masked secret dialog, copy feedback/manual-copy fallback, initial focus, and return-focus behavior. [Secret dialog](../../web/src/SecretDialog.tsx) |
| Audit controls and download | A keyboard-operable, initially collapsed Filters disclosure retains values and displays the active count. UTC date inputs stack on narrow screens. “Target” explains the existing exact-match filter. Export remains visible when filters are collapsed; it checks authorization with `HEAD`, then starts a native filtered CSV download without creating a full JavaScript Blob. A rejected preflight displays export failure. [Audit](../../web/src/Audit.tsx), [operator guide](../../docs/wiki/Audit.md) |
| Reproducible fixtures and browser choice | The browser runner owns a disposable Garage container, volume, random Admin/S3 ports, and fresh UI state. Browser selection reaches Playwright workers. The Rust CORS test owns its Garage fixture instead of borrowing a fixed container. [Runner](../../scripts/e2e-check.sh), [browser configuration](../../web/e2e/garage-target.ts), [CORS test](../../crates/garage-ui/src/api/tests/cors_preflight.rs) |
| Secret scanning | Checksum-pinned Gitleaks 8.30.0 scans the worktree and history reachable from all local refs, with redacted output and synthetic detection regressions. A clean scan is bounded by its rules and allowlist. [Scanner](../../scripts/secret-scan.sh), [configuration](../../data/config/gitleaks.toml) |
| Build and distribution identity | Unassigned local builds use `<VERSION>-local`; explicit validated `BUILD_VERSION` reaches binary/image builds. The future CI development identity uses the original workflow-run creation date in UTC plus its workflow-wide `run_number`: `YYYYMMDD.N-dev`. Reruns retain the identity; N does not reset daily. The manual workflow only creates new unpublished drafts. [Build script](../../scripts/build.sh), [build metadata](../../crates/garage-ui/build.rs), [CI](../../.github/workflows/ci.yml), [manual release workflow](../../.github/workflows/release.yml) |

CI remains disabled on GitHub. CI identity behavior was checked with offline metadata/command fixtures; no actual CI development number was allocated and no remote workflow run or publication is claimed.

## Verification results

Receipt names below identify local logs reviewed for this report. Raw logs are deliberately excluded from the public evidence directory because they contain machine-specific context. Reproduction commands are provided below; counts describe this checkpoint only.

| Check | Recorded result | Receipt |
|---|---|---|
| Frontend unit suite | 500 passed across 27 files in the final run | `frontend-final.log` |
| Frontend typecheck, lint, generated API consistency, production build | Passed; generated API diff empty | `typecheck-final.log`, `lint-final.log`, `api.log`, `api-diff.log`, `frontend-build-final.log` |
| Rust library | Initial run: 378/380 passed. Exact shutdown retake passed; the CORS case passed after receiving its owned fixture. 380 unique library cases verified across runs | `rust-full.log`, `shutdown-retake-exact.log`, `cors-green.log` |
| Other Rust checks | 6 load-generator cases and 1 startup integration case passed; 387 unique Rust cases verified in total. Formatting and all-target clippy passed | `loadgen.log`, `boot.log`, `fmt.log`, `clippy.log` |
| Chromium / Garage v2.4.1 | Initial run: 84/88 passed. Four existing Audit cases passed on retake; two new Audit cases passed; four redesign cases passed again with the final disclosure interaction. 90 unique cases verified across runs | `e2e-v241-full.log`, `e2e-v241-retake.log`, `audit-corrected.log`, `e2e-v241-redesign.log` |
| Chromium / Garage v2.3.0 | 71 passed before the run stopped on an existing test's hidden-filter interaction; continuation of the 19 failed/interrupted/unrun cases passed after the test opened the disclosure. 90 unique cases verified across runs | `e2e-v230-final.log`, `e2e-v230-remaining.log` |
| WebKit on macOS / Firefox on Linux | Each browser passed two live smoke cases at 360 and 1280 CSS px against each of Garage v2.4.1 and v2.3.0: authentication, bucket creation, upload, byte-exact download, and Audit CSV export | `webkit-v2.4.1.log`, `webkit-v2.3.0.log`, `firefox-v241.log`, `firefox-v230.log` |
| Dependency audits | Cargo and Bun: 0 vulnerabilities. Cargo retains the allowed `paste` unmaintained warning ([RUSTSEC-2024-0436](https://rustsec.org/advisories/RUSTSEC-2024-0436)) | `cargo-audit.log`, `bun-audit.log` |
| Secret scans | 0 findings in the worktree and all-ref history; 743 reachable commits in this snapshot. Scanner detection/redaction fixtures passed | `secrets-final.log`, `scanner-green.log` |
| Build identity and browser-selection checks | Passed, including local/dev version propagation and worker browser-project selection | `version-final.log`, `dev-version-final.log`, `browser-config-final.log` |

The Rust and Chromium totals are combined verification, **not single clean full-suite runs**. Unit-suite output includes jsdom limitations such as canvas/navigation support; passing unit tests do not replace browser verification.

The pinned Playwright 1.64 Firefox could not start on macOS 27, consistent with the app-data privacy issue tracked in [Playwright #42768](https://github.com/microsoft/playwright/issues/42768). No privacy settings were changed. The same pinned Firefox tests ran on Linux through an existing Bun container. These results do not establish macOS Firefox or physical-phone compatibility.

### Regression contracts

Pre-change checks recorded actual failures for eager section loading and the missing Target label (`frontend-red.log`: 2 failures), native CSV preflight/download and rejected-preflight handling (`export-red.log`: 2 failures), unassigned local version identity (`version-red.log`), browser selection reaching workers (`browser-config-red.log`: 1 failure), and detection of a synthetic worktree secret (`scanner-red.log`). The final frontend suite and focused identity/browser/scanner checks above passed. These regressions describe final behavior, rather than a chronology of implementation attempts.

### Bundle and image measurements

The entry JavaScript changed from **733,968 to 496,574 bytes** (32.34% reduction), or **206,926 to 151,520 gzip bytes** (26.78% reduction), using the same recorded comparison method (`bundle-comparison-final.json`). This comparison excludes CSS and lazy chunks; it measures file size, not total transferred assets or network speed.

The local no-cache Linux arm64 image was `sha256:099d37a6a30b8a5e738acc541a21cbb24437da329032ef60bd0d1841de902062`. Runtime inspection confirmed user `65532:65532`, a read-only root filesystem, the embedded brand SVG, the entry and lazy Audit assets, and the binary health check (`image-runtime.json`). This was local image validation, not deployment or registry publication.

## Inspect the Audit layout

These curated Chromium captures use Garage v2.4.1, an 800 CSS-pixel viewport height, and disposable fixtures. They show the final controls and responsive layout; they do not establish all-page or all-browser accessibility.

| 360 px, collapsed | 360 px, expanded |
|---|---|
| ![Audit with filters collapsed at 360 px](audit-filters-collapsed-360-viewport.png) | ![Audit with filters expanded at 360 px](audit-filters-open-360-viewport.png) |

![Audit with filters expanded at 1280 px](audit-filters-open-1280-viewport.png)

## Reproduce the checkpoint

Use the pinned toolchains, installed dependencies, browser binaries, local Garage images, and exclusive UI port documented in [Contributing](../../CONTRIBUTING.md#verify-the-affected-behavior). Build embedded frontend assets before Rust checks, and build the debug binary before browser checks. Run against disposable data; the browser and CORS checks mutate their owned Garage fixtures. The commands below are entrypoints, not a claim that an arbitrary environment will reproduce a clean run.

From `web/`:

```sh
bun run test -- src/App.lazy.test.tsx src/Audit.test.tsx src/Keys.test.tsx src/AdminTokens.test.tsx
bun run typecheck
bun run lint
bun run generate:api
git diff --exit-code -- src/api/garage-admin-v2.ts
bun run build
```

From the repository root:

```sh
scripts/check-build-identity.sh
scripts/check-dev-version.sh
bun scripts/check-browser-projects.ts
scripts/check-secret-scan.sh
scripts/secret-scan.sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test -p garage-ui --lib browser_preflight_matches_the_saved_cors_rule
cargo test -p garage-ui --lib network_server_serves_health_and_closes_idle_clients_on_shutdown
cargo test -p garage-loadgen
cargo test -p garage-ui --test boot
scripts/e2e-check.sh e2e/audit-filters.spec.ts
GARAGE_VERSION=v2.3.0 scripts/e2e-check.sh e2e/audit-filters.spec.ts
scripts/e2e-check.sh disposable-smoke.spec.ts --project=webkit
GARAGE_VERSION=v2.3.0 scripts/e2e-check.sh disposable-smoke.spec.ts --project=webkit
scripts/e2e-check.sh disposable-smoke.spec.ts --project=firefox
GARAGE_VERSION=v2.3.0 scripts/e2e-check.sh disposable-smoke.spec.ts --project=firefox
```

For complete-suite reproduction, use `bun run test` in `web`, `cargo test --workspace` at the root, and `scripts/e2e-check.sh e2e` for each Garage version. Keep browser runs sequential. Linux Firefox needs the Playwright system dependencies described in Contributing. These reproduction commands do not embed the private remote-container setup used for this run.

## Remaining boundaries

No Linux amd64 image, large-file, performance, or coverage run was repeated in this phase. Results in the [earlier formal report](../nine-fixes/report.md) remain historical evidence for its recorded revision and environment. This report makes no new coverage percentage, throughput, large-object, remote-network, or physical-phone claim.

Remote CI execution, signing/provenance, publication, and full working-spec acceptance remain subject to the [delivery status](../../docs/roadmap.md). Garage version/support policy is tracked separately in the [official support check](../../docs/garage-support.md); this report does not establish that assessment's outcome.
