#!/usr/bin/env bash
# Prepare a local development environment for the self-hosted AFFiNE fork:
# server + web + admin + Linux desktop.
#
# Usage:
#   scripts/selfhost-dev/setup.sh            # everything
#   scripts/selfhost-dev/setup.sh services   # only Postgres/Redis + DB
#   scripts/selfhost-dev/setup.sh native     # only Rust native modules
#   scripts/selfhost-dev/setup.sh frontend   # web + mobile web + admin bundles
#   scripts/selfhost-dev/setup.sh desktop    # Linux x64 Electron package
#
# Run the server afterwards:
#   cd packages/backend/server && yarn r ./src/index.ts   # http://localhost:3010
#
# Requirements: Node 22 (corepack/yarn 4), Rust (rust-toolchain.toml),
# PostgreSQL 16 + pgvector, Redis. Debian/Ubuntu package names are used below.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

DB_USER="${DB_USER:-affine}"
DB_PASSWORD="${DB_PASSWORD:-affine}"
DB_NAME="${DB_NAME:-affine}"
CONFIG_DIR="${AFFINE_CONFIG_DIR:-$HOME/.affine/config}"

# Development-only public key. It is the same test key AFFiNE's CI uses in
# .github/workflows/build-test.yml. Self-hosted server builds refuse to start
# without an embedded key (see packages/backend/native/src/lib.rs).
DEV_AFFINE_PRO_PUBLIC_KEY='-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEObwJiTmbui7rkWfPJ7Lozvuy2Rcl
otcrb0V6dlS2ijKEShm7ZttTwQn08xzesdjX/AxpoR5X9yfoHkauIBuuMQ==
-----END PUBLIC KEY-----'
export AFFINE_PRO_PUBLIC_KEY="${AFFINE_PRO_PUBLIC_KEY:-$DEV_AFFINE_PRO_PUBLIC_KEY}"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

deps() {
  step "Installing JS dependencies"
  corepack enable >/dev/null 2>&1 || true
  yarn install
  # Electron's postinstall is skipped by yarn config; fetch the binary.
  (cd node_modules/electron && node install.js)
}

services() {
  step "Starting PostgreSQL and Redis"
  if ! ls /usr/share/postgresql/*/extension/vector.control >/dev/null 2>&1; then
    echo "pgvector missing; trying apt-get install postgresql-16-pgvector"
    apt-get install -y postgresql-16-pgvector
  fi
  service postgresql start
  redis-cli ping >/dev/null 2>&1 || redis-server --daemonize yes
  su postgres -c "psql -tc \"SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'\"" | grep -q 1 ||
    su postgres -c "psql -c \"CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASSWORD}' SUPERUSER;\""
  su postgres -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'\"" | grep -q 1 ||
    su postgres -c "psql -c \"CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};\""

  step "Writing server config (self-hosted deployment)"
  local envfile=packages/backend/server/.env
  [ -f "$envfile" ] || cat >"$envfile" <<EOF
DATABASE_URL="postgres://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}"
REDIS_SERVER_HOST=localhost
EOF
  mkdir -p "$CONFIG_DIR"
  [ -f "$CONFIG_DIR/config.json" ] || cat >"$CONFIG_DIR/config.json" <<'EOF'
{
  "deployment": { "type": "selfhosted" },
  "server": { "name": "AFFiNE Self Hosted (dev)" },
  "indexer": { "enabled": true, "provider.type": "embedded" },
  "copilot": {
    "enabled": true,
    "byok.enabled": true,
    "byok.allowedProviders": ["openai", "anthropic", "gemini", "fal"],
    "byok.allowCustomEndpoint": true,
    "byok.allowPrivateEndpoint": true
  }
}
EOF
  # A stable private key is required once persistent BYOK is enabled
  # (it encrypts stored provider keys). Read by src/prelude.ts.
  if [ ! -f "$CONFIG_DIR/private.key" ]; then
    openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:prime256v1 \
      -out "$CONFIG_DIR/private.key"
    chmod 600 "$CONFIG_DIR/private.key"
  fi
}

native() {
  step "Building Rust native modules (first build takes ~30 min)"
  yarn affine @affine/server-native build
  yarn affine @affine/native build
  # Linux builds regenerate the NAPI bindings without macOS-only symbols;
  # keep the committed, cross-platform versions.
  git checkout -- packages/frontend/native/index.d.ts packages/frontend/native/index.js 2>/dev/null || true
}

migrate() {
  step "Applying database migrations"
  (cd packages/backend/server && yarn prisma migrate deploy && yarn data-migration run)
}

frontend() {
  step "Bundling web, mobile web and admin (BUILD_TYPE=${BUILD_TYPE:-stable})"
  export BUILD_TYPE="${BUILD_TYPE:-stable}"
  export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"
  yarn affine bundle -p @affine/web
  yarn affine bundle -p @affine/mobile
  yarn affine bundle -p @affine/admin

  step "Copying bundles into packages/backend/server/static"
  local static=packages/backend/server/static
  rm -rf "$static" && mkdir -p "$static"
  cp -r packages/frontend/apps/web/dist/. "$static"/
  cp -r packages/frontend/apps/mobile/dist "$static"/mobile
  cp -r packages/frontend/admin/dist "$static"/admin
  grep -qxF "$static/" .git/info/exclude 2>/dev/null || echo "$static/" >>.git/info/exclude
}

desktop() {
  step "Building and packaging the Linux desktop app (BUILD_TYPE=${BUILD_TYPE:-stable})"
  export BUILD_TYPE="${BUILD_TYPE:-stable}"
  yarn affine @affine/electron build
  yarn affine @affine/electron generate-assets
  SKIP_WEB_BUILD=1 HOIST_NODE_MODULES=1 \
    yarn affine @affine/electron package --platform=linux --arch=x64
  echo "Unpacked app: packages/frontend/apps/electron/out/$BUILD_TYPE/AFFiNE-linux-x64"
  echo "Installers (AppImage/deb/flatpak) need: yarn affine @affine/electron make"
}

case "${1:-all}" in
  deps) deps ;;
  services) services ;;
  native) native ;;
  migrate) migrate ;;
  frontend) frontend ;;
  desktop) desktop ;;
  all) deps; services; native; migrate; frontend ;;
  *) echo "unknown step: $1" >&2; exit 1 ;;
esac

step "Done"
