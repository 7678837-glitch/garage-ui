#!/bin/sh
# Exercise the build script without Cargo dependencies or a frontend build.
set -eu
cd "$(dirname "$0")/.."
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT HUP INT TERM
mkdir -p "$fixture/crates/garage-ui" "$fixture/web/dist"
printf '<html></html>\n' > "$fixture/web/dist/index.html"
printf '20261015.1\n' > "$fixture/VERSION"
rustc --edition=2024 crates/garage-ui/build.rs -o "$fixture/build-script"
commit=0123456789abcdef0123456789abcdef01234567
output=$(cd "$fixture" && env -u BUILD_VERSION CARGO_MANIFEST_DIR="$fixture/crates/garage-ui" GIT_COMMIT="$commit" "$fixture/build-script")
printf '%s\n' "$output" | rg -q "^cargo:rustc-env=GARAGE_UI_COMMIT=$commit$" || {
  echo 'Explicit build identity was not embedded' >&2
  exit 1
}
printf '%s\n' "$output" | rg -q '^cargo:rustc-env=GARAGE_UI_VERSION=20261015.1-local$' || {
  echo 'An unassigned local build must have a local version' >&2
  exit 1
}
printf '%s\n' "$output" | rg -q '^cargo:rerun-if-env-changed=BUILD_VERSION$' || {
  echo 'Cargo must rebuild when BUILD_VERSION changes' >&2
  exit 1
}
for version in 20261015.1 20261015.172-dev 20261015.1-local; do
  output=$(cd "$fixture" && CARGO_MANIFEST_DIR="$fixture/crates/garage-ui" GIT_COMMIT="$commit" BUILD_VERSION="$version" "$fixture/build-script")
  printf '%s\n' "$output" | rg -F -x -q "cargo:rustc-env=GARAGE_UI_VERSION=$version" || {
    echo "Explicit build version was not embedded: $version" >&2
    exit 1
  }
done
for version in '' 20261015.0-dev 20261015.01-dev 20260230.1-dev 20261301.1 \
  20261015.1-DEV 20261015.1.0 ' 20261015.1' '20261015.1 ' \
  '２０２６１０１５.1-dev' '20261015.1-dev; touch injected' "$(printf '20261015.1-dev\nx')" '20261015.1-dev
'; do
  if (cd "$fixture" && CARGO_MANIFEST_DIR="$fixture/crates/garage-ui" GIT_COMMIT="$commit" BUILD_VERSION="$version" "$fixture/build-script") > "$fixture/invalid-output" 2>&1; then
    echo "Malformed explicit build version was accepted: $version" >&2
    exit 1
  fi
done
if (cd "$fixture" && CARGO_MANIFEST_DIR="$fixture/crates/garage-ui" GIT_COMMIT=malformed "$fixture/build-script") > "$fixture/invalid-output" 2>&1; then
  echo 'Malformed explicit build identity was accepted' >&2
  exit 1
fi
output=$(cd "$fixture" && env -u GIT_COMMIT -u BUILD_VERSION CARGO_MANIFEST_DIR="$fixture/crates/garage-ui" "$fixture/build-script")
printf '%s\n' "$output" | rg -q '^cargo:rustc-env=GARAGE_UI_COMMIT=unknown$' || {
  echo 'Source archive identity must remain unknown' >&2
  exit 1
}
git -C "$fixture" init -q
git -C "$fixture" add VERSION
git -C "$fixture" -c user.name=IdentityTest -c user.email=identity@example.invalid commit -qm fixture
commit=$(git -C "$fixture" rev-parse HEAD)
output=$(cd "$fixture" && env -u GIT_COMMIT -u BUILD_VERSION CARGO_MANIFEST_DIR="$fixture/crates/garage-ui" "$fixture/build-script")
printf '%s\n' "$output" | rg -q "^cargo:rustc-env=GARAGE_UI_COMMIT=$commit$" || {
  echo 'Native build identity does not match repository HEAD' >&2
  exit 1
}
printf 'Build identity regression checks passed\n'
