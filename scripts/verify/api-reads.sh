#!/usr/bin/env bash
#
# Reads, authentication and role separation, against a running API.
#
# These run against a REAL server and a REAL database on purpose. Every bug this
# suite was written to catch — RLS refusing a write the type checker was happy
# with, a cookie that is never read because Nest middleware sees the raw Node
# request, a timestamp that arrives as a string from a raw query — compiles
# cleanly and passes a unit test with a mocked database.
#
#   API_BASE=http://localhost:4000/v1 bash scripts/verify/api-reads.sh
S="${TMPDIR:-/tmp}"
API="${API_BASE:-http://localhost:4000/v1}"
J="$S/cookies.txt"; rm -f "$J"

pass=0; fail=0
check() { # name expected actual [body]
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1));
  else echo "  FAIL  $1 (expected $2, got $3)"; echo "        ${4:0:260}"; fail=$((fail+1)); fi
}
req() { # method path [data] -> CODE, BODY
  local m=$1 p=$2 d=${3:-} out
  if [ -n "$d" ]; then
    out=$(curl -s -b "$J" -c "$J" -w $'\n%{http_code}' -X "$m" "$API$p" -H 'Content-Type: application/json' -d "$d")
  else
    out=$(curl -s -b "$J" -c "$J" -w $'\n%{http_code}' -X "$m" "$API$p")
  fi
  CODE="${out##*$'\n'}"; BODY="${out%$'\n'*}"
}
login() { rm -f "$J"; req POST /auth/login "{\"email\":\"$1\",\"password\":\"demo1234\"}"; }

echo "-- health --"
req GET /healthz; check "healthz" 200 "$CODE" "$BODY"
req GET /readyz;  check "readyz"  200 "$CODE" "$BODY"

echo "-- an anonymous caller gets nothing --"
req GET /patients; check "patients denied when signed out" 401 "$CODE" "$BODY"

echo "-- sign in --"
login anjali.mehta@sunriseclinic.in; check "login (doctor)" 201 "$CODE" "$BODY"
req POST /auth/login '{"email":"anjali.mehta@sunriseclinic.in","password":"wrong-password"}'
check "a wrong password is refused" 401 "$CODE" "$BODY"
login anjali.mehta@sunriseclinic.in
req GET /auth/me; check "auth/me" 200 "$CODE" "$BODY"

echo "-- reads the doctor is entitled to --"
for p in /patients /nav/counts /queue /tasks '/drugs/search?q=amox' /invoices /reports/summary \
         /clinic /services /locations /documents /inbox/conversations /encounter-templates \
         /prescription-templates /whatsapp/account /users /exports; do
  req GET "$p"; check "GET $p" 200 "$CODE" "$BODY"
done

echo "-- the seeded fixtures are reachable --"
req GET '/drugs/search?q=amox'
printf '%s' "$BODY" | grep -qi amoxicillin \
  && check "drug search finds amoxicillin" y y || check "drug search finds amoxicillin" y n

req GET '/patients?q=lakshmi'; check "search by name" 200 "$CODE" "$BODY"
PID=$(printf '%s' "$BODY" | grep -o '"id":"[0-9a-f-]\{36\}"' | head -1 | cut -d'"' -f4)
if [ -n "$PID" ]; then
  req GET "/patients/$PID";           check "patient detail"   200 "$CODE" "$BODY"
  req GET "/patients/$PID/visits";    check "patient visits"   200 "$CODE" "$BODY"
  req GET "/patients/$PID/allergies"; check "patient allergies" 200 "$CODE" "$BODY"
  printf '%s' "$BODY" | grep -qi penicillin \
    && check "the penicillin allergy is on the record" y y \
    || check "the penicillin allergy is on the record" y n
  req GET "/patients/$PID/snapshot";  check "patient snapshot" 200 "$CODE" "$BODY"
else
  check "search returned a patient id" y n
fi

req GET '/patients?q=9876543210'
N=$(printf '%s' "$BODY" | grep -o '"mrn"' | wc -l)
check "the shared number returns all three family members" 3 "$N" "$BODY"

echo "-- roles are separated --"
req GET /audit-events; check "a doctor may not read the audit trail" 403 "$CODE" "$BODY"
req GET /imports;      check "a doctor may not run an import"        403 "$CODE" "$BODY"

login compliance@sunriseclinic.in; check "login (auditor)" 201 "$CODE" "$BODY"
req GET /audit-events; check "an auditor may read the audit trail" 200 "$CODE" "$BODY"
req GET /patients;     check "an auditor may not read patients"    403 "$CODE" "$BODY"

login priya.k@sunriseclinic.in; check "login (receptionist)" 201 "$CODE" "$BODY"
req GET /patients;     check "a receptionist may read patients" 200 "$CODE" "$BODY"
req GET /audit-events; check "a receptionist may not read the audit trail" 403 "$CODE" "$BODY"

echo "-- the audit trail actually recorded all of this --"
login compliance@sunriseclinic.in
req GET /audit-events
N=$(printf '%s' "$BODY" | grep -o '"action"' | wc -l)
[ "$N" -gt 0 ] && check "audit events were written" y y || check "audit events were written" y n

echo "-- sign out --"
login anjali.mehta@sunriseclinic.in
req POST /auth/logout; check "logout" 204 "$CODE" "$BODY"
req GET /patients;     check "denied again after logout" 401 "$CODE" "$BODY"

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
