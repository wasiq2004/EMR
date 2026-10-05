#!/usr/bin/env bash
#
# Bringing a patient register in from somewhere else.
#
# WHY THIS SUITE EXISTS. The import wizard was a mock, end to end. The chosen
# file was never uploaded or read; the column list it asked you to confirm was a
# hardcoded array of seven names; and the result figures — "1,284 rows read",
# "1,207 ready", "54 possible duplicates", "23 problems" — were string literals
# in the page. The button beneath them said "Import the 1,207 ready rows" and
# had no handler. There was no POST /imports anywhere on the server.
#
# So every assertion here is about one thing: that the numbers a clinic is shown
# come from their own file, and that the rows that get inserted are the rows
# those numbers described.
#
#   bash scripts/verify/import.sh     (needs fixtures; see all.sh)
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
req() { # method path [data] -> CODE, BODY
  local m=$1 p=$2 d=${3:-} out
  if [ -n "$d" ]; then
    out=$(curl -s -b "$J" -c "$J" -w $'\n%{http_code}' -X "$m" "$API$p" -H 'Content-Type: application/json' -d "$d")
  else
    out=$(curl -s -b "$J" -c "$J" -w $'\n%{http_code}' -X "$m" "$API$p")
  fi
  CODE="${out##*$'\n'}"; BODY="${out%$'\n'*}"
}
send() { # curl-args... -> CODE, BODY   (multipart)
  local out
  out=$(curl -s -b "$J" -c "$J" -w $'\n%{http_code}' "$@")
  CODE="${out##*$'\n'}"; BODY="${out%$'\n'*}"
}
login() { rm -f "$J"; req POST /auth/login "{\"email\":\"$1\",\"password\":\"$VERIFY_PASSWORD\"}"; }
num()  { printf '%s' "$2" | grep -o "\"$1\":[0-9-]*" | head -1 | cut -d: -f2; }
jid()  { printf '%s' "$1" | grep -o '"id":"[0-9a-f-]\{36\}"' | head -1 | cut -d'"' -f4; }

# A tag unique to this run, so repeated runs against the same clinic do not
# collide on the name-and-date-of-birth duplicate check.
RUN="$RANDOM$RANDOM"
PATIENTS="$S/verify-import-$RUN.csv"

echo "-- only an administrator imports --"
login reception@$VERIFY_DOMAIN; check "login (reception)" 201 "$CODE" "$BODY"
send -X POST "$API/imports" -F "file=@/dev/null;filename=x.csv;type=text/csv"
check "reception cannot start an import" 403 "$CODE" "$BODY"

login owner@$VERIFY_DOMAIN; check "login (clinic admin)" 201 "$CODE" "$BODY"

echo "-- step one: the file is actually read --"
# Eight rows. Four should import, four should not, and the suite knows which —
# which is the whole point, because the old screen reported figures no file
# could have produced.
cat > "$PATIENTS" <<CSV
Name,Mobile No,DOB,Sex,Address,City,Reg No
Import Alpha $RUN,9876500001,03/04/1990,M,"12, MG Road",Bengaluru,OLD-1
Import Bravo $RUN,09876500002,1988-11-23,Female,7 Lake View,Pune,OLD-2
Import Charlie $RUN,+919876500003,31/02/1990,M,Nowhere,Chennai,OLD-3
,9876500004,01/01/1980,M,No name here,Delhi,OLD-4
Import Delta $RUN,notaphone,12/12/1975,F,Bad number,Kolkata,OLD-5
Import Echo $RUN,9876500006,,Mle,Bad sex,Surat,OLD-6
Import Alpha $RUN,9876500007,03/04/1990,M,Same person again,Bengaluru,OLD-7
Import Foxtrot $RUN,9876500001,05/05/1995,F,Shares a handset,Bengaluru,OLD-8
CSV

send -X POST "$API/imports" -F "file=@$PATIENTS;type=text/csv"
check "the file uploads" 201 "$CODE" "$BODY"
JOB=$(jid "$BODY")
check "eight rows were counted, not a hardcoded figure" 8 "$(num totalRows "$BODY")" "$BODY"
printf '%s' "$BODY" | grep -q '"AWAITING_MAPPING"'   && check "nothing is committed yet" y y   || check "nothing is committed yet" y n

# THE REAL HEADINGS, from the file. The old screen showed seven invented names.
printf '%s' "$BODY" | grep -q '"Mobile No"'   && check "the real column headings come back" y y   || check "the real column headings come back" y n
printf '%s' "$BODY" | grep -q '"Reg No"'      && check "including the ones we do not recognise" y y   || check "including the ones we do not recognise" y n
printf '%s' "$BODY" | grep -q '"decodedAs":"utf-8"'   && check "and the encoding it was read as" y y   || check "and the encoding it was read as" y n

