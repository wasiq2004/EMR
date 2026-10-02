#!/usr/bin/env bash
#
# Availability: the recurring pattern, the exceptions to it, and the slots
# derived from both.
#
# Slots are not stored. Every read recomputes them from the pattern, minus
# exceptions, minus what is already booked — so the only way to know the
# derivation is right is to set a pattern up and count what comes back. The
# arithmetic is where this goes wrong: a trailing remainder that is too short to
# be an appointment, a cancelled booking that still holds its slot, a clinic-wide
# holiday that a doctor's own entry should override. None of those are visible to
# a type checker and all of them are visible here.
#
#   bash scripts/verify/availability.sh     (needs fixtures; see all.sh)
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

# Reads one field out of a JSON object without a JSON parser, which is what the
# rest of the suites do. Good enough for flat scalars, which is all we ask for.
field() { printf '%s' "$2" | grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
count() { printf '%s' "$2" | grep -o "\"$1\"" | wc -l | tr -d ' '; }

# Slots come back as UTC instants, because that is what a timestamp is. A
# session described as "nine in the morning" is nine in the CLINIC's timezone, so
# the expected instant has to be resolved through that zone rather than written
# out by hand — and grepping for a local-looking string would make every one of
# these assertions pass without testing anything.
TZ_CLINIC="${VERIFY_TIMEZONE:-Asia/Kolkata}"
instant() { # YYYY-MM-DD HH:MM -> the UTC instant, as the API renders it
  node -e '
    const [date, clock, zone] = process.argv.slice(1);
    // Find the UTC instant whose wall clock in `zone` is the one asked for.
    const guess = new Date(`${date}T${clock}:00Z`);
    const seen = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    }).formatToParts(guess).reduce((a, p) => ((a[p.type] = p.value), a), {});
    const offset =
      Date.UTC(+seen.year, +seen.month - 1, +seen.day, +(seen.hour % 24), +seen.minute) -
      guess.getTime();
    console.log(new Date(guess.getTime() - offset).toISOString());
  ' "$1" "$2" "$TZ_CLINIC"
}
# The JSON object describing one appointment, pulled out of a calendar body.
#
# Needed because the calendar carries several entries and several slots, and
# grepping the first `"version":` or the first `"startsAt":` in the whole payload
# finds whichever came first — which is how a test ends up reading a slot's time
# and reporting that an appointment moved.
entry_of() { # appointment-id body -> ENTRY
  ENTRY=$(printf '%s' "$2" | tr '{' '
' | grep "$1" | head -1)
}

# An ENTRY's start, which is `scheduledStart` and not `startsAt`. Slots carry
# `startsAt` too, so `at` below cannot tell the difference between "the
# appointment is at 09:45" and "there is a free slot at 09:45".
entry_at() { # name appointment-id date clock body
  entry_of "$2" "$5"
  local want="$(instant "$3" "$4")" found=n
  printf '%s' "$ENTRY" | grep -q "\"scheduledStart\":\"$want\"" && found=y
  check "$1" y "$found" "$ENTRY"
}

at() { # name date clock present|absent body
  local want=$4 found=n
  printf '%s' "$5" | grep -q "\"startsAt\":\"$(instant "$2" "$3")\"" && found=y
  if [ "$want" = present ]; then check "$1" y "$found" "$5"; else check "$1" n "$found" "$5"; fi
}

# A Wednesday far enough out that no fixture appointment lands on it, and inside
# the 120-day cap the service enforces. Computed rather than hardcoded so this
# suite does not expire.
DAY=$(node -e '
  const d = new Date(); d.setDate(d.getDate() + 30);
  while (d.getDay() !== 3) d.setDate(d.getDate() + 1);
  console.log(d.toISOString().slice(0, 10));
')
NEXT=$(node -e "const d=new Date('$DAY'); d.setDate(d.getDate()+1); console.log(d.toISOString().slice(0,10))")
echo "-- deriving against $DAY (a Wednesday) --"

echo "-- who may change a working week --"
login reception@$VERIFY_DOMAIN; check "login (reception)" 201 "$CODE" "$BODY"
req GET "/availability/slots?from=$DAY&to=$NEXT"
check "reception reads slots" 200 "$CODE" "$BODY"
req POST /availability/schedules \
  "{\"practitionerId\":\"00000000-0000-0000-0000-000000000000\",\"weekday\":3,\"startsAt\":\"09:00\",\"endsAt\":\"10:00\"}"
check "reception cannot rewrite a doctor's week" 403 "$CODE" "$BODY"

login owner@$VERIFY_DOMAIN; check "login (clinic admin)" 201 "$CODE" "$BODY"

# The doctor's id, taken from the staff list rather than assumed.
req GET /users
DOCTOR=$(printf '%s' "$BODY" \
  | tr '}' '\n' \
  | grep "doctor@$VERIFY_DOMAIN" \
  | grep -o '"id":"[0-9a-f-]\{36\}"' | head -1 | cut -d'"' -f4)
if [ -z "$DOCTOR" ]; then
  echo "  FAIL  could not find the fixture doctor in /users"; exit 1
fi
check "found the fixture doctor" y y

echo "-- a pattern, and the slots it implies --"
# 09:00–10:00 in 15-minute slots is exactly four. Chosen because the answer is
# countable by hand: an assertion against a number nobody can verify proves only
# that the code agrees with itself.
req POST /availability/schedules \
  "{\"practitionerId\":\"$DOCTOR\",\"weekday\":3,\"startsAt\":\"09:00\",\"endsAt\":\"10:00\",\"slotMinutes\":15}"
check "save a Wednesday morning session" 201 "$CODE" "$BODY"
SCHED=$(field id "$BODY")

req GET "/availability/schedules?practitionerId=$DOCTOR"
check "the session is listed back" 200 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q '"weekday":3' \
  && check "listed on the right weekday" y y || check "listed on the right weekday" y n

req GET "/availability/slots?from=$DAY&to=$NEXT&practitionerId=$DOCTOR"
check "slots for the day" 200 "$CODE" "$BODY"
check "09:00-10:00 at 15 minutes is four slots" 4 "$(count startsAt "$BODY")" "$BODY"
at "the first slot starts at 09:00" "$DAY" 09:00 present "$BODY"
at "the last slot starts at 09:45"  "$DAY" 09:45 present "$BODY"
at "nothing starts at 10:00 (the end is exclusive)" "$DAY" 10:00 absent "$BODY"

echo "-- a session that does not divide evenly --"
# 09:00–09:50 at 20 minutes is two slots and a ten-minute remainder. The
# remainder must be dropped: an appointment half the length of the session's own
# slot is not a slot, and offering it books a patient into a gap.
req POST /availability/schedules \
  "{\"practitionerId\":\"$DOCTOR\",\"weekday\":3,\"startsAt\":\"14:00\",\"endsAt\":\"14:50\",\"slotMinutes\":20}"
check "save an afternoon session with a remainder" 201 "$CODE" "$BODY"
RAGGED=$(field id "$BODY")
req GET "/availability/slots?from=$DAY&to=$NEXT&practitionerId=$DOCTOR"
check "morning four plus afternoon two" 6 "$(count startsAt "$BODY")" "$BODY"
at "14:20 is offered" "$DAY" 14:20 present "$BODY"
at "the ten-minute remainder is not offered" "$DAY" 14:40 absent "$BODY"
req POST "/availability/schedules/$RAGGED/remove"; check "remove the ragged session" 201 "$CODE" "$BODY"

echo "-- a booking takes a slot out --"
req GET "/patients?q=lakshmi"
PATIENT=$(field id "$BODY")
req POST /appointments \
  "{\"patientId\":\"$PATIENT\",\"practitionerId\":\"$DOCTOR\",\"scheduledStart\":\"${DAY}T09:00:00+05:30\",\"durationMinutes\":15}"
check "book the 09:00" 201 "$CODE" "$BODY"
APPT=$(field id "$BODY")
req GET "/availability/slots?from=$DAY&to=$NEXT&practitionerId=$DOCTOR"
check "still four slots in the grid" 4 "$(count startsAt "$BODY")" "$BODY"
check "one of them is now taken" 1 "$(printf '%s' "$BODY" | grep -o '"isAvailable":false' | wc -l | tr -d ' ')" "$BODY"

echo "-- a cancelled booking gives the slot back --"
# This is the one that matters at a counter: a cancellation that keeps holding
# its slot means the 09:00 can never be resold, and nobody can see why.
req PATCH "/appointments/$APPT/status" '{"status":"CANCELLED"}'
check "cancel it" 200 "$CODE" "$BODY"
req GET "/availability/slots?from=$DAY&to=$NEXT&practitionerId=$DOCTOR"
check "every slot is free again" 0 \
  "$(printf '%s' "$BODY" | grep -o '"isAvailable":false' | wc -l | tr -d ' ')" "$BODY"

echo "-- leave empties the day --"
req POST /availability/exceptions \
  "{\"practitionerId\":\"$DOCTOR\",\"onDate\":\"$DAY\",\"isAvailable\":false,\"reason\":\"Conference\"}"
check "record a day of leave" 201 "$CODE" "$BODY"
LEAVE=$(field id "$BODY")
req GET "/availability/slots?from=$DAY&to=$NEXT&practitionerId=$DOCTOR"
check "slots still 200" 200 "$CODE" "$BODY"
check "the day offers nothing" 0 "$(count startsAt "$BODY")" "$BODY"
printf '%s' "$BODY" | grep -q 'Conference' \
  && check "and says why" y y || check "and says why" y n

echo "-- a reason is not optional --"
req POST /availability/exceptions \
  "{\"practitionerId\":\"$DOCTOR\",\"onDate\":\"$NEXT\",\"isAvailable\":false,\"reason\":\"\"}"
check "leave with no reason is refused" 422 "$CODE" "$BODY"

echo "-- the doctor's own entry beats a clinic-wide one --"
# A clinic closes for a holiday; one doctor comes in anyway to clear a backlog.
# The specific entry has to win, or the clinic cannot describe what is happening.
req POST /availability/exceptions \
  "{\"onDate\":\"$DAY\",\"isAvailable\":false,\"reason\":\"Public holiday\"}"
check "close the whole clinic that day" 201 "$CODE" "$BODY"
HOLIDAY=$(field id "$BODY")
req POST /availability/exceptions \
  "{\"id\":\"$LEAVE\",\"practitionerId\":\"$DOCTOR\",\"onDate\":\"$DAY\",\"isAvailable\":true,\"startsAt\":\"11:00\",\"endsAt\":\"12:00\",\"slotMinutes\":30,\"reason\":\"Clearing a backlog\"}"
check "the doctor works anyway" 201 "$CODE" "$BODY"
req GET "/availability/slots?from=$DAY&to=$NEXT&practitionerId=$DOCTOR"
check "their own hours apply, not the closure" 2 "$(count startsAt "$BODY")" "$BODY"
at "and they are the replacement hours" "$DAY" 11:00 present "$BODY"
at "the usual 09:00 is gone"                "$DAY" 09:00 absent  "$BODY"

echo "-- one entry per doctor per date --"
# Two overlapping exceptions for one day is a state nobody can read: which wins?
# A second insert must update the first rather than sit beside it.
req GET "/availability/exceptions?from=$DAY&to=$NEXT"
check "exceptions listed" 200 "$CODE" "$BODY"
check "two entries: one clinic-wide, one the doctor's" 2 "$(count onDate "$BODY")" "$BODY"

echo "-- putting it back --"
req POST "/availability/exceptions/$HOLIDAY/remove"; check "remove the holiday" 201 "$CODE" "$BODY"
req POST "/availability/exceptions/$LEAVE/remove";   check "remove the leave"    201 "$CODE" "$BODY"
req GET "/availability/slots?from=$DAY&to=$NEXT&practitionerId=$DOCTOR"
check "the pattern is back to four slots" 4 "$(count startsAt "$BODY")" "$BODY"
req POST "/availability/schedules/$SCHED/remove"; check "remove the session" 201 "$CODE" "$BODY"
req GET "/availability/slots?from=$DAY&to=$NEXT&practitionerId=$DOCTOR"
check "no pattern, no slots" 0 "$(count startsAt "$BODY")" "$BODY"

echo "-- a range nobody should be able to ask for --"
# Unbounded ranges are how a derived endpoint becomes a denial of service.
FAR=$(node -e 'const d=new Date(); d.setDate(d.getDate()+400); console.log(d.toISOString().slice(0,10))')
req GET "/availability/slots?from=$DAY&to=$FAR"
check "a year of slots is refused" 422 "$CODE" "$BODY"
req GET "/availability/slots?from=not-a-date&to=$NEXT"
check "a malformed date is refused" 422 "$CODE" "$BODY"


# ===========================================================================
# Stage B — the calendar
# ===========================================================================
#
# The calendar is one endpoint on purpose: the analytics strip has to agree with
# the grid beneath it. So these assertions mostly check that agreement, and that
# a filter narrows both together rather than one of them.

echo "-- the calendar composes bookings, slots and the day's numbers --"
login owner@$VERIFY_DOMAIN
req POST /availability/schedules \
  "{\"practitionerId\":\"$DOCTOR\",\"weekday\":3,\"startsAt\":\"09:00\",\"endsAt\":\"10:00\",\"slotMinutes\":15}"
check "a Wednesday session to draw" 201 "$CODE" "$BODY"
CSCHED=$(field id "$BODY")

req GET "/calendar?from=$DAY&to=$NEXT"
check "GET /calendar" 200 "$CODE" "$BODY"
check "one day in a one-day range" 1 "$(count date "$BODY")" "$BODY"
printf '%s' "$BODY" | grep -q '"columns"'   && check "it carries columns" y y   || check "it carries columns" y n
printf '%s' "$BODY" | grep -q '"analytics"'   && check "and the day's analytics" y y   || check "and the day's analytics" y n

echo "-- a booking moves the grid and the strip together --"
req GET "/patients?q=lakshmi"
CPAT=$(field id "$BODY")
req POST /appointments \
  "{\"patientId\":\"$CPAT\",\"practitionerId\":\"$DOCTOR\",\"scheduledStart\":\"${DAY}T09:30:00+05:30\",\"durationMinutes\":15}"
check "book the 09:30" 201 "$CODE" "$BODY"
CAPPT=$(field id "$BODY")

req GET "/calendar?from=$DAY&to=$NEXT"
printf '%s' "$BODY" | grep -q '"booked":1'   && check "the strip says one booked" y y   || check "the strip says one booked" y n
# TWO entries, not one. The appointment Stage A cancelled is still drawn — a
# cancelled block keeps its place in the grid so the day reads as it happened,
# and the strip excludes it from `booked` instead of the grid dropping it.
check "both the new booking and the cancelled one are drawn" 2 "$(count patientMrn "$BODY")" "$BODY"
printf '%s' "$BODY" | grep -q '"status":"CANCELLED"'   && check "the cancelled one is still there" y y   || check "the cancelled one is still there" y n
printf '%s' "$BODY" | grep -q '"cancelled":1'   && check "and counted as cancelled, not booked" y y   || check "and counted as cancelled, not booked" y n
# Four slots, one of them taken, so three remain free. The strip and the grid
# must say the same thing — this is the whole reason the endpoint exists.
printf '%s' "$BODY" | grep -q '"freeSlots":3'   && check "three slots left, counted over the same rows" y y   || check "three slots left, counted over the same rows" y n
printf '%s' "$BODY" | grep -q '"utilisationPct":25'   && check "15 of 60 offered minutes is 25% utilisation" y y   || check "15 of 60 offered minutes is 25% utilisation" y n

echo "-- a no-show does not count as a busy doctor --"
# Utilisation exists so a clinic can see whether it is actually full. Counting
# an appointment nobody attended would make the worst day of the month read as
# the busiest.
req PATCH "/appointments/$CAPPT/status" '{"status":"NOSHOW"}'
check "mark it a no-show" 200 "$CODE" "$BODY"
req GET "/calendar?from=$DAY&to=$NEXT"
printf '%s' "$BODY" | grep -q '"noShow":1'   && check "the strip counts the no-show" y y   || check "the strip counts the no-show" y n
printf '%s' "$BODY" | grep -q '"utilisationPct":0'   && check "but utilisation drops to zero" y y   || check "but utilisation drops to zero" y n
printf '%s' "$BODY" | grep -q '"freeSlots":4'   && check "and the slot is offered again" y y   || check "and the slot is offered again" y n

echo "-- filters narrow the grid and the numbers together --"
req PATCH "/appointments/$CAPPT/status" '{"status":"ARRIVED"}'
check "walk them back in" 200 "$CODE" "$BODY"
req GET "/calendar?from=$DAY&to=$NEXT&status=SCHEDULED"
check "filter to SCHEDULED only" 200 "$CODE" "$BODY"
check "the arrived appointment is not drawn" 0 "$(count patientMrn "$BODY")" "$BODY"
printf '%s' "$BODY" | grep -q '"arrived":0'   && check "and the strip agrees it is not there" y y   || check "and the strip agrees it is not there" y n

req GET "/calendar?from=$DAY&to=$NEXT&status=ARRIVED"
check "filter to ARRIVED" 200 "$CODE" "$BODY"
printf '%s' "$BODY" | grep -q '"arrived":1'   && check "now the strip finds it" y y   || check "now the strip finds it" y n

req GET "/calendar?from=$DAY&to=$NEXT&status=NOT_A_STATUS"
check "a bogus status is refused, not ignored" 422 "$CODE" "$BODY"

req GET "/calendar?from=$DAY&to=$NEXT&practitionerId=00000000-0000-0000-0000-000000000000"
check "an unknown doctor returns an empty day, not an error" 200 "$CODE" "$BODY"
check "with nothing drawn" 0 "$(count patientMrn "$BODY")" "$BODY"

echo "-- the month view derives no slots --"
# Thirty cells of counts do not need six thousand slot objects. `freeSlots` must
# come back NULL rather than 0: zero reads as "fully booked", and a month
# claiming every day is full is worse than one claiming nothing.
FOURWK=$(node -e "const d=new Date('$DAY');d.setDate(d.getDate()+28);console.log(d.toISOString().slice(0,10))")
req GET "/calendar?from=$DAY&to=$FOURWK&includeSlots=false"
check "a four-week range" 200 "$CODE" "$BODY"
check "twenty-eight days" 28 "$(count date "$BODY")" "$BODY"
check "no slots derived" 0 "$(count startsAt "$BODY")" "$BODY"
printf '%s' "$BODY" | grep -q '"freeSlots":null'   && check "free slots are null, not zero" y y   || check "free slots are null, not zero" y n

echo "-- rescheduling: what a drag does --"
req GET "/calendar?from=$DAY&to=$NEXT"
entry_of "$CAPPT" "$BODY"
VER=$(printf '%s' "$ENTRY" | grep -o '"version":[0-9]*' | head -1 | cut -d: -f2)
[ -n "$VER" ] && check "found this appointment's own version" y y   || check "found this appointment's own version" y n
req PATCH "/appointments/$CAPPT/schedule" \
  "{\"scheduledStart\":\"${DAY}T09:45:00+05:30\",\"scheduledEnd\":\"${DAY}T10:00:00+05:30\",\"version\":$VER}"
check "move it to 09:45" 200 "$CODE" "$BODY"
req GET "/calendar?from=$DAY&to=$NEXT"
entry_at "the appointment itself is at 09:45 now" "$CAPPT" "$DAY" 09:45 "$BODY"

# A stale version is the two-people-one-calendar case. Without this check the
# later drag silently wins and the earlier one vanishes with no trace.
req PATCH "/appointments/$CAPPT/schedule" \
  "{\"scheduledStart\":\"${DAY}T09:00:00+05:30\",\"version\":$VER}"
check "a stale version is refused" 409 "$CODE" "$BODY"

req PATCH "/appointments/$CAPPT/schedule" \
  "{\"scheduledStart\":\"${DAY}T09:00:00+05:30\",\"scheduledEnd\":\"${DAY}T08:00:00+05:30\"}"
check "an end before its start is refused, not swapped" 409 "$CODE" "$BODY"

echo "-- a closed appointment does not move --"
# Dragging a cancelled or checked-out block to a new time would rewrite history:
# the visit happened, or did not, at the time it says.
req PATCH "/appointments/$CAPPT/status" '{"status":"CANCELLED","cancelledReason":"Patient rang"}'
check "cancel it" 200 "$CODE" "$BODY"
req PATCH "/appointments/$CAPPT/schedule" "{\"scheduledStart\":\"${DAY}T09:00:00+05:30\"}"
check "a cancelled appointment cannot be moved" 409 "$CODE" "$BODY"

echo "-- who may see a calendar at all --"
# Not a client-side check. The pharmacy and analytics panels hold no scheduling
# permission, and the guard is the control.
login pharmacist@$VERIFY_DOMAIN; check "login (pharmacist)" 201 "$CODE" "$BODY"
req GET "/calendar?from=$DAY&to=$NEXT"
check "a pharmacist gets no calendar" 403 "$CODE" "$BODY"
login analyst@$VERIFY_DOMAIN; check "login (research analyst)" 201 "$CODE" "$BODY"
req GET "/calendar?from=$DAY&to=$NEXT"
check "nor does an analyst" 403 "$CODE" "$BODY"
login doctor@$VERIFY_DOMAIN
req GET "/calendar?from=$DAY&to=$NEXT"
check "the doctor does" 200 "$CODE" "$BODY"
login reception@$VERIFY_DOMAIN
req GET "/calendar?from=$DAY&to=$NEXT"
check "and so does the front desk" 200 "$CODE" "$BODY"

login owner@$VERIFY_DOMAIN
req POST "/availability/schedules/$CSCHED/remove"
check "clean up the session" 201 "$CODE" "$BODY"

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
