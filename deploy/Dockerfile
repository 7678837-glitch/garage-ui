# syntax=docker/dockerfile:1

FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS web
WORKDIR /src/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/index.html web/tsconfig.json web/vite.config.ts ./
COPY web/src ./src
RUN bun run build

FROM rust:1.99.0-bookworm@sha256:114c7a4425406451c2866b6aafe69fe29b1b298832db1277d411ac73c82d04d6 AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends musl-tools \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY rust-toolchain.toml Cargo.toml Cargo.lock VERSION ./
COPY crates ./crates
COPY --from=web /src/web/dist ./web/dist
ENV RUSTFLAGS="-C target-feature=+crt-static -C linker=musl-gcc"
RUN set -eu; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64) triple=x86_64-unknown-linux-musl ;; \
      aarch64) triple=aarch64-unknown-linux-musl ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    rustup target add "$triple"; \
    cargo build --release --locked --target "$triple" -p garage-ui --bin garage-ui; \
    cp "target/${triple}/release/garage-ui" /garage-ui

FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8 AS layout
RUN mkdir -p /data && chown 65532:65532 /data

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /garage-ui /garage-ui
COPY --from=layout --chown=65532:65532 /data /data
ENV HOST=0.0.0.0
ENV DATA_DIR=/data
EXPOSE 3909
VOLUME /data
USER 65532:65532
ENTRYPOINT ["/garage-ui"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["/garage-ui", "-health"]
