#!/usr/bin/env bash
#
# Every API suite, against a clinic this script creates and then deletes.
#
# The product ships with no data at all — no clinics, no patients, no accounts —
# so a verification run builds the world it needs and takes it away again. That
# is not only tidier than a permanent demo tenant: a suite that depends on
# records it did not create passes or fails for reasons that have nothing to do
# with the code.
#
#   bash scripts/verify/all.sh
#
# Requires the stack to be up (`docker compose up -d`) and MIGRATION_DATABASE_URL
# to point at its Postgres. The fixture clinic is removed even when a suite
# fails, so a red run does not leave a tenant behind.
set -u

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"

if [ -z "${MIGRATION_DATABASE_URL:-}" ]; then
  # Read it out of .env rather than guessing: the compose stack generates its
  # own password and the default would silently fail to authenticate.
  if [ -f "$root/.env" ]; then
    pw="$(grep '^POSTGRES_PASSWORD=' "$root/.env" | cut -d= -f2-)"
    port="$(grep '^POSTGRES_PORT=' "$root/.env" | cut -d= -f2-)"
    export MIGRATION_DATABASE_URL="postgres://emr_migrator:${pw}@localhost:${port:-5433}/emr"
  else
    echo "Set MIGRATION_DATABASE_URL, or create .env from .env.example." >&2
    exit 2
  fi
fi

echo "== building fixtures =="
fixtures="$(node "$here/fixtures.mjs" up)" || {
  echo "Could not build fixtures. Is the stack up?" >&2
  exit 1
}
eval "$fixtures"
echo "   clinic ${VERIFY_SLUG}"
echo

# Remove the clinic however this script exits — including a failing suite, a
# Ctrl-C, or a crash. A verification run that leaves a tenant behind poisons the
# next one.
cleanup() {
  echo
  echo "== removing fixtures =="
  node "$here/fixtures.mjs" down "$VERIFY_CLINIC_ID" || true
}
trap cleanup EXIT INT TERM

rc=0
for suite in api-reads availability consultation-flow reminders analytics lab broadcast platform; do
  echo "=============================================================="
  echo " $suite"
  echo "=============================================================="
  bash "$here/$suite.sh" || rc=1
  echo
done

exit "$rc"
