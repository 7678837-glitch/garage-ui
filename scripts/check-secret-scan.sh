#!/bin/sh
# Exercise the scanner only in disposable repositories with inert synthetic fixtures.
set -eu
cd "$(dirname "$0")/.."
python3 - "$PWD" <<'PY'
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

source = Path(sys.argv[1])
with tempfile.TemporaryDirectory(prefix="garage-ui-secret-scan-") as temporary:
    repo = Path(temporary) / "repo"
    (repo / "scripts").mkdir(parents=True)
    shutil.copy2(source / "scripts/secret-scan.sh", repo / "scripts/secret-scan.sh")
    config = source / "data/config/gitleaks.toml"
    if config.exists():
        (repo / "data/config").mkdir(parents=True)
        shutil.copy2(config, repo / "data/config/gitleaks.toml")
    env = dict(os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)

    def git(*arguments):
        subprocess.run(["git", *arguments], cwd=repo, env=env, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    git("init", "--initial-branch=main")
    git("config", "user.name", "Secret scanner fixture")
    git("config", "user.email", "fixture@example.invalid")
    git("add", ".")
    git("commit", "-m", "Clean scanner fixture")
    # These pieces never form credentials in the repository that contains this check.
    value = "K7m2Q9v4" + "R6x8N3p5" + "T1z0W4a6"

    def scan(expected, *arguments):
        result = subprocess.run(["sh", "scripts/secret-scan.sh", *arguments],
                                cwd=repo, env=env, text=True, capture_output=True)
        if value in result.stdout + result.stderr:
            raise SystemExit("FAIL: scanner printed a synthetic credential without redaction")
        if result.returncode != expected:
            raise SystemExit(f"FAIL: scanner {' '.join(arguments) or '(default)'} "
                             f"returned {result.returncode}; expected {expected}")

    scan(0)
    scan(0, "--worktree")
    scan(0, "--history")
    fixture = repo / "local.env"
    for field in ("password", "api_token"):
        fixture.write_text(f'{field} = "{value}"\n')
        scan(1, "--worktree")
        scan(0, "--history")
        fixture.unlink()
    for kind in ("", "RSA ", "OPENSSH ", "EC ", "DSA ", "ENCRYPTED "):
        # A marker alone must preserve the old scanner's detection contract.
        fixture.write_text("-----" + "BEGIN " + kind + "PRIVATE" + " KEY-----\n")
        scan(1, "--worktree")
        fixture.unlink()
    fixture.write_text("-----" + "BEGIN PRIVATE" + " KEY-----\n" + value * 4 +
                       "\n-----" + "END PRIVATE" + " KEY-----\n")
    scan(1, "--worktree")
    fixture.unlink()
    git("checkout", "-b", "history-fixture")
    fixture.write_text(f'api_token = "{value}"\n')
    git("add", "local.env")
    git("commit", "-m", "Inert synthetic history fixture")
    git("checkout", "main")
    scan(0, "--worktree")
    scan(1, "--history")
    scan(1)
    print("Secret scanner checks passed: clean, worktree password/token/private keys, redaction, all-ref history")
PY
