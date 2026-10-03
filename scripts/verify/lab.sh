#!/usr/bin/env bash
#
# Lab orders and results.
#
# The one thing this module exists for is the UNREAD RESULT: a clinic that
# orders a test and never looks at what came back. So most of this suite is
# about the distinction between "a result arrived" and "a clinician read it",
# and about the two states never collapsing into one.
#
#   bash scripts/verify/lab.sh     (needs fixtures; see all.sh)
S="${TMPDIR:-/tmp}"
API="${API_BASE:-http://localhost:4000/v1}"

if [ -z "${VERIFY_DOMAIN:-}" ]; then
  echo "  This suite needs fixtures. Run it through scripts/verify/all.sh," >&2
  echo "  or: eval \"\$(node scripts/verify/fixtures.mjs up)\"" >&2
  exit 2
fi
J="$S/cookies.txt"; rm -f "$J"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

pass=0; fail=0
check() { # name expected actual [body]
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1));
  else echo "  FAIL  $1 (expected $2, got $3)"; echo "        ${4:0:300}"; fail=$((fail+1)); fi
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
login() { rm -f "$J"; req POST /auth/login "{\"email\":\"$1\",\"password\":\"$VERIFY_PASSWORD\"}"; }
jget()  { printf '%s' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
num()   { printf '%s' "$2" | grep -o "\"$1\":[0-9-]*" | head -1 | cut -d: -f2; }
count() { printf '%s' "$2" | grep -o "$1" | wc -l | tr -d ' '; }

echo "-- the catalogue --"
login doctor@$VERIFY_DOMAIN; check "login (doctor)" 201 "$CODE" "$BODY"

req GET '/lab/tests/search?q=cbc'
check "search the test catalogue" 200 "$CODE" "$BODY"
# CBC is a synonym, not the leading word, and must still come first. The same
# word-boundary ranking the diagnosis search needed for "urti".
FIRST=$(printf '%s' "$BODY" | tr '{' '\n' | grep '"name"' | head -1)
printf '%s' "$FIRST" | grep -qi 'complete blood count'   && check "cbc finds the complete blood count first" y y   || check "cbc finds the complete blood count first" y n

req GET '/lab/tests/search?q=hb'
printf '%s' "$BODY" | grep -qi 'Haemoglobin'   && check "hb finds haemoglobin" y y   || check "hb finds haemoglobin" y n
printf '%s' "$BODY" | grep -q '"referenceLow":12'   && check "and carries its reference range" y y   || check "and carries its reference range" y n
printf '%s' "$BODY" | grep -q '"unit":"g/dL"'   && check "and its unit" y y   || check "and its unit" y n

# A test name with regex metacharacters must not blow up or mismatch.
req GET '/lab/tests/search?q=T3'
check "a name with digits and slashes searches cleanly" 200 "$CODE" "$BODY"

echo "-- ordering --"
req GET '/patients?q=lakshmi'
PID=$(jget "$BODY" id)

req GET '/lab/tests/search?q=haemoglobin'
TEST=$(jget "$BODY" id)

req POST /lab/orders "{\"patientId\":\"$PID\",\"catalogueItemId\":\"$TEST\",\"testName\":\"Haemoglobin\",\"clinicalNote\":\"Rule out anaemia\",\"isUrgent\":false}"
check "order a haemoglobin" 201 "$CODE" "$BODY"
ORDER=$(jget "$BODY" id)
printf '%s' "$BODY" | grep -q '"status":"ORDERED"'   && check "it starts as ordered" y y   || check "it starts as ordered" y n
printf '%s' "$BODY" | grep -q '"unit":"g/dL"'   && check "the unit is copied from the catalogue onto the order" y y   || check "the unit is copied from the catalogue onto the order" y n

# FREE TEXT IS A FIRST-CLASS PATH, as it is for diagnoses and drugs. A doctor
# ordering something the catalogue does not list must be able to write it down
# rather than pick the nearest wrong test.
req POST /lab/orders "{\"patientId\":\"$PID\",\"testName\":\"Serum ceruloplasmin\",\"isUrgent\":false}"
check "order a test the catalogue does not have" 201 "$CODE" "$BODY"
FREEORDER=$(jget "$BODY" id)
printf '%s' "$BODY" | grep -q '"catalogueItemId":null'   && check "and it is stored uncatalogued, not refused" y y   || check "and it is stored uncatalogued, not refused" y n

echo "-- a result arriving is NOT somebody reading it --"
# The whole point of the module. If entering a result marked the order reviewed,
# the arrival of a result would count as a clinician having seen it.
req POST "/lab/orders/$ORDER/result" '{"valueNumeric":9.1,"performedBy":"Metropolis"}'
check "enter a low haemoglobin" 201 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q '"status":"RESULTED"'   && check "the order is RESULTED, not REVIEWED" y y   || check "the order is RESULTED, not REVIEWED" y n
printf '%s' "$BODY" | grep -q '"reviewedAt":null'   && check "and nobody has reviewed it" y y   || check "and nobody has reviewed it" y n

# 9.1 against a 12-16 range is LOW. Half a range-width below 12 is 10, so 9.1 is
# past that and reads as critical: a haemoglobin of 9 is not an afternoon's
# problem.
printf '%s' "$BODY" | grep -q '"interpretation":"CRITICAL"'   && check "9.1 against a 12-16 range reads as critical" y y   || check "9.1 against a 12-16 range reads as critical" y n
printf '%s' "$BODY" | grep -q '"referenceLow":12'   && check "the range is copied onto the result" y y   || check "the range is copied onto the result" y n

echo "-- the interpretation is the server's, not the caller's --"
# The same rule as the vitals: "is this dangerous" is a clinical assertion, and a
# field that says only what the caller claimed is worse than absent.
req POST /lab/orders "{\"patientId\":\"$PID\",\"catalogueItemId\":\"$TEST\",\"testName\":\"Haemoglobin\",\"isUrgent\":false}"
H2=$(jget "$BODY" id)
req POST "/lab/orders/$H2/result" '{"valueNumeric":13.5,"interpretation":"CRITICAL","referenceLow":12,"referenceHigh":16}'
check "enter a normal haemoglobin claiming it is critical" 201 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q '"interpretation":"NORMAL"'   && check "13.5 is NORMAL whatever the caller claimed" y y   || check "13.5 is NORMAL whatever the caller claimed" y n

req POST /lab/orders "{\"patientId\":\"$PID\",\"catalogueItemId\":\"$TEST\",\"testName\":\"Haemoglobin\",\"isUrgent\":false}"
H3=$(jget "$BODY" id)
req POST "/lab/orders/$H3/result" '{"valueNumeric":11.2}'
printf '%s' "$BODY" | grep -q '"interpretation":"LOW"'   && check "11.2 is LOW but not critical" y y   || check "11.2 is LOW but not critical" y n

echo "-- a qualitative result has no direction --"
req GET '/lab/tests/search?q=urine%20culture'
CULT=$(jget "$BODY" id)
req POST /lab/orders "{\"patientId\":\"$PID\",\"catalogueItemId\":\"$CULT\",\"testName\":\"Urine culture\",\"isUrgent\":false}"
CORDER=$(jget "$BODY" id)
req POST "/lab/orders/$CORDER/result" '{"valueText":"No growth after 48 hours"}'
check "enter a text result" 201 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q '"interpretation":"NORMAL"'   && check "no growth reads as normal" y y   || check "no growth reads as normal" y n

req POST /lab/orders "{\"patientId\":\"$PID\",\"testName\":\"Dengue NS1 antigen\",\"isUrgent\":true}"
DORDER=$(jget "$BODY" id)
req POST "/lab/orders/$DORDER/result" '{"valueText":"Positive"}'
printf '%s' "$BODY" | grep -q '"interpretation":"ABNORMAL"'   && check "positive reads as abnormal, with no direction" y y   || check "positive reads as abnormal, with no direction" y n

# A free-text report is not guessed at. Unflagged, and still in the review list.
req POST /lab/orders "{\"patientId\":\"$PID\",\"testName\":\"Chest X-ray\",\"isUrgent\":false}"
XORDER=$(jget "$BODY" id)
req POST "/lab/orders/$XORDER/result" '{"valueText":"Mild bronchial wall thickening in the right lower zone."}'
printf '%s' "$BODY" | grep -q '"interpretation":null'   && check "a narrative report is left unflagged, not guessed at" y y   || check "a narrative report is left unflagged, not guessed at" y n

echo "-- a result with no value at all is not a result --"
req POST /lab/orders "{\"patientId\":\"$PID\",\"testName\":\"ESR\",\"isUrgent\":false}"
EORDER=$(jget "$BODY" id)
req POST "/lab/orders/$EORDER/result" '{}'
check "an empty result is refused" 422 "$CODE" "$BODY"

echo "-- reviewing --"
req POST "/lab/orders/$ORDER/review"
check "review the critical haemoglobin" 201 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q '"status":"REVIEWED"'   && check "it is reviewed" y y   || check "it is reviewed" y n
printf '%s' "$BODY" | grep -q '"reviewedAt":null'   && check "and records when" n y   || check "and records when" n n

# Reviewing twice is a conflict, not a silent no-op: the first review is the
# fact, and a second would overwrite who read it and when.
req POST "/lab/orders/$ORDER/review"
check "reviewing an already-reviewed order is refused" 409 "$CODE" "$BODY"

# And there is nothing to review before a result arrives.
req POST "/lab/orders/$FREEORDER/review"
check "reviewing an order with no result is refused" 409 "$CODE" "$BODY"

echo "-- a correction supersedes, and un-reviews --"
# A lab that phones to correct a potassium does not change what was ordered, and
# overwriting in place would destroy the record of what the doctor acted on.
req POST "/lab/orders/$ORDER/result" '{"valueNumeric":10.4}'
check "a second result without a reason is refused" 409 "$CODE" "$BODY"

req POST "/lab/orders/$ORDER/result" '{"valueNumeric":10.4,"supersedesReason":"Lab rang: transcription error"}'
check "with a reason it is accepted" 201 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q '"valueNumeric":10.4'   && check "the live result is the corrected one" y y   || check "the live result is the corrected one" y n

# THE IMPORTANT ONE. The doctor signed off on 9.1; they have not seen 10.4.
# Leaving the order reviewed would hide a corrected value behind a tick somebody
# put there for the old one.
printf '%s' "$BODY" | grep -q '"status":"RESULTED"'   && check "correcting a reviewed result un-reviews the order" y y   || check "correcting a reviewed result un-reviews the order" y n
printf '%s' "$BODY" | grep -q '"reviewedAt":null'   && check "and clears who reviewed it" y y   || check "and clears who reviewed it" y n

req GET "/lab/orders/$ORDER/history"
check "the history is readable" 200 "$CODE" "$BODY"
check "both results are kept" 2 "$(count '"resultedAt"' "$BODY")" "$BODY"
printf '%s' "$BODY" | grep -qi 'transcription error'   && check "and the superseded one says why" y y   || check "and the superseded one says why" y n
# The ordinary read returns only the live one, so "the result" is never ambiguous.
req GET "/lab/orders/$ORDER"
check "the order read returns one result, not two" 1 "$(count '"resultedAt"' "$BODY")" "$BODY"

echo "-- one live result per order, enforced by the database --"
LIVE=$(docker compose -f "$ROOT/docker-compose.yml" exec -T postgres psql -q -U emr_migrator -d emr -t -A -c "SELECT set_config('app.clinic_id', '$VERIFY_CLINIC_ID', false)" -c "SELECT count(*) FROM lab_result WHERE lab_order_id = '$ORDER' AND superseded_at IS NULL" 2>&1 | tail -1 | sed "s/[[:space:]]*$//")
check "exactly one live result" 1 "$LIVE"

echo "-- cancelling --"
req POST "/lab/orders/$FREEORDER/cancel" '{"reason":"Patient declined"}'
check "cancel an order with no result" 201 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q '"status":"CANCELLED"'   && check "it is cancelled" y y   || check "it is cancelled" y n

# A resulted order is not cancellable: the result exists and may have been acted
# on, and cancelling would leave it attached to something never asked for.
req POST "/lab/orders/$ORDER/cancel" '{"reason":"Changed my mind"}'
check "an order with a result cannot be cancelled" 409 "$CODE" "$BODY"

# And a result cannot be attached to a cancelled order.
req POST "/lab/orders/$FREEORDER/result" '{"valueNumeric":1}'
check "a cancelled order cannot be resulted" 409 "$CODE" "$BODY"

echo "-- the results-to-review card --"
req GET /lab/review-summary
check "the summary loads" 200 "$CODE" "$BODY"
AWAITING=$(num awaitingReview "$BODY")
CRITICAL=$(num criticalAwaitingReview "$BODY")
ABNORMAL=$(num abnormalAwaitingReview "$BODY")
echo "        (awaiting=$AWAITING abnormal=$ABNORMAL critical=$CRITICAL)"
# The corrected haemoglobin (10.4, LOW), the dengue (ABNORMAL), the normal one,
# the 11.2 (LOW), the culture (NORMAL) and the X-ray (unflagged) are all unread.
[ "$AWAITING" -ge 5 ]   && check "every unread result is counted" y y   || check "every unread result is counted" y n
[ "$ABNORMAL" -ge 1 ] && [ "$ABNORMAL" -le "$AWAITING" ]   && check "the abnormal subset is a subset" y y   || check "the abnormal subset is a subset" y n
[ "$CRITICAL" -le "$ABNORMAL" ]   && check "and critical is a subset of abnormal" y y   || check "and critical is a subset of abnormal" y n

req GET '/lab/orders?awaiting=true'
check "the awaiting list loads" 200 "$CODE" "$BODY"
# Urgent first. The dengue was ordered urgent.
FIRSTORDER=$(printf '%s' "$BODY" | tr '{' '\n' | grep '"testName"' | head -1)
printf '%s' "$FIRSTORDER" | grep -qi 'dengue'   && check "the urgent order sorts first" y y   || check "the urgent order sorts first" y n
# Reviewed and cancelled orders are not in it.
printf '%s' "$BODY" | grep -q '"status":"CANCELLED"'   && check "a cancelled order is not awaiting anything" n y   || check "a cancelled order is not awaiting anything" n n

echo "-- who may do what --"
# A nurse types in a report that arrived on paper; deciding a test is needed is
# not a judgement they make.
login nurse@$VERIFY_DOMAIN; check "login (nurse)" 201 "$CODE" "$BODY"
req GET '/lab/orders?awaiting=true'
check "a nurse can read the lab list" 200 "$CODE" "$BODY"
req POST /lab/orders "{\"patientId\":\"$PID\",\"testName\":\"ESR\",\"isUrgent\":false}"
check "but cannot order a test" 403 "$CODE" "$BODY"
req POST "/lab/orders/$EORDER/result" '{"valueNumeric":30}'
check "and can enter a result" 201 "$CODE" "$BODY"

# A lab result is clinical content. Reception does not see it.
login reception@$VERIFY_DOMAIN
req GET '/lab/orders?awaiting=true'
check "reception cannot read lab results at all" 403 "$CODE" "$BODY"

login pharmacist@$VERIFY_DOMAIN
req GET '/lab/orders?awaiting=true'
check "nor can a pharmacist" 403 "$CODE" "$BODY"

login analyst@$VERIFY_DOMAIN
req GET '/lab/orders?awaiting=true'
check "nor a research analyst" 403 "$CODE" "$BODY"

echo "-- a patient's own results --"
login doctor@$VERIFY_DOMAIN
req GET "/lab/orders?patientId=$PID"
check "orders for one patient" 200 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q 'Haemoglobin'   && check "the haemoglobin is there" y y   || check "the haemoglobin is there" y n

req GET "/lab/orders/00000000-0000-0000-0000-000000000000"
check "an order that does not exist is a 404" 404 "$CODE" "$BODY"

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
