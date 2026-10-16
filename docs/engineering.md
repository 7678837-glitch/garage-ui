# Non-functional and engineering requirements

The technology stack follows [decisions.md](decisions.md). This chapter rewrites chapters 6 and 7 of the original draft as equivalent gates under Rust and Bun. Functional and security acceptance is not relaxed because the toolchain changed.

## 6.1 Performance

- The first screen of the home page (health + statistics) returns within 1 second on a local network.
- The first page of a 10,000-bucket list appears within 2 seconds (paginated).
- Rendering one object-list page of 1000 rows uses virtual scrolling.
- The frontend main bundle, after gzip, is at most 300 KB. Routes load on demand.

## 6.2 Streaming large files

- Download, preview, and ZIP packaging all stream through. Do not read the whole payload into memory.
- An upload streams into S3. Above the threshold (default 64 MB) it switches to multipart automatically. The part size defaults to 16 MB. One upload defaults to 2 parts in flight at a time. The process-wide upload buffer has a hard cap (default 64 MB). Above that cap, uploads queue. Part size × in-flight part count × concurrent upload count must stay within that cap.
- Thumbnails are generated only for allowlisted bitmap types. When the source object is above the configurable limit (default 20 MB), or the pixel count is above the limit (default 40 million), do not generate a thumbnail. Show the icon directly. Before decoding, read the image header and check the dimensions, to stop a decompression bomb. Cache the result by object ETag in a bounded cache (LRU, configurable total size). The number of thumbnail tasks decoding at once has a cap (default 2). Further tasks queue. If one task's memory exceeds its budget, abandon that task and show the icon.

Acceptance: When the upload limit is configured to at least 6 GB, the server completes a 5 GB upload and a 5 GB download in a container limited to 256 MB of memory. Browsing thumbnails for 100 large images does not OOM.

## 6.3 Timeouts and cancellation

- Garage Admin client: connect timeout 5 seconds, total timeout 30 seconds (configurable).
- S3 calls use the request context. When the client disconnects, cancel the request to S3. A long operation (a large file, or a ZIP) has no total timeout, only an idle timeout.
- The server sets a header-read timeout and an idle timeout, and shuts down gracefully (wait for in-flight requests, default 30 seconds).

Acceptance: After the browser cancels a download, the server's request to S3 is cancelled within 1 second (visible in the log).

## 6.4 Error handling

- One error structure: `code` (a stable machine-readable code), `message` (readable text), and `garageStatus` (when Garage returned one).
- Keep the real status code (4.8 in [correctness.md](correctness.md)). When Garage is unreachable, return 502. On timeout, return 504.
- The frontend shows errors in one place. 401 goes to the login page. 403 shows that the caller has no permission. Do not swallow an error.
- When the frontend fails to load a stale code-split chunk, it refreshes once automatically (with a cooldown).

## 6.5 Observability

- Structured logs (JSON), with a request ID. The log level is configurable. Do not record sensitive information. Write only to stdout/stderr.
- This project's own `/metrics` (protected by authentication, or by a separate token) exposes request count, a latency histogram, the Garage call error count, and the in-flight upload count.
- `/healthz` (liveness) and `/readyz` (readiness: the database is available and Garage is reachable).
- The binary provides a `-health` subcommand for the container health check.

## 6.6 Test data generation

- Provide a development command that generates data. Implement it as a Rust program that is not built into the runtime image. It can create buckets, keys, and many objects in bulk on a test cluster (count, prefix depth, object-size distribution, and resume from a checkpoint are configurable). Use it to check pagination and performance at 10,000 buckets and 100,000 objects.
- The Garage under test may run in a local container.

Acceptance: The CI performance smoke test uses this command to generate data.

## 6.7 i18n (optional, P2)

- Keep copy in one place. The default language is English, and Simplified Chinese is provided. Localize dates and capacity units.

Acceptance: After a language switch, no key is untranslated (a test checks that the key sets match).

## 7.1 Technology stack

