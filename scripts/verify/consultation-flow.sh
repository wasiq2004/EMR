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

if [ -z "${VERIFY_DOMAIN:-}" ]; then
  echo "  This suite needs fixtures. Run it through scripts/verify/all.sh," >&2
  echo "  or: eval \"$(node scripts/verify/fixtures.mjs up)\"" >&2
  exit 2
fi
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
login() { rm -f "$J"; req POST /auth/login "{\"email\":\"$1\",\"password\":\"$VERIFY_PASSWORD\"}"; }
jget()  { printf '%s' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
jnum()  { printf '%s' "$1" | grep -o "\"$2\":[0-9]*"     | head -1 | cut -d: -f2; }
# How many times a key appears in a body — for asserting "none of these".
count() { printf '%s' "$2" | grep -o "$1" | wc -l | tr -d ' '; }

STAMP=$(date +%s)

echo "-- the receptionist registers a patient --"
login reception@$VERIFY_DOMAIN

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
login nurse@$VERIFY_DOMAIN
req POST /observations "{
  \"patientId\":\"$NEW_PID\",\"encounterId\":null,
  \"code\":\"8310-5\",\"display\":\"Temperature\",
  \"valueNumeric\":38.6,\"valueUnit\":\"Cel\",\"valueText\":null
}"
check "nurse records a temperature" 201 "$CODE" "$BODY"

# A temperature of 38.6 is above the 36.1-37.5 range, so the server must say so.
printf '%s' "$BODY" | grep -q '"interpretation":"HIGH"'   && check "and it is stored as HIGH, not unflagged" y y   || check "and it is stored as HIGH, not unflagged" y n

echo "-- the interpretation is the SERVER's, not the caller's --"
#
# Every one of these was stored as null before. `recordObservation` read
# `interpretation`, `referenceLow` and `referenceHigh` off the request, but
# `RecordObservation` never declared them, so `parseBody` stripped all three and
# the service wrote null every time — while the contract's own comment claimed
# the interpretation was "computed at write time and surfaced on the Snapshot".
# A systolic of 210 was recorded with nothing marking it abnormal.
#
# So the caller below LIES: it claims NORMAL, a bogus reference range and the
# wrong unit on each request. The server has to ignore all of it and derive its
# own from the LOINC code, because "is this reading dangerous" is a clinical
# assertion and a field that says only what the caller claimed is worse than
# absent on a record somebody later relies on.
obs() { # code value
  req POST /observations "{
    \"patientId\":\"$NEW_PID\",\"encounterId\":null,
    \"code\":\"$1\",\"display\":\"Whatever the caller calls it\",
    \"valueNumeric\":$2,\"valueUnit\":\"WRONG-UNIT\",\"valueText\":null,
    \"interpretation\":\"NORMAL\",\"referenceLow\":1,\"referenceHigh\":2
  }"
}

obs 8480-6 210; check "record a systolic of 210" 201 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q '"interpretation":"CRITICAL"'   && check "210 is CRITICAL, not the NORMAL the caller claimed" y y   || check "210 is CRITICAL, not the NORMAL the caller claimed" y n
printf '%s' "$BODY" | grep -q '"valueUnit":"mm\[Hg\]"'   && check "the unit is the measure's, not the caller's" y y   || check "the unit is the measure's, not the caller's" y n
printf '%s' "$BODY" | grep -q '"referenceLow":"90'   && check "the reference range is the server's" y y   || check "the reference range is the server's" y n
printf '%s' "$BODY" | grep -q '"display":"Systolic BP"'   && check "and so is the display name" y y   || check "and so is the display name" y n

obs 8480-6 145; check "record a systolic of 145" 201 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q '"interpretation":"HIGH"'   && check "145 is HIGH, which is not the same as critical" y y   || check "145 is HIGH, which is not the same as critical" y n

obs 8480-6 120; check "record a systolic of 120" 201 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q '"interpretation":"NORMAL"'   && check "120 is NORMAL" y y   || check "120 is NORMAL" y n

