# Repository rules

## Language

English is the primary language of this repository. Write everything in English: code comments, log and error messages (startup errors included), UI copy, documentation, commit messages, and pull request text.

Do not add new Chinese text. Chinese that still exists is pending translation. Two kinds of Chinese stay: test data that exercises non-ASCII handling, such as Chinese object names, and the Simplified Chinese UI locale catalog that spec 6.7 requires.

## CI

The GitHub Actions workflow is disabled on GitHub until development is finished. Do not re-enable it.

## Local development

Rust 1.99.0 is selected by `rust-toolchain.toml`. Bun 1.4.2 is pinned by `packageManager` in `web/package.json`.

`cargo build` and `cargo test` stop when `web/dist/index.html` is missing. From `web/`, run `bun install --frozen-lockfile`, then `./node_modules/.bin/vite build`. `bun run build` runs the typecheck and that same Vite build.

The API listens on `127.0.0.1:3909` unless `HOST` is set. `COOKIE_SECURE` defaults to true, so a browser on local HTTP needs `COOKIE_SECURE=false`. In `web/`, `bun run dev --host 127.0.0.1 --port 5173` proxies `/api` and `/healthz` to port 3909.
