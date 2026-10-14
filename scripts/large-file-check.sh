#!/bin/bash
# Rerun the large-file and browser thumbnail gate against fresh Garage v2.4.1 volumes.
# Requires installed web dependencies and Playwright Chromium; receipts remain in
# LARGE_FILE_RECEIPTS_DIR (default /tmp/garage-close-f-large), one directory per run.
# Pass a UI image as the first argument. With no argument, build this checkout
# for linux/arm64 with docker buildx and the orbstack builder. The UI image id is not pinned.
set -euo pipefail
if [[ -x /opt/homebrew/bin/magick ]]; then
  MAGICK=/opt/homebrew/bin/magick
else
  MAGICK=magick
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
umask 077
mkdir -p "${LARGE_FILE_RECEIPTS_DIR:-/tmp/garage-close-f-large}"
WORK="$(mktemp -d "${LARGE_FILE_RECEIPTS_DIR:-/tmp/garage-close-f-large}/run.XXXXXXXX")"
LOG="${WORK}/run.log"
RUN_ID="p3-large-file-$(basename "$WORK" | tr '[:upper:]' '[:lower:]')"
UI="${RUN_ID}-ui"
GARAGE="${RUN_ID}-garage"
CLIENT="${RUN_ID}-client"
NET="$RUN_ID"
VOL_GARAGE="${RUN_ID}-garage-data"
VOL_UI="${RUN_ID}-ui-data"
VOL_CONFIG="${RUN_ID}-config"
BUN="${BUN:-${HOME}/.bun/bin/bun}"
GARAGE_IMAGE=dxflrs/garage:v2.4.1
PY_IMAGE=python:3.12-slim
ALPINE_IMAGE=alpine:3
watch_pid=""
ok=0

log() {
  printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG"
}

stop_watch() {
  if [[ -n "${watch_pid}" ]]; then
    touch "${WORK}/sample.stop" 2>/dev/null || true
    kill "${watch_pid}" >/dev/null 2>&1 || true
    wait "${watch_pid}" >/dev/null 2>&1 || true
    watch_pid=""
  fi
}

cleanup() {
  stop_watch
  if [[ "$ok" != 1 && -f "${WORK}/gate.py" ]]; then
    {
      echo "---- garage-ui log ----"
      docker logs --tail 80 "$UI" 2>&1 || true
      echo "---- garage log ----"
      docker logs --tail 80 "$GARAGE" 2>&1 || true
    } | GATE_WORK="$WORK" python3 "${WORK}/gate.py" redact >>"$LOG" 2>/dev/null || true
  fi
  docker rm -f "$UI" "$GARAGE" "$CLIENT" >/dev/null 2>&1 || true
  docker volume rm "$VOL_GARAGE" "$VOL_UI" "$VOL_CONFIG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "${WORK}/secrets" "${WORK}/garage.toml" "${WORK}/env.ui" "${WORK}/session" \
    "${WORK}/client.out" "${WORK}/thumb.jpg" "${WORK}/samples.txt" "${WORK}/sample.stop" \
    "${WORK}/outcome.json" "${WORK}/disconnect.sent" "${WORK}/multipart.body" \
    "${WORK}/body.started" "${WORK}/cookies" "${WORK}/login.json" \
    "${WORK}/login.body" "${WORK}/login.headers" "${WORK}/headers" "${WORK}/body" || true
  {
    printf '%s cleanup_removed containers=%s,%s volumes=%s,%s,%s network=%s\n' \
      "$(date -u +%H:%M:%S)" "$GARAGE" "$UI" "$VOL_GARAGE" "$VOL_UI" "$VOL_CONFIG" "$NET"
  } >>"$LOG" 2>/dev/null || true
  true
}

require_image() {
  local name="$1"
  local prefix="$2"
  local id
  id="$(docker image inspect "$name" --format '{{.Id}}')"
  case "$id" in
    "sha256:${prefix}"*) log "image ${name} id=${id}" ;;
    *) log "image ${name} id ${id} does not start with ${prefix}"; exit 1 ;;
  esac
}

CURL_IMAGE=curlimages/curl:latest

run_client() {
  local code=0
  docker run --rm --pull never \
    --network "container:${UI}" \
    --entrypoint /bin/sh \
    -v "${WORK}:/work" \
    "$CURL_IMAGE" \
    /work/curl-client.sh "$@" >"${WORK}/client.out" || code=$?
  GATE_WORK="$WORK" python3 "${WORK}/gate.py" redact <"${WORK}/client.out" | tee -a "$LOG"
  rm -f "${WORK}/client.out"
  return "$code"
}

mkdir -p "$WORK"
: >"$LOG"
umask 077
trap cleanup EXIT

log "evidence_directory=${WORK}"
log "containers_created=${GARAGE},${UI}"
log "volumes_created=${VOL_GARAGE},${VOL_UI},${VOL_CONFIG}"
log "harness memory_metric=docker_stats_display memory_swap=256m idle_timeout_secs=3600 cookie_secure=false ports_published=ui_loopback_ephemeral"
log "load=$(uptime)"
log "disk_avail_kb=$(df -k /tmp | awk 'NR==2 {print $4}')"

require_image "$GARAGE_IMAGE" 2711bbf081dc
docker image inspect "$PY_IMAGE" >/dev/null
docker image inspect "$ALPINE_IMAGE" >/dev/null
docker image inspect "$CURL_IMAGE" >/dev/null
"$BUN" "${root}/scripts/large-file-browser.ts" --check

