#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if grep -R -n -E -e 'BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY' \
  --exclude-dir=target \
  --exclude-dir=node_modules \
  --exclude-dir=.git \
  .; then
  echo "found a private key block" >&2
  exit 1
fi
