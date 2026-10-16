#!/bin/sh
# Wait for the registry to return the manifest assigned to a tag alias.
set -eu
if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <registry> <version-tag> <alias-tag>" >&2
  exit 1
fi
exec python3 "$(dirname "$0")/verify-image-tag-alias.py" "$@"
