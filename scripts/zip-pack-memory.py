#!/usr/bin/env python3
"""Measure garage-ui RSS while it packs 1000 objects from the running Garage into a ZIP.

Rerun from anywhere:

    python3 scripts/zip-pack-memory.py

The script uses container garage-wave1-v241 and the target/debug/garage-ui symlink.
It exits 2 when 127.0.0.1:3909 is already open, and it does not stop that process.
The Garage admin token is read from the container config and is not printed.
"""

from __future__ import annotations

import http.client
import json
import os
import pathlib
import shutil
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed

CONTAINER = "garage-wave1-v241"
ADMIN_URL = "http://127.0.0.1:3953"
S3_URL = "http://127.0.0.1:3950"
UI_HOST = "127.0.0.1"
UI_PORT = 3909
OBJECT_COUNT = 1000
OBJECT_BYTES = 96 * 1024
GROWTH_LIMIT = 64 * 1024 * 1024
UPLOAD_WORKERS = 8


def repo_root() -> pathlib.Path:
    return pathlib.Path(__file__).resolve().parents[1]


def emit(text: str, secrets: list[str]) -> None:
    redacted = text
    for secret in secrets:
        if len(secret) >= 8:
            redacted = redacted.replace(secret, "[redacted]")
    print(redacted, flush=True)


def fail(message: str, secrets: list[str], code: int = 1) -> None:
    emit(message, secrets)
    raise SystemExit(code)


def port_is_open(port: int) -> bool:
    sock = socket.socket()
    sock.settimeout(0.5)
    try:
        return sock.connect_ex((UI_HOST, port)) == 0
    finally:
        sock.close()


def config_path(container: str) -> str:
    raw = subprocess.check_output(
        [
            "docker",
            "inspect",
            container,
            "--format",
            "{{range .Config.Env}}{{println .}}{{end}}",
        ],
        text=True,
        stderr=subprocess.DEVNULL,
    )
    for line in raw.splitlines():
        if line.startswith("GARAGE_CONFIG_FILE="):
            path = line.split("=", 1)[1].strip()
            if not path.startswith("/"):
                raise RuntimeError(f"{container} GARAGE_CONFIG_FILE is not absolute")
            return path
    raise RuntimeError(f"{container} has no GARAGE_CONFIG_FILE")


def token_from(text: str) -> str:
    line = next(
        (row.strip() for row in text.splitlines() if row.strip().startswith("admin_token")),
        "",
    )
    if not line:
        raise RuntimeError("garage config has no admin_token field")
    equals = line.find("=")
    if equals < 0:
        raise RuntimeError("garage admin_token field has no value")
    value = line[equals + 1 :].strip()
    if (value.startswith('"') and value.endswith('"')) or (
        value.startswith("'") and value.endswith("'")
    ):
        value = value[1:-1]
    if len(value) < 16:
        raise RuntimeError("garage admin_token field is too short")
    return value


