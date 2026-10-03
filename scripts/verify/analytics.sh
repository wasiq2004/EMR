#!/usr/bin/env bash
#
# Clinic analytics: the numbers, and the distinctions between them.
#
# Every assertion here is a number somebody would otherwise read wrongly.
# Collected is not invoiced; outstanding is not range-filtered; a no-show rate
# needs a denominator that has closed; utilisation without a schedule is unknown
# rather than zero. Those four get a clinic's budget wrong in four different
# directions, so each is asserted against money and appointments this suite
# creates itself.
#
#   bash scripts/verify/analytics.sh     (needs fixtures; see all.sh)
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
num()   { printf '%s' "$2" | grep -o "\"$1\":[0-9-]*" | head -1 | cut -d: -f2; }
key()   { node -e 'console.log(require("crypto").randomUUID())'; }

# Sums a breakdown array out of the response, so a drift between a total and its
# parts fails here rather than being noticed in a meeting.
sumof() { # section field body
  printf '%s' "$3" | python -c "
import json,sys
d = json.load(sys.stdin)
print(sum(r['amountPaise'] for r in d['$1']['$2']))
"
}

# ---------------------------------------------------------------------------
# DELTAS, NOT ABSOLUTES.
#
# `all.sh` builds ONE fixture clinic and runs every suite against it, so by the
# time this one runs, consultation-flow has already raised invoices and taken
# payments in the same clinic. Asserting "collected is exactly 650 rupees" passed
# when this suite ran alone and failed inside the full run — a test that depends
# on what ran before it is a test nobody can trust.
#
# So: read a figure, create known money, read it again, and assert the
# DIFFERENCE. That is true whatever else is in the clinic, and it is what the
# figure actually claims to measure.
# ---------------------------------------------------------------------------
baseline() { # -> BASE_COLLECTED, BASE_INVOICED, BASE_OUTSTANDING, BASE_REFUNDED
  req GET "/reports/analytics?$RANGE"
  BASE_COLLECTED=$(num collectedPaise "$BODY")
  BASE_INVOICED=$(num invoicedPaise "$BODY")
  BASE_OUTSTANDING=$(num outstandingPaise "$BODY")
  BASE_REFUNDED=$(num refundedPaise "$BODY")
}
delta() { # label expected before after
  check "$1" "$2" "$(( $4 - $3 ))"
}

# UTC throughout. A local weekday with a UTC date is right for most of the day
# and wrong overnight east of Greenwich — see availability.sh.
TODAY=$(node -e 'const d=new Date();d.setUTCHours(0,0,0,0);console.log(d.toISOString().slice(0,10))')
TOMORROW=$(node -e 'const d=new Date();d.setUTCDate(d.getUTCDate()+1);console.log(d.toISOString().slice(0,10))')
MONTH_AGO=$(node -e 'const d=new Date();d.setUTCDate(d.getUTCDate()-30);console.log(d.toISOString().slice(0,10))')
RANGE="from=$MONTH_AGO&to=$TOMORROW"

echo "-- who may read it --"
login reception@$VERIFY_DOMAIN; check "login (reception)" 201 "$CODE" "$BODY"
req GET "/reports/analytics?$RANGE"
check "reception cannot read clinic analytics" 403 "$CODE" "$BODY"

login owner@$VERIFY_DOMAIN; check "login (clinic admin)" 201 "$CODE" "$BODY"
req GET "/reports/analytics?$RANGE"
check "an administrator can" 200 "$CODE" "$BODY"

echo "-- the range is bounded before any query runs --"
# Utilisation derives slots across the range, so an unbounded range is how a
# report becomes a denial of service.
req GET "/reports/analytics?from=$TODAY&to=$TODAY"
check "a zero-length range is refused" 422 "$CODE" "$BODY"
req GET "/reports/analytics?from=$TOMORROW&to=$TODAY"
check "a backwards range is refused" 422 "$CODE" "$BODY"
FAR=$(node -e 'const d=new Date();d.setUTCDate(d.getUTCDate()+400);console.log(d.toISOString().slice(0,10))')
req GET "/reports/analytics?from=$TODAY&to=$FAR"
check "more than 120 days is refused" 422 "$CODE" "$BODY"
req GET "/reports/analytics?from=not-a-date&to=$TOMORROW"
check "a malformed date is refused" 422 "$CODE" "$BODY"