if [[ $# -gt 1 ]]; then
  log "usage: scripts/large-file-check.sh [ui-image]"
  exit 1
fi
if [[ -n "${1:-}" ]]; then
  UI_IMAGE="$1"
else
  UI_IMAGE="garage-ui:large-file-arm64"
  log "ui_build builder=orbstack platform=linux/arm64 context=${root}"
  docker buildx build \
    --builder orbstack \
    --platform linux/arm64 \
    --load \
    -f "${root}/deploy/Dockerfile" \
    -t "${UI_IMAGE}" \
    "${root}"
fi
ui_id="$(docker image inspect "${UI_IMAGE}" --format '{{.Id}}')"
ui_platform="$(docker image inspect "${UI_IMAGE}" --format '{{.Os}}/{{.Architecture}}')"
log "image ${UI_IMAGE} id=${ui_id} platform=${ui_platform}"
if [[ "$ui_platform" != "linux/arm64" ]]; then
  log "ui_platform_rejected expected=linux/arm64"
  exit 1
fi

cat >"${WORK}/gate.py" <<'PY'
import http.client
import json
import os
import pathlib
import socket
import subprocess
import time

CHUNK = 1024 * 1024
ONE_GB = 1073741824
TWO_GB = 2147483648
KILL_AT = 268435456
FIVE_GB = 5368709120
GROWTH_LIMIT = 67108864
UI_HOST = "127.0.0.1"
UI_PORT = 3909
GARAGE_HOST = "p3-large-file-garage"
GARAGE_PORT = 3903


def work():
    return pathlib.Path(os.environ.get("GATE_WORK", "/work"))


def secret_names():
    return (
        "admin_token",
        "rpc_secret",
        "metrics_token",
        "secret_access_key",
        "password",
        "password_hash",
        "access_key_id",
    )


def load_secrets():
    root = work()
    found = []
    for name in secret_names():
        for path in (root / "secrets" / name, root / name):
            if path.is_file():
                text = path.read_text(encoding="utf-8").strip()
                if len(text) >= 8:
                    found.append(text)
    session = root / "session"
    if session.is_file():
        for line in session.read_text(encoding="utf-8").splitlines():
            if len(line) >= 8:
                found.append(line)
    return found


def redact_text(text):
    for secret in load_secrets():
        text = text.replace(secret, "[redacted]")
    return text


def cmd_redact():
    import sys

    sys.stdout.write(redact_text(sys.stdin.read()))


def docker_socket():
    host = subprocess.check_output(
        ["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
        text=True,
    ).strip()
    if not host.startswith("unix://"):
        raise SystemExit(f"unsupported docker host {host}")
    return host[len("unix://") :]


def stats_bytes(container):
    sock = docker_socket()
    url = f"http://localhost/containers/{container}/stats?stream=false"
    raw = subprocess.check_output(
        ["curl", "-sS", "--unix-socket", sock, url],
    )
    data = json.loads(raw)
    mem = data.get("memory_stats") or {}
    usage = int(mem.get("usage") or 0)
    fields = mem.get("stats") or {}
    total_inactive = fields.get("total_inactive_file")
    inactive = int(fields.get("inactive_file") or 0)
    if total_inactive is not None and int(total_inactive) < usage:
        value = usage - int(total_inactive)
    elif inactive < usage:
        value = usage - inactive
    else:
        value = usage
    limit = int(mem.get("limit") or 0)
    return value, limit


def stats_line(container):
    line = subprocess.check_output(
        ["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", container],
        text=True,
    ).strip()
    return line.split("/")[0].strip()


def parse_size(text):
    units = {"B": 1, "KiB": 1024, "MiB": 1024**2, "GiB": 1024**3, "TiB": 1024**4}
    number = ""
    unit = ""
    for char in text:
        if char.isdigit() or char == ".":
            number += char
        else:
            unit += char
    if not number or unit not in units:
        raise SystemExit(f"unparsed docker stats size {text}")
    return float(number) * units[unit]


def cmd_mem_sample(container):
    shown = stats_line(container)
    parsed = int(parse_size(shown))
    cgroup, limit = stats_bytes(container)
    print(
        f"mem_bytes={parsed} mem_limit={limit} docker_stats={shown} "
        f"cgroup_bytes={cgroup}"
    )


def cmd_mem_watch(container, out_path, stop_path):
    path = pathlib.Path(out_path)
    stop = pathlib.Path(stop_path)
    with path.open("w", encoding="utf-8") as handle:
        while not stop.exists():
            try:
                value = int(parse_size(stats_line(container)))
            except Exception as exc:
                handle.write(f"error {type(exc).__name__}\n")
                handle.flush()
                time.sleep(0.5)
                continue
            handle.write(f"{value}\n")
            handle.flush()


def cmd_assert_ports(container):
    raw = subprocess.check_output(
        ["docker", "inspect", "-f", "{{json .NetworkSettings.Ports}}", container],
        text=True,
    )
    ports = json.loads(raw) or {}
    allowed = container == os.environ.get("GATE_UI_CONTAINER")
    published = []
    for spec, binds in ports.items():
        for bind in binds or []:
            if not allowed or spec != "3909/tcp" or bind.get("HostIp") != "127.0.0.1":
                raise SystemExit(f"unexpected published port {spec}")
            if not str(bind.get("HostPort", "")).isdigit():
                raise SystemExit("invalid browser port")
            published.append(bind)
    if allowed and len(published) != 1:
        raise SystemExit("expected exactly one loopback browser port")
    print(f"published_ports={json.dumps(ports)}")


def write_secret(path, text):
    path.write_text(text, encoding="utf-8")
    os.chmod(path, 0o600)


def cmd_init_secrets():
    import bcrypt

    root = work()
    secrets = root / "secrets"
    secrets.mkdir(mode=0o700, exist_ok=True)
    os.chmod(secrets, 0o700)
    admin = os.urandom(32).hex()
    rpc = os.urandom(32).hex()
    metrics = os.urandom(32).hex()
    password = os.urandom(18).hex()
    password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()
    write_secret(secrets / "admin_token", admin)
    write_secret(secrets / "rpc_secret", rpc)
    write_secret(secrets / "metrics_token", metrics)
    write_secret(secrets / "password", password)
    write_secret(secrets / "password_hash", password_hash)
    toml = (
        'metadata_dir = "/var/lib/garage/meta"\n'
        'data_dir = "/var/lib/garage/data"\n'
        'db_engine = "sqlite"\n'
        "replication_factor = 1\n"
        'rpc_bind_addr = "[::]:3901"\n'
        'rpc_public_addr = "127.0.0.1:3901"\n'
        f'rpc_secret = "{rpc}"\n'
        "\n"
        "[s3_api]\n"
        's3_region = "garage"\n'
        'api_bind_addr = "[::]:3900"\n'
        'root_domain = ".s3.garage.localhost"\n'
        "\n"
        "[s3_web]\n"
        'bind_addr = "[::]:3902"\n'
        'root_domain = ".web.garage.localhost"\n'
        'index = "index.html"\n'
        "\n"
        "[admin]\n"
        'api_bind_addr = "[::]:3903"\n'
        f'admin_token = "{admin}"\n'
        f'metrics_token = "{metrics}"\n'
    )
    write_secret(root / "garage.toml", toml)
    print("secrets_ready")


def admin_call(method, path, payload=None):
    token = (work() / "secrets" / "admin_token").read_text(encoding="utf-8").strip()
    body = b"" if payload is None else json.dumps(payload).encode()
    conn = http.client.HTTPConnection(GARAGE_HOST, GARAGE_PORT, timeout=30)
    conn.putrequest(method, path)
    conn.putheader("Authorization", f"Bearer {token}")
    conn.putheader("Accept", "application/json")
    if payload is not None:
        conn.putheader("Content-Type", "application/json")
        conn.putheader("Content-Length", str(len(body)))
    conn.endheaders()
    if payload is not None:
        conn.send(body)
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    return resp.status, data


def cmd_admin():
    deadline = time.time() + 90
    last = "none"
    while time.time() < deadline:
        try:
            status, data = admin_call("GET", "/v2/GetClusterHealth")
            last = f"status={status} body={data[:180]!r}"
            if status == 200:
                break
        except Exception as exc:
            last = f"{type(exc).__name__}: {exc}"
        time.sleep(1)
    else:
        print(f"garage_health_timeout {redact_text(last)}")
        raise SystemExit(1)
    print(f"garage_health {redact_text(last)}")
    status, data = admin_call(
        "POST", "/v2/CreateKey", {"name": "large-file", "neverExpires": True}
    )
    if status != 200:
        status, data = admin_call("POST", "/v2/CreateKey", {"name": "large-file"})
    if status != 200:
        print(f"create_key_status={status} body={redact_text(data.decode(errors='replace')[:800])}")
        raise SystemExit(1)
    created = json.loads(data)
    access = created.get("accessKeyId") or ""
    secret = created.get("secretAccessKey") or ""
    if not access or not secret:
        print(f"create_key_fields={sorted(created)}")
        raise SystemExit(1)
    write_secret(work() / "secrets" / "access_key_id", access)
    write_secret(work() / "secrets" / "secret_access_key", secret)
    print("create_key=ok")
    status, data = admin_call("POST", "/v2/CreateBucket", {"globalAlias": "large-file"})
    text = data.decode(errors="replace")
    if status != 200:
        print(f"create_bucket_status={status} body={redact_text(text[:800])}")
        lowered = text.lower()
        if "layout" in lowered or "not configured" in lowered or "no nodes" in lowered:
            raise SystemExit(42)
        raise SystemExit(1)
    bucket = json.loads(data)
    bucket_id = bucket.get("id") or ""
    if not bucket_id:
        print(f"create_bucket_fields={sorted(bucket)}")
        raise SystemExit(1)
    (work() / "bucket_id").write_text(bucket_id, encoding="utf-8")
    print(f"bucket_id={bucket_id}")
    status, data = admin_call(
        "POST",
        "/v2/AllowBucketKey",
        {
            "bucketId": bucket_id,
            "accessKeyId": access,
            "permissions": {"read": True, "write": True, "owner": True},
        },
    )
    if status != 200:
        print(
            f"allow_key_status={status} body={redact_text(data.decode(errors='replace')[:800])}"
        )
        raise SystemExit(1)
    print("allow_key=ok")


def load_session():
    lines = (work() / "session").read_text(encoding="utf-8").splitlines()
    if len(lines) < 2:
        raise SystemExit("session file is incomplete")
    return lines[0], lines[1]


def open_conn(method, path, length=None, content_type=None):
    session, csrf = load_session()
    conn = http.client.HTTPConnection(UI_HOST, UI_PORT, timeout=3600)
    conn.putrequest(method, path)
    conn.putheader("Cookie", f"garage_session={session}; garage_csrf={csrf}")
    if method not in ("GET", "HEAD"):
        conn.putheader("X-CSRF-Token", csrf)
    if content_type:
        conn.putheader("Content-Type", content_type)
    if length is not None:
        conn.putheader("Content-Length", str(length))
    conn.putheader("Connection", "close")
    conn.endheaders()
    return conn


def send_exact(conn, total, kill_after=None):
    chunk = b"\0" * CHUNK
    sent = 0
    target = kill_after if kill_after is not None else total
    while sent < target:
        step = min(CHUNK, target - sent)
        conn.send(chunk[:step])
        sent += step
    return sent


def cmd_login():
    password = (work() / "secrets" / "password").read_text(encoding="utf-8").strip()
    body = json.dumps({"username": "large-file", "password": password}).encode()
    conn = http.client.HTTPConnection(UI_HOST, UI_PORT, timeout=60)
    conn.putrequest("POST", "/api/auth/login")
    conn.putheader("Content-Type", "application/json")
    conn.putheader("Content-Length", str(len(body)))
    conn.putheader("Connection", "close")
    conn.endheaders()
    conn.send(body)
    resp = conn.getresponse()
    data = resp.read()
    cookies = {}
    for value in resp.headers.get_all("Set-Cookie") or []:
        pair = value.split(";", 1)[0]
        if "=" not in pair:
            continue
        key, val = pair.split("=", 1)
        cookies[key.strip()] = val.strip()
    if resp.status != 200 or "garage_session" not in cookies or "garage_csrf" not in cookies:
        print(f"login_status={resp.status} body={redact_text(data.decode(errors='replace')[:300])}")
        raise SystemExit(1)
    write_secret(work() / "session", cookies["garage_session"] + "\n" + cookies["garage_csrf"] + "\n")
    print("login=ok")


def bucket_id():
    return (work() / "bucket_id").read_text(encoding="utf-8").strip()


def object_path(key, query=""):
    path = f"/api/buckets/{bucket_id()}/objects/{key}"
    if query:
        path = f"{path}?{query}"
    return path


def read_response(conn):
    resp = conn.getresponse()
    data = resp.read()
    return resp.status, data


def cmd_probe():
    path = object_path("probe.bin")
    conn = open_conn("PUT", path, length=1, content_type="application/octet-stream")
    conn.send(b"x")
    status, data = read_response(conn)
    print(f"probe_put_status={status} body={redact_text(data.decode(errors='replace')[:400])}")
    if status != 201:
        raise SystemExit(1)
    conn = open_conn("GET", object_path("probe.bin", "download=1"))
    status, data = read_response(conn)
    print(f"probe_get_status={status} bytes={len(data)}")
    if status != 200 or data != b"x":
        raise SystemExit(1)


def cmd_memory():
    path = object_path("memory.bin")
    conn = open_conn("PUT", path, length=ONE_GB, content_type="application/octet-stream")
    (work() / "body.started").write_text("memory\n", encoding="utf-8")
    sent = send_exact(conn, ONE_GB)
    status, data = read_response(conn)
    text = data.decode(errors="replace")
    size = None
    try:
        size = json.loads(data).get("size")
    except json.JSONDecodeError:
        size = None
    print(f"memory_put_status={status} sent={sent} response_size={size} body={redact_text(text[:400])}")
    try_download(object_path("memory.bin", "download=1"), "memory_download")
    outcome = {"status": status, "sent": sent, "response_size": size}
    (work() / "outcome.json").write_text(json.dumps(outcome), encoding="utf-8")
    if status != 201 or sent != ONE_GB or size != ONE_GB:
        raise SystemExit(1)


def cmd_disconnect():
    path = object_path("disconnect.bin")
    conn = open_conn("PUT", path, length=TWO_GB, content_type="application/octet-stream")
    (work() / "body.started").write_text("disconnect\n", encoding="utf-8")
    sent = send_exact(conn, TWO_GB, kill_after=KILL_AT)
    marker = work() / "disconnect.sent"
    with marker.open("w", encoding="utf-8") as handle:
        handle.write(str(sent))
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(marker, 0o600)
    print(f"disconnect_sent={sent}", flush=True)
    # qemu user-mode emulation ignores SIGKILL from inside the process.
    # The host kills this container after the byte count is on disk.
    time.sleep(300)


def cmd_multipart():
    conn = open_conn("GET", f"/api/buckets/{bucket_id()}/multipart")
    status, data = read_response(conn)
    text = data.decode(errors="replace")
    print(f"multipart_status={status} body={redact_text(text[:4000])}")
    (work() / "multipart.body").write_text(text, encoding="utf-8")
    if status != 200:
        raise SystemExit(1)


def fetch_thumb(index):
    key = f"t{index:03d}.jpg"
    conn = open_conn("GET", object_path(f"{key}/thumbnail"))
    resp = conn.getresponse()
    ctype = resp.headers.get("Content-Type", "")
    chunks = []
    total = 0
    while True:
        block = resp.read(CHUNK)
        if not block:
            break
        total += len(block)
        if total <= 400:
            chunks.append(block)
    return resp.status, ctype, total, b"".join(chunks)


def cmd_thumbs():
    source = (work() / "thumb.jpg").read_bytes()
    if len(source) >= 20 * 1024 * 1024:
        raise SystemExit(f"thumbnail source is {len(source)} bytes")
    for index in range(100):
        key = f"t{index:03d}.jpg"
        conn = open_conn("PUT", object_path(key), length=len(source), content_type="image/jpeg")
        conn.send(source)
        status, data = read_response(conn)
        if status != 201:
            print(f"thumb_put_status={status} key={key} body={redact_text(data.decode(errors='replace')[:300])}")
            raise SystemExit(1)
    print("thumb_puts=100")
    try_download(object_path("t000.jpg", "download=1"), "jpeg_download")
    first_status, first_type, first_total, first_body = fetch_thumb(0)
    shown = ""
    if first_status != 200:
        shown = " body=" + redact_text(first_body[:300].decode(errors="replace"))
    print(f"thumb_one status={first_status} type={first_type} bytes={first_total}{shown}")

    def fetch(index):
        status, ctype, total, _body = fetch_thumb(index)
        return status, ctype, total

    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = [ (first_status, first_type, first_total) ]
        rows.extend(pool.map(fetch, range(1, 100)))
    counts = {}
    images = 0
    for status, ctype, _total in rows:
        counts[status] = counts.get(status, 0) + 1
        if status == 200 and ctype.startswith("image/"):
            images += 1
    print(f"thumb_statuses={json.dumps(counts)} image_responses={images} source_bytes={len(source)}")
    outcome = {"statuses": counts, "image_responses": images, "source_bytes": len(source)}
    (work() / "outcome.json").write_text(json.dumps(outcome), encoding="utf-8")
    if images != 100:
        raise SystemExit(1)


def cmd_transfer():
    path = object_path("five.bin")
    conn = open_conn("PUT", path, length=FIVE_GB, content_type="application/octet-stream")
    (work() / "body.started").write_text("transfer\n", encoding="utf-8")
    sent = send_exact(conn, FIVE_GB)
    status, data = read_response(conn)
    text = data.decode(errors="replace")
    size = None
    try:
        size = json.loads(data).get("size")
    except json.JSONDecodeError:
        size = None
    print(f"transfer_put_status={status} sent={sent} response_size={size} body={redact_text(text[:400])}")
    status_line, got = download_counted(object_path("five.bin", "download=1"))
    print(f"transfer_get_status={status_line} download_bytes={got}")
    download_status = 0
    parts = status_line.split()
    if len(parts) >= 2 and parts[1].isdigit():
        download_status = int(parts[1])
    outcome = {
        "upload_status": status,
        "upload_sent": sent,
        "upload_size": size,
        "download_status": download_status,
        "download_bytes": got,
    }
    (work() / "outcome.json").write_text(json.dumps(outcome), encoding="utf-8")
    if status != 201 or sent != FIVE_GB or size != FIVE_GB or download_status != 200 or got != FIVE_GB:
        raise SystemExit(1)


def try_download(path, label):
    try:
        status, got = download_counted(path)
        print(f"{label} status={status} bytes={got}")
    except SystemExit as exc:
        print(f"{label} failed {exc}")
    except Exception as exc:
        print(f"{label} error {type(exc).__name__}: {exc}")


def download_counted(path):
    session, csrf = load_session()
    sock = socket.create_connection((UI_HOST, UI_PORT), timeout=3600)
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {UI_HOST}:{UI_PORT}\r\n"
        f"Cookie: garage_session={session}; garage_csrf={csrf}\r\n"
        "Connection: close\r\n"
        "\r\n"
    ).encode()
    sock.sendall(request)
    data = b""
    while b"\r\n\r\n" not in data:
        block = sock.recv(4096)
        if not block:
            raise SystemExit(f"download_headers_closed got={data[:180]!r}")
        data += block
        if len(data) > 65536:
            raise SystemExit("download_headers_too_long")
    head, rest = data.split(b"\r\n\r\n", 1)
    lines = head.split(b"\r\n")
    status_line = lines[0].decode(errors="replace")
    headers = {}
    for line in lines[1:]:
        if b":" not in line:
            continue
        key, value = line.split(b":", 1)
        headers[key.decode(errors="replace").lower()] = value.strip().decode(errors="replace")
    if "content-length" in headers:
        need = int(headers["content-length"])
        got = len(rest)
        while got < need:
            block = sock.recv(min(CHUNK, need - got))
            if not block:
                break
            got += len(block)
        sock.close()
        return status_line, got
    got = len(rest)
    while True:
        block = sock.recv(CHUNK)
        if not block:
            break
        got += len(block)
    sock.close()
    return status_line, got


def cmd_wait_ready():
    deadline = time.time() + 90
    last = "none"
    while time.time() < deadline:
        try:
            conn = http.client.HTTPConnection(UI_HOST, UI_PORT, timeout=5)
            conn.putrequest("GET", "/readyz")
            conn.putheader("Connection", "close")
            conn.endheaders()
            resp = conn.getresponse()
            data = resp.read()
            last = f"status={resp.status} body={data.decode(errors='replace')[:200]}"
            if resp.status == 200:
                print(f"ready {last}")
                return
        except Exception as exc:
            last = f"{type(exc).__name__}: {exc}"
        time.sleep(1)
    print(f"ready_timeout {last}")
    raise SystemExit(1)


def main():
    import sys

    args = sys.argv[1:]
    if not args:
        raise SystemExit("missing command")
    name = args[0]
    if name == "redact":
        cmd_redact()
    elif name == "init-secrets":
        cmd_init_secrets()
    elif name == "mem-sample":
        cmd_mem_sample(args[1])
    elif name == "mem-watch":
        cmd_mem_watch(args[1], args[2], args[3])
    elif name == "assert-ports":
        cmd_assert_ports(args[1])
    elif name == "admin":
        cmd_admin()
    elif name == "wait-ready":
        cmd_wait_ready()
    elif name == "login":
        cmd_login()
    elif name == "probe":
        cmd_probe()
    elif name == "memory":
        cmd_memory()
    elif name == "disconnect":
        cmd_disconnect()
    elif name == "multipart":
        cmd_multipart()
    elif name == "thumbs":
        cmd_thumbs()
    elif name == "transfer":
        cmd_transfer()
    else:
        raise SystemExit(f"unknown command {name}")


if __name__ == "__main__":
    main()
PY

python3 -m py_compile "${WORK}/gate.py"
log "gate_py=compiled"

cat >"${WORK}/curl-client.sh" <<'SH'
#!/bin/sh
set -eu
BASE=http://127.0.0.1:3909

bucket() {
  cat /work/bucket_id
}

csrf() {
  awk -F '\t' '$6=="garage_csrf" { print $7; exit }' /work/cookies
}

put_file() {
  key=$1
  type=$2
  file=$3
  curl -sS -D /work/headers -o /work/body \
    -X PUT \
    -H "Content-Type: ${type}" \
    -H "X-CSRF-Token: $(csrf)" \
    -b /work/cookies \
    --upload-file "$file" \
    "${BASE}/api/buckets/$(bucket)/objects/${key}"
  head -n 1 /work/headers
  cat /work/body
  echo
}

put_zeros() {
  key=$1
  count=$2
  declared=$3
  type=$4
  dd if=/dev/zero bs=1048576 count="$count" status=none | curl -sS -D /work/headers -o /work/body \
    -X PUT \
    -H "Content-Length: ${declared}" \
    -H "Transfer-Encoding:" \
    -H "Expect:" \
    -H "Content-Type: ${type}" \
    -H "X-CSRF-Token: $(csrf)" \
    -b /work/cookies \
    --upload-file - \
    "${BASE}/api/buckets/$(bucket)/objects/${key}"
  head -n 1 /work/headers
  cat /work/body
  echo
}

case "${1:-}" in
wait-ready)
  i=0
  while [ "$i" -lt 90 ]; do
    if curl -sf "${BASE}/readyz"; then
      echo
      exit 0
    fi
    i=$((i + 1))
    sleep 1
  done
  echo "ready_timeout"
  exit 1
  ;;
login)
  printf '{"username":"large-file","password":"%s"}' "$(cat /work/secrets/password)" > /work/login.json
  code=$(curl -sS -o /work/login.body -D /work/login.headers -c /work/cookies -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    --data-binary @/work/login.json \
    "${BASE}/api/auth/login")
  rm -f /work/login.json
  echo "login_status=${code}"
  test "$code" = 200
  ;;