def read_admin_token(container: str) -> str:
    path = config_path(container)
    temp = tempfile.mkdtemp(prefix="zip-pack-memory-")
    dest = pathlib.Path(temp) / "garage.toml"
    try:
        subprocess.run(
            ["docker", "cp", f"{container}:{path}", str(dest)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return token_from(dest.read_text(encoding="utf-8"))
    finally:
        shutil.rmtree(temp, ignore_errors=True)


def rss_bytes(pid: int) -> int:
    raw = subprocess.check_output(
        ["/bin/ps", "-o", "rss=", "-p", str(pid)],
        text=True,
        stderr=subprocess.DEVNULL,
    ).strip()
    if raw == "":
        raise RuntimeError(f"garage-ui pid {pid} has no rss")
    return int(raw.split()[0]) * 1024


def sample_for(pid: int, seconds: float) -> list[int]:
    found: list[int] = []
    deadline = time.monotonic() + seconds
    while True:
        found.append(rss_bytes(pid))
        if time.monotonic() >= deadline:
            return found
        time.sleep(0.1)


def watch_rss(pid: int, samples: list[int], stop: threading.Event) -> None:
    while not stop.is_set():
        try:
            samples.append(rss_bytes(pid))
        except RuntimeError:
            return
        if stop.wait(0.1):
            return


def error_code(data: bytes) -> str:
    try:
        body = json.loads(data)
    except json.JSONDecodeError:
        return "unparsed"
    code = body.get("code") if isinstance(body, dict) else None
    return code if isinstance(code, str) and code else "unknown"


def cookie_pair(headers: http.client.HTTPMessage, name: str) -> str:
    for value in headers.get_all("Set-Cookie") or []:
        pair = value.split(";", 1)[0]
        prefix = f"{name}="
        if pair.startswith(prefix):
            return urllib.parse.unquote(pair[len(prefix) :])
    raise RuntimeError(f"response missing {name} cookie")


class Api:
    def __init__(self) -> None:
        self.session = ""
        self.csrf = ""

    def call(
        self,
        method: str,
        path: str,
        body: bytes | None = None,
        content_type: str | None = None,
        timeout: float = 60,
    ) -> tuple[int, bytes]:
        conn = http.client.HTTPConnection(UI_HOST, UI_PORT, timeout=timeout)
        try:
            conn.putrequest(method, path)
            if self.session:
                conn.putheader(
                    "Cookie",
                    f"garage_session={self.session}; garage_csrf={self.csrf}",
                )
            if method not in ("GET", "HEAD") and self.csrf and path != "/api/setup":
                conn.putheader("x-csrf-token", self.csrf)
            if content_type:
                conn.putheader("Content-Type", content_type)
            if body is not None:
                conn.putheader("Content-Length", str(len(body)))
            conn.putheader("Connection", "close")
            conn.endheaders()
            if body is not None:
                conn.send(body)
            response = conn.getresponse()
            if path == "/api/setup":
                self.session = cookie_pair(response.headers, "garage_session")
                self.csrf = cookie_pair(response.headers, "garage_csrf")
            data = response.read()
            return response.status, data
        finally:
            conn.close()

    def download(self, path: str, dest: pathlib.Path) -> tuple[int, int]:
        conn = http.client.HTTPConnection(UI_HOST, UI_PORT, timeout=300)
        total = 0
        try:
            conn.putrequest("GET", path)
            conn.putheader(
                "Cookie",
                f"garage_session={self.session}; garage_csrf={self.csrf}",
            )
            conn.putheader("Connection", "close")
            conn.endheaders()
            response = conn.getresponse()
            with dest.open("wb") as handle:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
                    total += len(chunk)
            return response.status, total
        finally:
            conn.close()


def object_path(bucket_id: str, key: str, query: str = "") -> str:
    segments = "/".join(urllib.parse.quote(part, safe="") for part in key.split("/"))
    path = f"/api/buckets/{urllib.parse.quote(bucket_id, safe='')}/objects/{segments}"
    if query:
        return f"{path}?{query}"
    return path


def json_call(api: Api, method: str, path: str, payload: dict[str, object], timeout: float = 60):
    body = json.dumps(payload).encode()
    return api.call(method, path, body, "application/json", timeout)


def require_status(status: int, data: bytes, expected: set[int], label: str, secrets: list[str]) -> dict:
    if status not in expected:
        fail(f"{label} status={status} code={error_code(data)}", secrets)
    try:
        parsed = json.loads(data)
    except json.JSONDecodeError:
        fail(f"{label} status={status} body is not json", secrets)
    if not isinstance(parsed, dict):
        fail(f"{label} status={status} body is not an object", secrets)
    return parsed


def stop_server(proc: subprocess.Popen[bytes], launched: pathlib.Path) -> None:
    if proc.poll() is not None:
        return
    comm = subprocess.check_output(
        ["/bin/ps", "-o", "comm=", "-p", str(proc.pid)],
        text=True,
        stderr=subprocess.DEVNULL,
    ).strip()
    allowed = {str(launched), str(launched.resolve())}
    if comm not in allowed:
        print(f"refusing to stop pid {proc.pid} comm={comm}", flush=True)
        return
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=10)


def log_tail(path: pathlib.Path, secrets: list[str]) -> None:
    if not path.exists():
        return
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()[-40:]
    emit("garage-ui log:", secrets)
    for line in lines:
        emit(line, secrets)


def upload_one(api: Api, bucket_id: str, key: str, payload: bytes) -> tuple[str, int, str]:
    status, data = api.call(
        "PUT",
        object_path(bucket_id, key),
        payload,
        "application/octet-stream",
        60,
    )
    code = "" if status == 201 else error_code(data)
    return key, status, code


def zip_names_and_sizes(path: pathlib.Path, payload: bytes) -> int:
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        expected = [f"{index:04d}" for index in range(OBJECT_COUNT)]
        if names != expected:
            raise RuntimeError(
                f"zip entries={len(names)} first={names[:3]!r} last={names[-3:]!r}"
            )
        for info in infos:
            data = archive.read(info)
            if data != payload:
                raise RuntimeError(f"zip entry {info.filename} size={len(data)}")
        return len(infos)


def cleanup(api: Api, bucket_id: str, key_id: str, secrets: list[str]) -> None:
    if bucket_id:
        status, data = api.call(
            "DELETE",
            object_path(bucket_id, "pack/", "recursive=true"),
            b"",
            "application/octet-stream",
            180,
        )
        emit(f"cleanup_prefix status={status} code={error_code(data) if status not in (200, 204) else 'ok'}", secrets)
        status, data = api.call("DELETE", f"/api/buckets/{urllib.parse.quote(bucket_id, safe='')}", timeout=60)
        emit(f"cleanup_bucket status={status} code={error_code(data) if status not in (200, 204) else 'ok'}", secrets)
    if key_id:
        status, data = api.call("DELETE", f"/api/keys/{urllib.parse.quote(key_id, safe='')}", timeout=60)
        emit(f"cleanup_key status={status} code={error_code(data) if status not in (200, 204) else 'ok'}", secrets)


def main() -> None:
    secrets: list[str] = []
    if port_is_open(UI_PORT):
        fail(f"port {UI_PORT} is already taken", secrets, 2)
    running = subprocess.check_output(
        ["docker", "inspect", CONTAINER, "--format", "{{.State.Running}}"],
        text=True,
        stderr=subprocess.DEVNULL,
    ).strip()
    if running != "true":
        fail(f"{CONTAINER} is not running", secrets)
    binary = repo_root() / "target" / "debug" / "garage-ui"
    if not binary.is_symlink():
        fail(f"{binary} is not the expected symlink", secrets)
    if not binary.exists():
        fail(f"{binary} target is missing", secrets)

    load = subprocess.check_output(["uptime"], text=True).strip()
    cores = subprocess.check_output(["sysctl", "-n", "hw.ncpu"], text=True).strip()
    emit(f"load={load}", secrets)
    emit(f"cores={cores}", secrets)
    emit(
        f"object_count={OBJECT_COUNT} object_bytes={OBJECT_BYTES} "
        f"payload_bytes={OBJECT_COUNT * OBJECT_BYTES} limit_bytes={GROWTH_LIMIT}",
        secrets,
    )

    token = read_admin_token(CONTAINER)
    secrets.append(token)
    password = os.urandom(18).hex()
    secrets.append(password)
    data_dir = pathlib.Path(tempfile.mkdtemp(prefix="zip-pack-memory-ui-"))
    log_path = data_dir / "garage-ui.log"
    env = os.environ.copy()
    env.pop("HOST", None)
    env["DATA_DIR"] = str(data_dir)
    env["GARAGE_ADMIN_URL"] = ADMIN_URL
    env["GARAGE_ADMIN_TOKEN"] = token
    env["S3_ENDPOINT_URL"] = S3_URL
    log_file = log_path.open("wb")
    proc = subprocess.Popen(
        [str(binary)],
        cwd=data_dir,
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )
    api = Api()
    bucket_id = ""
    key_id = ""
    passed = False
    try:
        deadline = time.monotonic() + 30
        while True:
            if proc.poll() is not None:
                log_tail(log_path, secrets)
                fail(f"garage-ui exited {proc.returncode} before healthz", secrets)
            try:
                status, _ = api.call("GET", "/healthz", timeout=2)
            except OSError:
                status = 0
            if status == 200:
                break
            if time.monotonic() >= deadline:
                log_tail(log_path, secrets)
                fail("healthz did not return 200", secrets)
            time.sleep(0.2)

        status, data = api.call(
            "POST",
            "/api/setup",
            json.dumps({"username": "zipmem", "password": password}).encode(),
            "application/json",
            60,
        )
        secrets.extend([api.session, api.csrf])
        if status != 200:
            fail(f"setup status={status} code={error_code(data)}", secrets)
        stamp = str(time.time_ns())[-8:]
        alias = f"zipmem{stamp}"
        key_name = f"zipmem{stamp}"
        created_bucket = require_status(
            *json_call(api, "POST", "/api/buckets", {"globalAlias": alias}),
            {200, 201},
            "create_bucket",
            secrets,
        )
        bucket_id = created_bucket.get("id")
        if not isinstance(bucket_id, str) or not bucket_id:
            fail(f"create_bucket fields={sorted(created_bucket)}", secrets)
        created_key = require_status(
            *json_call(api, "POST", "/api/keys", {"name": key_name}),
            {200, 201},
            "create_key",
            secrets,
        )
        secret = created_key.get("secretAccessKey")
        if isinstance(secret, str):
            secrets.append(secret)
        key_id = created_key.get("accessKeyId") or created_key.get("id")
        if not isinstance(key_id, str) or not key_id:
            fail("create_key missing accessKeyId", secrets)
        grant_status, grant_data = json_call(
            api,
            "POST",
            f"/api/buckets/{urllib.parse.quote(bucket_id, safe='')}/permissions",
            {
                "accessKeyId": key_id,
                "permissions": {"read": True, "write": True, "owner": True},
            },
        )
        if grant_status != 200:
            fail(f"grant status={grant_status} code={error_code(grant_data)}", secrets)
        cred_status, cred_data = json_call(
            api,
            "PUT",
            f"/api/buckets/{urllib.parse.quote(bucket_id, safe='')}/credential",
            {"access_key_id": key_id},
        )
        if cred_status != 200:
            fail(f"credential status={cred_status} code={error_code(cred_data)}", secrets)

        payload = b"z" * OBJECT_BYTES
        keys = [f"pack/{index:04d}" for index in range(OBJECT_COUNT)]
        failures: list[str] = []
        done = 0
        with ThreadPoolExecutor(max_workers=UPLOAD_WORKERS) as pool:
            futures = [
                pool.submit(upload_one, api, bucket_id, key, payload) for key in keys
            ]
            for future in as_completed(futures):
                key, status, code = future.result()
                done += 1
                if status != 201:
                    failures.append(f"{key} status={status} code={code}")
                if done % 100 == 0:
                    emit(f"uploaded={done} failures={len(failures)}", secrets)
        if failures:
            emit(f"upload_failures={len(failures)} first={failures[0]}", secrets)
            fail("uploads did not all return 201", secrets)
        emit(f"uploaded={OBJECT_COUNT} failures=0", secrets)

        idle = sample_for(proc.pid, 1.0)
        token_status, token_data = json_call(
            api,
            "POST",
            f"/api/buckets/{urllib.parse.quote(bucket_id, safe='')}/archive-token",
            {"keys": keys},
            60,
        )
        archive = require_status(token_status, token_data, {200}, "archive_token", secrets)
        archive_token = archive.get("token")
        if not isinstance(archive_token, str) or len(archive_token) < 16:
            fail("archive_token missing token", secrets)
        secrets.append(archive_token)
        baseline = rss_bytes(proc.pid)
        samples: list[int] = []
        stop = threading.Event()
        watcher = threading.Thread(
            target=watch_rss,
            args=(proc.pid, samples, stop),
            daemon=True,
        )
        watcher.start()
        archive_path = (
            f"/api/buckets/{urllib.parse.quote(bucket_id, safe='')}/archive"
            f"?token={urllib.parse.quote(archive_token, safe='')}"
        )
        zip_path = data_dir / "archive.zip"
        archive_status, archive_bytes = api.download(archive_path, zip_path)
        stop.set()
        watcher.join(timeout=2)
        if not samples:
            fail("rss sampler recorded no samples during the download", secrets)
        peak = max(samples)
        growth = peak - baseline
        if archive_status != 200:
            fail(
                f"archive status={archive_status} bytes={archive_bytes} growth_bytes={growth}",
                secrets,
            )
        try:
            entries = zip_names_and_sizes(zip_path, payload)
        except (RuntimeError, zipfile.BadZipFile) as exc:
            fail(f"zip check failed: {exc}", secrets)
        passed = entries == OBJECT_COUNT and growth <= GROWTH_LIMIT
        emit(f"baseline_rss_bytes={baseline}", secrets)
        emit(f"peak_rss_bytes={peak}", secrets)
        emit(f"growth_bytes={growth}", secrets)
        emit(f"zip_entries={entries}", secrets)
        emit(f"archive_bytes={archive_bytes}", secrets)
        emit(f"archive_status={archive_status}", secrets)
        emit(f"sample_count={len(samples)} sample_interval_ms=100", secrets)
        emit(
            f"idle_rss_min={min(idle)} idle_rss_median={int(statistics.median(idle))} "
            f"idle_rss_max={max(idle)}",
            secrets,
        )
        emit(f"download_rss_min={min(samples)} download_rss_max={peak}", secrets)
        emit(f"upload_failures=0", secrets)
        emit(f"pass={'true' if passed else 'false'}", secrets)
        if not passed:
            fail(
                f"peak growth {growth} bytes exceeds {GROWTH_LIMIT} or entries {entries} != {OBJECT_COUNT}",
                secrets,
            )
    except Exception as exc:
        emit(f"error={type(exc).__name__}: {exc}", secrets)
        log_tail(log_path, secrets)
        raise
    finally:
        try:
            if api.session:
                cleanup(api, bucket_id, key_id, secrets)
        except Exception as exc:
            emit(f"cleanup_error={type(exc).__name__}", secrets)
            passed = False
        log_file.close()
        stop_server(proc, binary)
        shutil.rmtree(data_dir, ignore_errors=True)
    if not passed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
