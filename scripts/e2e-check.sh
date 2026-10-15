#!/bin/sh
# Requires a built target/debug/garage-ui, web dependencies, browsers, and a local pinned Garage image.
# GARAGE_VERSION=v2.3.0|v2.4.1 BUN_BIN=/path/to/bun scripts/e2e-check.sh [Playwright arguments]
# No arguments runs the disposable smoke on Chromium. --project=firefox|webkit|chromium selects a browser.
set -eu
umask 077
cd "$(dirname "$0")/.."
repo=$(pwd)
bun=${BUN_BIN:-bun}
version=${GARAGE_VERSION:-v2.4.1}
case "$version" in v2.3.0|v2.4.1) ;; *) echo 'GARAGE_VERSION must be v2.3.0 or v2.4.1' >&2; exit 1 ;; esac
[ "$("$bun" --version)" = 1.4.2 ] || { echo 'Bun 1.4.2 is required (set BUN_BIN)' >&2; exit 1; }
[ -x "$repo/target/debug/garage-ui" ] || { echo 'Build target/debug/garage-ui before running browser checks' >&2; exit 1; }
[ -d "$repo/web/node_modules/@playwright/test" ] || { echo 'Install the locked web dependencies before running browser checks' >&2; exit 1; }
image="dxflrs/garage:$version"
# Resolve a local image ID so a mutable local tag cannot switch images during setup. Never pull implicitly.
image_id=$(docker image inspect "$image" --format '{{.Id}}')
"$bun" -e 'import { createServer } from "node:net"; const server = createServer(); server.once("error", () => { console.error("The browser checks require exclusive 127.0.0.1:3909"); process.exitCode = 1; }); server.listen(3909, "127.0.0.1", () => server.close());'
work=$(mktemp -d "${TMPDIR:-/tmp}/garage-ui-e2e.XXXXXXXX")
owner=${work##*/}
container="garage-ui-e2e-${owner#garage-ui-e2e.}"
volume="$container-data"
child=
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || :
    wait "$child" 2>/dev/null || :
  fi
  failed=0
  if ! docker info >/dev/null 2>&1; then
    echo "Docker is unavailable; cleanup is incomplete for $container, $volume, and $work" >&2
    exit 1
  fi
  # The random identity and matching ownership label are both required before any removal.
  if actual=$(docker inspect "$container" --format '{{index .Config.Labels "garage-ui.e2e-owner"}}' 2>/dev/null); then
    if [ "$actual" = "$owner" ]; then docker rm -f "$container" >/dev/null || failed=1; else failed=1; fi
  fi
  if actual=$(docker volume inspect "$volume" --format '{{index .Labels "garage-ui.e2e-owner"}}' 2>/dev/null); then
    if [ "$actual" = "$owner" ]; then docker volume rm "$volume" >/dev/null || failed=1; else failed=1; fi
  fi
  if [ "$failed" -eq 0 ]; then
    rm -rf -- "$work"
    echo "Removed owned browser fixture $container and temporary UI data"
  else
    echo "Fixture cleanup failed; inspect only $container, $volume, and $work" >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$work/ui"
export GARAGE_VERSION="$version" GARAGE_CONTAINER="$container" GARAGE_UI_E2E_DATA_DIR="$work/ui"
GARAGE_ADMIN_TOKEN=$("$bun" -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')
export GARAGE_ADMIN_TOKEN
unset GARAGE_UI_BOOTSTRAP_USERNAME GARAGE_UI_BOOTSTRAP_PASSWORD_HASH
export COOKIE_SECURE=false
rpc_secret=$("$bun" -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')
cat > "$work/garage.toml" <<CONFIG
metadata_dir = "/data/meta"
data_dir = "/data/objects"
db_engine = "sqlite"
replication_factor = 1
rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret = "$rpc_secret"
[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
root_domain = ".s3.garage.localhost"
[admin]
api_bind_addr = "[::]:3903"
admin_token = "$GARAGE_ADMIN_TOKEN"
CONFIG
docker volume create --label "garage-ui.e2e-owner=$owner" "$volume" >/dev/null
# v2.4.1 initializes its own layout; v2.3.0 needs one explicit assign/apply below.
if [ "$version" = v2.4.1 ]; then single_node=--single-node; else single_node=; fi
docker run -d --pull=never --name "$container" --label "garage-ui.e2e-owner=$owner" \
  --log-opt max-size=10m --log-opt max-file=1 \
  -e GARAGE_CONFIG_FILE=/etc/garage.toml \
  -p 127.0.0.1::3900 -p 127.0.0.1::3903 \
  -v "$volume:/data" -v "$work/garage.toml:/etc/garage.toml:ro" \
  "$image_id" /garage server $single_node >/dev/null
admin_port=$(docker inspect "$container" --format '{{(index (index .NetworkSettings.Ports "3903/tcp") 0).HostPort}}')
s3_port=$(docker inspect "$container" --format '{{(index (index .NetworkSettings.Ports "3900/tcp") 0).HostPort}}')
export GARAGE_ADMIN_URL="http://127.0.0.1:$admin_port" S3_ENDPOINT_URL="http://127.0.0.1:$s3_port" S3_REGION=garage
attempt=0
until docker exec "$container" /garage status >"$work/status" 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then echo 'Garage RPC did not become ready' >&2; exit 1; fi
  sleep 1
done
if [ "$version" = v2.3.0 ]; then
  node_line=$(docker exec "$container" /garage node id -q)
  node_id=${node_line%%@*}
  case "$node_id" in ''|*[!0-9a-f]*) echo 'Garage returned an invalid node ID' >&2; exit 1 ;; esac
  # Mutations run once. If either fails, report the actual layout and stop rather than replaying it.
  if ! docker exec "$container" /garage layout assign -z e2e -c 1GB "$node_id" >"$work/layout" 2>&1; then
    docker exec "$container" /garage layout show >&2
    echo 'Garage layout assignment failed' >&2
    exit 1
  fi
  if ! docker exec "$container" /garage layout apply --version 1 >>"$work/layout" 2>&1; then
    docker exec "$container" /garage layout show >&2
    echo 'Garage layout application failed' >&2
    exit 1
  fi
fi
"$bun" -e '
let last = "not checked";
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch(`${process.env.GARAGE_ADMIN_URL}/v2/GetClusterHealth`, {
      headers: { authorization: `Bearer ${process.env.GARAGE_ADMIN_TOKEN}` },
      signal: AbortSignal.timeout(2000),
    });
    last = `HTTP ${response.status}`;
    if (response.ok) {
      const health = await response.json();
      last = `status=${health.status}, storageNodes=${health.storageNodes}, storageNodesUp=${health.storageNodesUp}`;
      if (health.status === "healthy" && health.storageNodes === 1 && health.storageNodesUp === 1) process.exit(0);
    }
  } catch (error) { last = error instanceof Error ? error.message : String(error); }
  await Bun.sleep(1000);
}
throw new Error(`Garage did not reach a healthy single-node layout: ${last}`);
'
echo "Running browser checks against $version ($container)"
if [ "$#" -eq 0 ]; then set -- disposable-smoke.spec.ts; fi
(cd "$repo/web" && exec "$bun" run test:e2e "$@") &
child=$!
wait "$child"
child=