probe)
  printf x > /work/probe.bin
  put_file probe.bin application/octet-stream /work/probe.bin
  got=$(curl -sS -b /work/cookies -o /work/probe.get -w '%{http_code} %{size_download}' \
    "${BASE}/api/buckets/$(bucket)/objects/probe.bin?download=1")
  echo "probe_get ${got}"
  cmp -s /work/probe.bin /work/probe.get
  ;;
memory)
  put_zeros memory.bin 1024 1073741824 application/octet-stream
  head -n 1 /work/headers | grep -q ' 201 '
  ;;
disconnect)
  n=0
  while true; do
    dd if=/dev/zero bs=1048576 count=1 status=none
    n=$((n + 1))
    echo "$n" > /work/chunks
  done | curl -sS -o /dev/null \
    -X PUT \
    -H "Content-Length: 2147483648" \
    -H "Transfer-Encoding:" \
    -H "Expect:" \
    -H "Content-Type: application/octet-stream" \
    -H "X-CSRF-Token: $(csrf)" \
    -b /work/cookies \
    --upload-file - \
    "${BASE}/api/buckets/$(bucket)/objects/disconnect.bin" || true
  ;;
multipart)
  curl -sS -b /work/cookies -o /work/multipart.body -w 'multipart_status=%{http_code}\n' \
    "${BASE}/api/buckets/$(bucket)/multipart"
  cat /work/multipart.body
  echo
  ;;
