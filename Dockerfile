# ── Stage 1: Compile WASM artifacts from Rust source ─────────────
FROM rust:1.88-slim-bookworm@sha256:38bc5a86d998772d4aec2348656ed21438d20fcdce2795b56ca434cf21430d89 AS wasm

WORKDIR /build
COPY packages/ring-sig/ packages/ring-sig/

RUN cargo install wasm-pack --version 0.14.0 --locked \
 && wasm-pack build packages/ring-sig/wasm --target nodejs  --out-dir pkg         --release \
 && wasm-pack build packages/ring-sig/wasm --target bundler --out-dir pkg-bundler --release

# ── Stage 2: Install deps + compile TypeScript ───────────────────
FROM node:22-slim@sha256:f3a68cf41a855d227d1b0ab832bed9749469ef38cf4f58182fb8c893bc462383 AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json   packages/shared/
COPY packages/cli/package.json      packages/cli/
COPY packages/api/package.json      packages/api/
COPY packages/ui/package.json       packages/ui/

# WASM artifacts must exist before npm ci — ui has a file: dep on pkg-bundler
COPY --from=wasm /build/packages/ring-sig/wasm/pkg/         packages/ring-sig/wasm/pkg/
COPY --from=wasm /build/packages/ring-sig/wasm/pkg-bundler/ packages/ring-sig/wasm/pkg-bundler/

RUN npm ci

COPY packages/shared/ packages/shared/
COPY packages/cli/    packages/cli/

RUN npm run shared:build \
 && npm run cli:build

# ── Stage 3: Slim runtime ────────────────────────────────────────
FROM node:22-slim@sha256:f3a68cf41a855d227d1b0ab832bed9749469ef38cf4f58182fb8c893bc462383

RUN groupadd --gid 1001 anon \
 && useradd  --uid 1001 --gid anon --shell /bin/false anon

WORKDIR /app

COPY --from=builder --chown=anon:anon /app/package.json              ./
COPY --from=builder --chown=anon:anon /app/node_modules/             node_modules/
COPY --from=builder --chown=anon:anon /app/packages/cli/dist/        packages/cli/dist/
COPY --from=builder --chown=anon:anon /app/packages/cli/package.json packages/cli/
COPY --from=builder --chown=anon:anon /app/packages/cli/node_modules/ packages/cli/node_modules/
COPY --from=builder --chown=anon:anon /app/packages/shared/dist/     packages/shared/dist/
COPY --from=builder --chown=anon:anon /app/packages/shared/package.json packages/shared/
COPY --from=wasm    --chown=anon:anon /build/packages/ring-sig/wasm/pkg/ packages/ring-sig/wasm/pkg/

USER anon

ENTRYPOINT ["node", "packages/cli/dist/index.js"]