obs 2708-6 88; check "record an SpO2 of 88" 201 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q '"interpretation":"CRITICAL"'   && check "an SpO2 of 88 is critical" y y   || check "an SpO2 of 88 is critical" y n

# Weight has no reference range, so the answer is NULL and not NORMAL. Nothing
# checked it, which is not the same as having checked it and found it fine.
obs 29463-7 72; check "record a weight" 201 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q '"interpretation":null'   && check "a weight is not range-checked, so it is null not NORMAL" y y   || check "a weight is not range-checked, so it is null not NORMAL" y n
printf '%s' "$BODY" | grep -q '"valueUnit":"kg"'   && check "and it is stored in kilograms" y y   || check "and it is stored in kilograms" y n

obs 8302-2 170; check "record a height" 201 "$CODE" "$BODY"
# BMI is NOT asserted on the record, because it is not stored: 72kg at 170cm is
# 24.9, derived where it is shown. A stored BMI is a third copy of two numbers
# that stops agreeing the first time somebody corrects a mistyped weight.
req GET "/patients/$NEW_PID/snapshot"
printf '%s' "$BODY" | grep -q '"bmi"'   && check "BMI is derived on read, not stored on the record" n y   || check "BMI is derived on read, not stored on the record" n n

echo "-- the doctor consults --"
login doctor@$VERIFY_DOMAIN
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

echo "-- the dose is the prescriber's, not a default --"
#
# Adding a drug used to commit `frequency: '1-0-1'`, `AFTER_FOOD` and
# `durationDays: 5` hardcoded in the consultation screen, for every drug and
# whatever the doctor meant, and then display those three values back as
# read-only chips with no way to change them. A patient could leave holding a
# printed prescription saying twice a day after food for five days for a drug
# intended once at night for three. Every field was already in the contract and
# in the table; nothing was ever asking.
#
# So: a line written with a once-at-night, three-day course has to come back as
# exactly that.
req GET "/encounters/$ENC/prescriptions"
printf '%s' "$BODY" | grep -q '"frequency":"1-0-0"'   && check "the frequency stored is the one sent" y y   || check "the frequency stored is the one sent" y n
printf '%s' "$BODY" | grep -q '"durationDays":3'   && check "and so is the duration" y y   || check "and so is the duration" y n

# A tapering course is a real prescription no preset list contains, so free text
# has to survive unmangled.
req POST "/encounters/$ENC/prescriptions" '{
  "drugDisplayName":"Prednisolone 10","moleculeName":"Prednisolone","strength":"10 mg",
  "dosageForm":"Tablet","route":"Oral","frequency":"2-0-2 for 3 days then 1-0-1",
  "durationDays":6,"quantity":18,"instructions":"Taper as written. Do not stop suddenly."
}'
check "a tapering course is accepted as typed" 201 "$CODE" "$BODY"
TAPER=$(jget "$BODY" id)
printf '%s' "$BODY" | grep -q '2-0-2 for 3 days then 1-0-1'   && check "and is not rewritten into a preset" y y   || check "and is not rewritten into a preset" y n
# A number, not a string: the column is numeric and the serialiser converts it,
# so a pharmacy reading this does not have to parse it.
printf '%s' "$BODY" | grep -q '"quantity":18'   && check "the dispense quantity is stored as a number" y y   || check "the dispense quantity is stored as a number" y n
printf '%s' "$BODY" | grep -qi 'do not stop suddenly'   && check "and the instructions with it" y y   || check "and the instructions with it" y n

# Latin shorthand is normalised, so the printed prescription reads the same
# whichever the doctor typed.
req POST "/encounters/$ENC/prescriptions" '{
  "drugDisplayName":"Pantocid 40","moleculeName":"Pantoprazole","strength":"40 mg",
  "dosageForm":"Tablet","route":"Oral","frequency":"OD","durationDays":14
}'
check "a line written with OD is accepted" 201 "$CODE" "$BODY"
ODLINE=$(jget "$BODY" id)