seed-thumbs)
  i=0
  while [ "$i" -lt 100 ]; do
    key=$(printf 'thumbnails/t%03d.jpg' "$i")
    put_file "$key" image/jpeg /work/thumb.jpg >/dev/null
    head -n 1 /work/headers | grep -q ' 201 '
    i=$((i + 1))
  done
  echo "thumb_puts=100"
  ;;
transfer)
  put_zeros five.bin 5120 5368709120 application/octet-stream
  head -n 1 /work/headers | grep -q ' 201 '
  python_size=$(sed -n 's/.*"size":\([0-9]*\).*/\1/p' /work/body | head -n 1)
  echo "transfer_upload_bytes=${python_size}"
  test "$python_size" = 5368709120
  line=$(curl -sS -b /work/cookies -o /dev/null -w '%{http_code} %{size_download}' \
    "${BASE}/api/buckets/$(bucket)/objects/five.bin?download=1")
  echo "transfer_download ${line}"
  set -- $line
  test "$1" = 200
  test "$2" = 5368709120
  printf '%s\n' "{\"upload_status\":201,\"upload_size\":${python_size},\"download_status\":200,\"download_bytes\":$2}" > /work/outcome.json
  ;;
*)
  echo "unknown $1" >&2
  exit 1
  ;;
esac
SH
chmod +x "${WORK}/curl-client.sh"

