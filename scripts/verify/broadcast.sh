#!/usr/bin/env bash
#
# Broadcast: the consent gate, deduplication and a real send.
#
# The case this exists for: the SAME audience reaches a different number of
# people depending on whether the message is clinical or marketing, because
# those are separate acts of consent. If that ever stops being true, a clinic
# is sending promotional messages to people who agreed only to hear about
# their care.
#
#   API_BASE=http://localhost:4000/v1 bash scripts/verify/broadcast.sh
S="${TMPDIR:-/tmp}"
API="${API_BASE:-http://localhost:4000/v1}"
J="$S/bc-cookies.txt"; rm -f "$J"

pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1));
  else echo "  FAIL  $1 (expected $2, got $3)"; echo "        ${4:0:260}"; fail=$((fail+1)); fi
}
req() {
  local m=$1 p=$2 d=${3:-} out
  if [ -n "$d" ]; then
    out=$(curl -s -b "$J" -c "$J" -w $'\n%{http_code}' -X "$m" "$API$p" -H 'Content-Type: application/json' -d "$d")
  else
    out=$(curl -s -b "$J" -c "$J" -w $'\n%{http_code}' -X "$m" "$API$p")
  fi
  CODE="${out##*$'\n'}"; BODY="${out%$'\n'*}"
}
login() { rm -f "$J"; req POST /auth/login "{\"email\":\"$1\",\"password\":\"demo1234\"}"; }
jnum()  { printf '%s' "$1" | grep -o "\"$2\":[0-9]*" | head -1 | cut -d: -f2; }
jget()  { printf '%s' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

echo "-- only an administrator may broadcast --"
login priya.k@sunriseclinic.in
req POST /broadcasts/preview '{"purpose":"CLINICAL","audienceFilter":{}}'
check "a receptionist is refused" 403 "$CODE" "$BODY"
req GET /broadcasts
check "and cannot list them either" 403 "$CODE" "$BODY"

login owner@sunriseclinic.in
check "login (admin)" 201 "$CODE" "$BODY"

echo "-- consent decides the audience --"
req POST /broadcasts/preview '{"purpose":"CLINICAL","audienceFilter":{}}'
check "clinical preview" 200 "$CODE" "$BODY"
CLINICAL=$(jnum "$BODY" reaches)

req POST /broadcasts/preview '{"purpose":"MARKETING","audienceFilter":{}}'
check "marketing preview" 200 "$CODE" "$BODY"
MARKETING=$(jnum "$BODY" reaches)

echo "        clinical reaches $CLINICAL, marketing reaches $MARKETING"
[ "${CLINICAL:-0}" -gt "${MARKETING:-0}" ] \
  && check "marketing reaches FEWER people than clinical" y y \
  || check "marketing reaches FEWER people than clinical" y n

printf '%s' "$BODY" | grep -q '"NO_CONSENT":[1-9]' \
  && check "and says how many lacked marketing consent" y y \
  || check "and says how many lacked marketing consent" y n

echo "-- a shared family number is messaged once --"
req POST /broadcasts/preview '{"purpose":"CLINICAL","audienceFilter":{}}'
printf '%s' "$BODY" | grep -q '"DUPLICATE_NUMBER":[1-9]' \
  && check "the shared number is deduplicated" y y \
  || check "the shared number is deduplicated" y n

echo "-- an opt-out beats a consent --"
printf '%s' "$BODY" | grep -q '"OPTED_OUT":[1-9]' \
  && check "an opted-out patient is excluded" y y \
  || check "an opted-out patient is excluded" y n

echo "-- send --"
req GET /whatsapp/templates
TID=$(printf '%s' "$BODY" | grep -o '"id":"[0-9a-f-]\{36\}"' | head -1 | cut -d'"' -f4)

if [ -n "$TID" ]; then
  req POST /broadcasts "{\"name\":\"Verify run $(date +%s)\",\"templateId\":\"$TID\",\"purpose\":\"CLINICAL\",\"audienceFilter\":{},\"templateVariables\":{\"1\":\"there\",\"2\":\"1 November\"}}"
  check "create a broadcast" 201 "$CODE" "$BODY"
  BID=$(jget "$BODY" id)

  req POST "/broadcasts/$BID/send" ''
  check "send it" 201 "$CODE" "$BODY"
  SENT_TO=$(jnum "$BODY" recipients)
  [ "${SENT_TO:-0}" = "${CLINICAL:-0}" ] \
    && check "it reached exactly who the preview said" y y \
    || check "it reached exactly who the preview said" y n

  sleep 5
  req GET "/broadcasts/$BID/recipients"
  check "per-recipient outcomes are recorded" 200 "$CODE" "$BODY"
  printf '%s' "$BODY" | grep -q '"status":"SENT"' \
    && check "recipients are marked sent" y y \
    || check "recipients are marked sent" y n

  # Resending must be refused: the audience was frozen and already messaged.
  req POST "/broadcasts/$BID/send" ''
  check "a sent broadcast cannot be sent again" 409 "$CODE" "$BODY"
else
  check "an approved template exists to send" y n
fi

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