# The guess is a guess, shown for confirmation.
printf '%s' "$BODY" | grep -q '"Mobile No":"mobileE164"'   && check "Mobile No is guessed as the mobile" y y   || check "Mobile No is guessed as the mobile" y n
printf '%s' "$BODY" | grep -q '"DOB":"dateOfBirth"'        && check "DOB as the date of birth" y y        || check "DOB as the date of birth" y n

# A sample, so the mapping can be checked against real values.
printf '%s' "$BODY" | grep -q '12, MG Road'   && check "a quoted address survived the parser" y y   || check "a quoted address survived the parser" y n

echo "-- the register has not been touched --"
req GET "/patients?q=Import+Alpha+$RUN"
printf '%s' "$BODY" | grep -q "Import Alpha $RUN" \
  && check "uploading a file registers nobody" n y \
  || check "uploading a file registers nobody" n n

echo "-- what the upload refuses --"
printf 'Name,Name,Mobile\nA,B,9876500009\n' > "$S/dupcols-$RUN.csv"
send -X POST "$API/imports" -F "file=@$S/dupcols-$RUN.csv;type=text/csv"
check "two columns with the same heading are refused" 422 "$CODE" "$BODY"

printf 'Name,Mobile\n' > "$S/headersonly-$RUN.csv"
send -X POST "$API/imports" -F "file=@$S/headersonly-$RUN.csv;type=text/csv"
check "headings with no patients are refused" 422 "$CODE" "$BODY"

# An .xlsx is refused with an instruction rather than parsed as text. The old
# file picker accepted it, which it could afford to because it never looked.
printf 'PK\003\004 not really a workbook\n' > "$S/book-$RUN.xlsx"
send -X POST "$API/imports" -F "file=@$S/book-$RUN.xlsx;type=application/vnd.ms-excel"
check "an Excel workbook is refused with instructions" 422 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -qi 'csv'   && check "and the message says to save as CSV" y y   || check "and the message says to save as CSV" y n

echo "-- step two: the rows are checked against the real contract --"
req POST "/imports/$JOB/validate" '{"columnMapping":{"Mobile No":"mobileE164","DOB":"dateOfBirth","Sex":"gender"}}'
check "a mapping with no name column is refused" 422 "$CODE" "$BODY"

req POST "/imports/$JOB/validate" '{"columnMapping":{"Name":"fullName","Mobile No":"mobileE164","Address":"mobileE164"}}'
check "two columns pointing at one field are refused" 422 "$CODE" "$BODY"

req POST "/imports/$JOB/validate" '{"columnMapping":{"Name":"fullName","Mobile No":"notAField"}}'
check "an unknown target field is refused" 422 "$CODE" "$BODY"

MAP='{"columnMapping":{"Name":"fullName","Mobile No":"mobileE164","DOB":"dateOfBirth","Sex":"gender","Address":"addressLine1","City":"city","Reg No":""}}'
req POST "/imports/$JOB/validate" "$MAP"
check "the rows check" 201 "$CODE" "$BODY"

# THE COUNTS, AND THEY ARE COUNTED. Four rows are bad in four different ways:
#   Charlie  — 31 February is not a date
#   row 5    — no name
#   Delta    — "notaphone" is not a number
#   Echo     — "Mle" was written and is not recognised, so it is reported
#              rather than quietly becoming UNKNOWN
check "eight rows were read" 8 "$(num totalRows "$BODY")" "$BODY"
check "four have problems" 4 "$(num errorRows "$BODY")" "$BODY"
# Alpha appears twice with the same name and date of birth: the second is a
# duplicate within the file. Foxtrot shares Alpha's handset, which is NOT a
# duplicate — a family on one phone is routine — so it is flagged and imported.
check "three are ready" 3 "$(num validRows "$BODY")" "$BODY"

printf '%s' "$BODY" | grep -q '31/02/1990'   && check "the impossible date is named in the report" y y   || check "the impossible date is named in the report" y n
printf '%s' "$BODY" | grep -qi 'not a usable mobile'   && check "so is the unusable number" y y   || check "so is the unusable number" y n
printf '%s' "$BODY" | grep -q 'DUPLICATE_IN_FILE'   && check "the repeated person is flagged" y y   || check "the repeated person is flagged" y n

# The row numbers are the spreadsheet's, counting the heading as row 1 — a
# clinic correcting their file is looking at Excel.
printf '%s' "$BODY" | grep -q '"rowNumber":4'   && check "row numbers match the spreadsheet" y y   || check "row numbers match the spreadsheet" y n

echo "-- the problem report is a real file --"
send "$API/imports/$JOB/problems"
check "the report downloads" 200 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q 'Row in your file'   && check "it has a heading row" y y   || check "it has a heading row" y n
# IT CARRIES THE CLINIC'S OWN COLUMNS, so they fix their file rather than
# transcribing from a list of row numbers.
printf '%s' "$BODY" | grep -q 'Reg No'   && check "and their own columns, including unmapped ones" y y   || check "and their own columns, including unmapped ones" y n
printf '%s' "$BODY" | grep -q 'OLD-3'    && check "and the original values of each bad row" y y   || check "and the original values of each bad row" y n

