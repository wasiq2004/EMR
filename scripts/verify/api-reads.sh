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

if [ -z "${VERIFY_DOMAIN:-}" ]; then
  echo "  This suite needs fixtures. Run it through scripts/verify/all.sh," >&2
  echo "  or: eval \"$(node scripts/verify/fixtures.mjs up)\"" >&2
  exit 2
fi
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
login() { rm -f "$J"; req POST /auth/login "{\"email\":\"$1\",\"password\":\"$VERIFY_PASSWORD\"}"; }

echo "-- health --"
req GET /healthz; check "healthz" 200 "$CODE" "$BODY"
req GET /readyz;  check "readyz"  200 "$CODE" "$BODY"

echo "-- an anonymous caller gets nothing --"
req GET /patients; check "patients denied when signed out" 401 "$CODE" "$BODY"

echo "-- sign in --"
login doctor@$VERIFY_DOMAIN; check "login (doctor)" 201 "$CODE" "$BODY"
req POST /auth/login "{\"email\":\"doctor@$VERIFY_DOMAIN\",\"password\":\"definitely-not-the-password\"}"
check "a wrong password is refused" 401 "$CODE" "$BODY"
login doctor@$VERIFY_DOMAIN
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

req GET "/patients?q=${VERIFY_SHARED_NUMBER#+91}"
N=$(printf '%s' "$BODY" | grep -o '"mrn"' | wc -l)
check "the shared number returns all three family members" 3 "$N" "$BODY"

echo "-- roles are separated --"
req GET /audit-events; check "a doctor may not read the audit trail" 403 "$CODE" "$BODY"
req GET /imports;      check "a doctor may not run an import"        403 "$CODE" "$BODY"

login auditor@$VERIFY_DOMAIN; check "login (auditor)" 201 "$CODE" "$BODY"
req GET /audit-events; check "an auditor may read the audit trail" 200 "$CODE" "$BODY"
req GET /patients;     check "an auditor may not read patients"    403 "$CODE" "$BODY"

login reception@$VERIFY_DOMAIN; check "login (receptionist)" 201 "$CODE" "$BODY"
req GET /patients;     check "a receptionist may read patients" 200 "$CODE" "$BODY"
req GET /audit-events; check "a receptionist may not read the audit trail" 403 "$CODE" "$BODY"

echo "-- the audit trail actually recorded all of this --"
login auditor@$VERIFY_DOMAIN
req GET /audit-events
N=$(printf '%s' "$BODY" | grep -o '"action"' | wc -l)
[ "$N" -gt 0 ] && check "audit events were written" y y || check "audit events were written" y n

echo "-- sign out --"
login doctor@$VERIFY_DOMAIN
req POST /auth/logout; check "logout" 204 "$CODE" "$BODY"
req GET /patients;     check "denied again after logout" 401 "$CODE" "$BODY"

echo "-- a document can be uploaded, which it could not be before --"
#
# `POST /documents` did not exist. The service behind it did — tenant-scoped,
# hashing, virus-scan-aware — and `StorageService.put` enforced the MIME
# allowlist and the 25 MB cap, and neither was reachable. The Upload button on a
# patient's documents tab was dead because there was nothing to call, so a clinic
# could not attach the one thing a paper-heavy practice has most of: a scanned
# report from somebody else.
login reception@$VERIFY_DOMAIN
req GET '/patients?q=arjun'
UPID=$(printf '%s' "$BODY" | grep -o '"id":"[0-9a-f-]\{36\}"' | head -1 | cut -d'"' -f4)

# A real PDF, not a text file named .pdf. The server reads the MIME the client
# declares, but a file that cannot be opened afterwards is not a passing test.
PDF="$S/verify-upload.pdf"
printf '%%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%%%EOF\n' > "$PDF"

upload() { # field-args... -> CODE, BODY
  local out
  out=$(curl -s -b "$J" -c "$J" -w $'\n%{http_code}' -X POST "$API/documents" "$@")
  CODE="${out##*$'\n'}"; BODY="${out%$'\n'*}"
}

upload -F "file=@$PDF;type=application/pdf" \
       -F "patientId=$UPID" \
       -F 'documentType=LAB_REPORT' \
       -F 'title=CBC and ESR, outside lab'