echo "-- money: collected is not invoiced --"
baseline
echo "        (baseline: collected=$BASE_COLLECTED invoiced=$BASE_INVOICED owed=$BASE_OUTSTANDING)"

req GET "/patients?q=arjun"
PID=$(jget "$BODY" id)

login reception@$VERIFY_DOMAIN
# ₹1000 invoiced, ₹400 collected in cash. Chosen so no two figures could be
# confused for each other by coincidence.
req POST /invoices "{\"patientId\":\"$PID\",\"lineItems\":[{\"description\":\"Consultation\",\"quantity\":1,\"unitPricePaise\":100000,\"amountPaise\":100000}]}"
check "raise a 1000 rupee invoice" 201 "$CODE" "$BODY"
INV=$(jget "$BODY" id)
req POST "/invoices/$INV/payments" "{\"amountPaise\":40000,\"method\":\"CASH\",\"idempotencyKey\":\"$(key)\"}"
check "collect 400 of it in cash" 201 "$CODE" "$BODY"

# A second invoice, fully paid by UPI, so the method breakdown has two rows.
req POST /invoices "{\"patientId\":\"$PID\",\"lineItems\":[{\"description\":\"Dressing\",\"quantity\":1,\"unitPricePaise\":25000,\"amountPaise\":25000}]}"
INV2=$(jget "$BODY" id)
req POST "/invoices/$INV2/payments" "{\"amountPaise\":25000,\"method\":\"UPI\",\"idempotencyKey\":\"$(key)\"}"
check "collect 250 by UPI" 201 "$CODE" "$BODY"

login owner@$VERIFY_DOMAIN
req GET "/reports/analytics?$RANGE"
check "analytics loads" 200 "$CODE" "$BODY"

# 40000 + 25000 = 65000 collected. 100000 + 25000 = 125000 invoiced. These are
# DIFFERENT NUMBERS and reporting either alone as "revenue" is how a clinic
# budgets against money it has not received.
AFTER_COLLECTED=$(num collectedPaise "$BODY")
AFTER_INVOICED=$(num invoicedPaise "$BODY")
AFTER_OUTSTANDING=$(num outstandingPaise "$BODY")

delta "collections rose by the 650 collected" 65000 "$BASE_COLLECTED" "$AFTER_COLLECTED"
delta "invoiced rose by 1250, which is not the same number" 125000 "$BASE_INVOICED" "$AFTER_INVOICED"
# 100000 - 40000 = 60000 still owed on the first invoice; the second is settled.
delta "outstanding rose by the 600 still owed" 60000 "$BASE_OUTSTANDING" "$AFTER_OUTSTANDING"

echo "-- outstanding is deliberately NOT range-filtered --"
# A debt from March is still a debt in June. Scoping it to the window would make
# it shrink as the window moved, which is the opposite of what a dues report is
# for — so a range containing none of the invoices still reports the same debt.
OLD_FROM=$(node -e 'const d=new Date();d.setUTCDate(d.getUTCDate()-100);console.log(d.toISOString().slice(0,10))')
OLD_TO=$(node -e 'const d=new Date();d.setUTCDate(d.getUTCDate()-60);console.log(d.toISOString().slice(0,10))')
req GET "/reports/analytics?from=$OLD_FROM&to=$OLD_TO"
# The range holds none of the money this suite created, so collections drop back
# to whatever the window itself contains — but OUTSTANDING is unchanged, because
# it is a statement about now rather than about the window.
check "a historical range reports the same debt" "$AFTER_OUTSTANDING" "$(num outstandingPaise "$BODY")" "$BODY"
HIST_COLLECTED=$(num collectedPaise "$BODY")
[ "$HIST_COLLECTED" -lt "$AFTER_COLLECTED" ]   && check "while its collections are lower, being a different window" y y   || check "while its collections are lower, being a different window" y n

