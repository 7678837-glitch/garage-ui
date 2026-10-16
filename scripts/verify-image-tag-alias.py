#!/usr/bin/env python3
"""Wait for a published tag alias to resolve to the verified version image."""

import subprocess
import sys
import time


def inspect_digest(reference, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return ""
    try:
        result = subprocess.run(
            ["docker", "buildx", "imagetools", "inspect", reference, "--format", "{{.Manifest.Digest}}"],
            check=True,
            capture_output=True,
            text=True,
            timeout=min(10, remaining),
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return ""
    return result.stdout.strip()


def verify_alias(registry, version_tag, alias_tag, timeout=300, poll_interval=3):
    version = f"{registry}:{version_tag}"
    alias = f"{registry}:{alias_tag}"
    deadline = time.monotonic() + timeout
    last_version_digest = ""
    last_alias_digest = ""
    while time.monotonic() < deadline:
        last_version_digest = inspect_digest(version, deadline)
        last_alias_digest = inspect_digest(alias, deadline)
        if last_version_digest and last_version_digest == last_alias_digest:
            print(f"Verified {alias} matches {version} ({last_version_digest})")
            return True
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(poll_interval, remaining))
    print(
        f"{alias} did not converge to {version} within {timeout} seconds "
        f"(version={last_version_digest or 'unavailable'}, alias={last_alias_digest or 'unavailable'})",
        file=sys.stderr,
    )
    return False


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit(f"Usage: {sys.argv[0]} <registry> <version-tag> <alias-tag>")
    raise SystemExit(0 if verify_alias(*sys.argv[1:]) else 1)
