#!/bin/sh
# Usage: scripts/secret-scan.sh [--worktree|--history|--all]; default: both.
# Requires the checksum-verified Gitleaks 8.30.0 release binary on PATH.
set -eu
cd "$(dirname "$0")/.."
if [ "$#" -gt 1 ]; then
  echo "Usage: $0 [--worktree|--history|--all]" >&2
  exit 2
fi
mode=${1:---all}
case "$mode" in
  --worktree|--history|--all) ;;
  *) echo "Usage: $0 [--worktree|--history|--all]" >&2; exit 2 ;;
esac
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "Gitleaks 8.30.0 is required. Install the checksum-verified binary from https://github.com/gitleaks/gitleaks/releases/tag/v8.30.0 and add it to PATH." >&2
  exit 2
fi
if [ "$(gitleaks version)" != 8.30.0 ]; then
  echo "Gitleaks 8.30.0 is required; install the pinned release used by CI." >&2
  exit 2
fi
config=$PWD/data/config/gitleaks.toml
if [ "$mode" != --worktree ]; then
  if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
    echo "Full-history secret scanning requires an unshallow checkout. Run git fetch --unshallow --tags, or use actions/checkout fetch-depth: 0." >&2
    exit 2
  fi
  git rev-parse --verify HEAD >/dev/null
fi
status=0
if [ "$mode" != --history ]; then
  gitleaks dir --config "$config" --no-banner --no-color --redact=100 \
    --ignore-gitleaks-allow --verbose . || status=$?
fi
if [ "$mode" != --worktree ]; then
  gitleaks git --config "$config" --no-banner --no-color --redact=100 \
    --ignore-gitleaks-allow --verbose --log-opts=--all . || status=$?
fi
exit "$status"