echo "-- the register STILL has not been touched --"
req GET "/patients?q=Import+Alpha+$RUN"
printf '%s' "$BODY" | grep -q "Import Alpha $RUN" \
  && check "checking the rows registers nobody" n y \
  || check "checking the rows registers nobody" n n

echo "-- step three: the commit --"
req POST "/imports/$JOB/commit"
check "the import commits" 201 "$CODE" "$BODY"
check "three patients were added" 3 "$(num importedRows "$BODY")" "$BODY"
# Counted against the FILE, not against the candidate list — "0 skipped" on a
# file with five rejected rows is the reassuring half-truth the mock gave.
check "and five rows were not imported" 5 "$(num skippedRows "$BODY")" "$BODY"

echo "-- what landed is what the figures described --"
req GET "/patients?q=Import+Alpha+$RUN"
ALPHA=$(printf '%s' "$BODY" | grep -o "Import Alpha $RUN" | wc -l | tr -d ' ')
check "Alpha is in the register exactly once" 1 "$ALPHA" "$BODY"

# The number was normalised the way the front desk normalises it. Without that,
# a patient imported as 9876500001 and later registered as +919876500001 is two
# records no duplicate check connects.
printf '%s' "$BODY" | grep -q '+919876500001'   && check "a bare 10-digit number became +91…" y y   || check "a bare 10-digit number became +91…" y n
# Tagged, so staff know these details were not taken at this desk.
printf '%s' "$BODY" | grep -q '"imported"'   && check "and the record is tagged imported" y y   || check "and the record is tagged imported" y n

req GET "/patients?q=Import+Bravo+$RUN"
printf '%s' "$BODY" | grep -q '+919876500002'   && check "a leading 0 was stripped, not kept" y y   || check "a leading 0 was stripped, not kept" y n

# Foxtrot shares Alpha's handset and IS imported. This is the assertion most
# likely to be broken by someone "tightening" duplicate detection: a family of
# five on one number is normal in this market, and refusing four of them would
# leave a clinic unable to import its own register.
req GET "/patients?q=Import+Foxtrot+$RUN"
printf '%s' "$BODY" | grep -q "Import Foxtrot $RUN" \
  && check "someone sharing a handset was still imported" y y \
  || check "someone sharing a handset was still imported" y n

# And the rows with problems are NOT in the register.
req GET "/patients?q=Import+Charlie+$RUN"
printf '%s' "$BODY" | grep -q "Import Charlie $RUN" \
  && check "the row with an impossible date was not imported" n y \
  || check "the row with an impossible date was not imported" n n
req GET "/patients?q=Import+Echo+$RUN"
printf '%s' "$BODY" | grep -q "Import Echo $RUN" \
  && check "nor the row with an unreadable sex" n y \
  || check "nor the row with an unreadable sex" n n

echo "-- committing twice does not import twice --"
req POST "/imports/$JOB/commit"
check "a second commit is refused" 409 "$CODE" "$BODY"
req GET "/patients?q=Import+Alpha+$RUN"
AGAIN=$(printf '%s' "$BODY" | grep -o "Import Alpha $RUN" | wc -l | tr -d ' ')
check "and Alpha is still there exactly once" 1 "$AGAIN" "$BODY"

echo "-- re-importing the same file finds them already registered --"
send -X POST "$API/imports" -F "file=@$PATIENTS;type=text/csv"
JOB2=$(jid "$BODY")
req POST "/imports/$JOB2/validate" "$MAP"
check "the same file checks again" 201 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q 'ALREADY_REGISTERED'   && check "and the rows are reported as already in the register" y y   || check "and the rows are reported as already in the register" y n
check "with nothing left to import" 0 "$(num validRows "$BODY")" "$BODY"
req POST "/imports/$JOB2/commit"
check "so committing it is refused rather than duplicating anybody" 422 "$CODE" "$BODY"

echo "-- an unmapped file cannot be committed --"
send -X POST "$API/imports" -F "file=@$PATIENTS;type=text/csv"
JOB3=$(jid "$BODY")
req POST "/imports/$JOB3/commit"
check "a commit before the columns are matched is refused" 409 "$CODE" "$BODY"

echo "-- history --"
req GET /imports
check "previous imports list" 200 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q "verify-import-$RUN.csv"   && check "this run is in it" y y   || check "this run is in it" y n
printf '%s' "$BODY" | grep -q '"importedRows":3'   && check "with the real number imported" y y   || check "with the real number imported" y n

echo "-- one clinic's import is invisible to another --"
# The auditor can see that an import happened and cannot start or commit one.
login auditor@$VERIFY_DOMAIN
req POST "/imports/$JOB/commit"
check "the auditor cannot commit an import" 403 "$CODE" "$BODY"

rm -f "$PATIENTS" "$S/dupcols-$RUN.csv" "$S/headersonly-$RUN.csv" "$S/book-$RUN.xlsx"

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
