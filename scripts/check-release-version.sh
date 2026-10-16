#!/bin/sh
# Exercise the tag gate without building artifacts or images.
set -eu
cd "$(dirname "$0")/.."
python3 - <<'PY'
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap

workflow = Path(".github/workflows/ci.yml").read_text()
gate = textwrap.dedent(workflow.split("          python3 - <<'PY_RELEASE_GATE'\n", 1)[1].split("          PY_RELEASE_GATE\n", 1)[0])
commit = "0123456789abcdef0123456789abcdef01234567"
version = "20261016.1"

with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    (root / "web").mkdir()
    commands = root / "commands"
    commands.mkdir()
    (commands / "git").write_text(f"#!/bin/sh\nprintf '%s\\n' '{commit}'\n")
    (commands / "git").chmod(0o755)

    def write_source(current_version=version, cargo_version=None, web_version=None, lock_version=None):
        expected = f"{current_version}.0"
        (root / "VERSION").write_text(current_version + "\n")
        (root / "Cargo.toml").write_text(
            "[workspace]\nmembers = []\n[workspace.package]\nversion = \"%s\"\n" % (cargo_version or expected)
        )
        locked = lock_version or expected
        (root / "Cargo.lock").write_text(
            "version = 4\n\n[[package]]\nname = \"garage-ui\"\nversion = \"%s\"\n\n[[package]]\nname = \"garage-loadgen\"\nversion = \"%s\"\n" % (locked, locked)
        )
        (root / "web/package.json").write_text(json.dumps({"version": web_version or expected}))

    def validate(tag=version, ref=None, workflow_commit=commit, **source):
        write_source(**source)
        output = root / "output"
        output.write_text("")
        env = dict(
            os.environ,
            PATH=f"{commands}:{os.environ['PATH']}",
            GITHUB_REF=ref or f"refs/tags/{tag}",
            GITHUB_REF_NAME=tag,
            GITHUB_SHA=workflow_commit,
            GITHUB_OUTPUT=str(output),
        )
        result = subprocess.run([sys.executable, "-c", gate], cwd=root, env=env, capture_output=True, text=True)
        return result, output.read_text()

    result, output = validate()
    assert result.returncode == 0, result.stderr
    assert output == f"version={version}\ncommit={commit}\n", output

    cases = [
        ("bad calendar date", dict(current_version="20260230.1", tag="20260230.1")),
        ("zero sequence", dict(current_version="20261016.0", tag="20261016.0")),
        ("leading zero sequence", dict(current_version="20261016.01", tag="20261016.01")),
        ("v prefix", dict(tag="v20261016.1")),
        ("mismatched tag", dict(tag="20261016.2")),
        ("mismatched Cargo manifest", dict(cargo_version="20261016.2.0")),
        ("mismatched web manifest", dict(web_version="20261016.2.0")),
        ("mismatched lockfile", dict(lock_version="20261016.2.0")),
        ("branch ref", dict(ref="refs/heads/dev")),
        ("mismatched commit", dict(workflow_commit="f" * 40)),
        ("abbreviated commit", dict(workflow_commit=commit[:7])),
    ]
    for name, kwargs in cases:
        result, output = validate(**kwargs)
        assert result.returncode != 0, f"{name} was accepted"
        assert not output, f"{name} reached release job outputs"

    # A later release must not retain the source template's previous image tag.
    release_script = Path("scripts/release.sh").read_text()
    render = release_script.split("<<'PY_DEPLOYMENT'\n", 1)[1].split("\nPY_DEPLOYMENT", 1)[0]
    (root / "deploy").mkdir()
    (root / "deploy/compose.external.yaml").write_text(Path("deploy/compose.external.yaml").read_text())
    for candidate in (version, "20261017.2"):
        destination = root / "compose.yaml"
        result = subprocess.run([sys.executable, "-c", render, candidate, str(destination)], cwd=root, capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        assert "${GARAGE_UI_VERSION:-" + candidate + "}" in destination.read_text()

    # Publication must fail closed before touching Docker for an immutable
    # release or when GitHub cannot establish the existing release state.
    (root / "scripts").mkdir()
    (root / "scripts/publish.sh").write_text(Path("scripts/publish.sh").read_text())
    artifacts = root / "artifacts"
    artifacts.mkdir()
    names = ["garage-ui-linux-amd64", "garage-ui-linux-arm64", "sbom.spdx.json", "compose.yaml", ".env.example"]
    for name in names:
        (artifacts / name).write_text("synthetic release fixture\n")
    (artifacts / "SHA256SUMS").write_text("".join(
        hashlib.sha256((artifacts / name).read_bytes()).hexdigest() + "  " + name + "\n" for name in names
    ))
    (commands / "docker").write_text('#!/bin/sh\ntouch "$DOCKER_PROBE"\nexit 9\n')
    (commands / "docker").chmod(0o755)
    for response in (f"printf '{version}\\tfalse\\n'", "exit 7"):
        (commands / "gh").write_text("#!/bin/sh\n" + response + "\n")
        (commands / "gh").chmod(0o755)
        probe = root / "docker-called"
        env = dict(os.environ, PATH=f"{commands}:{os.environ['PATH']}", DOCKER_PROBE=str(probe))
        result = subprocess.run(["sh", "scripts/publish.sh", str(artifacts)], cwd=root, env=env, capture_output=True, text=True)
        if response == "exit 7":
            assert result.returncode == 7, result.stderr
        else:
            assert "already published" in result.stderr, result.stderr
        assert not probe.exists(), "Publication reached Docker before confirming a writable draft"

    assert "needs: gate" in workflow, "release must not run before the tag gate"
    assert "pull_request:" not in workflow and "branches:" not in workflow, "ordinary pushes and PRs must not build"
print("Release tag gate checks passed")
PY
