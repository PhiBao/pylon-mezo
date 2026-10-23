# Pylon engine service (Rust) — Fly.io image.
#
# Multi-stage: build the release binary, then ship it on a slim runtime with ca-certificates.
# The deployment record travels with the image so the service knows the chain's addresses without
# a network fetch; everything else comes from the environment (see fly.toml and the secrets).

FROM rust:1.90-slim-bookworm AS build
WORKDIR /src

# Compile dependencies once, separately from the source, so a source-only change rebuilds fast.
COPY server/Cargo.toml server/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
    && cargo build --release --locked 2>/dev/null || true

COPY server/src ./src
RUN touch src/main.rs && cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /src/target/release/pylon-server /usr/local/bin/pylon-server
COPY contracts/deployments/31611.json /app/deployments/31611.json

ENV DATA_DIR=/data \
    PORT=8080 \
    DEPLOYMENT=/app/deployments/31611.json

EXPOSE 8080
CMD ["pylon-server", "serve"]
