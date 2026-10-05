#!/usr/bin/env bash
#
# The operations console, and the boundary it exists behind.
#
# The cases that matter are the refusals. A platform operator must not reach a
# patient, and a clinic administrator — the most privileged clinic role — must
# not reach the console.
#
#   API_BASE=http://localhost:4000/v1 bash scripts/verify/platform.sh
S="${TMPDIR:-/tmp}"
API="${API_BASE:-http://localhost:4000/v1}"

if [ -z "${VERIFY_DOMAIN:-}" ]; then
  echo "  This suite needs fixtures. Run it through scripts/verify/all.sh." >&2
  exit 2
fi

pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1));
  else echo "  FAIL  $1 (expected $2, got $3)"; echo "        ${4:0:240}"; fail=$((fail+1)); fi
}
call() { # method path cookiejar [data]
  local m=$1 p=$2 j=$3 d=${4:-} out
  if [ -n "$d" ]; then
    out=$(curl -s -b "$j" -c "$j" -w $'\n%{http_code}' -X "$m" "$API$p" -H 'Content-Type: application/json' -d "$d")
  else
    out=$(curl -s -b "$j" -c "$j" -w $'\n%{http_code}' -X "$m" "$API$p")
  fi
  CODE="${out##*$'\n'}"; BODY="${out%$'\n'*}"
}

OPS="$S/ops-cookies.txt";    rm -f "$OPS"
CLIN="$S/clin-cookies.txt";  rm -f "$CLIN"

echo "-- an operator signs in --"
call POST /platform/auth/login "$OPS" "{\"email\":\"$VERIFY_OPERATOR_EMAIL\",\"password\":\"$VERIFY_OPERATOR_PASSWORD\"}"
check "operator sign-in" 201 "$CODE" "$BODY"

call GET /platform/overview "$OPS"
check "reads the estate overview" 200 "$CODE" "$BODY"

call GET /platform/tenants "$OPS"
check "lists clinics across tenants" 200 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q "$VERIFY_SLUG" \
  && check "the fixture clinic is visible" y y \
  || check "the fixture clinic is visible" y n

echo "-- the operator cannot reach clinical data --"
for p in /patients /inbox/conversations /broadcasts /audit-events; do
  call GET "$p" "$OPS"
  check "operator refused $p" 401 "$CODE" "$BODY"
done

echo "-- a clinic administrator cannot reach the console --"
call POST /auth/login "$CLIN" "{\"email\":\"owner@$VERIFY_DOMAIN\",\"password\":\"$VERIFY_PASSWORD\"}"
check "clinic admin sign-in" 201 "$CODE" "$BODY"

for p in /platform/overview /platform/tenants /platform/audit; do
  call GET "$p" "$CLIN"
  check "clinic admin refused $p" 401 "$CODE" "$BODY"
done

call POST "/platform/tenants/$VERIFY_CLINIC_ID/suspend" "$CLIN" '{"reason":"attempting to escalate from a clinic session"}'
check "clinic admin cannot suspend a clinic" 401 "$CODE" "$BODY"

echo "-- changes demand a stated reason --"
call POST "/platform/tenants/$VERIFY_CLINIC_ID/suspend" "$OPS" '{}'
check "suspending with no reason is refused" 422 "$CODE" "$BODY"

call POST "/platform/tenants/$VERIFY_CLINIC_ID/suspend" "$OPS" '{"reason":"short"}'
check "a one-word reason is refused" 422 "$CODE" "$BODY"

echo "-- suspension takes effect immediately --"
call POST "/platform/tenants/$VERIFY_CLINIC_ID/suspend" "$OPS" '{"reason":"Verification run: checking suspension propagates"}'
check "suspend" 201 "$CODE" "$BODY"

rm -f "$CLIN"
call POST /auth/login "$CLIN" "{\"email\":\"owner@$VERIFY_DOMAIN\",\"password\":\"$VERIFY_PASSWORD\"}"
check "the clinic can no longer sign in" 403 "$CODE" "$BODY"

call POST "/platform/tenants/$VERIFY_CLINIC_ID/restore" "$OPS" '{"reason":"Verification run: restoring the fixture clinic"}'
check "restore" 201 "$CODE" "$BODY"

rm -f "$CLIN"
call POST /auth/login "$CLIN" "{\"email\":\"owner@$VERIFY_DOMAIN\",\"password\":\"$VERIFY_PASSWORD\"}"
check "and can sign in again" 201 "$CODE" "$BODY"

