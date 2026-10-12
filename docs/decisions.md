# Decisions already absorbed

Date: 2026-10-10. Decided by: the maintainer of this project. The text below writes these decisions into the working spec. Chapter 7 of the original draft, Go / Node / pnpm, is no longer the current technology stack.

## The backend is written in Rust

The project foundation is written in Rust. The deliverable is still one binary with the frontend single-page application embedded in it.

The engineering clauses rewritten because of this are in [engineering.md](engineering.md):

- Formatting, static checks, tests, coverage, and vulnerability scanning move to the Rust toolchain.
- The S3 client is the official `aws-sdk-s3` (AWS SDK for Rust). That SDK's documentation requires an async runtime. The official examples use tokio.
- The password algorithm is still bcrypt.
- The runtime image is still the nonroot variant of distroless static. The binary is statically linked. The target machine does not have a C runtime or libsqlite preinstalled.
- `gofmt`, `go vet`, `staticcheck`, `go test -race`, `govulncheck`, and Go type generation from the original draft are no longer gates.

Features, security, correctness, API paths, and acceptance criteria are not relaxed because the language changed.

## The frontend toolchain is Bun

Installing dependencies, running scripts, and pinning versions all use Bun.

- Pin Bun to a specific version with the `packageManager` field in `package.json`.
- The lockfile is `bun.lock`. CI uses `bun install --frozen-lockfile`.
- Do not commit `.nvmrc`. Do not use pnpm. Build scripts do not use `latest`.
- Block on high and above vulnerabilities in production dependencies with `bun audit --prod --audit-level=high`. Block on critical vulnerabilities in build-time dependencies the same way.
- Vitest, Testing Library, and Playwright are still the test stack. Bun starts them.

## Multiple agents in parallel

Multiple agents may develop in parallel.

How parallel work is closed:

- Split tasks by the phases and section numbers in [roadmap.md](roadmap.md). Tasks that change the same set of files do not run in parallel.
- The main session closes full-suite tests and `git` commits. Agents working in parallel do not each run the full test suite, and they do not each run `git add`.
- When the spec conflicts with the facts, stop and change the spec or ask. Do not change an acceptance criterion to make a test green.
- For security, persistence, and deletion, the acceptance text in [security.md](security.md) and [correctness.md](correctness.md) is the authority.

## Garage in a local container

Garage may run in a container on this machine, for integration tests, E2E, and manual evaluation.

- The versions to cover are still Garage v2.3.x and v2.4.1. The compose example defaults to v2.4.1.
- A container is only a dependency under test and an example deployment. This project still does not install a Garage node, upgrade one, or edit a Garage configuration file.
- Examples and images do not contain a real secret, or a placeholder private key that could be used as a secret. A placeholder must be rejected by the startup check. The rule is 3.14 of [security.md](security.md).

## Runtime technology stack

On 2026-10-10 the maintainer confirmed this. The maintainer's words were: "OK, agreed." Versions match the stable releases of that day. When writing `Cargo.toml`, pin the versions below. If a newer patch of the same major version already exists, use that newer patch on the first `cargo add`, and commit `Cargo.lock`. Do not use nightly. Do not use a major version that has not been released.

Compiler and async runtime:

- Rust 1.99.0 (2026-10-01). `rust-toolchain.toml` pins that version. Do not write a floating `stable`. A new stable and `cargo update` are bumped in the same change.
- tokio 1.53.2, multi-thread runtime. Enable only the features that are used: `macros`, `rt-multi-thread`, `net`, `signal`, `time`, `io-util`, `sync`, `fs`.

HTTP:

- axum 0.8.9. Write route parameters as `/{param}`.
- tower-http 0.7.1. If the first compile does not match axum's tower version, switch to tower-http 0.6.11 and edit this file.
- axum-extra 0.12.6, for cookies and typed headers.
- Do not pin hyper on its own, unless the build does not compile without that pin.
- Explicit method plus path, middleware, streaming request bodies and response bodies, a header-read timeout, an idle timeout, and graceful shutdown. Upload, download, and ZIP have no total request timeout. The Admin API is not a wildcard reverse proxy.

Data and outbound calls:

