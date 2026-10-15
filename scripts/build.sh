#!/bin/sh
# No arguments: build the web bundle and host binary.
# --images [amd64|arm64]: load both Linux images, or only the selected architecture.
# Local image tags are garage-ui:<BUILD_VERSION>-<architecture>; nothing is pushed.
set -eu
cd "$(dirname "$0")/.."
commit=$(git rev-parse --verify HEAD)
export GIT_COMMIT=$commit
version=$(python3 - <<'PY'
from datetime import datetime
import os
from pathlib import Path
import re

if "BUILD_VERSION" in os.environ:
    version = os.environ["BUILD_VERSION"]
else:
    stable = Path("VERSION").read_text().removesuffix("\n")
    if not re.fullmatch(r"[0-9]{8}\.[1-9][0-9]*", stable):
        raise SystemExit("VERSION must be YYYYMMDD.N")
    version = f"{stable}-local"
if not re.fullmatch(r"[0-9]{8}\.[1-9][0-9]*(?:-dev|-local)?", version):
    raise SystemExit("BUILD_VERSION must be YYYYMMDD.N with an optional -dev or -local suffix")
try:
    datetime.strptime(version[:8], "%Y%m%d")
except ValueError:
    raise SystemExit("BUILD_VERSION must contain a valid calendar date") from None
print(version)
PY
)
export BUILD_VERSION=$version

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

for arch in $architectures; do
  docker buildx build --platform "linux/$arch" --no-cache --load \
    --build-arg "GIT_COMMIT=$commit" --build-arg "BUILD_VERSION=$version" \
    -f deploy/Dockerfile -t "garage-ui:$version-$arch" .
done
