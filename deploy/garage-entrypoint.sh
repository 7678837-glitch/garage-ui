#!/bin/sh
# Generate configuration in a shell-equipped init container; the Garage image has no shell.
# Keep secrets in volumes and reuse existing tokens across restarts.
set -eu
umask 077
mkdir -p /config

gen() {
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

write_if_missing() {
  if [ ! -s "$1" ]; then
    gen > "$1"
  fi
  chmod 600 "$1"
}

write_if_missing /config/rpc_secret
write_if_missing /config/admin_token
write_if_missing /config/metrics_token

# Share only API tokens with the non-root UI; keep the RPC secret and config private.
mkdir -p /ui-secrets
cp /config/admin_token /ui-secrets/admin_token
cp /config/metrics_token /ui-secrets/metrics_token
chown -R 65532:65532 /ui-secrets
chmod 700 /ui-secrets
chmod 600 /ui-secrets/admin_token /ui-secrets/metrics_token

rpc_secret=$(cat /config/rpc_secret)
admin_token=$(cat /config/admin_token)
metrics_token=$(cat /config/metrics_token)

cat > /config/garage.toml <<EOF
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"
replication_factor = 1
rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret = "${rpc_secret}"

[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
root_domain = ".s3.garage.localhost"

[s3_web]
bind_addr = "[::]:3902"
root_domain = ".web.garage.localhost"
index = "index.html"

[admin]
api_bind_addr = "[::]:3903"
admin_token = "${admin_token}"
metrics_token = "${metrics_token}"
EOF
chmod 600 /config/garage.toml
