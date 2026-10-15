#!/bin/sh
# Usage: scripts/publish.sh <release-directory>
# Publishes the images and files that scripts/release.sh prepared:
#   - pushes ghcr.io/xjoker/garage-ui:<VERSION>-amd64|arm64 plus the multi-arch <VERSION> and latest tags;
#   - verifies the pushed image by pulling it and probing /healthz;
#   - uploads the binaries, SBOM and SHA256SUMS to a DRAFT GitHub release. Publishing the draft is manual.
# Requires an existing login; this script never reads or stores a token:
#   gh auth token | docker login ghcr.io -u <github-user> --password-stdin
set -eu
if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <release-directory>" >&2
  exit 1
fi
caller_dir=$PWD
cd "$(dirname "$0")/.."
case "$1" in
  /*) out=$1 ;;
  *) out=$caller_dir/$1 ;;
esac
version=$(cat VERSION)
commit=$(git rev-parse --verify HEAD)
repo=xjoker/garage-ui
registry=ghcr.io/$repo

if ! git diff --quiet HEAD --; then
  echo "Publishing requires clean tracked source" >&2
  exit 1
fi
files="garage-ui-linux-amd64 garage-ui-linux-arm64 sbom.spdx.json SHA256SUMS"
for name in $files; do
  [ -f "$out/$name" ] || { echo "Missing $out/$name; run scripts/release.sh first" >&2; exit 1; }
done

# Runs an image read-only and requires /healthz to report this release's version and commit.
verify_image() {
  python3 - "$1" "$2" "$version" "$commit" <<'PY'
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

image, platform, version, commit = sys.argv[1:]
cid = subprocess.check_output([
    "docker", "run", "-d", "--read-only", "--platform", platform,
    "--tmpfs", "/data:rw,uid=65532,gid=65532,mode=700",
    "--tmpfs", "/tmp:rw", "-p", "127.0.0.1::3909", image,
], text=True).strip()
try:
    info = json.loads(subprocess.check_output(["docker", "inspect", cid]))[0]
    port = info["NetworkSettings"]["Ports"]["3909/tcp"][0]["HostPort"]
    deadline = time.monotonic() + 60
    while True:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=2) as response:
                health = json.load(response)
            break
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if time.monotonic() >= deadline:
                raise SystemExit(f"Health probe timed out for {image}")
            time.sleep(1)
    if health.get("status") != "ok" or health.get("commit") != commit or health.get("version") != version:
        raise SystemExit(f"Build identity mismatch for {image}: {health!r}")
    print(f"Verified {image} ({platform}): commit={commit} version={version}")
finally:
    subprocess.run(["docker", "rm", "-f", "-v", cid], check=True, stdout=subprocess.DEVNULL)
PY
}

# Local images must be the ones built from this commit before anything leaves the machine.
for arch in amd64 arm64; do
  docker image inspect "garage-ui:$version-$arch" >/dev/null
  verify_image "garage-ui:$version-$arch" "linux/$arch"
done

for arch in amd64 arm64; do
  docker tag "garage-ui:$version-$arch" "$registry:$version-$arch"
  docker push "$registry:$version-$arch"
done
docker buildx imagetools create -t "$registry:$version" -t "$registry:latest" \
  "$registry:$version-amd64" "$registry:$version-arm64"

# A successful push is not proof: both platforms must be in the index and the pulled image must be this build.
for tag in "$version" latest; do
  platforms=$(docker buildx imagetools inspect "$registry:$tag" \
    --format '{{range .Manifest.Manifests}}{{.Platform.OS}}/{{.Platform.Architecture}} {{end}}')
  case "$platforms" in
    *linux/amd64*linux/arm64* | *linux/arm64*linux/amd64*) ;;
    *) echo "$registry:$tag lacks a platform: $platforms" >&2; exit 1 ;;
  esac
done
case $(uname -m) in
  arm64 | aarch64) host=linux/arm64 ;;
  *) host=linux/amd64 ;;
esac
docker pull --platform "$host" "$registry:$version"
verify_image "$registry:$version" "$host"

# The tag is created when the owner publishes the draft, at the commit this release was built from.
if gh release view "$version" --repo "$repo" >/dev/null 2>&1; then
  if [ "$(gh release view "$version" --repo "$repo" --json isDraft --jq .isDraft)" != true ]; then
    echo "Release $version is already published; refusing to modify it" >&2
    exit 1
  fi
else
  gh release create "$version" --repo "$repo" --draft --target "$commit" \
    --title "$version" --notes "See CHANGELOG.md for $version."
fi
for name in $files; do
  gh release upload "$version" "$out/$name" --repo "$repo" --clobber
done

echo "Draft release $version is ready. Review it, then publish with:"
echo "  gh release edit $version --repo $repo --draft=false"