echo "-- every action is on the record --"
call GET "/platform/audit?clinicId=$VERIFY_CLINIC_ID" "$OPS"
check "the operator log reads" 200 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q 'CLINIC_SUSPENDED' \
  && check "the suspension is recorded" y y \
  || check "the suspension is recorded" y n
printf '%s' "$BODY" | grep -q 'checking suspension propagates' \
  && check "with the reason that was given" y y \
  || check "with the reason that was given" y n

echo "-- NO PLAN MAY SILENTLY OMIT A MODULE --"
#
# THE BUG THIS EXISTS TO CATCH, which already happened once: `FEATURES` in
# packages/contracts grew three keys — pharmacy, lab and analytics — across three
# stages of work, and every plan row in the catalogue kept the eight it was
# created with. `resolveFeatures` treats an absent key as false, correctly, so
# all three modules were off for every clinic on a real plan.
#
# A pharmacist signing in lands on /pharmacy and an analyst on /analytics,
# because neither has a clinic dashboard to land on — so those two roles met
# "this part of the product is not enabled for your clinic" on the first screen
# after sign-in. It reads as a broken account rather than an unpriced module.
#
# NOTHING CAUGHT IT because the clinical suites run against a fixture clinic
# whose subscription carries an override turning all eleven features on. That is
# right for those suites — they test clinic behaviour, not a price list — but it
# meant no test ever asked whether a clinic on a CATALOGUE plan could reach the
# pharmacy. This is that question.
#
# The key list comes from the API's own build rather than being hardcoded here,
# so adding a twelfth feature makes this assertion fail until somebody prices it.
# The operator session from the top of this suite is still in $OPS.
call GET /platform/plans "$OPS"
check "the plan catalogue reads" 200 "$CODE" "$BODY"

# Every key the product knows about, from the running build.
KNOWN=$(docker compose exec -T api node -e "
  const { FEATURE_KEYS } = require('/app/node_modules/@emr/contracts/dist/index.js');
  console.log(FEATURE_KEYS.join(' '));
" 2>/dev/null | tr -d '\r')

if [ -z "$KNOWN" ]; then
  echo "        (could not read FEATURE_KEYS from the api container; skipping)"
else
  MISSING=""
  for key in $KNOWN; do
    # Each plan in the catalogue must MENTION the key. Its value is a pricing
    # decision and not this suite's business; its absence is a bug, because an
    # unset key is indistinguishable in the console from one somebody decided
    # against.
    GAPS=$(docker compose exec -T postgres psql -U "${POSTGRES_USER:-emr_migrator}" \
             -d "${POSTGRES_DB:-emr}" -At -q \
             -c "SELECT count(*) FROM plan WHERE NOT (features ? '$key');" 2>/dev/null | tr -d '\r')
    if [ "${GAPS:-0}" != "0" ]; then
      MISSING="$MISSING $key($GAPS)"
    fi
  done

  if [ -z "$MISSING" ]; then
    check "every plan mentions every known module" y y
  else
    check "every plan mentions every known module" y n "unpriced:$MISSING"
  fi
fi

echo "-- a clinic on the top tier can reach what it paid for --"
# The specific regression. `clinic-plus` is the everything tier, so a module
# missing there is a mistake rather than a pricing decision.
for key in pharmacy lab analytics reports billing documents; do
  ON=$(docker compose exec -T postgres psql -U "${POSTGRES_USER:-emr_migrator}" \
         -d "${POSTGRES_DB:-emr}" -At -q \
         -c "SELECT coalesce((features ->> '$key')::boolean, false) FROM plan WHERE code = 'clinic-plus';" \
         2>/dev/null | tr -d '\r')
  if [ "$ON" = "t" ] || [ "$ON" = "true" ]; then
    check "clinic-plus includes $key" y y
  else
    check "clinic-plus includes $key" y n "resolved to '${ON:-absent}'"
  fi
done

# And the dependency actually holds: analytics is gated on reports, so granting
# it on a plan without reports is a silent no-op rather than a grant.
ANALYTICS_OK=$(docker compose exec -T postgres psql -U "${POSTGRES_USER:-emr_migrator}" \
  -d "${POSTGRES_DB:-emr}" -At -q -c \
  "SELECT count(*) FROM plan WHERE (features->>'analytics')::boolean IS TRUE AND (features->>'reports')::boolean IS NOT TRUE;" \
  2>/dev/null | tr -d '\r')
check "no plan grants analytics without reports" 0 "${ANALYTICS_OK:-0}" \
  "analytics is gated on reports, so that grant resolves to off"

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