- SQLx 0.9.0. Take the feature that bundles SQLite and links it statically. The name in the documentation is `sqlite`. If the 0.9 manifest writes it as `sqlite-bundled`, the bundled static build is what counts. Do not use `sqlite-unbundled`. Do not use `query!`, which requires `DATABASE_URL` at compile time, unless sqlx offline is configured first. A short query does not hold the runtime. Audit CSV export stays streaming.
- Sessions and the user store use the same SQLite database. Write sessions with SQLx. Do not bring in a session framework.
- Implement CSRF ourselves as the double-submit cookie in [security.md](security.md). Compare in constant time.
- S3: aws-sdk-s3 1.152.0, rustls by default. aws-config 1.12.0, using `behavior-version-latest`.
- Admin API: reqwest 0.13.5, with features `json` and rustls. Do not use native-tls.
- Passwords: the bcrypt crate 0.19.3. The algorithm is still bcrypt. Starting with 0.19.2, the panic caused by a non-ASCII hash is fixed.
- Frontend assets: rust-embed 8.13.0. A release build embeds the files. In development, read them from disk. The author is still Peter John. The repository is at pyrossh.dev.
- serde 1.0.229 and serde_json 1.0.151. Stay on 1.0.
- Logs: tracing 0.1.44 and tracing-subscriber 0.3.23. JSON goes to stdout/stderr.
- Errors: anyhow 1.0.104. Not below 1.0.103. That release fixed the `Error::downcast_mut` issue.
- Metrics: metrics 0.24.6 and metrics-exporter-prometheus 0.18.3. Do not add OpenTelemetry. Do not use tikv's `prometheus` crate.
- Command line: clap 4.6.7 with derive. It covers `-health` and the offline admin commands in phase 6.
- Rate limiting: governor 0.10.4.
- ZIP: `zip` 9.0.0 on crates.io. The repository is zip-rs/zip2. Path traversal during extraction is fixed starting in 2.3.0. Do not use the archived zip-rs/zip.
- Thumbnails: image 0.25.10, bounded, and the image header is read first.

Static linking:

- Release targets: `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`. `RUSTFLAGS` includes `+crt-static`.
- Acceptance: on both architectures, `ldd` reports `not a dynamic executable`.
- Cross-compile with a musl toolchain (cargo-zigbuild, or a musl build image that supports both amd64 and arm64 hosts). Do not use the host clang to link musl.
- The build machine needs a C/C++ compiler. The bundled SQLite is C, and the rustls that aws-sdk uses by default pulls in aws-lc-rs. The runtime image does not contain, and does not depend on, system libsqlite, libssl, or glibc. TLS uses rustls.

The frontend toolchain pins Bun 1.4.2. `packageManager` records that version. On 2026-10-10, 1.5 had not been released. Do not pin it ahead of that release.

## Frontend UI

On 2026-10-10 the maintainer confirmed this. The maintainer's words were: "Yes. Remove daisyUI and zustand. The simpler the frontend is, the more powerful it is."

- UI libraries: React 18, TypeScript strict mode, Vite, TanStack Query, react-hook-form + zod, and Tailwind.
- Do not use daisyUI. Do not use zustand. Do not add another UI library.
- Server data uses TanStack Query. Forms such as login, create bucket, and keys use react-hook-form and zod. UI state such as the theme and the sidebar toggle lives in the component.
- Styling uses only Tailwind. Light and dark themes are still done as 5.35 of [features-ui.md](features-ui.md) says.
- The frontend is still built into the same Rust binary. It is not deployed on its own.

## Maintenance check

On 2026-10-10 the crates named in this section were checked, along with the frontend libraries that remain in the spec: React, TypeScript, Vite, TanStack Query, react-hook-form, zod, Tailwind, Vitest, Testing Library, and Playwright. The check used the latest non-yanked version on crates.io or npm, whether the repository is archived, the most recent push, and whether RustSec marks the library as unmaintained.

None of the chosen libraries has that mark. None of the chosen repositories is archived. The ones with a long gap between releases, whose repositories still have commits, are governor (released 2025-12-16, commit 2026-08-24), image (released 2026-03-10, commit 2026-09-15), and axum (released 2026-04-14, commit 2026-10-09). These three stay in the stack.

React 18 is outside feature maintenance. The latest stable release is still 18.3.1 (2024-04-26). After React 19 was released, 18 kept only a security-fix policy, and no further 18 release has been published since. The spec continues to pin React 18.

Transitive dependencies related to static linking and TLS are also maintained: hyper 1.12.0, rustls 0.23.45, aws-lc-rs 1.18.1, and libsqlite3-sys 0.38.2.

## Containerized deployment of this project

On 2026-10-10 the maintainer confirmed this. The maintainer's words were: "This project also needs to support containerized deployment." This is a release form for the admin UI itself. The Garage containers in the previous section only cover the cluster under test and the Garage in the example.

- A multi-stage image. The build stage contains Rust 1.99.0, a C/C++ compiler, the musl toolchain from the previous section, and Bun 1.4.2. Bun appears only in the build stage.
- The runtime stage uses the nonroot variant of distroless static: one statically linked binary, no shell, no Node, no Bun, and no system libsqlite, libssl, or glibc.
- Port 3909. When `HOST` is not set inside the image, listen on `0.0.0.0`. The compose example writes the host port as `127.0.0.1:3909`. The data volume is `/data`. The health check uses the binary's `-health`. The acceptance text for listening and for the port mapping is 3.1 of [security.md](security.md).
- CI builds `linux/amd64` and `linux/arm64`. Base images are pinned by digest.
- The compose example may also start Garage v2.4.1, only for local evaluation. This project does not install, upgrade, or edit the configuration of a Garage node.
