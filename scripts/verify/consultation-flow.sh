#!/usr/bin/env bash
#
# One consultation, front desk to signed prescription and paid invoice.
#
# This is the product's actual job, walked end to end by the four roles that do
# it, including the parts that must FAIL: reception opening a consultation, a
# doctor without a registration number signing one, a penicillin reaching a
# penicillin-allergic patient, and a signed record being edited.
#
#   API_BASE=http://localhost:4000/v1 bash scripts/verify/consultation-flow.sh
S="${TMPDIR:-/tmp}"
API="${API_BASE:-http://localhost:4000/v1}"
J="$S/flow-cookies.txt"; rm -f "$J"

pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1));
  else echo "  FAIL  $1 (expected $2, got $3)"; echo "        ${4:0:300}"; fail=$((fail+1)); fi
}
req() {
  local m=$1 p=$2 d=${3:-} h=${4:-} out
  if [ -n "$d" ]; then
    out=$(curl -s -b "$J" -c "$J" -w $'\n%{http_code}' -X "$m" "$API$p" \
      -H 'Content-Type: application/json' ${h:+-H "$h"} -d "$d")
  else
    out=$(curl -s -b "$J" -c "$J" -w $'\n%{http_code}' -X "$m" "$API$p" ${h:+-H "$h"})
  fi
  CODE="${out##*$'\n'}"; BODY="${out%$'\n'*}"
}
login() { rm -f "$J"; req POST /auth/login "{\"email\":\"$1\",\"password\":\"demo1234\"}"; }
jget()  { printf '%s' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
jnum()  { printf '%s' "$1" | grep -o "\"$2\":[0-9]*"     | head -1 | cut -d: -f2; }

STAMP=$(date +%s)

echo "-- the receptionist registers a patient --"
login priya.k@sunriseclinic.in

# Search before create. The server refuses a registration without proof a
# duplicate check ran, so this is not optional set-up — it is the workflow.
req GET "/patients/duplicates?mobile=%2B919812340000&name=Test%20Patient%20$STAMP"
check "duplicate check" 200 "$CODE" "$BODY"
TOKEN=$(jget "$BODY" searchToken)
[ -n "$TOKEN" ] && check "duplicate check issues a search token" y y \
                || check "duplicate check issues a search token" y n

req POST /patients "{
  \"fullName\":\"Test Patient $STAMP\",
  \"mobileE164\":\"+919812340000\",
  \"gender\":\"FEMALE\",
  \"dateOfBirth\":\"1990-05-11\",
  \"searchToken\":\"$TOKEN\"
}"
check "register a patient" 201 "$CODE" "$BODY"
NEW_PID=$(jget "$BODY" id)
MRN=$(jget "$BODY" mrn)
echo "        mrn: ${MRN:-<none>}"

echo "-- registration without a search token is refused --"
req POST /patients "{
  \"fullName\":\"Unsearched $STAMP\",\"mobileE164\":\"+919812340001\",
  \"gender\":\"MALE\",\"dateOfBirth\":\"1990-05-11\",\"searchToken\":\"made-up\"
}"
check "search-before-create is enforced server-side" 422 "$CODE" "$BODY"

echo "-- the receptionist puts them in the queue --"
req POST /queue "{\"patientId\":\"$NEW_PID\",\"practitionerId\":null,\"reasonText\":\"Fever and sore throat\"}"
check "add to queue" 201 "$CODE" "$BODY"
req GET /queue
printf '%s' "$BODY" | grep -q "$NEW_PID" \
  && check "the patient appears in the live queue" y y \
  || check "the patient appears in the live queue" y n

echo "-- reception may not open a consultation --"
req POST /encounters "{\"patientId\":\"$NEW_PID\"}"
check "reception refused encounter:create" 403 "$CODE" "$BODY"

echo "-- the nurse records vitals --"
login fatima.s@sunriseclinic.in
req POST /observations "{
  \"patientId\":\"$NEW_PID\",\"encounterId\":null,
  \"code\":\"8310-5\",\"display\":\"Temperature\",
  \"valueNumeric\":38.6,\"valueUnit\":\"Cel\",\"valueText\":null
}"
check "nurse records a temperature" 201 "$CODE" "$BODY"

echo "-- the doctor consults --"
login anjali.mehta@sunriseclinic.in
req POST /encounters "{\"patientId\":\"$NEW_PID\"}"
check "open a consultation" 201 "$CODE" "$BODY"
# Asserted here, on a patient registered seconds ago, because opening a
# consultation RESUMES an existing draft rather than starting a second one —
# so this is the only point in the run where the encounter is certainly new.
printf '%s' "$BODY" | grep -q '"consultationMode":"IN_PERSON"'   && check "a new consultation defaults to in person" y y   || check "a new consultation defaults to in person" y n
ENC=$(jget "$BODY" id)
VER=$(jnum "$BODY" version)

req PATCH "/encounters/$ENC" \
  '{"chiefComplaint":"Fever and sore throat, 3 days","assessment_notes":null}' \
  "If-Match: ${VER:-1}"
