#!/bin/sh
# Exercise the build script without Cargo dependencies or a frontend build.
set -eu
cd "$(dirname "$0")/.."
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT HUP INT TERM
mkdir -p "$fixture/crates/garage-ui" "$fixture/web/dist"
printf '<html></html>\n' > "$fixture/web/dist/index.html"
printf '20261015.1\n' > "$fixture/VERSION"
rustc crates/garage-ui/build.rs -o "$fixture/build-script"
commit=0123456789abcdef0123456789abcdef01234567
output=$(cd "$fixture" && CARGO_MANIFEST_DIR="$fixture/crates/garage-ui" GIT_COMMIT="$commit" "$fixture/build-script")
printf '%s\n' "$output" | rg -q "^cargo:rustc-env=GARAGE_UI_COMMIT=$commit$" || {
  echo 'Explicit build identity was not embedded' >&2
  exit 1
}
if (cd "$fixture" && CARGO_MANIFEST_DIR="$fixture/crates/garage-ui" GIT_COMMIT=malformed "$fixture/build-script") > "$fixture/invalid-output" 2>&1; then
  echo 'Malformed explicit build identity was accepted' >&2
  exit 1
fi
output=$(cd "$fixture" && env -u GIT_COMMIT CARGO_MANIFEST_DIR="$fixture/crates/garage-ui" "$fixture/build-script")
printf '%s\n' "$output" | rg -q '^cargo:rustc-env=GARAGE_UI_COMMIT=unknown$' || {
  echo 'Source archive identity must remain unknown' >&2
  exit 1
}
git -C "$fixture" init -q
git -C "$fixture" add VERSION
git -C "$fixture" -c user.name=IdentityTest -c user.email=identity@example.invalid commit -qm fixture
commit=$(git -C "$fixture" rev-parse HEAD)
output=$(cd "$fixture" && env -u GIT_COMMIT CARGO_MANIFEST_DIR="$fixture/crates/garage-ui" "$fixture/build-script")
printf '%s\n' "$output" | rg -q "^cargo:rustc-env=GARAGE_UI_COMMIT=$commit$" || {
  echo 'Native build identity does not match repository HEAD' >&2
  exit 1
}
printf 'Build identity regression checks passed\n'
