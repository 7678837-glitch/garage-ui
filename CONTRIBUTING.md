# Contributing

Garage UI is under active development. The CI workflow remains disabled until development is finished; do not re-enable it as part of a contribution or treat missing CI checks as passing checks. Read the [development and release identity rules](docs/engineering.md#79-release-and-images) before preparing artifacts; verification applies to the recorded source commit.

## Read before changing code

Read the applicable [repository instructions](AGENTS.md), the [working spec](docs/README.md), and the relevant source and tests. [DEV-GUIDE.md](DEV-GUIDE.md) is the historical requirements draft, with superseded Go/pnpm instructions. Honor generated-file notices and update their source rather than editing managed instruction files directly. The working spec and [decisions](docs/decisions.md) describe the current Rust/Bun stack. Specs contain acceptance targets, so confirm a feature in source before describing it as implemented.

Use English for code comments, errors, UI copy, documentation, commits, and pull requests. Simplified Chinese belongs in the existing UI locale catalog or deliberate non-ASCII test fixtures.

## Repository and script map

| Location | Purpose |
|---|---|
| [crates/garage-ui](crates/garage-ui) | Rust service, API handlers, authentication, SQLite state, and embedded frontend |
| [crates/garage-loadgen](crates/garage-loadgen) | Development-only Garage test-data generator; excluded from the runtime image |
| [web/src](web/src), [web/e2e](web/e2e) | React interface, component tests, and browser integration tests |
| [openapi](openapi) | Pinned Garage API input; generated frontend types live in `web/src/api` |
| [deploy](deploy) | Runtime Dockerfile, local/existing-cluster Compose examples, and UI-only Helm chart |
| [docs](docs/README.md), [evidence](evidence) | Working spec, operator Wiki, delivery status, and revision-specific verification reports |
| [VERSION](VERSION), [CHANGELOG.md](CHANGELOG.md) | Release identity and historical change notes |

Use [scripts/build.sh](scripts/build.sh) for host or local image builds and [scripts/check-build-identity.sh](scripts/check-build-identity.sh) for the focused source-identity check. [scripts/release.sh](scripts/release.sh) owns local release artifact preparation; read [release requirements](docs/engineering.md#79-release-and-images) before using it. Publishing requires separate maintainer authorization.

Focused tooling checks run from the repository root:

| Command | Scope and prerequisites |
|---|---|
| `scripts/check-dev-version.sh` | Checks local/development build-version propagation and CI identity assignment using disposable command fixtures; requires Python 3 and Git, without building binaries or images |
| `bun scripts/check-browser-projects.ts` | Checks browser-project selection and propagation to Playwright workers; requires Bun and the installed `web` dependencies, without launching browsers |
| `scripts/check-secret-scan.sh` | Checks scanner detection, redaction, and all-ref history behavior in disposable repositories with synthetic fixtures; requires Python 3, Git, and the pinned Gitleaks binary described below |

Specialized validation tools live under [scripts](scripts): `list-performance.ts` measures real catalog lists; `large-file-check.sh` and `large-file-browser.ts` exercise large-object and browser-thumbnail behavior; `s3-recovery-check.ts` checks same-process S3 discovery recovery; `zip-pack-memory.py` measures ZIP memory use. Read each tool's prerequisites before running it: these tools can create fixtures, write data, and use shared Docker/services. `api-split-lines.sh` compares the API module split with a supplied historical base. The scope of `secret-scan.sh` is described under [AI assistance](#use-ai-assistance-within-a-bounded-task).

Keep raw local receipts under ignored `evidence-local/`; Playwright's generated `web/test-results/` and `web/playwright-report/` are ignored as well. Curate public, credential-free evidence deliberately under `evidence/`. Ignoring a path does not remove files that are already tracked.

## Set up local development

Install the pinned Rust toolchain from [rust-toolchain.toml](rust-toolchain.toml), Bun version from [web/package.json](web/package.json), and Python 3 available as `python3` for the build script's version validation. From the repository root:

```sh
scripts/build.sh
```

This installs frontend dependencies with the frozen lockfile, builds `web/dist`, and builds the host release binary. The backend build requires `web/dist/index.html`, including when running Rust tests; build the frontend first in a clean checkout.

The shipped UI uses React, Vite, Radix Themes, and `radix-ui`; [web/package.json](web/package.json) and the lockfile own the dependency versions. Reuse the installed Radix controls and the theme tokens in `web/src/theme.tsx` and `web/src/index.css` before adding local styling. Keep native file inputs for upload and the existing confirmation flow for destructive actions. The production Rust binary embeds `web/dist`; Bun runs only during builds and local development, so changes must not require a browser CDN, Node.js runtime, or separately deployed frontend.

For frontend iteration, run the backend with the Garage configuration described in [Build and run](README.md#build-and-run), then run this in another terminal:

```sh
cd web
bun run dev
```

Vite proxies `/api` and `/healthz` to the backend on `127.0.0.1:3909`. Use an isolated `DATA_DIR` for development, and do not point tests at an operator's live data directory. For local cleartext only, set `COOKIE_SECURE=false`. Do not occupy a port or replace a server owned by another contributor.

The backend uses SQLite for UI users, sessions, audit records, one-time ZIP tokens, and bucket-to-access-key mappings. Object payloads and Garage bucket/key state remain in Garage, accessed through S3 and the Admin API. SQLite is not an object-data cache. `DATA_DIR` also holds the generated session key; preserve this directory when its users and sessions need to survive a restart. Relevant implementation: [database schema](crates/garage-ui/src/db.rs) and [configuration](crates/garage-ui/src/config.rs).

## Verify the affected behavior

Use the smallest checks that establish the change's behavior. For a behavior change or bug fix, first add a meaningful regression test and record its failure, then implement the change and record the passing result. Pure documentation, configuration, and visual changes do not need tests that merely restate their implementation. Authentication, persistence, and transaction changes require the real SQLite dependency.

Frontend checks run from `web`:

```sh
bun run typecheck
bun run lint
bun run test -- src/Buckets.test.tsx
```

Replace the test path with the affected existing test or the regression test you added. `bun run test` invokes Vitest; do not substitute Bun's native `bun test` runner. For the complete frontend unit suite, use `bun run test`.

Rust checks run from the repository root:

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test -p garage-ui slash_only_endpoint_is_unset
```

Replace `slash_only_endpoint_is_unset` with the affected test's name. `cargo test --workspace` is the full Rust suite. Its [CORS preflight test](crates/garage-ui/src/api/tests/cors_preflight.rs) requires an accessible Docker daemon and the local `dxflrs/garage:v2.4.1` image (`docker pull dxflrs/garage:v2.4.1` before running the suite). The test creates its own disposable container and data volume, uses random loopback Admin/S3 ports, and cleans up its owned resources; it does not use a borrowed Garage fixture or pull the image itself.

`CARGO_TARGET_DIR` changes Cargo's artifact directory. When using it for parallel work, choose a directory owned by your checkout; it does not isolate runtime data, Docker resources, or service ports. The browser configurations still require `target/debug/garage-ui`, as described below.

For an OpenAPI update, regenerate and inspect the generated diff:

```sh
cd web
bun run generate:api
git diff -- src/api/garage-admin-v2.ts
```

Commit the pinned OpenAPI input and corresponding generated types together. For a UI change, inspect the affected flow in a real browser at 360, 390, 768, and 1280 CSS pixels, including keyboard focus, errors, destructive confirmations, and secret display where relevant. On narrow screens, check touch targets, the Sections dialog, and the account menu. Save screenshots that let the reviewer assess the final UI, after checking them for credentials and personal data.

### Browser integration tests

The main, [setup-wizard](web/e2e/wizard.config.ts), and [TLS-warning](web/e2e/tls.config.ts) configurations support Chromium, Firefox, and WebKit. Chromium is the default. Use `GARAGE_BROWSER=all` to run all three, or `--project=firefox` / `--project=webkit` to select one. Each run needs exclusive access to `127.0.0.1:3909`; the harness never reuses an existing UI server.

For a fresh checkout, install the pinned Rust toolchain and Bun first, then prepare the locked dependencies, browser binaries, frontend assets, debug binary, and local Garage images:

```sh
cd web
bun install --frozen-lockfile
bunx playwright install chromium firefox webkit
bun run build
cd ..
cargo build -p garage-ui --bin garage-ui
docker pull dxflrs/garage:v2.4.1
docker pull dxflrs/garage:v2.3.0
```

On Linux, Playwright may also require system packages; follow its [browser installation instructions](https://playwright.dev/docs/browsers#install-system-dependencies). A custom `CARGO_TARGET_DIR` does not change the configurations' required binary path, `target/debug/garage-ui`.

Run the disposable smoke against each supported Garage version:

```sh
scripts/e2e-check.sh
GARAGE_VERSION=v2.3.0 scripts/e2e-check.sh
```

The [runner](scripts/e2e-check.sh) defaults to Garage v2.4.1 and `disposable-smoke.spec.ts`. It requires the Bun version pinned in [web/package.json](web/package.json) (`BUN_BIN` can select its executable), Docker, installed Playwright browsers, and the prerequisites above. It never installs dependencies, pulls images, or builds the application. It resolves the selected local image to its ID, creates a single-node Garage fixture on random loopback Admin/S3 ports, and uses a fresh UI data directory. Cleanup removes only the fixture container and volume with its exact ownership label plus its temporary directory; cleanup failures identify the resources to inspect. Do not run two browser checks concurrently on port 3909.

On macOS, the runner gives the bundled Firefox a separate `GarageUITestFirefox` application-data identity through a temporary `XUL_APP_FILE`. This avoids accessing the personal Firefox directory protected by macOS 27 ([upstream issue](https://github.com/microsoft/playwright/issues/42768)); the installed browser bundle and personal profiles are not modified. Use the runner for Firefox checks on these systems.

Pass an affected spec or a separate configuration when appropriate:

```sh
scripts/e2e-check.sh e2e/buckets-keys.spec.ts
scripts/e2e-check.sh --config=e2e/wizard.config.ts
scripts/e2e-check.sh --config=e2e/tls.config.ts
GARAGE_BROWSER=all scripts/e2e-check.sh
```

Borrowed disposable fixtures remain an alternative for direct `bun run test:e2e` runs from `web`. The defaults in [garage-target.ts](web/e2e/garage-target.ts) are `garage-wave1-v241` on Admin/S3 ports 3953/3950 and `garage-wave1-v230` on 3943/3940, selected with `GARAGE_VERSION`. Override `GARAGE_CONTAINER`, `GARAGE_ADMIN_URL`, and `S3_ENDPOINT_URL` for another disposable fixture; provide `GARAGE_ADMIN_TOKEN` or allow Docker access to read the fixture's configured token. These tests mutate Garage. The demo Compose file does not provision these named fixtures. Coordinate ownership and disclose unavailable prerequisites.

## Use AI assistance within a bounded task

Give the assistant the desired behavior, allowed files, relevant spec sections, verification commands, and a concrete completion criterion. A useful task states the input, expected output, important failure case, and any operations the maintainer has authorized. Have the assistant inspect existing signatures and patterns before coding, reuse Radix components and theme tokens for UI work, keep edits within scope, and ask about a new product or architecture decision instead of inventing one.

For concurrent work, assign non-overlapping file ownership and use separate branches/worktrees where useful. Preserve other contributors' edits. Coordinate shared ports, Garage fixtures, SQLite databases, and test runs; a separate worktree does not isolate those resources. Keep staging and integration under the coordinating contributor's control.

Never include live tokens, passwords, session keys, private machine paths, personal context, or credential-bearing screenshots in patches, commits, or pull requests. The [secret scan](scripts/secret-scan.sh) requires the checksum-verified **Gitleaks 8.30.0 release binary** on `PATH`. Download the archive for your operating system and architecture and the checksum list from the [official release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.0); compare the archive's SHA-256 with that list before extracting and installing it. Do not substitute an unverified binary or a different version.

```sh
scripts/secret-scan.sh
scripts/secret-scan.sh --worktree
scripts/secret-scan.sh --history
```

The default (`--all`) scans both the working tree and Git history reachable from all local refs, using [the repository configuration](data/config/gitleaks.toml). History scanning requires a complete, non-shallow checkout; fetch the missing history and tags before scanning a shallow clone. The script redacts findings and ignores inline `gitleaks:allow` directives. Its rules and explicit allowlist have limits: a passing scan does not prove that all secrets were detected. Review the actual diff and any files intended for publication for credentials and personal data.

An AI-generated completion report should state what changed, the exact commands and results, the initial failing and final passing regression where applicable, browser evidence for UI work, and any checks not run. Do not infer coverage, security, compatibility, or deployment success from an unrelated earlier run. Human maintainers remain responsible for reviewing contributions, merging, and publishing releases.

## Submit a focused contribution

Keep a change independently reviewable and reversible. Commit only owned files; include lockfile changes when dependencies change. Explain the concrete problem, resulting behavior, and verification in the pull request, with any remaining limits stated plainly. Follow the [development and release identity rules](docs/engineering.md#79-release-and-images) for version changes.