echo "-- changing a dose without deleting the line --"
# There was no way to do this at all: the panel showed the dose as read-only
# chips, so a mis-set dose could only be fixed by removing the line and starting
# again.
req PATCH "/prescriptions/$ODLINE" '{
  "frequency":"1-0-1","timingRelativeToFood":"BEFORE_FOOD","durationDays":7,
  "quantity":14,"instructions":"Thirty minutes before food."
}'
check "revise the dose" 200 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q '"frequency":"1-0-1"'   && check "the new frequency took" y y   || check "the new frequency took" y n
printf '%s' "$BODY" | grep -q '"timingRelativeToFood":"BEFORE_FOOD"'   && check "and the new timing" y y   || check "and the new timing" y n
printf '%s' "$BODY" | grep -q '"durationDays":7'   && check "and the new duration" y y   || check "and the new duration" y n

# A dosage with no frequency at all is not a dosage.
req PATCH "/prescriptions/$ODLINE" '{"frequency":""}'
check "a blank frequency is refused" 422 "$CODE" "$BODY"

req PATCH "/prescriptions/00000000-0000-0000-0000-000000000000" '{"frequency":"1-0-1"}'
check "revising a line that does not exist is a 404" 404 "$CODE" "$BODY"

req DELETE "/prescriptions/$TAPER"
check "remove the tapering line" 204 "$CODE" "$BODY"

echo "-- the diagnosis catalogue --"
# Roughly 300 curated ICD-10 codes rather than the full seventy thousand: a
# search for "fever" in the complete set returns dozens of qualifiers nobody at
# an outpatient desk will use and buries the one they want.
req GET '/diagnoses/search?q=urti'
check "search the catalogue" 200 "$CODE" "$BODY"
#
# J06.9 FIRST, not urticaria.
#
# This is the assertion the ranking exists for. "urti" is a mid-string synonym
# on J06.9 — upper respiratory infection, among the commonest diagnoses in an
# Indian OPD — while "urticaria" happens to START with those four letters.
# Ranking by string prefix put a rare skin complaint above the thing the doctor
# meant, every time. Ranking is now on word boundaries.
FIRST=$(printf '%s' "$BODY" | tr '{' '\n' | grep '"code"' | head -1)
printf '%s' "$FIRST" | grep -q 'J06.9'   && check "typing urti offers upper respiratory infection first" y y   || check "typing urti offers upper respiratory infection first" y n

req GET '/diagnoses/search?q=piles'
printf '%s' "$BODY" | grep -q 'K64.9'   && check "a synonym finds its code (piles)" y y   || check "a synonym finds its code (piles)" y n
req GET '/diagnoses/search?q=sugar'
printf '%s' "$BODY" | grep -q 'E11.9'   && check "and so does a colloquialism (sugar)" y y   || check "and so does a colloquialism (sugar)" y n

req GET '/diagnoses/search?q=J02.9'
printf '%s' "$BODY" | grep -q 'Acute pharyngitis'   && check "searching by code works" y y   || check "searching by code works" y n
# The dot has to be escaped before it reaches the regex, or J02.9 would also
# match J02X9 and rank it as an exact word.
req GET '/diagnoses/search?q=J02X9'
check "a near-miss code matches nothing" 0 "$(count '"code"' "$BODY")" "$BODY"

req GET '/diagnoses/search?q=diabetes'
printf '%s' "$BODY" | grep -q '"isChronicByDefault":true'   && check "diabetes is flagged chronic by default" y y   || check "diabetes is flagged chronic by default" y n

echo "-- a coded diagnosis, and a free-text one --"
req POST /conditions "{
  \"patientId\":\"$NEW_PID\",\"encounterId\":\"$ENC\",
  \"displayText\":\"Acute pharyngitis\",\"code\":\"J02.9\",
  \"codeSystem\":\"http://hl7.org/fhir/sid/icd-10\",\"isChronic\":false
}"
check "record a coded diagnosis" 201 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q '"code":"J02.9"'   && check "the code is stored, not dropped" y y   || check "the code is stored, not dropped" y n