check "save the draft" 200 "$CODE" "$BODY"
VER=$(jnum "$BODY" version)

req GET "/patients/$NEW_PID/snapshot"
printf '%s' "$BODY" | grep -qi "38.6" \
  && check "the vitals the nurse took are on the snapshot" y y \
  || check "the vitals the nurse took are on the snapshot" y n

echo "-- prescribing --"
req GET '/drugs/search?q=azithral'
DRUG=$(jget "$BODY" id)
if [ -n "$DRUG" ]; then CAT="\"$DRUG\""; else CAT=null; fi
req POST "/encounters/$ENC/prescriptions" "{
  \"catalogueItemId\":$CAT,
  \"drugDisplayName\":\"Azithral 500\",\"moleculeName\":\"Azithromycin\",
  \"strength\":\"500 mg\",\"dosageForm\":\"Tablet\",\"route\":\"Oral\",
  \"frequency\":\"1-0-0\",\"timingRelativeToFood\":\"AFTER_FOOD\",\"durationDays\":3
}"
check "add a prescription line" 201 "$CODE" "$BODY"
LINE=$(jget "$BODY" id)

req GET "/encounters/$ENC/prescriptions"
check "read back the prescription" 200 "$CODE" "$BODY"

echo "-- the allergy gate --"
# Lakshmi Narayanan is HIGH-criticality penicillin-allergic. Amoxicillin is a
# penicillin under a brand name that does not contain the word. This is the one
# thing the system must not let through quietly.
req GET '/patients?q=lakshmi'
LAK=$(jget "$BODY" id)
req POST /encounters "{\"patientId\":\"$LAK\"}"
LENC=$(jget "$BODY" id)

req POST "/encounters/$LENC/prescriptions" '{
  "drugDisplayName":"Mox 500","moleculeName":"Amoxicillin","strength":"500 mg",
  "dosageForm":"Capsule","route":"Oral","frequency":"1-0-1","durationDays":5
}'
check "a penicillin for a penicillin-allergic patient is refused" 422 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -qi penicillin   && check "the refusal names the allergy" y y   || check "the refusal names the allergy" y n
printf '%s' "$BODY" | grep -q ALLERGY_CLASS   && check "amoxicillin is matched to penicillin by class" y y   || check "amoxicillin is matched to penicillin by class" y n

# The doctor may proceed, but only on the record.
req POST "/encounters/$LENC/prescriptions" '{
  "drugDisplayName":"Mox 500","moleculeName":"Amoxicillin","strength":"500 mg",
  "dosageForm":"Capsule","route":"Oral","frequency":"1-0-1","durationDays":5,
  "safetyOverrideReason":"Discussed with patient; previous reaction mild, 20 years ago."
}'
check "an override with a written reason is accepted" 201 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q ALLERGY_CLASS   && check "the warning is stored on the prescription as evidence" y y   || check "the warning is stored on the prescription as evidence" y n

# A safe antibiotic for the same patient must not warn.
req POST "/encounters/$LENC/prescriptions" '{
  "drugDisplayName":"Azithral 500","moleculeName":"Azithromycin","strength":"500 mg",
  "dosageForm":"Tablet","route":"Oral","frequency":"1-0-0","durationDays":3
}'
check "a safe alternative is accepted" 201 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q ALLERGY   && check "no spurious allergy warning on the safe alternative" n y   || check "no spurious allergy warning on the safe alternative" n n

# Prescribing the same molecule twice should advise, not block.
req POST "/encounters/$LENC/prescriptions" '{
  "drugDisplayName":"Azee 500","moleculeName":"Azithromycin","strength":"500 mg",
  "dosageForm":"Tablet","route":"Oral","frequency":"1-0-0","durationDays":3
}'
check "a duplicate molecule is still accepted" 201 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q DUPLICATE_THERAPY   && check "duplicate therapy is flagged" y y   || check "duplicate therapy is flagged" y n

echo "-- the teleconsultation prohibition --"
# Schedule X in a remote consultation is barred by law, not by clinical
# judgement, so unlike the allergy gate it has NO override. The same drug at an
# in-person visit is fine, which is what makes the flag worth carrying.
req GET '/patients?q=arjun'
TP=$(jget "$BODY" id)

req POST /encounters "{\"patientId\":\"$TP\"}"
TENC=$(jget "$BODY" id)

# Normalise, because this patient's draft survives between runs and the previous
# run left it remote. The test is about the TRANSITION, so it sets its start.
req GET "/encounters/$TENC"
TV=$(jnum "$BODY" version)
req PATCH "/encounters/$TENC" '{"consultationMode":"IN_PERSON"}' "If-Match: ${TV:-1}"
printf '%s' "$BODY" | grep -q '"consultationMode":"IN_PERSON"'   && check "a remote consultation can be moved back to in person" y y   || check "a remote consultation can be moved back to in person" y n

req POST "/encounters/$TENC/prescriptions" '{
  "drugDisplayName":"Alprax 0.25","moleculeName":"Alprazolam","strength":"0.25 mg",
  "dosageForm":"Tablet","route":"Oral","frequency":"0-0-1","durationDays":5
}'
check "Schedule X is allowed at an in-person visit" 201 "$CODE" "$BODY"

