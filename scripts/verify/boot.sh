#!/usr/bin/env bash
#
# Does the API actually start?
#
# WHY THIS EXISTS. A Nest dependency is resolved at RUNTIME, from a Symbol. The
# type checker cannot see it, ESLint cannot see it, and no unit test touches the
# injector — so a provider that is declared but not EXPORTED compiles perfectly,
# lints clean, and then kills the process during bootstrap.
#
# That is not a hypothetical either. `PG_POOL` was injected into the health
# controller and left out of `DatabaseModule`'s exports. Everything was green.
# The container then exited on boot, never became healthy, `web` depends on
# `api: service_healthy`, and the deploy aborted with:
#
#     dependency failed to start: container ...-api-1 is unhealthy
#
# which says nothing whatsoever about a missing export.
#
# NO DATABASE IS NEEDED, and that is the point — it makes this cheap enough to
# run on every change. `pg.Pool` does not open a socket until the first query,
# so the whole injector builds and every route is mapped against a connection
# string that points at nothing. What this proves is narrow and exactly the gap:
# the application can be CONSTRUCTED. Whether it can reach Postgres is what
# `/readyz` and the other suites are for.
#
#   bash scripts/verify/boot.sh

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/apps/api" || exit 2

if [ ! -f dist/main.js ]; then
  echo "  dist/main.js is missing. Build first:  pnpm --filter @emr/api build" >&2
  exit 2
fi

PORT_TO_USE="${BOOT_CHECK_PORT:-4599}"
LOG="$(mktemp)"

# A connection string that resolves to nothing, on a port nothing listens on.
# Deliberate: if this suite ever passes BECAUSE a database happened to be up,
# it is no longer testing what it claims to.
NODE_ENV=development \
PORT="$PORT_TO_USE" \
DATABASE_URL="postgres://nobody:nobody@127.0.0.1:59999/none" \
PLATFORM_DATABASE_URL="postgres://nobody:nobody@127.0.0.1:59999/none" \
JWT_SECRET="development-only-not-a-secret-key" \
ENCRYPTION_KEY="development-only-encryption-key-not-a-secret" \
  node dist/main.js > "$LOG" 2>&1 &
PID=$!

# Up to 30s. A cold Nest boot with every module is a couple of seconds; the
# margin is for a loaded CI box.
ok=0
for _ in $(seq 1 60); do
  if grep -q "API listening" "$LOG" 2>/dev/null; then ok=1; break; fi
  # Exited already — no point waiting out the rest of the timeout.
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
  sleep 0.5
done

kill "$PID" 2>/dev/null
wait "$PID" 2>/dev/null

if [ "$ok" = "1" ]; then
  echo "  PASS  the API builds its injector and listens"
  rm -f "$LOG"
  exit 0
fi

echo "  FAIL  the API did not start." >&2
echo >&2

# The useful line, pulled out of the Nest banner. A DI failure is always one of
# these, and it names the symbol and the module it is missing from.
if grep -qE "UnknownDependenciesException|can't resolve dependencies" "$LOG"; then
  echo "  A DEPENDENCY IS NOT RESOLVABLE. Almost always a provider that is declared" >&2
  echo "  in a module but missing from its \`exports\`, being injected elsewhere." >&2
  echo "  \`@Global()\` publishes a module's EXPORTS — not its private providers." >&2
  echo >&2
fi

grep -iE "ERROR|Exception|Cannot find|can't resolve" "$LOG" | head -10 >&2
echo >&2
echo "  Full log: $LOG" >&2
exit 1
