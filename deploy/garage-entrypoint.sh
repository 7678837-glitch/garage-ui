#!/bin/sh
# 在带 shell 的初始化容器里生成 Garage 配置。官方镜像是 scratch，不能在里面跑脚本。
# 密钥只写入卷，不打印。已有文件则沿用，避免每次启动换密钥。
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