- Backend: Rust 1.99.0. One binary embeds the frontend. For HTTP, SQLite, S3, the Admin client, and the other crates, see "Runtime technology stack" in [decisions.md](decisions.md).
- S3: the official `aws-sdk-s3`. Use the endpoint configuration that this SDK currently recommends. The runtime is the tokio multi-thread runtime.
- The session library supports database storage. SQLite and the user store use the same database. Passwords use bcrypt.
- Frontend UI: React 18, TypeScript strict mode, Vite, Radix Themes 3.3.0, `radix-ui` 1.8.1, TanStack Query, react-hook-form + zod, and Tailwind. Do not use daisyUI or zustand. Server data uses TanStack Query; UI state lives in the component. Use Radix controls and theme tokens for shared interface patterns, with native file inputs for upload.
- Frontend toolchain: Bun. Install, scripts, and the lockfile all go through Bun.
- Tests: `cargo test`. Bun starts Vitest + Testing Library. Playwright runs E2E. Integration tests against Garage v2.3.x and v2.4.1 may use a local container.

## 7.2 Pin dependency and toolchain versions

- Rust: `rust-toolchain.toml` pins 1.99.0. Bump a new stable and run `cargo update` in the same change. Commit `Cargo.lock`. After a dependency change, the lockfile matches the manifest.
- Bun: the `packageManager` field in `package.json` pins 1.4.2. Commit `bun.lock`. Do not use `latest` in a build. Dependencies of the build scripts (esbuild, `@swc/core`, and the same kind of package) may be listed explicitly.
- Do not use `.nvmrc` or pnpm.
- Pin each base image by digest. Do not use a floating tag.
- An automation bot opens dependency updates every week. Merge them after the relevant local checks pass.

## 7.3 Build

- One-command build. Bun builds the frontend first, then the build embeds it and compiles the Rust binary. If the frontend output is missing, the build fails and prints a clear message.
- The release targets are `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`. `RUSTFLAGS` includes `+crt-static`. `arm/v7` stays optional and is outside this acceptance.
- Check the release binary of both architectures with `ldd`. The result is `not a dynamic executable`. For cross-compilation and the C/C++ compiler required on the build machine, see [decisions.md](decisions.md).
- The build is reproducible. Inject the version, the commit, and the build time.

## 7.4 CI

CI builds and publishes release artifacts only. It is triggered by candidate date-version tags, with a cheap validation job before any toolchain or image build. Ordinary branch pushes, pull requests, schedules, and manual dispatches do not build.

The gate requires a valid calendar date and positive sequence in `YYYYMMDD.N`, an exact match with root `VERSION`, matching Cargo workspace/lockfile and web manifest versions (`YYYYMMDD.N.0`), and the exact tagged source commit. Invalid tags stop before the build. There is no `v` prefix or rolling development tag.

Tests and audits run locally before the maintainer pushes the release tag: frontend type/lint/unit/build and generated-type checks, Rust formatting/Clippy/tests, dependency and secret checks, and affected real-Garage browser workflows. Release candidates receive the full regression run. Record the source identity and actual results; a green build is not test evidence.

The build produces and verifies Linux amd64/arm64 images and binaries, an SBOM, checksums, and standalone deployment files. Publication uses the workflow's scoped `GITHUB_TOKEN`. A published release is not overwritten. Public anonymous image access is verified before the GitHub release is published.

## 7.5 lint

- ESLint (typescript-eslint strict rules, react-hooks) has zero errors and zero warnings. `any` is forbidden (except generated types).
- Rust: `rustfmt` and `clippy` have zero warnings.

## 7.6 Test coverage

- Measure backend statement coverage with a pinned `cargo-llvm-cov`. It is at least 80%. Security-related packages (authentication, CSRF, rate limiting, the proxy allowlist, object response headers, and config redaction) are at least 95%.
- Frontend coverage is at least 70%.
- Every acceptance criterion in [security.md](security.md) and [correctness.md](correctness.md) has a matching automated test.

Do not copy the original draft's `go test -race`. Cover shared mutable state (sessions, the rate-limit window, the credential cache, and the upload buffer) with targeted concurrency tests.

## 7.7 Zero dependency vulnerabilities

- Before a release, reachable vulnerabilities from `cargo audit` are 0. High and above from `bun audit --prod` are 0. Critical vulnerabilities in build-time dependencies are 0.
- When an exception is required, record the reason, the impact assessment, and the expiry date in the repository.

