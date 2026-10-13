# garage-ui

garage-ui is an unofficial web admin UI for Garage, the S3-compatible object store from Deuxfleurs. The program is one static Rust binary.

garage-ui is under active development, not yet released.

## Current behavior

You can set up an account, log in, log out, and change your password. The roles are admin and viewer. An admin can grant a viewer the download permission bit and the share permission bit.

You can read cluster health, cluster status, and cluster statistics.

You can list buckets with pagination, create a bucket, and delete a bucket. You can set bucket aliases and bucket quotas. You can grant and revoke bucket permissions.

You can list keys with pagination, create a key, delete a key, and rename a key. You can allow a key to create buckets. Viewing a key secret requires a second confirmation.

A prefix walk of 5000 objects is included. Allowlisted inline preview truncates long text. You can delete one object. A batch delete requires the selected count. A recursive delete walks list pages. The tested case lists three pages and deletes 2500 objects.

You can select more than one object. You can open the upload panel. The UI shows a new credential once, and you can copy it. You can choose a light theme, a dark theme, or the system theme. Keyboard focus is visible. You can open the About page.

## Writes stop below Garage v2.3.0

When Garage reports a release older than v2.3.0, the UI refuses writes.

## Build and run

The repository pins Rust 1.99.0 in `rust-toolchain.toml` and Bun 1.4.2 in `web/package.json`.

From the repository root, build the frontend and the binary.

```sh
scripts/build.sh
```

`scripts/build.sh` runs `bun install --frozen-lockfile`, then `bun run build`, then `cargo build --release -p garage-ui --bin garage-ui`.

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
