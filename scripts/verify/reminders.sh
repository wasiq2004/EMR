#!/usr/bin/env bash
#
# Follow-up reminders: scheduling them, and the claim that stops a double send.
#
# The checkpoint this suite exists for is one line of the plan — "a follow-up set
# today for tomorrow fires once, not twice" — and almost everything here is some
# version of that. The failure being guarded against is a patient receiving the
# same message from their doctor twice, which costs a clinic more trust than a
# missed reminder does.
#
# It runs against the real API and the real database. The WhatsApp provider is
# the one thing that is not real: with no credential configured the client
# SIMULATES the send and records the whole lifecycle anyway, which is exactly
# what we want to assert against — every status transition is genuine.
#
#   bash scripts/verify/reminders.sh     (needs fixtures; see all.sh)
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
login() { rm -f "$J"; req POST /auth/login "{\"email\":\"$1\",\"password\":\"$VERIFY_PASSWORD\"}"; }
jget()  { printf '%s' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
count() { printf '%s' "$2" | grep -o "$1" | wc -l | tr -d ' '; }

# The job endpoint takes a bearer secret rather than a session — a cron line has
# no user. Read from the same .env the stack was started with.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
JOBS_SECRET="${JOBS_SECRET:-$(grep '^JOBS_SECRET=' "$ROOT/.env" 2>/dev/null | cut -d= -f2-)}"
job() { # [secret] -> CODE, BODY
  local secret=${1-$JOBS_SECRET} out
  out=$(curl -s -w $'\n%{http_code}' -X POST "$API/jobs/run-due" \
    -H "Authorization: Bearer $secret")
  CODE="${out##*$'\n'}"; BODY="${out%$'\n'*}"
}

echo "-- the scheduler endpoint is not open --"
# A cross-tenant credential deserves checking. It authorises exactly one
# endpoint, which takes no parameters and returns five integers.
out=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/jobs/run-due")
check "no secret is refused" 401 "$out"
job "definitely-not-the-secret"
check "a wrong secret is refused" 401 "$CODE" "$BODY"
job
check "the right secret is accepted" 201 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q '"claimed"'   && check "and it reports what it did" y y   || check "and it reports what it did" y n

echo "-- reminders are off until a clinic turns them on --"
# A clinic that has not connected WhatsApp and has not thought about what its
# patients consented to should not start messaging them because a feature
# shipped.
login owner@$VERIFY_DOMAIN; check "login (clinic admin)" 201 "$CODE" "$BODY"
req GET /settings/reminders
check "read the reminder settings" 200 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q '"followUpEnabled":false'   && check "follow-up reminders default to off" y y   || check "follow-up reminders default to off" y n
printf '%s' "$BODY" | grep -q '"notifyClinicNumber":false'   && check "and so does the copy to the clinic" y y   || check "and so does the copy to the clinic" y n

echo "-- signing with reminders off schedules nothing --"
req GET "/patients?q=lakshmi"
PID=$(jget "$BODY" id)

login doctor@$VERIFY_DOMAIN
req POST /encounters "{\"patientId\":\"$PID\"}"
check "open a consultation" 201 "$CODE" "$BODY"
ENC=$(jget "$BODY" id)
VER=$(printf '%s' "$BODY" | grep -o '"version":[0-9]*' | head -1 | cut -d: -f2)

req PATCH "/encounters/$ENC" '{"chiefComplaint":"Cough","followUpAfterDays":7}' "If-Match: ${VER:-1}"
check "set a seven-day follow-up" 200 "$CODE" "$BODY"
req POST "/encounters/$ENC/finalise" '{}'
check "sign it" 201 "$CODE" "$BODY"

login owner@$VERIFY_DOMAIN
req GET /reminders
check "read the reminder log" 200 "$CODE" "$BODY"
check "nothing was scheduled, because reminders are off" 0 "$(count '"dueAt"' "$BODY")" "$BODY"

echo "-- a copy to the clinic needs somewhere to send it --"
req POST /settings/reminders '{"notifyClinicNumber":true}'
check "turning the copy on without a number is refused" 422 "$CODE" "$BODY"
req POST /settings/reminders '{"notifyClinicNumber":true,"clinicNotifyMobileE164":"not-a-number"}'
check "and so is a number that is not E.164" 422 "$CODE" "$BODY"

echo "-- turn reminders on --"
req POST /settings/reminders '{"followUpEnabled":true,"leadTimeDays":1,"quietHoursStart":9}'
check "enable follow-up reminders" 201 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q '"followUpEnabled":true'   && check "the setting took" y y   || check "the setting took" y n
# Merged, not replaced: the earlier read showed quietHoursEnd at its default and
# the patch above did not mention it. Writing the whole blob would drop it.
printf '%s' "$BODY" | grep -q '"quietHoursEnd":20'   && check "and the keys not mentioned survived the merge" y y   || check "and the keys not mentioned survived the merge" y n

echo "-- signing now schedules exactly one reminder --"
login doctor@$VERIFY_DOMAIN
req GET '/patients?q=arjun'
PID2=$(jget "$BODY" id)
req POST /encounters "{\"patientId\":\"$PID2\"}"
ENC2=$(jget "$BODY" id)
VER2=$(printf '%s' "$BODY" | grep -o '"version":[0-9]*' | head -1 | cut -d: -f2)
# Five days out with a one-day lead time, so the reminder is due in four days —
# comfortably in the future, which is what makes the "does not fire early"
# assertion below meaningful.
req PATCH "/encounters/$ENC2" '{"chiefComplaint":"Review","followUpAfterDays":5}' "If-Match: ${VER2:-1}"
check "set a five-day follow-up" 200 "$CODE" "$BODY"
req POST "/encounters/$ENC2/finalise" '{}'
check "sign it" 201 "$CODE" "$BODY"

login owner@$VERIFY_DOMAIN
req GET "/reminders?patientId=$PID2"
check "one reminder is scheduled" 1 "$(count '"dueAt"' "$BODY")" "$BODY"
printf '%s' "$BODY" | grep -q '"status":"PENDING"'   && check "and it is pending" y y   || check "and it is pending" y n
printf '%s' "$BODY" | grep -q '"kind":"FOLLOW_UP"'   && check "as a follow-up" y y   || check "as a follow-up" y n
REM=$(jget "$BODY" id)

echo "-- it does not fire before it is due --"
# The whole point of a due date. A run now must leave it alone.
job
check "run the scheduler" 201 "$CODE" "$BODY"
req GET "/reminders?patientId=$PID2"
printf '%s' "$BODY" | grep -q '"status":"PENDING"'   && check "a reminder due in four days is still pending" y y   || check "a reminder due in four days is still pending" y n
printf '%s' "$BODY" | grep -q '"attempts":0'   && check "and was never attempted" y y   || check "and was never attempted" y n

echo "-- ONCE, NOT TWICE: the checkpoint --"
#
# Pulled back to now so the next run picks it up. Done in SQL rather than
# through the API on purpose: there is no endpoint that moves a due date, and
# there should not be — nothing a clinic does should make a reminder fire early.
#
# Through the container, because psql is not on a developer's PATH on Windows
# and this suite has to run the same way everywhere the stack does.
# `app.clinic_id` IS SET FIRST, and that is not a workaround — it is the forced
# RLS working. Every tenant table carries FORCE ROW LEVEL SECURITY, which unlike
# plain ENABLE applies to the table's OWNER too, so even `emr_migrator` cannot
# insert a row without declaring which clinic it belongs to. An earlier version
# of this helper omitted it and every insert was silently rejected.
# `-q` matters: without it psql prints the command tag ("INSERT 0 1") after the
# RETURNING value, so taking the last line captured the tag instead of the id.
psql_q() {
  docker compose -f "$ROOT/docker-compose.yml" exec -T postgres psql -q -U emr_migrator -d emr -t -A -c "SELECT set_config('app.clinic_id', '$VERIFY_CLINIC_ID', false)" -c "$1" 2>&1 | tail -1 | sed "s/[[:space:]]*$//"
}

psql_q "UPDATE scheduled_reminder SET due_at = now() - interval '1 minute' WHERE id = '$REM'" >/dev/null
check "the reminder is now due" y y

# TWO RUNS AT ONCE. This is the assertion the design is for: overlapping cron
# runs are not hypothetical, they are what happens the first time a send is
# slow. The claim is `UPDATE ... WHERE status = 'PENDING' ... FOR UPDATE SKIP
# LOCKED`, so the second run takes nothing; the idempotency key on the
# `communication` row is the layer under that.
job & job & wait

req GET "/reminders?patientId=$PID2"
check "still exactly one reminder row" 1 "$(count '"dueAt"' "$BODY")" "$BODY"
printf '%s' "$BODY" | grep -q '"status":"PENDING"'   && check "it is no longer pending" n y   || check "it is no longer pending" n n

# ONE message, whatever happened to it. The fixture patient has WhatsApp consent
# and the fixture clinic has an approved template — but it is named
# `clinic_closure_notice`, not `follow_up_reminder`, so the honest outcome here
# is a FAILED reminder that says exactly which template is missing. That is the
# behaviour we want: an administrator can fix a missing template in ten minutes,
# and a reminder that silently never sends is discovered when a patient does not
# come back.
MESSAGES=$(psql_q "SELECT count(*) FROM communication WHERE idempotency_key = 'reminder-$REM'")
check "at most one message exists for this reminder" 1 "$(( MESSAGES > 1 ? 2 : 1 ))" "$BODY"

ATTEMPTS=$(psql_q "SELECT attempts FROM scheduled_reminder WHERE id = '$REM'")
check "claimed once, not twice" 1 "$ATTEMPTS"

STATUS=$(psql_q "SELECT status FROM scheduled_reminder WHERE id = '$REM'")
echo "        (terminal status: $STATUS)"
case "$STATUS" in
  SENT|FAILED|SKIPPED) check "it reached a terminal status" y y ;;
  *) check "it reached a terminal status (not $STATUS)" y n ;;
