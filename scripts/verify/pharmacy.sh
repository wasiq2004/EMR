#!/usr/bin/env bash
#
# The medicine counter: stock that is created, money that is taken, and the
# guarantee that neither happens twice.
#
# WHY THIS SUITE EXISTS. The pharmacy shipped with fifteen tables, thirty-eight
# routes and no API coverage at all. The specific thing it was missing is the one
# this file leads with: `POST /pharmacy/receipts` creates stock and
# `POST /pharmacy/sales` takes money, and until recently a retried request did
# both twice — the web client sent an `Idempotency-Key` header that nothing on
# the server read, and neither table had a column to put it in.
#
#   bash scripts/verify/pharmacy.sh     (needs fixtures; see all.sh)
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

echo "-- who works the counter --"
login pharmacist@$VERIFY_DOMAIN; check "login (pharmacist)" 201 "$CODE" "$BODY"
req GET /pharmacy/queue
check "the pharmacist sees the dispensing queue" 200 "$CODE" "$BODY"
req GET /pharmacy/stock
check "and the stock" 200 "$CODE" "$BODY"

# The counter reads a patient's name, age and allergies — enough to hand the
# right medicine to the right person — and nothing clinical beyond that.
req GET /encounters/00000000-0000-0000-0000-000000000000
check "but not a consultation" 403 "$CODE" "$BODY"

login reception@$VERIFY_DOMAIN
req GET /pharmacy/stock
check "reception does not work the counter" 403 "$CODE" "$BODY"

echo "-- a supplier and a product to receive against --"
login owner@$VERIFY_DOMAIN; check "login (clinic admin)" 201 "$CODE" "$BODY"

req POST /pharmacy/suppliers '{"name":"Verification Distributors","contactPhoneE164":"+919000000002"}'
check "create a supplier" 201 "$CODE" "$BODY"
SUP=$(jget "$BODY" id)

req GET '/drugs/search?q=amox'
CAT=$(jget "$BODY" id)
req POST /pharmacy/products "{\"catalogueItemId\":\"$CAT\",\"name\":\"Mox 500\",\"packUnit\":\"Capsule\",\"packSize\":10,\"reorderLevel\":20,\"gstRateBps\":1200}"
check "stock a product" 201 "$CODE" "$BODY"
PROD=$(jget "$BODY" id)

echo "-- A RECEIPT CREATES STOCK, and must not create it twice --"
# Recording the same delivery twice puts medicine on the shelf that is not
# there, and the shortfall surfaces at the next count with no way to tell which
# receipt was the phantom.
RKEY=$(key)
RECEIPT="{
  \"supplierId\":\"$SUP\",\"supplierInvoiceNumber\":\"INV-1\",
  \"idempotencyKey\":\"$RKEY\",
  \"lines\":[{\"productId\":\"$PROD\",\"batchNumber\":\"B-001\",\"expiryDate\":\"2028-01-31\",
             \"quantity\":100,\"unitCostPaise\":1500,\"mrpPaise\":2500,\"gstRateBps\":1200}]
}"
req POST /pharmacy/receipts "$RECEIPT"
check "receive 100 capsules" 201 "$CODE" "$BODY"
FIRST_RECEIPT=$(jget "$BODY" id)

req GET /pharmacy/stock
ONHAND=$(printf '%s' "$BODY" | tr '{' '\n' | grep 'Mox 500' | grep -o '"quantityOnHand":[0-9]*' | head -1 | cut -d: -f2)
check "a hundred on the shelf" 100 "${ONHAND:-0}" "$BODY"

# THE SAME REQUEST AGAIN. Same key, same everything — a retry after a timeout.
req POST /pharmacy/receipts "$RECEIPT"
check "the same receipt again is accepted" 201 "$CODE" "$BODY"
check "and returns the original, not a new one" "$FIRST_RECEIPT" "$(jget "$BODY" id)" "$BODY"

req GET /pharmacy/stock
ONHAND2=$(printf '%s' "$BODY" | tr '{' '\n' | grep 'Mox 500' | grep -o '"quantityOnHand":[0-9]*' | head -1 | cut -d: -f2)
check "STILL a hundred — the stock was not created twice" 100 "${ONHAND2:-0}" "$BODY"

# A receipt with no key is refused outright rather than accepted unprotected.
req POST /pharmacy/receipts "{
  \"supplierId\":\"$SUP\",
  \"lines\":[{\"productId\":\"$PROD\",\"batchNumber\":\"B-002\",\"expiryDate\":\"2028-01-31\",
             \"quantity\":10,\"unitCostPaise\":1500,\"gstRateBps\":1200}]
}"
check "a receipt with no idempotency key is refused" 422 "$CODE" "$BODY"