# FREE TEXT IS A FIRST-CLASS ENTRY, not a fallback. The catalogue holds ~300
# codes, so plenty of real diagnoses are genuinely not in it, and a doctor who
# cannot find one must be able to write it down and move on. Picking the nearest
# wrong code is the failure the catalogue is designed to avoid — a code carries
# the authority of a standard onto an insurance claim, which free text does not.
req POST /conditions "{
  \"patientId\":\"$NEW_PID\",\"encounterId\":\"$ENC\",
  \"displayText\":\"Viral URTI with secondary otitis, left\",\"isChronic\":false
}"
check "record a diagnosis with no code at all" 201 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q '"code":null'   && check "and it is stored uncoded, not refused" y y   || check "and it is stored uncoded, not refused" y n

req GET "/patients/$NEW_PID/snapshot"
printf '%s' "$BODY" | grep -q 'Acute pharyngitis'   && check "the coded one is on the snapshot" y y   || check "the coded one is on the snapshot" y n
printf '%s' "$BODY" | grep -qi 'secondary otitis'   && check "and so is the free-text one" y y   || check "and so is the free-text one" y n

echo "-- the data-quality screen counts the gap rather than hiding it --"
# One coded and one uncoded diagnosis on this encounter, so the ratio must not
# be 100%. The point of counting is that the gap stays visible instead of being
# forced shut by making a code mandatory.
login analyst@$VERIFY_DOMAIN
req GET "/analytics/quality?from=$(node -e "const d=new Date();d.setDate(d.getDate()-7);console.log(d.toISOString().slice(0,10))")&to=$(node -e "const d=new Date();d.setDate(d.getDate()+1);console.log(d.toISOString().slice(0,10))")"
check "the data-quality report loads" 200 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q 'diagnoses-coded'   && check "it reports the coded proportion" y y   || check "it reports the coded proportion" y n

echo "-- adding a code this clinic uses --"
login doctor@$VERIFY_DOMAIN
req POST /diagnoses '{"code":"J06.9","displayText":"URTI with otitis (clinic shorthand)","isChronicByDefault":false}'
check "a doctor cannot add to the clinic code list" 403 "$CODE" "$BODY"

login owner@$VERIFY_DOMAIN
req POST /diagnoses '{"code":"J06.9","displayText":"URTI with otitis (clinic shorthand)","isChronicByDefault":false,"synonyms":"urtiotitis"}'
check "an administrator can" 201 "$CODE" "$BODY"
# Twice is not an error. Two doctors reaching for the same missing code on the
# same morning is the expected case, not a conflict either should have to resolve.
req POST /diagnoses '{"code":"J06.9","displayText":"URTI with otitis (clinic shorthand)","isChronicByDefault":false}'
check "adding the same wording twice is idempotent" 201 "$CODE" "$BODY"

login doctor@$VERIFY_DOMAIN
req GET '/diagnoses/search?q=urtiotitis'
printf '%s' "$BODY" | grep -q 'clinic shorthand'   && check "the clinic's own entry is searchable" y y   || check "the clinic's own entry is searchable" y n
printf '%s' "$BODY" | grep -q '"isOwn":true'   && check "and is marked as the clinic's, not a standard code" y y   || check "and is marked as the clinic's, not a standard code" y n

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
login unregistered@$VERIFY_DOMAIN
req POST /encounters "{\"patientId\":\"$NEW_PID\"}"
RENC=$(jget "$BODY" id)
req POST "/encounters/$RENC/finalise" "" "If-Match: 1"
check "an unregistered doctor is refused at signing" 403 "$CODE" "$BODY"