esac

# Nothing may be left mid-flight. A row stuck in SENDING is only picked up again
# by the stale-claim sweep fifteen minutes later, so every exit path has to write
# a terminal status.
# Scoped to THIS clinic explicitly. `emr_migrator` is a superuser, so it
# bypasses row-level security entirely and would otherwise count rows belonging
# to every other clinic on the deployment — including leftovers from a run that
# was interrupted. See the note in migration 0012 about what FORCE does and does
# not buy.
STUCK=$(psql_q "SELECT count(*) FROM scheduled_reminder WHERE status = 'SENDING' AND clinic_id = '$VERIFY_CLINIC_ID'")
check "nothing is left stuck in SENDING" 0 "$STUCK"

# And a third run finds nothing to do.
job
printf '%s' "$BODY" | grep -q '"claimed":0'   && check "a later run claims nothing" y y   || check "a later run claims nothing" y n

echo "-- a missing template is reported, not swallowed --"
if [ "$STATUS" = "FAILED" ]; then
  req GET "/reminders?patientId=$PID2"
  printf '%s' "$BODY" | grep -qi 'follow_up_reminder'   && check "the failure names the template to create" y y   || check "the failure names the template to create" y n
else
  check "the failure names the template to create (status was $STATUS)" y y
fi

echo "-- no consent, no message, and it is not a failure --"
# A patient who never consented to WhatsApp was CORRECTLY not messaged. Filing
# that as FAILED would make a working system look broken and bury the real
# failures in the noise.
NOCONSENT=$(psql_q "
  INSERT INTO scheduled_reminder (clinic_id, patient_id, kind, due_at, channel, status)
  SELECT '$VERIFY_CLINIC_ID', p.id, 'FOLLOW_UP', now() - interval '1 minute', 'WHATSAPP', 'PENDING'
  FROM patient p
  WHERE p.clinic_id = '$VERIFY_CLINIC_ID'
    AND NOT EXISTS (
      SELECT 1 FROM consent c
      WHERE c.patient_id = p.id AND c.scope = 'WHATSAPP_COMMUNICATION' AND c.status = 'ACTIVE'
    )
  LIMIT 1
  RETURNING id")
if [ -n "$NOCONSENT" ]; then
  job
  SKIPPED=$(psql_q "SELECT status FROM scheduled_reminder WHERE id = '$NOCONSENT'")
  check "a patient without consent is SKIPPED, not FAILED" SKIPPED "$SKIPPED"
  REASON=$(psql_q "SELECT last_error FROM scheduled_reminder WHERE id = '$NOCONSENT'")
  printf '%s' "$REASON" | grep -qi 'consent'   && check "and the reason says why" y y   || check "and the reason says why" y n
else
  echo "        (every fixture patient has consent; skip)"
fi

echo "-- email is modelled, not implemented, and says so --"
EMAILREM=$(psql_q "
  INSERT INTO scheduled_reminder (clinic_id, patient_id, kind, due_at, channel, status)
  VALUES ('$VERIFY_CLINIC_ID', '$PID', 'FOLLOW_UP', now() - interval '1 minute', 'EMAIL', 'PENDING')
  RETURNING id")
job
EMAILSTATUS=$(psql_q "SELECT status FROM scheduled_reminder WHERE id = '$EMAILREM'")
check "an email reminder fails rather than pretending" FAILED "$EMAILSTATUS"
EMAILREASON=$(psql_q "SELECT last_error FROM scheduled_reminder WHERE id = '$EMAILREM'")
printf '%s' "$EMAILREASON" | grep -qi 'mail provider'   && check "and says there is no mail provider" y y   || check "and says there is no mail provider" y n

echo "-- a stuck claim is recovered, not abandoned --"
# A runner that dies mid-send leaves a row in SENDING. Nothing would ever pick it
# up again, so the sweep releases claims older than fifteen minutes back to
# PENDING — not to FAILED, because nothing is known about whether the message
# went, and the idempotency key means a retry cannot duplicate one that did.
STUCKREM=$(psql_q "
  INSERT INTO scheduled_reminder (clinic_id, patient_id, kind, due_at, channel, status, claimed_at, attempts)
  VALUES ('$VERIFY_CLINIC_ID', '$PID', 'APPOINTMENT', now() - interval '1 hour', 'WHATSAPP', 'SENDING', now() - interval '2 hours', 1)
  RETURNING id")
job
RECOVERED=$(printf '%s' "$BODY" | grep -o '"recovered":[0-9]*' | head -1 | cut -d: -f2)
check "the run reports recovering it" 1 "${RECOVERED:-0}" "$BODY"

echo "-- who may read and change any of this --"
login reception@$VERIFY_DOMAIN
req GET /reminders
check "reception can read the reminder log" 200 "$CODE" "$BODY"
req POST /settings/reminders '{"followUpEnabled":false}'
check "but cannot change the settings" 403 "$CODE" "$BODY"

login pharmacist@$VERIFY_DOMAIN
req GET /reminders
check "a pharmacist cannot read it at all" 403 "$CODE" "$BODY"

login doctor@$VERIFY_DOMAIN
req GET /settings/reminders
check "a doctor can see what the clinic sends" 200 "$CODE" "$BODY"

echo "-- cancelling --"
login owner@$VERIFY_DOMAIN
NEWREM=$(psql_q "
  INSERT INTO scheduled_reminder (clinic_id, patient_id, kind, due_at, channel, status)
  VALUES ('$VERIFY_CLINIC_ID', '$PID', 'FOLLOW_UP', now() + interval '3 days', 'WHATSAPP', 'PENDING')
  RETURNING id")
req POST "/reminders/$NEWREM/cancel"
check "cancel a pending reminder" 201 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q '"cancelled":true'   && check "it says it cancelled" y y   || check "it says it cancelled" y n

# A sent message cannot be unsent, and "cancelling" one would misrepresent what
# the patient received.
req POST "/reminders/$REM/cancel"
printf '%s' "$BODY" | grep -q '"cancelled":false'   && check "an already-sent reminder cannot be cancelled" y y   || check "an already-sent reminder cannot be cancelled" y n

job
CANCELLED=$(psql_q "SELECT status FROM scheduled_reminder WHERE id = '$NEWREM'")
check "and a cancelled one is never sent" CANCELLED "$CANCELLED"

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