req GET "/encounters/$TENC"
TV=$(jnum "$BODY" version)
req PATCH "/encounters/$TENC" '{"consultationMode":"TELECONSULTATION"}' "If-Match: ${TV:-1}"
check "a draft can be switched to remote" 200 "$CODE" "$BODY"

# With an override reason, which must make no difference whatsoever.
req POST "/encounters/$TENC/prescriptions" '{
  "drugDisplayName":"Alprax 0.25","moleculeName":"Alprazolam","strength":"0.25 mg",
  "dosageForm":"Tablet","route":"Oral","frequency":"0-0-1","durationDays":5,
  "safetyOverrideReason":"Long-term stable patient, I accept responsibility."
}'
check "Schedule X is refused in a teleconsultation" 422 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q '"overridable":false'   && check "and a written reason cannot override it" y y   || check "and a written reason cannot override it" y n
printf '%s' "$BODY" | grep -qi "in-person"   && check "the refusal says what the doctor CAN do" y y   || check "the refusal says what the doctor CAN do" y n

# A non-prohibited medicine on the same remote consultation must still work.
req POST "/encounters/$TENC/prescriptions" '{
  "drugDisplayName":"Crocin 650","moleculeName":"Paracetamol","strength":"650 mg",
  "dosageForm":"Tablet","route":"Oral","frequency":"1-1-1","durationDays":3
}'
check "an ordinary medicine is unaffected by the mode" 201 "$CODE" "$BODY"

echo "-- finalising --"
req POST "/encounters/$ENC/finalise" "" "If-Match: ${VER:-1}"
check "finalise the consultation" 201 "$CODE" "$BODY"

req PATCH "/encounters/$ENC" '{"chiefComplaint":"tampered"}' "If-Match: 99"
[ "$CODE" = "200" ] && check "a finalised consultation cannot be edited" refused allowed "$BODY" \
                    || check "a finalised consultation cannot be edited" refused refused

echo "-- the doctor without a registration number cannot sign --"
login rakesh.iyer@sunriseclinic.in
req POST /encounters "{\"patientId\":\"$NEW_PID\"}"
RENC=$(jget "$BODY" id)
req POST "/encounters/$RENC/finalise" "" "If-Match: 1"
check "an unregistered doctor is refused at signing" 403 "$CODE" "$BODY"

echo "-- an approved template is sendable in the inbox, window or not --"
login priya.k@sunriseclinic.in
req GET /whatsapp/templates
TPL=$(jget "$BODY" id)

req GET /inbox/conversations
# The first conversation that is neither opted out nor closed.
CONV=$(printf '%s' "$BODY" | tr '}' '
' | grep -v '"isOptedOut":true' | grep -o '"id":"[0-9a-f-]\{36\}"' | head -1 | cut -d'"' -f4)

if [ -n "$TPL" ] && [ -n "$CONV" ]; then
  # A template, INSIDE the open window. This is the case that used to be
  # unreachable: templates were offered only once the window had closed.
  req POST "/inbox/conversations/$CONV/reply"     "{\"templateId\":\"$TPL\",\"templateVariables\":{\"1\":\"Sunita\",\"2\":\"1 November\"}}"
  check "a template sends inside an open window" 201 "$CODE" "$BODY"
  printf '%s' "$BODY" | grep -q '"messageKind":"TEMPLATE"'     && check "it is recorded as a template" y y     || check "it is recorded as a template" y n
  printf '%s' "$BODY" | grep -q 'Namaste Sunita'     && check "the stored body is FILLED, not the raw placeholders" y y     || check "the stored body is FILLED, not the raw placeholders" y n
  printf '%s' "$BODY" | grep -q '"status":"SENT"'     && check "it is actually dispatched, not left queued" y y     || check "it is actually dispatched, not left queued" y n

  # Free text also has to really go out — it used to be written QUEUED and
  # dropped, with the interface showing a sent message.
  req POST "/inbox/conversations/$CONV/reply" '{"body":"See you then."}'
  check "free text sends inside the window" 201 "$CODE" "$BODY"
  printf '%s' "$BODY" | grep -q '"status":"SENT"'     && check "and is dispatched too" y y     || check "and is dispatched too" y n
else
  check "a template and a conversation exist to test with" y n
fi

echo "-- billing --"
login priya.k@sunriseclinic.in
req POST /invoices "{\"patientId\":\"$NEW_PID\",\"lineItems\":[{\"description\":\"New consultation\",\"quantity\":1,\"unitPricePaise\":60000,\"amountPaise\":60000}]}"
check "raise an invoice" 201 "$CODE" "$BODY"
INV=$(jget "$BODY" id)
if [ -n "$INV" ]; then
  req POST "/invoices/$INV/payments" "{\"amountPaise\":60000,\"method\":\"CASH\",\"idempotencyKey\":\"pay-$STAMP\"}"
  check "record a payment" 201 "$CODE" "$BODY"
fi

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