GATE_WORK="$WORK" python3 "${WORK}/gate.py" init-secrets
log "secrets_generated"

docker network create "$NET" >/dev/null
docker volume create "$VOL_GARAGE" >/dev/null
docker volume create "$VOL_UI" >/dev/null
docker volume create "$VOL_CONFIG" >/dev/null

docker run --rm --pull never \
  -v "${VOL_CONFIG}:/config" \
  -v "${WORK}:/work:ro" \
  "$ALPINE_IMAGE" \
  sh -c 'cp /work/garage.toml /config/garage.toml && chmod 600 /config/garage.toml'

docker run -d --name "$GARAGE" --pull never \
  --network "$NET" --network-alias p3-large-file-garage \
  -e GARAGE_CONFIG_FILE=/config/garage.toml \
  -v "${VOL_CONFIG}:/config:ro" \
  -v "${VOL_GARAGE}:/var/lib/garage" \
  "$GARAGE_IMAGE" /garage server --single-node >/dev/null
log "garage_started"

admin_code=0
docker run --rm --pull never \
  --network "$NET" \
  -e GATE_WORK=/work \
  -v "${WORK}:/work" \
  "$PY_IMAGE" \
  python -u /work/gate.py admin >"${WORK}/client.out" || admin_code=$?
GATE_WORK="$WORK" python3 "${WORK}/gate.py" redact <"${WORK}/client.out" | tee -a "$LOG"
rm -f "${WORK}/client.out"
if [[ "$admin_code" == 42 ]]; then
  node_line="$(docker exec "$GARAGE" /garage node id -q | head -n 1)"
  node_id="${node_line%%@*}"
  log "layout_assign node_prefix_len=${#node_id}"
  docker exec "$GARAGE" /garage layout assign -z dc1 -c 100GB "$node_id"
  docker exec "$GARAGE" /garage layout apply --version 1
  admin_code=0
  docker run --rm --pull never \
    --network "$NET" \
    -e GATE_WORK=/work \
    -v "${WORK}:/work" \
    "$PY_IMAGE" \
    python -u /work/gate.py admin >"${WORK}/client.out" || admin_code=$?
  GATE_WORK="$WORK" python3 "${WORK}/gate.py" redact <"${WORK}/client.out" | tee -a "$LOG"
  rm -f "${WORK}/client.out"
