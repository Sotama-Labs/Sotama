# syntax=docker/dockerfile:1.7
#
# sotama-keeper — fly.io image. Build context is the `keeper/` directory:
#     fly deploy --dockerfile keeper/Dockerfile  (run from repo root with a fly.toml at keeper/)

FROM rust:1.91.1-bookworm AS builder
WORKDIR /build

# Cache deps separately from source for fast rebuilds.
COPY Cargo.toml Cargo.lock* ./
RUN mkdir -p src && echo 'fn main() {}' > src/main.rs
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release && rm -rf src

# Real source on top of the cached deps.
COPY src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release && \
    cp target/release/sotama-keeper /tmp/sotama-keeper

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        libssl3 \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 1000 keeper
USER keeper
WORKDIR /home/keeper

COPY --from=builder /tmp/sotama-keeper /usr/local/bin/sotama-keeper

ENV RUST_LOG=info,sotama_keeper=debug
# Fly.io passes signals; tini-style PID 1 not needed for a tokio app.
ENTRYPOINT ["/usr/local/bin/sotama-keeper"]
