#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
(cd web && bun install --frozen-lockfile && bun run build)
cargo build --release -p garage-ui --bin garage-ui