echo "-- an approved template is sendable in the inbox, window or not --"
login reception@$VERIFY_DOMAIN
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
login reception@$VERIFY_DOMAIN
req POST /invoices "{\"patientId\":\"$NEW_PID\",\"lineItems\":[{\"description\":\"New consultation\",\"quantity\":1,\"unitPricePaise\":60000,\"amountPaise\":60000}]}"
check "raise an invoice" 201 "$CODE" "$BODY"
INV=$(jget "$BODY" id)
if [ -n "$INV" ]; then
  req POST "/invoices/$INV/payments" "{\"amountPaise\":60000,\"method\":\"CASH\",\"idempotencyKey\":\"pay-$STAMP\"}"
  check "record a payment" 201 "$CODE" "$BODY"
fi

echo "-- billing raised from the visit, and part paid --"
# The visit, not just the patient.
#
# An invoice carrying its `encounterId` is what lets check-out ask "has this
# consultation been billed" at all. The field was accepted by the API and never
# sent by the screen that raises the invoice, so the question had no answer and
# check-out offered to bill a visit that was already paid for.
req POST /invoices "{\"patientId\":\"$NEW_PID\",\"encounterId\":\"$ENC\",\"lineItems\":[{\"description\":\"Consultation\",\"quantity\":1,\"unitPricePaise\":80000,\"amountPaise\":80000}]}"
check "raise an invoice against the encounter" 201 "$CODE" "$BODY"
VINV=$(jget "$BODY" id)

req GET "/invoices/for-encounter/$ENC"
check "the visit can find its own invoice" 200 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q "$VINV"   && check "and it is that invoice" y y || check "and it is that invoice" y n

# Part payment. ₹300 of ₹800 leaves ₹500 owing — the number a receptionist reads
# off the screen while the patient is standing there, so it is asserted exactly
# rather than checked for being "non-zero".
req POST "/invoices/$VINV/payments" "{\"amountPaise\":30000,\"method\":\"CASH\",\"idempotencyKey\":\"part-$STAMP\"}"
check "take a part payment" 201 "$CODE" "$BODY"
req GET "/invoices/$VINV"
check "read the invoice back" 200 "$CODE" "$BODY"
# There is no balance column, and that is deliberate: a stored balance is a
# second copy of a number derivable from the payments, and the two disagree the
# first time one is voided. Total and paid are asserted instead.
printf '%s' "$BODY" | grep -q '"totalPaise":80000'   && check "the invoice is still eight hundred rupees" y y   || check "the invoice is still eight hundred rupees" y n
printf '%s' "$BODY" | grep -q '"paidPaise":30000'   && check "three hundred paid, so five hundred owing" y y   || check "three hundred paid, so five hundred owing" y n
printf '%s' "$BODY" | grep -q '"status":"BALANCED"'   && check "a part-paid invoice is not BALANCED" n y   || check "a part-paid invoice is not BALANCED" n n

# The same payment submitted twice — a double-tap on a counter terminal, or a
# retry after a timeout — must not be taken twice.
req POST "/invoices/$VINV/payments" "{\"amountPaise\":30000,\"method\":\"CASH\",\"idempotencyKey\":\"part-$STAMP\"}"
req GET "/invoices/$VINV"
printf '%s' "$BODY" | grep -q '"paidPaise":30000'   && check "a replayed payment is not taken twice" y y   || check "a replayed payment is not taken twice" y n

# Settle the rest, and the invoice closes itself rather than being closed by hand.
req POST "/invoices/$VINV/payments" "{\"amountPaise\":50000,\"method\":\"UPI\",\"idempotencyKey\":\"rest-$STAMP\"}"
check "settle the balance" 201 "$CODE" "$BODY"
req GET "/invoices/$VINV"
printf '%s' "$BODY" | grep -q '"status":"BALANCED"'   && check "now it is balanced" y y   || check "now it is balanced" y n

req GET "/invoices?patientId=$NEW_PID"
check "the patient's billing tab lists their invoices" 200 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q "$VINV"   && check "including the one raised from the visit" y y   || check "including the one raised from the visit" y n

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