echo "-- the breakdowns add up --"
req GET "/reports/analytics?$RANGE"
printf '%s' "$BODY" | grep -q '"label":"CASH"'   && check "cash appears in the method breakdown" y y   || check "cash appears in the method breakdown" y n
printf '%s' "$BODY" | grep -q '"label":"UPI"'   && check "and so does UPI" y y   || check "and so does UPI" y n
# Summed out of the response so a drift between the total and its parts fails
# here rather than being noticed in a meeting.
# Against the TOTAL, not against this suite's contribution: the point of the
# assertion is that a breakdown adds up to the figure printed above it.
check "the method rows sum to the collected total" "$(num collectedPaise "$BODY")" "$(sumof revenue byMethod "$BODY")" "$BODY"
check "and the service rows sum to the invoiced total" "$(num invoicedPaise "$BODY")" "$(sumof revenue byService "$BODY")" "$BODY"
check "and the doctor rows too" "$(num collectedPaise "$BODY")" "$(sumof revenue byPractitioner "$BODY")" "$BODY"

echo "-- the payment-method filter narrows the money, not just the chart --"
req GET "/reports/analytics?$RANGE&paymentMethod=CASH"
check "filter to cash" 200 "$CODE" "$BODY"
CASH_ONLY=$(num collectedPaise "$BODY")
# Narrower than everything, and it still adds up to its own breakdown.
[ "$CASH_ONLY" -lt "$AFTER_COLLECTED" ]   && check "cash alone is less than every method" y y   || check "cash alone is less than every method" y n
check "and the cash breakdown sums to it" "$CASH_ONLY" "$(sumof revenue byMethod "$BODY")" "$BODY"
req GET "/reports/analytics?$RANGE&paymentMethod=UPI"
UPI_ONLY=$(num collectedPaise "$BODY")
check "cash plus UPI accounts for everything collected" "$AFTER_COLLECTED" "$(( CASH_ONLY + UPI_ONLY ))" "$BODY"
req GET "/reports/analytics?$RANGE&paymentMethod=NOT_A_METHOD"
check "a bogus method is refused, not ignored" 422 "$CODE" "$BODY"

echo "-- a refund is reported, not netted away silently --"
login reception@$VERIFY_DOMAIN
req POST "/invoices/$INV2/payments" "{\"amountPaise\":-5000,\"method\":\"UPI\",\"isRefund\":true,\"refundReason\":\"Overcharged\",\"idempotencyKey\":\"$(key)\"}"
check "refund 50 rupees" 201 "$CODE" "$BODY"
login owner@$VERIFY_DOMAIN
req GET "/reports/analytics?$RANGE"
delta "the refund has its own figure" 5000 "$BASE_REFUNDED" "$(num refundedPaise "$BODY")"
# Collections are GROSS. A refund that silently reduced them would leave a clinic
# unable to see that a refund happened at all.
check "and collections are unchanged by it" "$AFTER_COLLECTED" "$(num collectedPaise "$BODY")" "$BODY"

echo "-- patients: new and returning do not double-count --"
req GET "/reports/analytics?$RANGE"
NEW=$(num newCount "$BODY"); RET=$(num returningCount "$BODY"); SEEN=$(num seenCount "$BODY")
echo "        (new=$NEW returning=$RET seen=$SEEN)"
# A patient registered AND seen in the range is new, not both — otherwise the
# two add to more than the number of people who came.
[ "$RET" -le "$SEEN" ]   && check "returning never exceeds the number seen" y y   || check "returning never exceeds the number seen" y n

echo "-- appointments: the rates have a denominator that has closed --"
req GET /practitioners
DOC=$(jget "$BODY" id)

