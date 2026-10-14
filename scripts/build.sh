#!/bin/sh
# No arguments: build the web bundle and host binary.
# --images [amd64|arm64]: load both Linux images, or only the selected architecture.
# Local image tags are garage-ui:<VERSION>-<architecture>; nothing is pushed.
set -eu
cd "$(dirname "$0")/.."

if [ "$#" -eq 0 ]; then
  (cd web && bun install --frozen-lockfile && bun run build)
  cargo build --release -p garage-ui --bin garage-ui
  exit 0
fi

if [ "$1" != --images ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 [--images [amd64|arm64]]" >&2
  exit 1
fi
case "${2-}" in
  "") architectures="amd64 arm64" ;;
  amd64|arm64) architectures=$2 ;;
  *) echo "Unsupported image architecture: $2" >&2; exit 1 ;;
esac

version=$(cat VERSION)
for arch in $architectures; do
  docker buildx build --platform "linux/$arch" --no-cache --load \
    -f deploy/Dockerfile -t "garage-ui:$version-$arch" .
done