check "reception can file a scanned report" 201 "$CODE" "$BODY"
UDOC=$(printf '%s' "$BODY" | grep -o '"id":"[0-9a-f-]\{36\}"' | head -1 | cut -d'"' -f4)
printf '%s' "$BODY" | grep -q '"documentType":"LAB_REPORT"'   && check "filed as what it is" y y   || check "filed as what it is" y n
printf '%s' "$BODY" | grep -q '"sizeBytes":[1-9]'   && check "and the size was recorded" y y   || check "and the size was recorded" y n

# THE FILE COMES BACK. An upload that stores a row and loses the bytes is the
# failure mode worth checking: everything looks right until somebody needs it.
req GET "/documents/$UDOC/download"
check "and it downloads again" 200 "$CODE" "$BODY"
printf '%s' "$BODY" | head -c 5 | grep -q 'PDF'   && check "byte for byte, a PDF" y y   || check "byte for byte, a PDF" y n

# The title falls back to the filename rather than landing empty.
upload -F "file=@$PDF;type=application/pdf" -F "patientId=$UPID" -F 'documentType=OTHER'
check "a document with no description is still accepted" 201 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q '"title":"verify-upload.pdf"'   && check "and falls back to the filename" y y   || check "and falls back to the filename" y n

echo "-- what the upload route refuses --"
upload -F "file=@$PDF;type=application/pdf" -F 'documentType=LAB_REPORT'
check "a file belonging to no patient is refused" 422 "$CODE" "$BODY"

upload -F "patientId=$UPID" -F 'documentType=LAB_REPORT'
check "a request with no file is refused" 422 "$CODE" "$BODY"

upload -F "file=@$PDF;type=application/pdf" -F "patientId=$UPID" -F 'documentType=NOT_A_TYPE'
check "an unknown kind of document is refused" 422 "$CODE" "$BODY"

# PATIENT_UPLOAD is refused ON PURPOSE, and this assertion is the one that would
# catch somebody "fixing" it. That type is held PENDING a scan; nothing in this
# system ever sets CLEAN; download and share both refuse anything PENDING. It
# would upload fine and then never open again — storing data that cannot be read.
upload -F "file=@$PDF;type=application/pdf" -F "patientId=$UPID" -F 'documentType=PATIENT_UPLOAD'
check "a patient upload is refused while no scanner exists" 422 "$CODE" "$BODY"

# A Word document is not in the allowlist. The formats that are accepted are the
# ones that can be scanned and rendered; a .docx is neither.
DOCX="$S/verify-upload.docx"
printf 'PK\003\004 not really a docx\n' > "$DOCX"
upload -F "file=@$DOCX;type=application/vnd.openxmlformats-officedocument.wordprocessingml.document" \
       -F "patientId=$UPID" -F 'documentType=OTHER'
if [ "$CODE" = 403 ] || [ "$CODE" = 422 ]; then
  check "a format that cannot be scanned is refused" y y
else
  check "a format that cannot be scanned is refused" y n "got $CODE: $BODY"
fi

# JSON to a multipart route gets a sentence rather than a stack trace.
req POST /documents "{\"patientId\":\"$UPID\",\"documentType\":\"OTHER\"}"
check "JSON sent to the upload route is refused clearly" 422 "$CODE" "$BODY"

# Reading is not filing. The auditor can see that documents exist and cannot add
# to the record.
login auditor@$VERIFY_DOMAIN
upload -F "file=@$PDF;type=application/pdf" -F "patientId=$UPID" -F 'documentType=OTHER'
check "the auditor cannot file documents" 403 "$CODE" "$BODY"

rm -f "$PDF" "$DOCX"

echo "-- consent can be recorded, which it could not be before --"
#
# The schema, the read endpoint and the screen were all there, and nothing in the
# product could WRITE a consent. The only consents in any database were the ones
# these fixtures insert with raw SQL. That mattered beyond tidiness: the WhatsApp
# send path refuses a patient with no WHATSAPP_COMMUNICATION consent, so
# reminders and broadcasts were gated on something no clinic could obtain.
login reception@$VERIFY_DOMAIN
req GET '/patients?q=arjun'
CPID=$(printf '%s' "$BODY" | grep -o '"id":"[0-9a-f-]\{36\}"' | head -1 | cut -d'"' -f4)

