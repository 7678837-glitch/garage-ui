#!/bin/sh
# Wait for the registry to return the manifest assigned to a tag alias.
set -eu
if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <registry> <version-tag> <alias-tag>" >&2
  exit 1
fi

registry=$1
version_tag=$2
alias_tag=$3
attempt=0
while [ "$attempt" -lt 30 ]; do
  version_digest=$(docker buildx imagetools inspect "$registry:$version_tag" --format '{{.Manifest.Digest}}' 2>/dev/null) || version_digest=
  alias_digest=$(docker buildx imagetools inspect "$registry:$alias_tag" --format '{{.Manifest.Digest}}' 2>/dev/null) || alias_digest=
  if [ -n "$version_digest" ] && [ "$version_digest" = "$alias_digest" ]; then
    echo "Verified $registry:$alias_tag matches $registry:$version_tag ($version_digest)"
    exit 0
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -lt 30 ]; then
    sleep 2
  fi
done

echo "$registry:$alias_tag did not converge to $registry:$version_tag within 60 seconds" >&2
exit 1
