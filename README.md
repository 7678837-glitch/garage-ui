# garage-ui

garage-ui is an unofficial web admin UI for Garage, the S3-compatible object store from Deuxfleurs. The program is one static Rust binary.

The current development version is 20261014.2 (DRAFT, not published). The minimum supported Garage version is v2.3.0; compatibility has been tested with v2.3.0 and v2.4.1.

## Current behavior

- Set up the first administrator, log in and out, and change your password. Administrators manage users, reset passwords, and grant viewers separate download and share permissions.
- Read cluster health, status, capacity statistics, and a Prometheus metrics summary of S3 requests, errors, and block traffic. A notice identifies unavailable metrics or disabled TLS verification.
- List, filter, and sort nodes; connect a node; stage capacity changes; preview and apply a layout at the next version; revert staged changes; view layout history and sync trackers; and skip dead nodes with explicit data-loss confirmation when missing data is allowed.
- Inspect node workers and their variables, change a worker variable, and launch repair tasks, including scrub start, pause, resume, and cancel. Inspect block errors and block information, retry resync, purge blocks with confirmation, and request metadata snapshots for one node or every node. These operations require an administrator.
- List, filter, sort, create, and delete buckets. Manage global and local aliases, quotas and usage, key permissions, website access, CORS rules, and lifecycle rules. Inspect and abort incomplete multipart uploads, or clean up uploads older than a chosen age and see the removed count.
- List, filter, sort, create, delete, and rename access keys. Allow bucket creation, inspect each key's bucket grants, and reveal a key secret after confirmation. Manage Garage admin tokens, their expiration and scopes; a newly created token secret is shown once, and full-admin scopes carry a warning.
- Browse objects by prefix with pagination and breadcrumbs, search within a prefix, and sort the loaded page by size or time. Inspect metadata and administrator-only version diagnostics. Preview allowlisted text, images, audio, and video; use Left and Right to move between objects in the loaded directory. Bitmap list thumbnails require download permission and load as their rows enter view.
- Upload files and folders with an upload queue, progress, cancellation, retry, overwrite confirmation, and multipart upload for large files. Download objects, stream selected objects or a prefix as a ZIP, and create expiring share links when permitted. Delete an object, a counted selection, or a prefix recursively after confirmation.
- Filter audit events and export CSV as an administrator. Use English or Simplified Chinese, localized timestamps and capacity units, light/dark/system themes, visible keyboard focus, loading/error/retry states, and the About page. Main pages and destructive-action dialogs accommodate narrow viewports.

## Writes stop below Garage v2.3.0

When Garage reports a release older than v2.3.0, the UI refuses writes.

## Build and run

The repository pins Rust 1.99.0 in `rust-toolchain.toml` and Bun 1.4.2 in `web/package.json`.

From the repository root, build the frontend and the binary.

```sh
scripts/build.sh
```

With no arguments, `scripts/build.sh` runs `bun install --frozen-lockfile`, then `bun run build`, then `cargo build --release -p garage-ui --bin garage-ui` for the host.

To build and load both Linux images locally:

```sh
scripts/build.sh --images
```

Use `scripts/build.sh --images amd64` or `scripts/build.sh --images arm64` for one architecture. Image builds use Docker buildx with `--no-cache` and load local tags `garage-ui:<VERSION>-amd64` and `garage-ui:<VERSION>-arm64`.

To call a Garage cluster, set the admin API address and the admin token before you start the binary. Do not commit the token. The example Garage config in `deploy/garage-entrypoint.sh` binds the admin API on port 3903, so a local address is `http://127.0.0.1:3903`.

1. Export `GARAGE_ADMIN_URL` to that admin API address.
2. Export `GARAGE_ADMIN_TOKEN` to the admin token from the Garage configuration.
3. Run `./target/release/garage-ui`.
4. Open http://127.0.0.1:3909. The first visit is setup.

## Environment variables

You can start the process with the variables below unset. Set an admin URL and an admin token when the UI should call Garage.

`API_BASE_URL` is the Garage admin API base URL. `GARAGE_ADMIN_URL` is an alias. When both are set, the process uses `API_BASE_URL`.

`API_ADMIN_KEY_FILE` is a path to a file that contains the admin token. `GARAGE_ADMIN_TOKEN` is the token itself. When the file path is non-empty, the process reads the file and ignores `GARAGE_ADMIN_TOKEN`.

`DATA_DIR` is the directory for the SQLite database and the generated session key. The default is `./data`. The process creates the directory when it is missing.

The process reads `.env` from the working directory. A variable in the process environment replaces the same name from that file. `.env.example` does not assign any variables.

## Authentication stays on

The process exits at startup if the environment contains `AUTH_DISABLED`, `DISABLE_AUTH`, or `GARAGE_UI_NO_AUTH`.

The browser does not hold the Garage admin token. The token stays in the server process. The browser keeps an HttpOnly session cookie named `garage_session`.

When you run the binary directly, it listens on 127.0.0.1 port 3909. Keep it on that address.

## Version numbers use YYYYMMDD.N

The first release on a calendar day is `.1`. A later release on the same day increments `N`. The next day starts again at `.1`. The `VERSION` file at the repository root is the only source.

## Planned work

Later work is listed in the [roadmap](docs/roadmap.md).

## Documentation

Start with the [docs index](docs/README.md).

## License

The license is MIT. The terms are in [LICENSE](LICENSE).