echo "-- A SALE TAKES MONEY, and must not take it twice --"
req GET /pharmacy/stock
# The batch, by its number. Stock is listed per BATCH rather than per product,
# and a sale line has to name the batch it came off — selling from "the product"
# is not something the schema allows, because expiry belongs to the batch.
BATCH=$(printf '%s' "$BODY" | tr '{' '\n' | grep 'B-001' | grep -o '"id":"[0-9a-f-]\{36\}"' | head -1 | cut -d'"' -f4)
check "the batch is addressable" y "$([ -n "$BATCH" ] && echo y || echo n)" "$BODY"

SKEY=$(key)
SALE="{
  \"buyerName\":\"Walk-in\",\"paymentMethod\":\"CASH\",\"paidPaise\":2500,
  \"idempotencyKey\":\"$SKEY\",
  \"lines\":[{\"productId\":\"$PROD\",\"stockBatchId\":\"$BATCH\",\"quantity\":1,
             \"unitPricePaise\":2500,\"gstRateBps\":1200,\"discountPaise\":0}]
}"
login pharmacist@$VERIFY_DOMAIN
req POST /pharmacy/sales "$SALE"
check "sell one capsule" 201 "$CODE" "$BODY"
FIRST_SALE=$(jget "$BODY" id)

req GET /pharmacy/stock
AFTER_SALE=$(printf '%s' "$BODY" | tr '{' '\n' | grep 'Mox 500' | grep -o '"quantityOnHand":[0-9]*' | head -1 | cut -d: -f2)
check "ninety-nine left" 99 "${AFTER_SALE:-0}" "$BODY"

# The double-tap at the counter.
req POST /pharmacy/sales "$SALE"
check "the same sale again is accepted" 201 "$CODE" "$BODY"
check "and returns the original" "$FIRST_SALE" "$(jget "$BODY" id)" "$BODY"

req GET /pharmacy/stock
AFTER_RETRY=$(printf '%s' "$BODY" | tr '{' '\n' | grep 'Mox 500' | grep -o '"quantityOnHand":[0-9]*' | head -1 | cut -d: -f2)
check "STILL ninety-nine — neither the money nor the stock moved twice" 99 "${AFTER_RETRY:-0}" "$BODY"

req POST /pharmacy/sales "{
  \"buyerName\":\"Walk-in\",\"paymentMethod\":\"CASH\",\"paidPaise\":2500,
  \"lines\":[{\"productId\":\"$PROD\",\"stockBatchId\":\"$BATCH\",\"quantity\":1,
             \"unitPricePaise\":2500,\"gstRateBps\":1200,\"discountPaise\":0}]
}"
check "a sale with no idempotency key is refused" 422 "$CODE" "$BODY"

echo "-- a different key is a different sale --"
# The guarantee must not be so broad that a genuine second sale is swallowed.
req POST /pharmacy/sales "{
  \"buyerName\":\"Another walk-in\",\"paymentMethod\":\"UPI\",\"paidPaise\":2500,
  \"idempotencyKey\":\"$(key)\",
  \"lines\":[{\"productId\":\"$PROD\",\"stockBatchId\":\"$BATCH\",\"quantity\":1,
             \"unitPricePaise\":2500,\"gstRateBps\":1200,\"discountPaise\":0}]
}"
check "a genuine second sale goes through" 201 "$CODE" "$BODY"
req GET /pharmacy/stock
AFTER_SECOND=$(printf '%s' "$BODY" | tr '{' '\n' | grep 'Mox 500' | grep -o '"quantityOnHand":[0-9]*' | head -1 | cut -d: -f2)
check "and ninety-eight are left" 98 "${AFTER_SECOND:-0}" "$BODY"

echo "-- stock cannot go negative --"
req POST /pharmacy/sales "{
  \"buyerName\":\"Greedy\",\"paymentMethod\":\"CASH\",\"paidPaise\":2500,
  \"idempotencyKey\":\"$(key)\",
  \"lines\":[{\"productId\":\"$PROD\",\"stockBatchId\":\"$BATCH\",\"quantity\":9999,
             \"unitPricePaise\":2500,\"gstRateBps\":1200,\"discountPaise\":0}]
}"
check "selling more than is on the shelf is refused" 422 "$CODE" "$BODY"

echo "-- the ledger explains the shelf --"
req GET /pharmacy/stock/movements
check "the movement ledger reads" 200 "$CODE" "$BODY"
# Receipt, two sales. The reversal noise a re-fill would add is not here because
# nothing was re-filled.
MOVES=$(printf '%s' "$BODY" | grep -o '"movementType"' | wc -l | tr -d ' ')
[ "$MOVES" -ge 3 ]   && check "every movement is recorded" y y   || check "every movement is recorded" y n

echo "-- alerts --"
req GET /pharmacy/alerts
check "the alerts screen reads" 200 "$CODE" "$BODY"

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
