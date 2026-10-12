#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
base="${1:?usage: scripts/api-split-lines.sh BASE_SHA}"
exec python3 - "$base" crates/garage-ui/src/api << 'PY'
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

base = sys.argv[1]
directory = Path(sys.argv[2])
blob = subprocess.run(
    ["git", "show", f"{base}:crates/garage-ui/src/api.rs"],
    check=True,
    capture_output=True,
)
base_lines = blob.stdout.decode().splitlines()
new_lines = []
for path in sorted(directory.rglob("*")):
    if path.is_file():
        new_lines.extend(path.read_text().splitlines())

use_text = set()
index = 0
while index < len(base_lines):
    line = base_lines[index]
    if line.startswith("use ") or line.startswith("    use "):
        start = index
        while index < len(base_lines) and not base_lines[index].rstrip().endswith(";"):
            index += 1
        use_text.update(base_lines[start : index + 1])
    index += 1

base_counts = Counter(base_lines)
consumed = Counter()
mod_line = re.compile(r"^mod [A-Za-z_][A-Za-z0-9_]*;$")
reexport = re.compile(r"^pub(\(crate\))? use ")
super_use = re.compile(r"^use super::")
unexpected = []

def take_prefixed(line):
    for prefix in ("pub(crate) ", "pub(super) "):
        if line.startswith(prefix):
            original = line[len(prefix) :]
            if original in base_counts and consumed[original] < base_counts[original]:
                return original
        stripped = line.lstrip(" ")
        indent = line[: len(line) - len(stripped)]
        if indent and stripped.startswith(prefix):
            original = indent + stripped[len(prefix) :]
            if original in base_counts and consumed[original] < base_counts[original]:
                return original
    return None

for line in new_lines:
    if line in base_counts and consumed[line] < base_counts[line]:
        consumed[line] += 1
        continue
    original = take_prefixed(line)
    if original is not None:
        consumed[original] += 1
        continue
    thumb = '#[path = "thumb.rs"]'
    if line == '#[path = "../thumb.rs"]' and consumed[thumb] < base_counts[thumb]:
        consumed[thumb] += 1
        continue
    if mod_line.match(line) or reexport.match(line) or super_use.match(line):
        continue
    if line in use_text:
        continue
    unexpected.append(line)

missing = [(base_counts[line] - consumed[line], line) for line in base_counts if consumed[line] != base_counts[line]]
if unexpected or missing:
    print(f"api split is not an exact move: {len(unexpected)} unexpected, {len(missing)} missing", file=sys.stderr)
    for line in unexpected[:20]:
        print(f"unexpected: {line}", file=sys.stderr)
    for count, line in missing[:20]:
        print(f"missing {count}: {line}", file=sys.stderr)
    sys.exit(1)
PY