## 7.8 Generate types from the Garage OpenAPI document

- The only source is the Admin API v2 OpenAPI description in the Garage repository (`garage-admin-v2.json`). Generate TypeScript types from it. Rust types may be generated the same way.
- Commit the generator script, the generator version, and the pinned OpenAPI file version together. Local pre-release checks verify that the generated output matches the commit.
- When the supported Garage version is raised, regenerate and list the field differences in the change notes.

## 7.9 Release and images

- Docker Compose with a published image is the primary installation path. Provide standalone deployment files in each release so users do not need Git, Rust, or Bun. Static Linux binaries remain an alternative. The split of work in the multi-stage build is in "Containerized deployment of this project" in [decisions.md](decisions.md).
- Runtime image: distroless static nonroot, with no shell. The user is not root. `/data` is a volume. Expose 3909. Inside the image, listen on `0.0.0.0` by default (3.1 in [security.md](security.md)). The binary is statically linked. Do not install a shell, Node, Bun, the system libsqlite, libssl, or glibc in the image. CI builds `linux/amd64` and `linux/arm64`.
- Write the compose example's port mapping so that it binds only the host `127.0.0.1`. Acceptance: after a start from the example, reaching 3909 from another address on the host fails, and reaching it from `127.0.0.1` succeeds.
- The health check uses the binary's own `-health` (interval 30 seconds, timeout 5 seconds, start grace 10 seconds, 3 retries). Do not bring in an extra tool image.
- Release artifacts: a multi-arch image, a binary for each platform, `SHA256SUMS`, and signatures (sign the image with cosign keyless signing or with a key; sign the binary with ed25519), plus an SBOM and a proof of build provenance. The first public release, `20261016.2`, ships unsigned images and binaries with an SBOM and checksums; signatures and build-provenance attestations are deferred to a later release. Checksums establish file integrity, not publisher identity.
- Publishing: images go only to `ghcr.io/xjoker/garage-ui` (tags `<VERSION>-amd64`, `<VERSION>-arm64`, and multi-arch `<VERSION>` and `latest`). Tag-gated CI builds each architecture on its native runner, then loads both images into the verification job before it runs `scripts/release.sh` and `scripts/publish.sh` to publish the verified GitHub draft. For local artifact preparation, run `BUILD_VERSION=$(cat VERSION) scripts/build.sh --images`, then `scripts/release.sh <output-directory>`. The scripts reject dirty source or mismatched build identity; publication verifies the remote index, pulled image health, checksums, and anonymous GHCR access. A source repository being public does not make its GHCR package public: the owner sets that once in package settings. The local publish script stops at a draft; CI completes publication. Attach `compose.yaml` and `.env.example` alongside both binaries, the SBOM, and `SHA256SUMS`.
- Version numbers are `YYYYMMDD.N`. The first release on a calendar day is `.1`. Another release on the same day increments `N`. A new day starts again at `.1`. The only source is the `VERSION` file at the repository root, and its contents are that string. The Cargo workspace version and `web/package.json` `version` are `YYYYMMDD.N.0`. The trailing `.0` exists only to satisfy the manifest format. Git tags and GitHub release names match `VERSION` exactly, with no `v` prefix. Before changing the version, run `date +%Y%m%d`, then `git tag -l '<that date>.*'` and `gh release list`, and take the next unused sequence for that day. Do not increment from the previous version's date. Change `VERSION` and the manifest/lockfile version fields only in a release commit; ordinary development does not change them. The change notes for each version list the minimum Garage version required.
- CI uses the validated tag version and full tagged commit for every artifact. It does not allocate a development sequence on branch pushes. Push the version tag only after local validation of that source revision succeeds.
- An unassigned local build, including a direct Docker build, uses `<VERSION>-local`. `BUILD_VERSION` can explicitly supply a validated version; `scripts/release.sh` selects the stable `VERSION` when it verifies the prebuilt image tags. `/healthz` reports the embedded version and full commit.
- Provide a compose example (Garage v2.4.1 + this project) and a Helm Chart (P2).
