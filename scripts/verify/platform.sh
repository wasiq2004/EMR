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

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
