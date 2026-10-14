#!/bin/sh
# Usage: scripts/release.sh [output-directory]
# Creates two static Linux binaries, their SBOM and SHA256SUMS, without signing.
set -eu
if [ "$#" -gt 1 ]; then
  echo "Usage: $0 [output-directory]" >&2
  exit 1
fi
caller_dir=$PWD
cd "$(dirname "$0")/.."
version=$(cat VERSION)
commit=$(git rev-parse --verify HEAD)
if ! git diff --quiet HEAD --; then
  echo "Release requires clean tracked source" >&2
  exit 1
fi
out=${1:-/tmp/garage-ui-release/$version}
case "$out" in
  /*) ;;
  *) out=$caller_dir/$out ;;
esac
# An existing destination may contain a previous release; never overwrite it.
mkdir -p "$(dirname "$out")"
mkdir "$out"

export BUILDKIT_PROGRESS=plain

rust_image=$(awk '$1 == "FROM" && $2 ~ /^rust:/ { print $2; exit }' deploy/Dockerfile)
if [ -z "$rust_image" ]; then
  echo "deploy/Dockerfile names no rust image" >&2
  exit 1
fi

python3 - "$out/sbom.spdx.json" <<'PY'
import datetime
import json
import re
import subprocess
import sys
from pathlib import Path

dest = Path(sys.argv[1])

def load_jsonc(path):
    text = Path(path).read_text()
    # bun.lock is JSON with trailing commas.
    return json.loads(re.sub(r",(\s*[}\]])", r"\1", text))

def spdx_id(origin, name, version, used):
    raw = re.sub(r"[^A-Za-z0-9.-]+", "-", f"{origin}-{name}-{version}").strip("-")
    if not raw:
        raise SystemExit(f"empty SPDXID for {origin} {name} {version}")
    base = f"SPDXRef-{raw}"
    ident = base
    n = 2
    while ident in used:
        ident = f"{base}-{n}"
        n += 1
    used.add(ident)
    return ident

meta = json.loads(
    subprocess.check_output(
        ["cargo", "metadata", "--locked", "--format-version", "1"],
        text=True,
    )
)
cargo = []
for pkg in meta["packages"]:
    name = pkg["name"]
    version = pkg["version"]
    if not isinstance(name, str) or not isinstance(version, str) or not name or not version:
        raise SystemExit(f"cargo package missing name or version: {pkg!r}")
    cargo.append((name, version))

lock = load_jsonc("web/bun.lock")
ws = lock["workspaces"][""]
bun = []
direct = []
for field in ("dependencies", "devDependencies"):
    recorded = ws.get(field, {})
    if not isinstance(recorded, dict):
        raise SystemExit(f"web/bun.lock workspaces {field} is not an object")
    for name, version in recorded.items():
        if not isinstance(version, str) or not version:
            raise SystemExit(f"bun {field} {name} has no version")
        direct.append((name, version))
        bun.append((name, version))

resolved = []
for key, value in lock["packages"].items():
    if not isinstance(value, list) or not value or not isinstance(value[0], str):
        raise SystemExit(f"bun package {key} has no recorded version")
    ident = value[0]
    if "@" not in ident:
        raise SystemExit(f"bun package {key} ident has no version: {ident}")
    name, version = ident.rsplit("@", 1)
    if not name or not version:
        raise SystemExit(f"bun package {key} ident is incomplete: {ident}")
    resolved.append((name, version))
    bun.append((name, version))

resolved_set = set(resolved)
missing = [item for item in direct if item not in resolved_set]
if missing:
    raise SystemExit(f"bun direct dependency missing from packages: {missing}")

used = set()
packages = []
counts = {}
for origin, items in (("cargo", cargo), ("bun", bun)):
    seen = set()
    count = 0
    for name, version in items:
        if (name, version) in seen:
            continue
        seen.add((name, version))
        count += 1
        packages.append(
            {
                "SPDXID": spdx_id(origin, name, version, used),
                "name": name,
                "versionInfo": version,
                "downloadLocation": "NOASSERTION",
                "filesAnalyzed": False,
                "sourceInfo": origin,
            }
        )
    counts[origin] = count

created = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
doc = {
    "spdxVersion": "SPDX-2.3",
    "dataLicense": "CC0-1.0",
    "SPDXID": "SPDXRef-DOCUMENT",
    "name": "garage-ui",
    "documentNamespace": f"https://github.com/xjoker/garage-ui/spdx/local-{created.replace(':', '').replace('-', '')}",
    "creationInfo": {
        "created": created,
        "creators": ["Tool: scripts/release.sh"],
    },
    "packages": packages,
}
if doc["spdxVersion"] != "SPDX-2.3":
    raise SystemExit("spdxVersion drifted")
if counts["cargo"] == 0 or counts["bun"] == 0:
    raise SystemExit(f"empty SBOM counts: {counts}")
dest.write_text(json.dumps(doc, indent=2) + "\n")
print(f"sbom packages cargo={counts['cargo']} bun={counts['bun']} total={len(packages)}")
PY

scripts/build.sh --images

copy_bin() {
  platform=$1
  tag=$2
  dest=$3
  cid=$(docker create --platform "$platform" "$tag")
  if ! docker cp "$cid:/garage-ui" "$dest"; then
    docker rm -v "$cid" >/dev/null || true
    exit 1
  fi
  docker rm -v "$cid" >/dev/null
}

copy_bin linux/amd64 "garage-ui:$version-amd64" "$out/garage-ui-linux-amd64"
copy_bin linux/arm64 "garage-ui:$version-arm64" "$out/garage-ui-linux-arm64"

# The Dockerfile pins a multi-arch index. Pulling that index digest for a second
# platform fails with "cannot overwrite digest", so ELF checks use the platform manifest.
platform_rust_image() {
  platform=$1
  python3 - "$rust_image" "$platform" <<'PY'
import json
import subprocess
import sys

image, platform = sys.argv[1], sys.argv[2]
raw = subprocess.check_output(["docker", "buildx", "imagetools", "inspect", "--raw", image])
doc = json.loads(raw)
os_name, arch = platform.split("/", 1)
variant = "v8" if arch == "arm64" else None
digest = None
for manifest in doc["manifests"]:
    plat = manifest.get("platform") or {}
    if plat.get("os") == os_name and plat.get("architecture") == arch and plat.get("variant") == variant:
        digest = manifest["digest"]
        break
if not digest:
    raise SystemExit(f"no {platform} manifest in {image}")
print(f"{image.split('@', 1)[0]}@{digest}")
PY
}

static_one() {
  platform=$1
  bin=$2
  image=$(platform_rust_image "$platform")
  docker pull --platform "$platform" "$image"
  cid=$(docker create --platform "$platform" --entrypoint sh "$image" -c \
    'readelf -lW /garage-ui && readelf -dW /garage-ui')
  if ! docker cp "$bin" "$cid:/garage-ui"; then
    docker rm "$cid" >/dev/null || true
    exit 1
  fi
  set +e
  elf_out=$(docker start -a "$cid" 2>&1)
  elf_status=$?
  set -e
  docker rm "$cid" >/dev/null
  printf '%s\n' "$elf_out"
  if [ "$elf_status" -ne 0 ]; then
    echo "ELF inspection failed for $bin (status $elf_status)" >&2
    exit 1
  fi
  if printf '%s\n' "$elf_out" | grep -E '^[[:space:]]*INTERP[[:space:]]|\(NEEDED\)' >/dev/null; then
    echo "ELF requires a dynamic loader or shared library: $bin" >&2
    exit 1
  fi
}

static_one linux/amd64 "$out/garage-ui-linux-amd64"
static_one linux/arm64 "$out/garage-ui-linux-arm64"

# Verify build identity and runtime restrictions on the exact final images.
python3 - "$version" "$commit" <<'PY'
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

version, commit = sys.argv[1:]
if commit == "unknown":
    raise SystemExit("Release commit identity must be known")
if subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() != commit:
    raise SystemExit("Repository HEAD changed during the release build")
for arch in ("amd64", "arm64"):
    image = f"garage-ui:{version}-{arch}"
    cid = subprocess.check_output([
        "docker", "run", "-d", "--read-only", "--platform", f"linux/{arch}",
        "--tmpfs", "/data:rw,uid=65532,gid=65532,mode=700",
        "--tmpfs", "/tmp:rw", "-p", "127.0.0.1::3909", image,
    ], text=True).strip()
    try:
        info = json.loads(subprocess.check_output(["docker", "inspect", cid]))[0]
        if info["Config"]["User"] != "65532:65532" or not info["HostConfig"]["ReadonlyRootfs"]:
            raise SystemExit(f"Runtime restrictions missing for {image}")
        port = info["NetworkSettings"]["Ports"]["3909/tcp"][0]["HostPort"]
        url = f"http://127.0.0.1:{port}/healthz"
        deadline = time.monotonic() + 60
        while True:
            try:
                with urllib.request.urlopen(url, timeout=2) as response:
                    health = json.load(response)
                break
            except (urllib.error.URLError, TimeoutError):
                if time.monotonic() >= deadline:
                    raise SystemExit(f"Health probe timed out for {image}")
                time.sleep(1)
        if health.get("status") != "ok" or health.get("commit") != commit or health.get("version") != version:
            raise SystemExit(f"Build identity mismatch for {image}: {health!r}")
        print(f"Verified {image}: commit={commit} version={version}, nonroot, read-only")
    finally:
        subprocess.run(["docker", "rm", "-f", "-v", cid], check=True, stdout=subprocess.DEVNULL)
PY

python3 - "$out" <<'PY'
import hashlib
import sys
from pathlib import Path

out = Path(sys.argv[1])
names = ["garage-ui-linux-amd64", "garage-ui-linux-arm64", "sbom.spdx.json"]
lines = []
for name in names:
    digest = hashlib.sha256((out / name).read_bytes()).hexdigest()
    lines.append(f"{digest}  {name}")
text = "\n".join(lines) + "\n"
(out / "SHA256SUMS").write_text(text)
sys.stdout.write(text)
PY

printf 'Release artifacts: %s\n' "$out"
