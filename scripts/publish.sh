#!/bin/sh
# Usage: scripts/publish.sh <release-directory>
# Publishes the images and files that scripts/release.sh prepared:
#   - pushes ghcr.io/xjoker/garage-ui:<VERSION>-amd64|arm64 plus the multi-arch <VERSION> and latest tags;
#   - verifies the pushed image by pulling it and probing /healthz;
#   - uploads binaries, deployment files, the SBOM and SHA256SUMS to a GitHub release.
# Set PUBLISH_GITHUB_RELEASE=true to publish the draft after upload; the tag workflow uses this.
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
files="garage-ui-linux-amd64 garage-ui-linux-arm64 sbom.spdx.json compose.yaml .env.example SHA256SUMS"
for name in $files; do
  [ -f "$out/$name" ] || { echo "Missing $out/$name; run scripts/release.sh first" >&2; exit 1; }
done
(cd "$out" && sha256sum --check SHA256SUMS)

# A published release is immutable from this script. Check before any registry
# mutation; a draft may be retargeted to the source commit being published.
releases=$(gh api --paginate "repos/$repo/releases?per_page=100" \
  --jq '.[] | [.tag_name, .draft] | @tsv')
release_state=$(printf '%s\n' "$releases" | awk -v version="$version" '$1 == version { print $2 }')
case "$release_state" in
  true) release_exists=true ;;
  '') release_exists=false ;;
  *) echo "Release $version is already published; refusing to modify it" >&2; exit 1 ;;
esac

notes=$(mktemp)
trap 'rm -f "$notes"' EXIT HUP INT TERM
python3 - "$version" "$notes" <<'PY'
import sys
from pathlib import Path

version, destination = sys.argv[1:]
lines = Path("CHANGELOG.md").read_text().splitlines()
heading = f"## {version}"
try:
    start = lines.index(heading)
except ValueError:
    raise SystemExit(f"CHANGELOG.md has no entry for {version}")
end = next((index for index in range(start + 1, len(lines)) if lines[index].startswith("## ")), len(lines))
body = "\n".join(lines[start:end]).strip()
policy = "\n\n## Release integrity\n\nThis release is unsigned and has no build-provenance attestation. SHA-256 checksums provide file-integrity verification only."
Path(destination).write_text(f"{body}{policy}\n")
PY

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
docker buildx imagetools create -t "$registry:$version" \
  "$registry:$version-amd64" "$registry:$version-arm64"

# A successful push is not proof: both platforms must be in the index and the pulled image must be this build.
for tag in "$version"; do
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
# A new ghcr package starts private, and the pull above used this machine's login.
# Read the index with an anonymous registry token, as a user without an account would.
anon_token=$(curl -fsS "https://ghcr.io/token?scope=repository:$repo:pull" 2>/dev/null |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["token"])' 2>/dev/null) || anon_token=
if [ -z "$anon_token" ] || ! curl -fsS -o /dev/null -H "Authorization: Bearer $anon_token" \
  -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" \
  "https://ghcr.io/v2/$repo/manifests/$version" 2>/dev/null; then
  echo "$registry:$version is not publicly readable. Set the package to public at" >&2
  echo "  https://github.com/users/xjoker/packages/container/garage-ui/settings" >&2
  echo "then run this script again; the pushes above are safe to repeat." >&2
  exit 1
fi

# The draft can be updated to the exact source commit. A published release was
# rejected above before images were pushed.
if [ "$release_exists" = true ]; then
  gh release edit "$version" --repo "$repo" --draft --target "$commit" \
    --title "$version" --notes-file "$notes"
else
  gh release create "$version" --repo "$repo" --draft --target "$commit" \
    --title "$version" --notes-file "$notes"
fi
for name in $files; do
  gh release upload "$version" "$out/$name" --repo "$repo" --clobber
done

if [ "${PUBLISH_GITHUB_RELEASE:-}" = true ]; then
  docker buildx imagetools create -t "$registry:latest" "$registry:$version"
  version_digest=$(docker buildx imagetools inspect "$registry:$version" --format '{{.Manifest.Digest}}')
  latest_digest=$(docker buildx imagetools inspect "$registry:latest" --format '{{.Manifest.Digest}}')
  if [ "$version_digest" != "$latest_digest" ]; then
    echo "latest does not match the verified $version image" >&2
    exit 1
  fi
  gh release edit "$version" --repo "$repo" --draft=false
  echo "Published release $version"
else
  echo "Draft release $version is ready. Review it, then publish with:"
  echo "  PUBLISH_GITHUB_RELEASE=true scripts/publish.sh \"$out\""
fi
