#!/usr/bin/env bash
#
# The browser suite, against a clinic built and destroyed for the run.
#
#   bash scripts/verify/browser.sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"

if [ -z "${MIGRATION_DATABASE_URL:-}" ] && [ -f "$root/.env" ]; then
  pw="$(grep '^POSTGRES_PASSWORD=' "$root/.env" | cut -d= -f2-)"
  port="$(grep '^POSTGRES_PORT=' "$root/.env" | cut -d= -f2-)"
  export MIGRATION_DATABASE_URL="postgres://emr_migrator:${pw}@localhost:${port:-5433}/emr"
fi

eval "$(node "$here/fixtures.mjs" up)"
echo "   clinic ${VERIFY_SLUG}"

# Removed however this exits, so a failing run does not leave a tenant behind.
trap 'node "$here/fixtures.mjs" down "$VERIFY_CLINIC_ID" || true' EXIT INT TERM

cd "$root/apps/web" && npx playwright test "$@"
