#!/usr/bin/env bash
#
# The research analyst: counts and codes, never a person.
#
# WHY THIS SUITE EXISTS. The analytics module makes one claim that is worth more
# than all its features put together — a Research Analyst cannot identify a
# patient — and it makes that claim structurally rather than by filtering: the
# controller has no route that takes a name, a number or an MRN, and the role
# holds no `patient:read`. An absence is exactly the kind of guarantee that
# erodes: somebody adds a convenient lookup, or widens a permission set, and
# nothing fails. This suite is what fails.
#
# The rest of it asserts the three properties that make an extract safe to hand
# to a researcher: small cells are suppressed rather than zeroed, subject keys
# are per-cohort so two extracts cannot be joined, and every export carries the
# definition that produced it.
#
#   bash scripts/verify/research.sh     (needs fixtures; see all.sh)
S="${TMPDIR:-/tmp}"
API="${API_BASE:-http://localhost:4000/v1}"

if [ -z "${VERIFY_DOMAIN:-}" ]; then
  echo "  This suite needs fixtures. Run it through scripts/verify/all.sh," >&2
  echo "  or: eval \"\$(node scripts/verify/fixtures.mjs up)\"" >&2
  exit 2
fi
J="$S/cookies.txt"; rm -f "$J"

pass=0; fail=0
check() { # name expected actual [body]
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1));
  else echo "  FAIL  $1 (expected $2, got $3)"; echo "        ${4:0:300}"; fail=$((fail+1)); fi
}
yes_() { # name condition-exit
  if [ "$1" = y ]; then check "$2" y y; else check "$2" y n "${3:-}"; fi
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
num()  { printf '%s' "$2" | grep -o "\"$1\":[0-9-]*" | head -1 | cut -d: -f2; }
jid()  { printf '%s' "$1" | grep -o '"id":"[0-9a-f-]\{36\}"' | head -1 | cut -d'"' -f4; }
has()  { printf '%s' "$2" | grep -q "$1" && echo y || echo n; }

FROM=$(node -e 'const d=new Date();d.setUTCFullYear(d.getUTCFullYear()-2);console.log(d.toISOString().slice(0,10))')
TO=$(node -e 'console.log(new Date().toISOString().slice(0,10))')
FILTERS="{\"from\":\"$FROM\",\"to\":\"$TO\"}"

echo "-- THE GUARANTEE: an analyst cannot reach a person --"
login analyst@$VERIFY_DOMAIN; check "login (research analyst)" 201 "$CODE" "$BODY"

# Not "the search endpoint filters out names" — there is no route, and no
# permission. Both halves are asserted, because either one alone would be
# undone by a one-line change somebody thought was harmless.
req GET '/patients?q=arjun'
check "the register is refused outright" 403 "$CODE" "$BODY"
req GET '/patients/search?q=arjun'
check "so is patient search" 403 "$CODE" "$BODY"
req GET '/patients/duplicates?mobile=%2B919876543210&name=Arjun'
check "and the duplicate check, which takes a name and a number" 403 "$CODE" "$BODY"
req GET /queue
check "the live queue is refused" 403 "$CODE" "$BODY"
req GET /documents
check "documents are refused" 403 "$CODE" "$BODY"
req GET /appointments
check "the appointment book is refused" 403 "$CODE" "$BODY"
req GET /encounters/00000000-0000-0000-0000-000000000000
check "and a consultation is refused" 403 "$CODE" "$BODY"
req GET /invoices
check "billing is refused" 403 "$CODE" "$BODY"
req GET /broadcasts
check "and so is anything that could message a patient" 403 "$CODE" "$BODY"

# The analyst's own surface answers.
req GET /analytics/dictionary
check "the data dictionary reads" 200 "$CODE" "$BODY"
req GET "/analytics/quality?from=$FROM&to=$TO"
check "the data quality report reads" 200 "$CODE" "$BODY"
req GET /analytics/cohorts
check "and the cohort list" 200 "$CODE" "$BODY"

echo "-- a definition cannot quietly mean something wider than it says --"
# `.strict()` on CohortFilters. An unknown key is REFUSED rather than ignored:
# a filter that is accepted and dropped returns a wider cohort than its own
# definition claims, and the definition is what makes the figures traceable.
req POST /analytics/cohorts/preview "{\"from\":\"$FROM\",\"to\":\"$TO\",\"encounterTypes\":[\"FOLLOW_UP\"]}"
check "an unknown filter key is refused, not ignored" 422 "$CODE" "$BODY"

# An unbounded window is the whole record rather than a cohort.
req POST /analytics/cohorts/preview '{}'
check "a cohort with no date window is refused" 422 "$CODE" "$BODY"

req POST /analytics/cohorts/preview "{\"from\":\"$FROM\",\"to\":\"$TO\",\"minEncounters\":0}"
check "a zero minimum is refused" 422 "$CODE" "$BODY"

echo "-- previewing --"
req POST /analytics/cohorts/preview "$FILTERS"
check "a preview runs" 201 "$CODE" "$BODY"
PREVIEW_SIZE=$(num size "$BODY")
[ -n "$PREVIEW_SIZE" ] || PREVIEW_SIZE=$(num total "$BODY")
yes_ "$(has 'smallCellThreshold' "$BODY")" "the threshold is stated, not implied" "$BODY"

# PSEUDONYMS, NOT IDS. If a subject key were a patient id, the extract would be
# identifying and the whole module's claim would be false.
yes_ "$(has '"subjectKey":"S-' "$BODY")" "subjects are named by a pseudonym" "$BODY"
printf '%s' "$BODY" | grep -q '"patientId"' \
  && check "and no patient id appears in a projection" n y "$BODY" \
  || check "and no patient id appears in a projection" n n

# Nor a name, number or MRN.
printf '%s' "$BODY" | grep -qi '"fullName"\|"mobileE164"\|"mrn"' \
  && check "nor a name, number or record number" n y "$BODY" \
  || check "nor a name, number or record number" n n

echo "-- small cells are suppressed, not zeroed --"
# A cell of three is reported as null with a count of how many were suppressed.
# Zero would be a FALSE STATEMENT about the data; a gap that is declared is not.
req POST /analytics/cohorts/preview "$FILTERS"
yes_ "$(has 'suppressed' "$BODY")" "the number of suppressed cells is reported" "$BODY"
# A narrow cohort: one age band, which at a verification clinic is a few people.
req POST /analytics/cohorts/preview "{\"from\":\"$FROM\",\"to\":\"$TO\",\"ageBands\":[\"0-4\"]}"
check "a deliberately narrow cohort still answers" 201 "$CODE" "$BODY"
# The TOTAL is not suppressed: knowing a cohort has three members discloses
# nothing on its own, and hiding it would make the screen unusable.
yes_ "$(has '"size"' "$BODY")" "the cohort's own size is not suppressed" "$BODY"

echo "-- saving a cohort --"
req POST /analytics/cohorts "{\"name\":\"Verify\",\"purpose\":\"too short\",\"filters\":$FILTERS}"
check "a purpose nobody could act on is refused" 422 "$CODE" "$BODY"
req POST /analytics/cohorts "{\"name\":\"V\",\"purpose\":\"Checking hypertension follow-up rates\",\"filters\":$FILTERS}"
check "and so is a one-letter name" 422 "$CODE" "$BODY"

req POST /analytics/cohorts "{\"name\":\"Verification cohort $RANDOM\",\"purpose\":\"Checking that saved definitions keep their provenance\",\"filters\":$FILTERS}"
check "a cohort with a real purpose saves" 201 "$CODE" "$BODY"
COHORT=$(jid "$BODY")
check "and starts at definition version 1" 1 "$(num definitionVersion "$BODY")" "$BODY"

echo "-- a saved cohort's keys are stable across runs --"
# Salted with the cohort's own id, so re-running it counts the same people the
# same way. Without that, two runs of one definition could not be compared.
req POST "/analytics/cohorts/$COHORT/evaluate"
check "the cohort evaluates" 201 "$CODE" "$BODY"
KEY_A=$(printf '%s' "$BODY" | grep -o '"subjectKey":"S-[A-Z0-9]*"' | head -1 | cut -d'"' -f4)
SIZE_A=$(num size "$BODY")
req POST "/analytics/cohorts/$COHORT/evaluate"
check "and again" 201 "$CODE" "$BODY"
KEY_B=$(printf '%s' "$BODY" | grep -o '"subjectKey":"S-[A-Z0-9]*"' | head -1 | cut -d'"' -f4)
check "the same subject keeps the same key" "$KEY_A" "$KEY_B" "$BODY"
check "and the size is the same" "$SIZE_A" "$(num size "$BODY")" "$BODY"

echo "-- two cohorts cannot be joined on the key --"
# THE REASON THE SALT EXISTS. Joining two extracts on a shared key lets the
# attributes of one narrow a person down in the other, which is the standard way
# a pseudonymised extract gets re-identified.
req POST /analytics/cohorts "{\"name\":\"Second cohort $RANDOM\",\"purpose\":\"Confirming that keys do not carry between cohorts\",\"filters\":$FILTERS}"
COHORT2=$(jid "$BODY")
req POST "/analytics/cohorts/$COHORT2/evaluate"
KEY_C=$(printf '%s' "$BODY" | grep -o '"subjectKey":"S-[A-Z0-9]*"' | head -1 | cut -d'"' -f4)
if [ -n "$KEY_A" ] && [ "$KEY_A" = "$KEY_C" ]; then
  check "the same patient has an unrelated key in another cohort" y n "both cohorts used $KEY_A"
else
  check "the same patient has an unrelated key in another cohort" y y
fi

echo "-- an export carries the definition that produced it --"
req POST /analytics/exports "{\"cohortId\":\"$COHORT\",\"exportType\":\"AGGREGATE\"}"
check "an export against a saved cohort is accepted" 201 "$CODE" "$BODY"
yes_ "$(has 'definitionSnapshot' "$BODY")" "the definition is stored as it was" "$BODY"
yes_ "$(has 'definitionVersion' "$BODY")" "with its version" "$BODY"
yes_ "$(has 'columnsIncluded' "$BODY")" "and the exact column list" "$BODY"

# THE COLUMN LIST IS WHAT A REVIEWER CHECKS. It must be stated rather than
# derived from the rows, or an empty export records no columns and there is
# nothing to review.
yes_ "$(has 'subject_key' "$BODY")" "the columns name the pseudonym" "$BODY"
printf '%s' "$BODY" | grep -q 'full_name\|mobile\|"mrn"\|date_of_birth' \
  && check "and no identifying column is in the file" n y "$BODY" \
  || check "and no identifying column is in the file" n n

# A date of birth is identifying; an age band is not.
yes_ "$(has 'age_band' "$BODY")" "ages are banded, not dated" "$BODY"

req GET /analytics/exports
check "the export list reads" 200 "$CODE" "$BODY"
yes_ "$(has 'requestedByName' "$BODY")" "and says who asked for each one" "$BODY"

echo "-- an export with no definition is refused --"
# A figure quoted in a report next year has to be traceable to the definition
# that produced it. An export without one is untraceable by construction.
req POST /analytics/exports '{"exportType":"AGGREGATE"}'
printf '%s' "$BODY" | grep -qi 'definition is not optional\|needs either' \
  && check "an export with neither a cohort nor filters is refused" y y \
  || check "an export with neither a cohort nor filters is refused" y n "$BODY"

echo "-- the clinic side --"
login owner@$VERIFY_DOMAIN
req GET /analytics/cohorts
check "a clinic admin can see the cohorts" 200 "$CODE" "$BODY"
# And the analyst's work does not leak into the clinical panel's reach: the
# admin reads patients, which is the separation working in the other direction.
req GET '/patients?q=arjun'
check "and can still read the register" 200 "$CODE" "$BODY"

login doctor@$VERIFY_DOMAIN
req POST /analytics/exports "{\"cohortId\":\"$COHORT\",\"exportType\":\"AGGREGATE\"}"
check "a doctor does not request research extracts" 403 "$CODE" "$BODY"

echo "-- deleting a cohort --"
login analyst@$VERIFY_DOMAIN
req POST "/analytics/cohorts/$COHORT2/delete"
check "a cohort can be deleted" 201 "$CODE" "$BODY"
req GET "/analytics/cohorts/$COHORT2"
check "and is gone" 404 "$CODE" "$BODY"

# The export outlives the cohort. Deleting a definition must not erase the
# record that an extract was taken under it — that record is the audit trail.
req GET /analytics/exports
yes_ "$(has 'definitionSnapshot' "$BODY")" "exports keep their snapshot after the cohort goes" "$BODY"

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