fi
if [[ "$admin_code" != 0 ]]; then
  log "admin_setup_failed code=${admin_code}"
  exit 1
fi

docker run --rm --pull never \
  -v "${VOL_UI}:/data" \
  -v "${WORK}/secrets:/hostsecrets:ro" \
  "$ALPINE_IMAGE" \
  sh -c 'cp /hostsecrets/admin_token /data/admin_token && cp /hostsecrets/access_key_id /data/access_key_id && cp /hostsecrets/secret_access_key /data/secret_access_key && chown 65532:65532 /data /data/admin_token /data/access_key_id /data/secret_access_key && chmod 700 /data && chmod 600 /data/admin_token /data/access_key_id /data/secret_access_key'

python3 - <<PY
import os
import pathlib
work = pathlib.Path("${WORK}")
hash_value = (work / "secrets" / "password_hash").read_text(encoding="utf-8").strip()
lines = [
    "HOST=0.0.0.0",
    "DATA_DIR=/data",
    "COOKIE_SECURE=false",
    "MAX_UPLOAD_SIZE_MB=6144",
    "GARAGE_ADMIN_URL=http://p3-large-file-garage:3903",
    "API_ADMIN_KEY_FILE=/data/admin_token",
    "S3_ENDPOINT_URL=http://p3-large-file-garage:3900",
    "S3_REGION=garage",
    "S3_ACCESS_KEY_ID_FILE=/data/access_key_id",
    "S3_SECRET_ACCESS_KEY_FILE=/data/secret_access_key",
    "GARAGE_UI_BOOTSTRAP_USERNAME=large-file",
    "GARAGE_UI_BOOTSTRAP_PASSWORD_HASH=" + hash_value,
    "GARAGE_IDLE_TIMEOUT_SECS=3600",
]
(work / "env.ui").write_text("\n".join(lines) + "\n", encoding="utf-8")
os.chmod(work / "env.ui", 0o600)
PY