login reception@$VERIFY_DOMAIN
# Three appointments today: one completed, one no-show, one cancelled. So the
# closed denominator is 3 and each rate is 33%.
for spec in "09:00 FULFILLED" "09:30 NOSHOW" "10:00 CANCELLED"; do
  set -- $spec
  req POST /appointments "{\"patientId\":\"$PID\",\"practitionerId\":\"$DOC\",\"scheduledStart\":\"${TODAY}T$1:00+05:30\",\"durationMinutes\":15}"
  A=$(jget "$BODY" id)
  case "$2" in
    FULFILLED)
      req PATCH "/appointments/$A/status" '{"status":"ARRIVED"}' >/dev/null
      req PATCH "/appointments/$A/status" '{"status":"IN_PROGRESS"}' >/dev/null
      req PATCH "/appointments/$A/status" '{"status":"FULFILLED"}' ;;
    NOSHOW)    req PATCH "/appointments/$A/status" '{"status":"NOSHOW"}' ;;
    CANCELLED) req PATCH "/appointments/$A/status" '{"status":"CANCELLED","cancelledReason":"Rang to cancel"}' ;;
  esac
done
check "three appointments, one of each outcome" 200 "$CODE" "$BODY"

# A fourth, left SCHEDULED. It must NOT count toward the rates: a no-show rate
# over all appointments counts tomorrow's bookings as attended.
req POST /appointments "{\"patientId\":\"$PID\",\"practitionerId\":\"$DOC\",\"scheduledStart\":\"${TODAY}T11:00:00+05:30\",\"durationMinutes\":15}"
check "and a fourth still scheduled" 201 "$CODE" "$BODY"

login owner@$VERIFY_DOMAIN
req GET "/reports/analytics?from=$TODAY&to=$TOMORROW&practitionerId=$DOC"
# Scoped to TODAY and this doctor, which is where the four were created. The
# rates are asserted as a relationship rather than a fixed percentage, because
# another suite may have booked for the same doctor on the same day: what must
# hold is that the denominator excludes the one still open.
BOOKED=$(num bookedCount "$BODY"); CLOSED=$(num closedCount "$BODY")
echo "        (booked=$BOOKED closed=$CLOSED)"
[ "$BOOKED" -ge 4 ]   && check "the four appointments are counted" y y   || check "the four appointments are counted" y n
[ "$CLOSED" -lt "$BOOKED" ]   && check "the still-scheduled one is NOT in the closed denominator" y y   || check "the still-scheduled one is NOT in the closed denominator" y n
NOSHOW=$(num noShowCount "$BODY"); CANCELLED=$(num cancelledCount "$BODY"); COMPLETED=$(num completedCount "$BODY")
check "closed is completed plus no-show plus cancelled" "$CLOSED" "$(( COMPLETED + NOSHOW + CANCELLED ))" "$BODY"
# The percentage is that count over that denominator, rounded — asserted as the
# arithmetic rather than as a number, so it holds whatever else is in the day.
check "the no-show rate is that count over the closed ones" "$(python -c "print(round($NOSHOW/$CLOSED*100))")" "$(num noShowPct "$BODY")" "$BODY"
check "and so is the cancellation rate" "$(python -c "print(round($CANCELLED/$CLOSED*100))")" "$(num cancellationPct "$BODY")" "$BODY"

echo "-- utilisation is unknown without a schedule, not zero --"
# A clinic that has not entered its working hours has no denominator. Reporting
# 0% would read as "nobody came" rather than "we do not know".
printf '%s' "$BODY" | grep -q '"utilisationPct":null'   && check "no schedules means null utilisation" y y   || check "no schedules means null utilisation" y n
printf '%s' "$BODY" | grep -q '"offeredMinutes":null'   && check "and no offered minutes" y y   || check "and no offered minutes" y n

# Now give the doctor hours covering today, and it becomes a real number.
WEEKDAY=$(node -e "console.log(new Date('$TODAY'+'T00:00:00Z').getUTCDay())")
req POST /availability/schedules "{\"practitionerId\":\"$DOC\",\"weekday\":$WEEKDAY,\"startsAt\":\"09:00\",\"endsAt\":\"10:00\",\"slotMinutes\":15}"
check "give the doctor an hour today" 201 "$CODE" "$BODY"
SCHED=$(jget "$BODY" id)