req POST "/patients/$CPID/consents" '{"scope":"MARKETING_COMMUNICATION","policyVersion":"v2.0","captureMethod":"VERBAL_RECORDED","presentedLanguage":"ta"}'
check "reception can record a consent" 201 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q '"status":"ACTIVE"'   && check "it is active" y y   || check "it is active" y n
printf '%s' "$BODY" | grep -q '"presentedLanguage":"ta"'   && check "and records the language it was presented in" y y   || check "and records the language it was presented in" y n
CONSENT=$(printf '%s' "$BODY" | grep -o '"id":"[0-9a-f-]\{36\}"' | head -1 | cut -d'"' -f4)

# Every field here is a DPDP requirement, not bookkeeping. A consent with no
# notice version cannot be relied on later: it does not say which notice applied.
req POST "/patients/$CPID/consents" '{"scope":"TREATMENT","captureMethod":"VERBAL_RECORDED"}'
check "a consent with no notice version is refused" 422 "$CODE" "$BODY"
req POST "/patients/$CPID/consents" '{"scope":"NOT_A_SCOPE","policyVersion":"v1","captureMethod":"VERBAL_RECORDED"}'
check "and so is an unknown purpose" 422 "$CODE" "$BODY"

# One ACTIVE consent per purpose. Re-recording supersedes rather than
# duplicating: two live consents for one purpose is a state nobody can act on.
req POST "/patients/$CPID/consents" '{"scope":"MARKETING_COMMUNICATION","policyVersion":"v3.0","captureMethod":"IN_PERSON_SIGNED"}'
check "re-recording the same purpose is accepted" 201 "$CODE" "$BODY"
req GET "/patients/$CPID/consents"
ACTIVE_MARKETING=$(printf '%s' "$BODY" | tr '{' '\n' | grep MARKETING_COMMUNICATION | grep -c '"status":"ACTIVE"')
check "but only one of them stays active" 1 "$ACTIVE_MARKETING" "$BODY"

echo "-- withdrawing --"
# Reception records consent; withdrawing stops reminders and broadcasts reaching
# that patient from the moment it lands, so it sits with the doctor and admin.
req POST "/consents/$CONSENT/withdraw" '{}'
check "reception cannot withdraw a consent" 403 "$CODE" "$BODY"

login owner@$VERIFY_DOMAIN
req GET "/patients/$CPID/consents"
LIVE=$(printf '%s' "$BODY" | tr '{' '\n' | grep MARKETING_COMMUNICATION | grep '"status":"ACTIVE"' | grep -o '"id":"[0-9a-f-]\{36\}"' | head -1 | cut -d'"' -f4)
req POST "/consents/$LIVE/withdraw" '{"reason":"Asked at the desk"}'
check "an administrator can" 201 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q '"withdrawnAt":null'   && check "it records when it was withdrawn" n y   || check "it records when it was withdrawn" n n

# A WITHDRAWAL IS NOT A DELETE. The clinic needs to show both that consent was
# held and that it was withdrawn — a message sent last week was lawfully sent.
req GET "/patients/$CPID/consents"
printf '%s' "$BODY" | grep -q 'MARKETING_COMMUNICATION'   && check "the row is kept, not deleted" y y   || check "the row is kept, not deleted" y n
printf '%s' "$BODY" | grep -qi 'asked at the desk'   && check "and keeps the note" y y   || check "and keeps the note" y n

# Withdrawing twice is a no-op: the second person wanted the same outcome.
req POST "/consents/$LIVE/withdraw" '{}'
check "withdrawing twice is not an error" 201 "$CODE" "$BODY"

echo "-- a share link can be revoked, which the dialog has always promised --"
req GET /documents
DOC=$(printf '%s' "$BODY" | grep -o '"id":"[0-9a-f-]\{36\}"' | head -1 | cut -d'"' -f4)
if [ -n "$DOC" ]; then
  req POST "/documents/$DOC/share" '{"ttlHours":24,"maxAccessCount":3,"requireOtp":false,"purpose":"Verification"}'
  check "create a share link" 201 "$CODE" "$BODY"
  # The id was not returned before, which is why the dialog could promise
  # revocation and offer no way to do it.
  printf '%s' "$BODY" | grep -q '"id"'   && check "the response carries the link id" y y   || check "the response carries the link id" y n
  LINK=$(printf '%s' "$BODY" | grep -o '"id":"[0-9a-f-]\{36\}"' | head -1 | cut -d'"' -f4)
  req POST "/share-links/$LINK/revoke"
  check "revoke it" 204 "$CODE" "$BODY"
else
  echo "        (no documents in the fixture; skip)"
fi

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
