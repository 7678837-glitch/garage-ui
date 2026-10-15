#!/bin/sh
# Verify version propagation without building binaries or images.
set -eu
cd "$(dirname "$0")/.."
python3 - <<'PY'
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
import sys

with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    (root / "scripts").mkdir()
    shutil.copyfile("scripts/build.sh", root / "scripts/build.sh")
    (root / "VERSION").write_text("20261015.1\n")
    commands = root / "commands"
    commands.mkdir()
    commit = "0123456789abcdef0123456789abcdef01234567"
    (commands / "git").write_text(f"#!/bin/sh\nprintf '%s\\n' '{commit}'\n")
    probe = root / "probe.json"
    recorder = """#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
Path(os.environ['PROBE']).write_text(json.dumps({
    'version': os.environ.get('BUILD_VERSION'),
    'commit': os.environ.get('GIT_COMMIT'),
    'args': sys.argv[1:],
}))
"""
    (commands / "docker").write_text(recorder)
    for command in commands.iterdir():
        command.chmod(0o755)
    env = dict(os.environ, PATH=f"{commands}:{os.environ['PATH']}", PROBE=str(probe))
    env.pop("BUILD_VERSION", None)
    for explicit in (None, "20261015.1", "20261015.172-dev", "20261015.1-local"):
        current = dict(env)
        if explicit is not None:
            current["BUILD_VERSION"] = explicit
        result = subprocess.run(["sh", "scripts/build.sh", "--images", "amd64"], cwd=root, env=current, capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        observed = json.loads(probe.read_text())
        version = explicit or "20261015.1-local"
        assert observed["version"] == version, observed
        assert observed["commit"] == commit, observed
        assert f"BUILD_VERSION={version}" in observed["args"], observed
        assert f"GIT_COMMIT={commit}" in observed["args"], observed
        assert f"garage-ui:{version}-amd64" in observed["args"], observed
    probe.unlink()
    for invalid in ("", "20261015.0-dev", "20261015.01-dev", "20260230.1-dev", "20261015.1-dev\n", " 20261015.1", "２０２６１０１５.1-dev", "20261015.1-dev; touch injected"):
        current = dict(env, BUILD_VERSION=invalid)
        result = subprocess.run(["sh", "scripts/build.sh", "--images", "amd64"], cwd=root, env=current, capture_output=True, text=True)
        assert result.returncode != 0, f"Invalid build version accepted: {invalid!r}"
        assert not probe.exists(), f"Invalid build version reached Docker: {invalid!r}"
    assert not (root / "injected").exists(), "Build version was evaluated as shell code"
    workflow = Path(".github/workflows/ci.yml").read_text()
    identity = textwrap.dedent(workflow.split("          python3 - <<'PY_IDENTITY'\n", 1)[1].split("          PY_IDENTITY\n", 1)[0])
    run = {"id": 12345, "run_number": 172, "head_sha": commit, "created_at": "2026-10-15T23:59:59Z"}
    ci_env = dict(env, GITHUB_SHA=commit, GITHUB_EVENT_NAME="push", GITHUB_REF="refs/heads/dev",
                  GITHUB_RUN_ID="12345", GITHUB_RUN_NUMBER="172", GITHUB_RUN_ATTEMPT="1",
                  GITHUB_OUTPUT=str(root / "output"), RUNNER_TEMP=str(root))

    def assign(current, metadata):
        (root / "output").write_text("")
        (root / "workflow-run.json").write_text(json.dumps(metadata))
        return subprocess.run([sys.executable, "-c", identity], cwd=root, env=current, capture_output=True, text=True)

    for attempt in ("1", "2"):
        current = dict(ci_env, GITHUB_RUN_ATTEMPT=attempt)
        result = assign(current, run)
        assert result.returncode == 0, result.stderr
        assert (root / "output").read_text() == f"version=20261015.172-dev\ncommit={commit}\n"
        receipt = json.loads((root / "build-identity.json").read_text())
        assert receipt["version"] == "20261015.172-dev", receipt
        assert receipt["run_attempt"] == int(attempt), receipt
    next_run = dict(run, id=12346, run_number=173, created_at="2026-10-16T00:00:01Z")
    result = assign(dict(ci_env, GITHUB_RUN_ID="12346", GITHUB_RUN_NUMBER="173"), next_run)
    assert result.returncode == 0, result.stderr
    assert "version=20261016.173-dev\n" in (root / "output").read_text()
    for event, ref in (("pull_request", "refs/pull/1/merge"), ("push", "refs/heads/main")):
        result = assign(dict(ci_env, GITHUB_EVENT_NAME=event, GITHUB_REF=ref), {})
        assert result.returncode == 0, result.stderr
        assert "version=20261015.1-local\n" in (root / "output").read_text()
    for metadata in (dict(run, head_sha="f" * 40), dict(run, id=1), dict(run, run_number=173)):
        result = assign(ci_env, metadata)
        assert result.returncode != 0, "Mismatched workflow metadata was accepted"
        assert not (root / "output").read_text(), "Invalid identity reached job outputs"
    for invalid_sha in (commit[:7], "f" * 40):
        result = assign(dict(ci_env, GITHUB_SHA=invalid_sha), run)
        assert result.returncode != 0, "A checkout outside the workflow commit was accepted"
        assert not (root / "output").read_text(), "Invalid commit reached job outputs"
print("Development build version propagation checks passed")
PY