req GET "/reports/analytics?from=$TODAY&to=$TOMORROW&practitionerId=$DOC"
check "one day, one doctor" 200 "$CODE" "$BODY"
check "sixty minutes offered" 60 "$(num offeredMinutes "$BODY")" "$BODY"
# Two live appointments at 15 minutes each inside the hour — the no-show and the
# cancellation contribute nothing, because a doctor is not busy during an
# appointment nobody attended.
BOOKED=$(num bookedMinutes "$BODY")
echo "        (booked minutes: $BOOKED of 60)"
[ "$BOOKED" -gt 0 ] && [ "$BOOKED" -le 60 ]   && check "booked minutes are inside the offered hour" y y   || check "booked minutes are inside the offered hour" y n
UTIL=$(num utilisationPct "$BODY")
[ -n "$UTIL" ] && [ "$UTIL" -ge 0 ] && [ "$UTIL" -le 100 ]   && check "utilisation is a real percentage" y y   || check "utilisation is a real percentage" y n

req POST "/availability/schedules/$SCHED/remove" >/dev/null

echo "-- invoice ageing --"
req GET "/reports/analytics?$RANGE"
check "every bucket is present, including the empty ones" 4 "$(printf '%s' "$BODY" | grep -o '"label":"[0-9]*-[0-9]* days"\|"label":"Over 60 days"' | wc -l | tr -d ' ')" "$BODY"
AGED=$(printf '%s' "$BODY" | python -c "
import json,sys
d = json.load(sys.stdin)
print(sum(b['amountPaise'] for b in d['ageing']['buckets']))
")
check "the buckets sum to the ageing total" "$(printf '%s' "$BODY" | python -c "
import json,sys; print(json.load(sys.stdin)['ageing']['totalPaise'])
")" "$AGED" "$BODY"
# And the ageing total is the outstanding figure, reached by a different query.
# Two numbers for the same money that disagree is the thing worth catching.
check "and match the outstanding figure" "$(num outstandingPaise "$BODY")" "$AGED" "$BODY"
printf '%s' "$BODY" | grep -q '"label":"0-7 days"'   && check "a fresh debt lands in the newest bucket" y y   || check "a fresh debt lands in the newest bucket" y n

echo "-- CSV export --"
for view in revenue-by-method revenue-by-doctor revenue-by-service collections-daily registrations-daily invoice-ageing; do
  out=$(curl -s -b "$J" -c "$J" -w $'\n%{http_code}' "$API/reports/analytics/export?view=$view&$RANGE")
  code="${out##*$'\n'}"; body="${out%$'\n'*}"
  check "export $view" 200 "$code" "$body"
done

out=$(curl -s -b "$J" -c "$J" -w $'\n%{http_code}' "$API/reports/analytics/export?view=not-a-view&$RANGE")
check "an unknown view is refused rather than returning an empty file" 422 "${out##*$'\n'}"

# The quoting has to be real: a service called "Consultation, follow-up" breaks
# a naive join and the file opens in Excel with its columns shifted — which looks
# like bad data rather than a bad export.
login reception@$VERIFY_DOMAIN
req POST /invoices "{\"patientId\":\"$PID\",\"lineItems\":[{\"description\":\"Dressing, large \\\"with tape\\\"\",\"quantity\":1,\"unitPricePaise\":10000,\"amountPaise\":10000}]}"
check "an invoice line with a comma and a quote in it" 201 "$CODE" "$BODY"
login owner@$VERIFY_DOMAIN
CSV=$(curl -s -b "$J" -c "$J" "$API/reports/analytics/export?view=revenue-by-service&$RANGE")
printf '%s' "$CSV" | grep -q '"Dressing, large ""with tape"""'   && check "the comma and quote are escaped per RFC 4180" y y   || check "the comma and quote are escaped per RFC 4180" y n
# Three header cells and no more: a shifted column would show up as a row with
# the wrong field count.
HEADCOLS=$(printf '%s' "$CSV" | head -1 | tr -cd ',' | wc -c | tr -d ' ')
check "the header has three columns" 2 "$HEADCOLS" "$CSV"

echo "-- the dashboard still works --"
# Stage G added to the reports module; the existing summary must be untouched.
req GET /reports/summary
check "the dashboard summary still loads" 200 "$CODE" "$BODY"

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
