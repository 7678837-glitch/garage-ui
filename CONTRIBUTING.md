# Contributing

Garage UI is under active development. GitHub Actions are disabled until development is finished; do not re-enable them as part of a contribution or treat missing remote checks as passing checks. The version in `VERSION` can also identify an unpublished release draft; verification of that draft does not cover later development commits.

## Read before changing code

Read the applicable [repository instructions](AGENTS.md), the [working spec](docs/README.md), and the relevant source and tests. [DEV-GUIDE.md](DEV-GUIDE.md) is the historical requirements draft, with superseded Go/pnpm instructions. Honor generated-file notices and update their source rather than editing managed instruction files directly. The working spec and [decisions](docs/decisions.md) describe the current Rust/Bun stack. Specs contain acceptance targets, so confirm a feature in source before describing it as implemented.

Use English for code comments, errors, UI copy, documentation, commits, and pull requests. Simplified Chinese belongs in the existing UI locale catalog or deliberate non-ASCII test fixtures.

## Set up local development

Install the pinned Rust toolchain from [rust-toolchain.toml](rust-toolchain.toml) and Bun version from [web/package.json](web/package.json). From the repository root:

```sh
scripts/build.sh
```

This installs frontend dependencies with the frozen lockfile, builds `web/dist`, and builds the host release binary. The backend build requires `web/dist/index.html`, including when running Rust tests; build the frontend first in a clean checkout.

The shipped UI uses React 18, Vite, Radix Themes 3.3, and `radix-ui` 1.8.1. Reuse the installed Radix controls and the theme tokens in `web/src/theme.tsx` and `web/src/index.css` before adding local styling. Keep native file inputs for upload and the existing confirmation flow for destructive actions. The production Rust binary embeds `web/dist`; Bun runs only during builds and local development, so changes must not require a browser CDN, Node.js runtime, or separately deployed frontend.

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

Replace `slash_only_endpoint_is_unset` with the affected test's name. `cargo test --workspace` is the default Rust suite. It needs Docker for the S3 client test, which starts its own container. The CORS preflight test also needs the `garage-wave1-v241` fixture described below, so it is ignored by default; with the fixture running, use `cargo test --workspace -- --include-ignored` for the full suite. When parallel work needs separate build artifacts, set `CARGO_TARGET_DIR` to a directory owned by your checkout; this does not isolate database state or service ports.

For an OpenAPI update, regenerate and inspect the generated diff:

```sh
cd web
bun run generate:api
git diff -- src/api/garage-admin-v2.ts
```

Commit the pinned OpenAPI input and corresponding generated types together. For a UI change, inspect the affected flow in a real browser at 360, 390, 768, and 1280 CSS pixels, including keyboard focus, errors, destructive confirmations, and secret display where relevant. On narrow screens, check touch targets, the Sections dialog, and the account menu. Save screenshots that let the reviewer assess the final UI, after checking them for credentials and personal data.

### Browser integration tests

The current [Playwright configuration](web/playwright.config.ts) expects a debug binary at `target/debug/garage-ui` and exclusive access to port 3909. It starts a fresh UI data directory, creates fixture users, and does not reuse an existing UI server. Build the frontend and debug binary before running it:

```sh
cd web
bun run build
cd ..
cargo build -p garage-ui --bin garage-ui
cd web
GARAGE_VERSION=v2.4.1 bun run test:e2e -- e2e/buckets-keys.spec.ts
GARAGE_VERSION=v2.3.0 bun run test:e2e -- e2e/buckets-keys.spec.ts
```

Use the affected spec rather than the example when appropriate. A custom `CARGO_TARGET_DIR` does not change Playwright's hardcoded binary path. The harness requires running disposable Garage fixtures defined in [garage-target.ts](web/e2e/garage-target.ts): `garage-wave1-v241` on admin/S3 ports 3953/3950 and `garage-wave1-v230` on 3943/3940. Docker access is required to read their configured admin token. These tests modify the fixtures; do not use production clusters. The Compose example does not provision these named fixtures. Arrange them before running E2E and disclose unavailable prerequisites. Setup-wizard and TLS-warning tests use their separate [wizard](web/e2e/wizard.config.ts) and [TLS](web/e2e/tls.config.ts) configurations.

## Use AI assistance within a bounded task

Give the assistant the desired behavior, allowed files, relevant spec sections, verification commands, and a concrete completion criterion. A useful task states the input, expected output, important failure case, and any operations the maintainer has authorized. Have the assistant inspect existing signatures and patterns before coding, reuse Radix components and theme tokens for UI work, keep edits within scope, and ask about a new product or architecture decision instead of inventing one.

For concurrent work, assign non-overlapping file ownership and use separate branches/worktrees where useful. Preserve other contributors' edits. Coordinate shared ports, Garage fixtures, SQLite databases, and test runs; a separate worktree does not isolate those resources. Keep staging and integration under the coordinating contributor's control.

Never include live tokens, passwords, session keys, private machine paths, personal context, or credential-bearing screenshots in patches, commits, or pull requests. The current [secret scan](scripts/secret-scan.sh) detects private-key blocks in the working tree; passing it does not establish token/password detection or a clean Git history. Review the actual diff for sensitive content.

An AI-generated completion report should state what changed, the exact commands and results, the initial failing and final passing regression where applicable, browser evidence for UI work, and any checks not run. Do not infer coverage, security, compatibility, or deployment success from an unrelated earlier run. Human maintainers remain responsible for reviewing contributions, merging, and publishing releases.

## Submit a focused contribution

Keep a change independently reviewable and reversible. Commit only owned files; include lockfile changes when dependencies change. Explain the concrete problem, resulting behavior, and verification in the pull request, with any remaining limits stated plainly. Do not bump the version during ordinary development; release version rules are in [engineering](docs/engineering.md#79-release-and-images).