hash_ok=0
docker run --rm --pull never \
  --env-file "${WORK}/env.ui" \
  -v "${WORK}:/work:ro" \
  "$PY_IMAGE" \
  python -c 'import os, pathlib; got=os.environ["GARAGE_UI_BOOTSTRAP_PASSWORD_HASH"]; want=pathlib.Path("/work/secrets/password_hash").read_text().strip(); raise SystemExit(0 if got==want else 1)' \
  && hash_ok=1 || hash_ok=0
if [[ "$hash_ok" != 1 ]]; then
  GATE_FIX_WORK="$WORK" python3 - <<'PY'
import os
import pathlib
work = pathlib.Path(os.environ["GATE_FIX_WORK"])
text = (work / "env.ui").read_text(encoding="utf-8")
lines = []
for line in text.splitlines():
    if line.startswith("GARAGE_UI_BOOTSTRAP_PASSWORD_HASH="):
        value = line.split("=", 1)[1].replace("$", "$$")
        line = "GARAGE_UI_BOOTSTRAP_PASSWORD_HASH=" + value
    lines.append(line)
(work / "env.ui").write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
  docker run --rm --pull never \
    --env-file "${WORK}/env.ui" \
    -v "${WORK}:/work:ro" \
    "$PY_IMAGE" \
    python -c 'import os, pathlib; got=os.environ["GARAGE_UI_BOOTSTRAP_PASSWORD_HASH"]; want=pathlib.Path("/work/secrets/password_hash").read_text().strip(); raise SystemExit(0 if got==want else 1)'
  log "bootstrap_hash_env=doubled_dollars"
else
  log "bootstrap_hash_env=literal"
fi

docker run -d --name "$UI" --pull never \
  --network "$NET" \
  -p 127.0.0.1::3909 \
  --memory=256m \
  --memory-swap=256m \
  --read-only \
  --tmpfs /tmp \
  -v "${VOL_UI}:/data" \
  --env-file "${WORK}/env.ui" \
  "$UI_IMAGE" >/dev/null
log "ui_started"
docker inspect -f 'ui memory={{.HostConfig.Memory}} swap={{.HostConfig.MemorySwap}} readonly={{.HostConfig.ReadonlyRootfs}} tmpfs={{json .HostConfig.Tmpfs}}' "$UI" | tee -a "$LOG"
GATE_UI_CONTAINER="$UI" GATE_WORK="$WORK" python3 "${WORK}/gate.py" assert-ports "$UI" | tee -a "$LOG"
GATE_UI_CONTAINER="$UI" GATE_WORK="$WORK" python3 "${WORK}/gate.py" assert-ports "$GARAGE" | tee -a "$LOG"

run_client wait-ready
log "listen=ready"
GATE_WORK="$WORK" python3 "${WORK}/gate.py" mem-sample "$UI" | tee -a "$LOG"
run_client login
run_client probe
log "probe=ok"
rm -f "${WORK}/outcome.json"

baseline="$(GATE_WORK="$WORK" python3 "${WORK}/gate.py" mem-sample "$UI" | tee -a "$LOG" | awk -F= '/mem_bytes=/{print $2; exit}' | awk '{print $1}')"
rm -f "${WORK}/sample.stop" "${WORK}/samples.txt" "${WORK}/body.started"
GATE_WORK="$WORK" python3 "${WORK}/gate.py" mem-watch "$UI" "${WORK}/samples.txt" "${WORK}/sample.stop" &
watch_pid=$!
mem_code=0
run_client memory || mem_code=$?
stop_watch
python3 - <<PY | tee -a "$LOG"
import pathlib
samples = []
for line in pathlib.Path("${WORK}/samples.txt").read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if line.isdigit():
        samples.append(int(line))
baseline = int("${baseline}")
peak = max(samples) if samples else baseline
growth = peak - baseline
passed = ${mem_code} == 0 and growth <= 67108864 and len(samples) > 0
print(
    "check memory upload_bytes=1073741824 "
    f"baseline_bytes={baseline} peak_bytes={peak} growth_bytes={growth} "
    f"limit_bytes=67108864 sample_count={len(samples)} "
    f"sample_min={min(samples) if samples else 0} pass={'true' if passed else 'false'}"
)
pathlib.Path("${WORK}/check.memory").write_text("0\n" if passed else "1\n", encoding="utf-8")
PY
mem_pass="$(tr -d '\n' <"${WORK}/check.memory")"

disc_code=0
rm -f "${WORK}/disconnect.sent" "${WORK}/client.out"
rm -f "${WORK}/chunks"
docker run --name "$CLIENT" --rm --pull never \
  --network "container:${UI}" \
  --entrypoint /bin/sh \
  -v "${WORK}:/work" \
  "$CURL_IMAGE" \
  /work/curl-client.sh disconnect >"${WORK}/client.out" &
client_pid=$!
for _ in $(seq 1 300); do
  if [[ -s "${WORK}/chunks" ]] && [[ "$(tr -d '\n' <"${WORK}/chunks")" -ge 256 ]]; then
    printf '268435456\n' >"${WORK}/disconnect.sent"
    break
  fi
  if ! kill -0 "$client_pid" 2>/dev/null; then
    break
  fi
  sleep 0.2
done
docker kill --signal=KILL "$CLIENT" >/dev/null 2>&1 || true
set +e
wait "$client_pid"
disc_code=$?
set -e
GATE_WORK="$WORK" python3 "${WORK}/gate.py" redact <"${WORK}/client.out" | tee -a "$LOG" || true
rm -f "${WORK}/client.out"
sent="missing"
if [[ -f "${WORK}/disconnect.sent" ]]; then
  sent="$(tr -d '\n' <"${WORK}/disconnect.sent")"
fi
log "disconnect_client_exit=${disc_code} sent_file=${sent}"
final_body=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  run_client multipart || true
  final_body="$(tr -d '\n' <"${WORK}/multipart.body" 2>/dev/null || true)"
  if [[ "$final_body" == *'"uploads":[]'* || "$final_body" == *'"uploads": []'* ]]; then
    sleep 2
    run_client multipart || true
    final_body="$(tr -d '\n' <"${WORK}/multipart.body")"
    break
  fi
  sleep 2
done
python3 - <<PY | tee -a "$LOG"
import json
body = open("${WORK}/multipart.body", encoding="utf-8").read()
sent = "${sent}"
exit_code = int("${disc_code}")
try:
    uploads = json.loads(body).get("uploads")
except json.JSONDecodeError:
    uploads = None
passed = exit_code == 137 and sent == "268435456" and uploads == []
print(
    "check disconnect declared_bytes=2147483648 "
    f"sent_bytes={sent} client_exit={exit_code} "
    f"multipart={body.strip()} pass={'true' if passed else 'false'}"
)
open("${WORK}/check.disconnect", "w", encoding="utf-8").write("0\n" if passed else "1\n")
PY
disc_pass="$(tr -d '\n' <"${WORK}/check.disconnect")"

oom_before="$(docker inspect -f '{{.State.OOMKilled}} {{.State.Status}}' "$UI")"
log "before_thumbs ${oom_before}"
rm -f "${WORK}/outcome.json"
if [[ ! -f "${WORK}/thumb.jpg" ]]; then
  "$MAGICK" -size 4096x4096 xc:white -strip -quality 80 "${WORK}/thumb.jpg"
fi
read -r thumb_w thumb_h < <("$MAGICK" identify -format '%w %h\n' "${WORK}/thumb.jpg")
thumb_bytes="$(python3 -c 'import os; print(os.path.getsize("'"${WORK}/thumb.jpg"'"))')"
log "thumbnail_source width=${thumb_w} height=${thumb_h} bytes=${thumb_bytes}"
thumb_code=0
if [[ "$thumb_w" == 4096 && "$thumb_h" == 4096 && "$thumb_bytes" -lt 20971520 ]]; then
  rm -f "${WORK}/sample.stop"
  GATE_WORK="$WORK" python3 "${WORK}/gate.py" mem-watch "$UI" "${WORK}/browser.samples" "${WORK}/sample.stop" &
  watch_pid=$!
  run_client seed-thumbs || thumb_code=$?
  if [[ "$thumb_code" == 0 ]]; then
    browser_port="$(docker inspect -f '{{(index (index .NetworkSettings.Ports "3909/tcp") 0).HostPort}}' "$UI")"
    "$BUN" "${root}/scripts/large-file-browser.ts" "http://127.0.0.1:${browser_port}" "$WORK" >"${WORK}/client.out" 2>&1 || thumb_code=$?
    GATE_WORK="$WORK" python3 "${WORK}/gate.py" redact <"${WORK}/client.out" | tee -a "$LOG"
    rm -f "${WORK}/client.out"
  fi
  stop_watch
else
  thumb_code=1
  log "thumbnail_source_rejected"
fi
oom_after="$(docker inspect -f '{{.State.OOMKilled}}' "$UI")"
ui_status="$(docker inspect -f '{{.State.Status}}' "$UI")"
python3 - <<PY | tee -a "$LOG"
import json
import pathlib
try:
    outcome = json.loads(pathlib.Path("${WORK}/browser.json").read_text())
except FileNotFoundError:
    outcome = {}
lines = pathlib.Path("${WORK}/browser.samples").read_text().splitlines() if pathlib.Path("${WORK}/browser.samples").exists() else []
samples = [int(line) for line in lines if line.isdigit()]
peak = max(samples, default=0)
images = outcome.get("decoded_images", 0)
responses = outcome.get("image_responses", 0)
oom = "${oom_after}".strip().lower() == "true"
passed = (${thumb_code} == 0 and outcome.get("passed") is True
          and pathlib.Path("${WORK}/browser.png").is_file()
          and images == 100 and responses == 100 and samples
          and len(samples) == len(lines) and peak < 268435456
          and not oom and "${ui_status}" == "running")
print(
    "check thumbnails sources=100 width=${thumb_w} height=${thumb_h} "
    f"source_bytes=${thumb_bytes} image_responses={responses} decoded_images={images} "
    f"peak_bytes={peak} sample_count={len(samples)} "
    f"oom_killed={'true' if oom else 'false'} container_status=${ui_status} "
    f"pass={'true' if passed else 'false'}"
)
open("${WORK}/check.thumbnails", "w", encoding="utf-8").write("0\n" if passed else "1\n")
PY
thumb_pass="$(tr -d '\n' <"${WORK}/check.thumbnails")"

transfer_code=0
transfer_pass=1
if [[ "$ui_status" == "running" && "$oom_after" == "false" ]]; then
  rm -f "${WORK}/outcome.json"
  run_client transfer || transfer_code=$?
  python3 - <<PY | tee -a "$LOG"
import json
try:
    outcome = json.loads(open("${WORK}/outcome.json", encoding="utf-8").read())
except FileNotFoundError:
    outcome = {}
upload = outcome.get("upload_size")
download = outcome.get("download_bytes")
passed = ${transfer_code} == 0 and upload == 5368709120 and download == 5368709120
print(
    "check transfer upload_bytes="
    f"{upload} download_bytes={download} "
    f"upload_status={outcome.get('upload_status')} download_status={outcome.get('download_status')} "
    f"pass={'true' if passed else 'false'}"
)
open("${WORK}/check.transfer", "w", encoding="utf-8").write("0\n" if passed else "1\n")
PY
  transfer_pass="$(tr -d '\n' <"${WORK}/check.transfer")"
else
  log "check transfer skipped container_status=${ui_status} oom_killed=${oom_after} pass=false"
fi

final_state="$(docker inspect -f '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.State.OOMKilled}} {{.State.Status}}' "$UI")"
log "final_container ${final_state}"
if [[ "$final_state" != "268435456 268435456 false running" ]]; then
  transfer_pass=1
fi
log "results memory=${mem_pass} disconnect=${disc_pass} thumbnails=${thumb_pass} transfer=${transfer_pass}"
if [[ "$mem_pass" == 0 && "$disc_pass" == 0 && "$thumb_pass" == 0 && "$transfer_pass" == 0 ]]; then
  ok=1
  log "gate=pass"
  exit 0
fi
log "gate=fail"
exit 1
