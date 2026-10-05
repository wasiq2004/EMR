# Build to completion — task list

End-to-end: real backend, real database, Docker, everything wired.
Checkpoint (build + typecheck + test + commit) after every 5 tasks.

## Stage 1 — Database and API foundation

- [x] 1. Fix the three schema bugs found in review (worker/readonly RLS policies,
      shared-catalogue write protection, finalised-prescription trigger)
- [x] 2. Scaffold `apps/api`: package.json, tsconfig, nest-cli, main.ts with the
      global guard / interceptor / pipe chain
- [x] 3. Database module: Drizzle connection, `TenantDb`, migration runner
- [x] 4. The five missing security modules: audit writer, clinic-status cache,
      token-revocation cache, practitioner-credential cache, OTP service
- [x] 5. Auth module: login, TOTP, refresh rotation, logout, `/auth/me`

> **CHECKPOINT 1 — CLEARED.** API boots, migrations run, sign-in works against
> Postgres, and a 42-case end-to-end smoke passes: health, deny-by-default,
> sign-in, refusal of a wrong password, 17 tenant-scoped reads, the acceptance
> fixtures, role separation across doctor / auditor / receptionist, audit rows
> actually written, and sign-out.
>
> Seven real bugs found and fixed in the process, all of them invisible to the
> type checker: Nest middleware under Fastify receives the raw Node request (so
> the session cookie was never read and every caller looked anonymous); the
> exception filter assumed a Fastify reply; RLS made sign-in, the clinic-status
> check and EVERY audit write silently return or affect zero rows; a JS array
> interpolated into a `sql` template expands to a placeholder list; and raw
> `execute()` rows are not decoded, so timestamps arrive as strings.

## Stage 2 — Clinical API

- [x] 6. Patients: search, duplicate check, register, update, snapshot, merge
- [x] 7. Scheduling: live queue, walk-ins, reorder, appointments
- [x] 8. Clinical: encounters, observations, conditions, allergies, internal notes
- [x] 9. Prescribing: drug search, lines, safety checks, finalise and sign
- [x] 10. Documents: upload URLs, share links with OTP

> **CHECKPOINT 2 — CLEARED.** `scripts/verify/consultation-flow.sh` walks one
> consultation end to end against the live database: the receptionist searches,
> registers and queues; the nurse records vitals; the doctor opens, drafts,
> prescribes, signs; the invoice is raised and paid. 27 cases, including the
> four that must fail — reception opening a consultation, an unregistered doctor
> signing one, a penicillin reaching a penicillin-allergic patient, and a signed
> record being edited.

## Stage 3 — Operational API

- [x] 11. Communication: conversations, messages, the unlinked queue
- [x] 12. Tasks
- [x] 13. Billing: invoices, payments
- [x] 14. Reports
- [x] 15. Settings: clinic, staff, services, templates, reminders

> **CHECKPOINT 3 — CLEARED.** 69 cases green across both suites in
> `scripts/verify/`. Task 10 (share links with OTP) is written but its upload
> path is only exercised once documents have real bytes behind them — covered
> under task 23.

## Stage 4 — Data, wiring and containers

- [x] 16. Audit trail endpoint, import and export
- [x] 17. Seed script carrying the Annex 5 acceptance fixtures
- [x] 18. Point the frontend at the real API and retire the mock path
- [x] 19. Docker: Postgres and Redis with health checks and init
- [x] 20. Docker: API image, multi-stage

> **CHECKPOINT 4 — CLEARED.** `docker compose up` brings up Postgres, Redis, the
> one-shot migrate/seed job, the API and the web app; all four report healthy,
> and both verification suites pass against the containers.

## Stage 5 — Finish

- [x] 21. Docker: web image, multi-stage, standalone output
- [x] 22. `docker-compose.yml` wired end to end with env and health gates
- [x] 23. Migrate and seed inside the container, verify the stack live
- [x] 24. Browser tests against the real backend
- [x] 25. UI polish pass

> **CHECKPOINT 5 — CLEARED.** Full stack in Docker, all four services healthy,
> 69 API cases + 111 web unit tests + 7 browser tests green against it.

## Stage 6 — Handover

- [x] 26. README and runbook
- [x] 27. Final verification: build, lint, unit, e2e, docker
- [x] 28. Final commit

---

## Final verification — cold build, 2026-09-22

`docker compose down -v && docker compose build && docker compose up -d`, then:

| Suite | Result |
|---|---|
| Typecheck — contracts, db, api, web | 0 errors |
| Lint — api, web | 0 errors, 0 warnings |
| `scripts/verify/api-reads.sh` | 42 passed |
| `scripts/verify/consultation-flow.sh` | 27 passed |
| `pnpm --filter @emr/web test` | 111 passed |
| `npx playwright test` | 7 passed |
| `docker compose ps` | 4 of 4 healthy |

Database, checked directly rather than asserted: 29 of 29 tenant tables under
FORCED row-level security, exactly 3 SECURITY DEFINER functions (the reviewed
pre-tenant resolvers), `emr_app` NOBYPASSRLS and not superuser, the resolver role
BYPASSRLS but NOLOGIN, and the messaging worker holding no privilege at all on
`encounter_internal_note`.

Known gaps are listed in the README and are deliberate, not unfinished: WhatsApp
has no Business API credential, there is no mail provider, the Schedule X
telemedicine rule needs an in-person/remote flag on the encounter before it can
be evaluated, and object storage is local disk.

---

# Phase 2 — Pharmacist and Research Analyst panels, 2026-09-27

Two roles the blueprint specifies and the product lacked. Scope confirmed by the
owner: **full §10 pharmacy** (purchasing and retail included, not only
dispensing) and **clinic-side de-identified analytics** (no identifier search at
all, enforced at the API rather than in the UI).

## A. Role foundation
- [x] A1. `PHARMACIST` and `RESEARCH_ANALYST` on the `user_role` enum + migration
- [x] A2. Pharmacy and research resources in the RBAC resource list
- [x] A3. Permission sets for both roles; `ROLE_LABEL`, `PANEL_FOR_ROLE`
- [x] A4. `pharmacy` and `research` feature flags in the registry
- [x] A5. Own nav section lists and landing routes, per the AUDITOR precedent
- [x] **Checkpoint 1** — typecheck clean, nav tests green

## B. Pharmacy schema — 13 tables
- [x] B1. `supplier`, `pharmacy_product` (tax, pack, reorder levels)
- [x] B2. `purchase_order` + `purchase_order_line`
- [x] B3. `goods_receipt` + `goods_receipt_line` (the only thing that creates stock)
- [x] B4. `stock_batch` + `stock_movement` (one universal ledger, not per-reason tables)
- [x] B5. `dispense_record` + `dispense_line`, `rx_clarification`
- [x] B6. `pharmacy_sale` + `pharmacy_sale_line`
- [x] **Checkpoint 2** — applied. Verified directly: 49 of 49 tenant tables
      forced (was 29), `emr_app` holds only INSERT+SELECT on `stock_movement`,
      `emr_platform` holds nothing on any of the fifteen, both triggers present.

## C. Pharmacy API
- [x] C1. Catalogue and suppliers
- [x] C2. Purchasing: order, receive, return
- [x] C3. Stock: batches, movements, adjustments, alerts
- [x] C4. Dispensing: queue, dispense, partial, substitute, clarify
- [x] C5. Sales and returns
- [x] C6. Pharmacy reports
- [x] **Checkpoint 3** — 38 pharmacy routes mapped, API boots clean

## D. Research API
- [x] D1. Cohort definition and evaluation, de-identified projection
- [x] D2. Data-quality metrics
- [x] D3. Trend explorer aggregates
- [x] D4. Saved analyses and provenance-carrying exports
- [x] **Checkpoint 4** — proven against a live analyst session: `/patients`,
      `/documents`, `/invoices`, `/audit-events`, `/pharmacy/queue` all 403;
      the four analytics endpoints 200. Cohort rows carry no identifying key.

## E. Panels
- [x] E1. Pharmacy: Rx Queue, Dispense, Inventory, Purchase, Sales, Alerts, Suppliers, Catalogue, Reports
- [x] E2. Research: Overview, Cohorts, Explorer, Data Quality, Saved Analyses, Exports, Dictionary
- [ ] E3. Doctor home gains the Clarification Requests card, now that it can exist
- [ ] E4. Prescription shows its dispensing state
- [x] **Checkpoint 5** — all 15 new screens return 200; 132 unit tests pass
      (20 new, asserting both panels' boundaries)

## F. UI consistency across all six panels
- [ ] F1. Token hygiene: the duplicated `--color-line-control`, contrast re-measured
- [ ] F2. Shared page furniture so six panels do not drift into six dialects
- [ ] F3. Super Admin console: Plans, Operators, Settings, Health screens for the
      APIs built last session but never given a UI
- [ ] F4. Empty, loading and error states present on every new screen
- [ ] **Checkpoint 6** — theme contrast test green, visual pass in both themes

## G. Verification
- [x] G1. Fixtures provision a pharmacist and an analyst
- [ ] G2. `scripts/verify/pharmacy.sh`, `scripts/verify/research.sh`
- [ ] G3. Browser suite covers both new panels
- [ ] G4. Full regression, README, commit


## Verified end to end, 2026-09-27

Run against the live stack with real records, not asserted:

| Claim | How it was proved |
|---|---|
| Zero re-entry doctor → pharmacy | Finalising an encounter put the prescription on the counter queue with the patient's name, MRN, age and allergy, and nothing else clinical |
| Quantity derived, not typed | `1-0-1` for 10 days produced a suggested quantity of 20 |
| Allergy checked before prescribing | Amoxicillin on a penicillin-allergic patient was refused server-side with 422 |
| Expired stock cannot enter inventory | A receipt dated 2024-01-01 was refused with 409 |
| The stock ledger reconciles | RECEIPT +100 → 100, DISPENSE −20 → 80; `stock_batch` agreed |
| The ledger cannot be edited | `UPDATE stock_movement` as `emr_migrator` raised the append-only trigger |
| A finalised prescription cannot be altered | `UPDATE medication_request` as `emr_migrator` raised the immutability trigger |
| The asker cannot answer their own question | Pharmacist → 403, doctor → 201, record released to IN_PROGRESS after the answer |
| The analyst cannot reach a person | 403 on patients, documents, invoices, audit-events and the pharmacy queue; 200 on all four analytics endpoints |
| Small cells are suppressed, not zeroed | A cohort of one reported its age cell as null and disclosed 6 hidden cells |
| Cohort rows carry no identity | Keys are ageBand, sex, encounterCount, month bounds, codes, molecules, followUpCompleted, subjectKey |
| Tenancy still holds | 49 of 49 clinic_id tables under FORCED RLS, up from 29 |
| The console still sees nothing | `emr_platform` holds zero privileges on all 15 new tables |

## Still open
- [x] F3. Super Admin screens built: Plans, Operators, Settings, Health, plus
      clinic onboarding, per-clinic module overrides and clinic-admin credential
      reset. Seven console pages now render; all eight orphaned endpoints reachable.
- [ ] F1, F2, F4. UI consistency pass across the ten older clinic screens
- [ ] G2. `scripts/verify/pharmacy.sh` and `research.sh` — the checks above were run
      by hand and need to be a suite that runs on every change
- [ ] G3. Browser coverage for the two new panels
- [ ] G4. README, commit


## Super Admin console completed, 2026-09-27

The eight endpoints built in the previous session had no UI at all. The console showed
Overview, Clinics and the operator log, so there was no way to add a clinic, issue or
rotate a credential, edit the plan catalogue, manage operators, change a deployment
setting or see health — which is what the owner reported.

### What was missing and is now built

| Endpoint | Where it now lives |
|---|---|
| `POST /platform/tenants` | **Clinics → Onboard a clinic** |
| `POST /platform/tenants/:id/reset-admin-password` | Clinic detail → **Reset admin password** |
| `POST /platform/tenants/:id/features` | Clinic detail → **Modules** panel |
| `GET/POST /platform/plans`, `:id/retire` | New **Plans** page |
| `GET/POST /platform/operators`, `:id`, `:id/reset-password` | New **Operators** page |
| `GET/POST /platform/settings` | New **Settings** page |
| `GET /platform/health` | New **Health** page |
| `POST /platform/usage/aggregate` | Health → **Recompute usage** |

### The build was silently broken

`docker compose build web` had been FAILING on ESLint `react/no-unescaped-entities`
— seven unescaped apostrophes and quotes in JSX text — and compose then reused the
last good image. The new pages compiled locally and 404'd in the container, which
reads as a routing problem rather than a build failure.

Worth remembering: check `docker compose build` output for `ERROR`, not just its tail.
A failed build leaves the previous image running and says nothing at the end.

### Verified against the live console

| Claim | Result |
|---|---|
| Onboard a clinic from the console | 201; created Greenpark with slug and plan |
| Its administrator can sign in at once | 201 with the issued one-time password |
| Reset that credential | new password 201, old password 401 |
| A wrong email does not reveal staff | 422, no information about who exists |
| Create a plan, features resolve with dependencies | `broadcasts` pulled in `whatsapp`, 3 of 10 |
| Retire a plan | 201; existing clinics keep it |
| Save a setting | stored, and `isDefault` flipped to false |
| Health | all four checks ok, onboarding reported available |
| SUPPORT operator is refused the privileged actions | 403 on onboard, 403 on reset, 403 on operators; 200 on plans |

Verification artefacts removed afterwards: the Greenpark clinic, the `verify-plan`
row and the `@verify.test` operator. `pilot`, `clinic` and `clinic-plus` remain.

### Suite state
- API typecheck 0 errors, API lint 0 errors, web typecheck 0 errors, web lint 0 errors
- 132 web unit tests pass
- `platform-db.service.ts` needed a documented `no-restricted-imports` exemption: it
  is the operations console's own BYPASSRLS connection and deliberately does not go
  through `TenantDb`. The comment states why, so the next reader does not "fix" it.

---

# Dead-control audit, 2026-09-28

Prompted by the owner finding Settings → Staff and roles read-only. Scanned every
`<Button>` in the web app for a missing handler, and every API route for a missing
caller, rather than looking for more by eye.

Scanners kept at `scratchpad/deadbuttons.py` and `routes2.py` — the route one has
to be template-literal aware or it reports ~40 false positives, because most
parameterised calls are built as `` `/x/${id}/y` ``.

## Found

- **15 buttons** with no `onClick`, no `asChild`, no submit handler
- **5 settings pages that were pure stubs** — 34 lines, zero queries, zero
  mutations, rendering a hardcoded empty state that would say "No services
  defined" forever
- **8 endpoints with no caller** after filtering false positives

## Fixed

- [x] **`POST /auth/refresh` was never called by anything.** Access token TTL is
      ten minutes, so every user was signed out mid-work every ten minutes and the
      server's refresh-token rotation was dead code. The API client now refreshes
      once on a 401 and replays. Coalesced behind a single in-flight promise: the
      server rotates the refresh token on use, so N concurrent 401s each posting
      their own refresh would invalidate each other and kill the session.
- [x] Settings → Staff and roles: invite, edit (including role), reset password
- [x] Settings → Services and fees: full CRUD, plus `POST /services` on the API
- [x] Settings → Locations: full CRUD, plus `POST /locations` on the API,
      with the single-primary rule enforced in one transaction

## Still open

- [ ] Settings → Consent text — stub, and no write API
- [ ] Settings → Consultation templates — stub, `GET` only
- [ ] Settings → Prescription sets — stub, `GET` only
- [ ] Document download: `GET /documents/:id/download` and `GET /share/:token/file`
      have no caller, and three buttons that should call them are dead
- [ ] `POST /share-links/:id/revoke` — a share link can be created, never revoked
- [ ] `patients/merge` — dead primary action
- [ ] `patients/[id]/consents`, `patients/[id]/documents` — dead buttons
- [x] `reports` — dead export button. **Fixed in Stage G:** it was a `<Button>`
      with no `onClick`, so it looked like an export and did nothing. The
      dashboard is a fixed trailing window with nothing to export that a reader
      cannot already see, so the control now leads to `/reports/analytics`, which
      has the filters and six real CSV exports.
- [ ] `settings/import` — two dead buttons, `GET /imports` uncalled, no import path
      at all (noted in the gap study)
- [x] `settings/account` — two-factor HIDDEN, owner decision 2026-09-28. Four
      surfaces commented out with a note on each saying what to undo:
      the Settings panel, the grace-period banner on every screen, the
      per-account badges in the staff list, and (annotated, not changed) the
      `mfaRequired` expression in `auth.service.ts`, which already evaluates
      false for every account so `/login/mfa` is unreachable.
      Nothing was deleted: `mfa_enabled` and `mfa_secret_encrypted` stay on the
      schema, `MFA_GRACE_DAYS` stays configurable, and the session still carries
      `mfaGraceDaysRemaining`. Building TOTP enrolment and deleting the comment
      markers is the whole of turning it back on.
- [ ] Broadcasts: `POST :id/test`, `POST :id/cancel`, `GET :id/recipients` uncalled
- [ ] `POST /pharmacy/sales/:id/return` — hook and service exist, no UI

---

# Phase 3 — Calendar, clinical capture, follow-up, money

Plan and reasoning: `docs/phase-3-plan.md`. Read that before starting any item —
four of the seven asks are partly built already and two needed decisions first.

**Decided 2026-10-02:** doctor registration number stays optional-and-visible
(current behaviour, no change); reminders are WhatsApp now with email modelled but
stubbed; the scheduler is cron calling an idempotent `POST /jobs/run-due`.

## Stage C — Check-in / check-out  (small, independent — do first)
- [x] C1. `CHECKED_OUT` on `appointment_status`, + migration
- [x] C2. Front desk: Check in (`SCHEDULED|CONFIRMED → ARRIVED`, stamps `arrived_at`)
- [x] C3. Front desk: Check out (`FULFILLED → CHECKED_OUT`), prompting to raise the
      invoice if none exists
- [x] C4. Queue screen reflects both; doctor's start/finalise already covers the middle
- [x] **Checkpoint** — one patient walked the whole machine end to end against the
      live stack: SCHEDULED → (illegal jump to FULFILLED refused 409) → check in →
      (check out before signing refused 409) → consult → finalise → check out →
      (reopen refused 409). Board moved 1 waiting → 1 to-check-out → 1 checked-out.

**Also fixed while in there, both pre-existing:**
- `changeStatus` was a blanket setter — the API would revive a cancelled
  appointment or send a scheduled one straight to completed with nobody seen.
  `ALLOWED_STATUS_TRANSITIONS` existed in contracts but drove **only the UI**.
  The server enforces it now.
- The appointments list rendered a dropdown of **every** status regardless of
  what was reachable, so it offered moves the server would refuse. It now lists
  only legal transitions, with Check in promoted to a button.

## Stage F — Billing from the visit  (small, independent)
- [x] F1. Raise an invoice from the consultation screen, pre-filled from the
      appointment's service
- [x] F2. Raise an invoice at check-out
- [x] F3. Patient billing tab: every invoice, paid, outstanding
- [x] **Checkpoint** — in `scripts/verify/consultation-flow.sh`: an invoice
      raised against the encounter, found again by `/invoices/for-encounter`,
      part-paid ₹300 of ₹800 with the remainder still owing and the invoice NOT
      marked BALANCED, then settled and closed by itself. 54 assertions green.

      The checkpoint found that the front desk could not take money at all.
      `RecordPayment` has always required an `idempotencyKey` in the body and
      carried the comment "a retried request must not take the payment twice".
      Three things were wrong at once, and each one hid the next:

      1. `payment` had no column for the key. It was parsed, validated and
         thrown away, so a resubmitted payment was recorded twice — two
         identical ₹300 receipts, both looking real, and no way to tell later
         which was never collected. Fixed with `idempotency_key` and a partial
         unique index on (clinic_id, idempotency_key); `recordPayment` now
         inserts `ON CONFLICT DO NOTHING` and returns the original payment on a
         replay. The index does the work, because a check-then-insert loses the
         race to the two concurrent taps this guards against.
      2. The payment screen sent the key as an `Idempotency-Key` HEADER, which
         nothing on the server reads, and nothing in the body — so **every
         payment submitted from the interface returned 422**. Verified against
         the running API before and after. It now sends the key in the body.
      3. The key was minted inside `mutationFn`, so each retry carried a new
         one. Even once plumbed through, that is not idempotency. It is held in
         a ref now and replaced only after the payment lands.

      `@Idempotent()` was deleted. It was applied to no route, no guard read its
      metadata, and a decorator in `decorators.ts` named for a guarantee is
      precisely what made this invisible for so long.

## Stage A — Practitioner availability  (foundation for the calendar)
- [x] A1. `practitioner_schedule` — practitioner, location, weekday, start, end,
      slot minutes, effective dates
- [x] A2. `schedule_exception` — date, reason, optional replacement hours
- [x] A3. Slot derivation: pattern − exceptions − booked
- [x] A4. Settings → Doctor schedules (Clinic Admin)
- [x] **Checkpoint** — `scripts/verify/availability.sh`, 42 assertions, all green
      against a real clinic. It proves the derivation rather than the plumbing:
      a 09:00–10:00 session at 15 minutes is exactly four slots at 09:00, 09:15,
      09:30 and 09:45 and nothing at 10:00; a 50-minute session at 20 drops the
      ten-minute remainder instead of offering an appointment half the length of
      its own slot; a booking takes a slot and a CANCELLED one gives it back; a
      day of leave returns no slots and says why; and a doctor's own entry beats
      a clinic-wide closure, so "we are shut for the holiday but Dr Rao is coming
      in" is expressible.

      Two things the checkpoint changed. Slot instants are UTC, and the suite's
      first assertions grepped a local-looking string that can never appear —
      they passed without testing anything, which is worse than failing, so the
      expected instant is now resolved through the clinic's own timezone. And
      `eachDate` silently truncated a range at 120 days: a caller asking for a
      year got four months with no indication the rest was dropped, which renders
      as a doctor who stops working in February. The controller now refuses the
      range outright; the cap stays as a bound on the method itself.

### Closed after Stage F
- [x] All six of the endpoints passed an `idempotencyKey` that went nowhere are
      resolved, and they did not all need the same answer — which was the point
      of giving them their own pass rather than applying one pattern six times.

      **Four got real keys.** `/pharmacy/receipts` and `/pharmacy/sales`
      (migration `0015`) create stock and take money, so there the key is
      REQUIRED: a request without protection is refused. `/appointments`,
      `/queue` and `/patients` (migration `0016`) got the same mechanism with the
      key OPTIONAL, because a duplicate appointment is a mess somebody cancels
      and a duplicate patient is a record somebody merges — not money that moved.
      An integration without a key is served, and is simply unprotected.

      **One needed nothing.** `/pharmacy/lines/:id/fill` was flagged as the most
      dangerous of the six and its own comment agreed. It is wrong: `fillLine`
      calls `reverseExisting` FIRST, so it is a SET rather than an ADD and a
      double-submit nets out correctly. The comment is corrected and the dead
      header removed.

      **`/appointments` and `/queue` share one key space**, deliberately — one
      index over `(clinic_id, idempotency_key)` on `appointment`, so a key minted
      for a booking cannot be reused to add a walk-in. Migration `0016` asserts
      the index is not scoped by `is_walk_in`, which is the plausible-looking
      change that would let the same key through twice.

      Every call site now holds its key in a ref across attempts. That half
      mattered as much as the server half: the keys were being minted inside
      `mutationFn`, so a fresh value went out on every retry and the server would
      have seen two distinct operations even once it started reading them. Two
      failures stacked into the appearance of care.

## Stage B — The calendar
- [x] B1. `GET /calendar` — appointments + derived free slots for a range.
      ONE endpoint, not a client-side join of `/appointments` and
      `/availability/slots`, because the analytics strip has to agree with the
      grid beneath it. Filter to one doctor and the strip narrows with it. Two
      round trips reconciled in the browser is two chances to disagree, and the
      number that disagrees is the one somebody reads out in a meeting.
- [x] B2. Views: day, 3-day, week, month, per-doctor columns. The month sends
      `includeSlots=false` — thirty cells of counts do not need five doctors ×
      thirty days × forty slots of derivation. The slot-dependent figures come
      back `null` rather than `0`, because zero reads as "fully booked".
      View and date live in the QUERY STRING, so a day can be linked, the back
      button undoes a month-to-day drill-down, and an all-day-open tab survives
      a refresh in place.
- [x] B3. Click an empty slot → booking dialog carrying the time, doctor and
      length from the slot. The full form at `/appointments/new` stays for the
      case where none of that is settled yet.
- [x] B4. Drag to move, resize, or move between doctors' columns →
      `PATCH /appointments/:id/schedule`. Separate from `changeStatus` on
      purpose: "rescheduled to Thursday" and "marked no-show" are different
      facts and must not share an audit entry. Version-checked, closed
      appointments refused, an end before its start refused rather than swapped.
- [x] B5. Filters: doctor, location, status (multi), walk-in vs booked, and
      "only mine" — which is the doctor's own id as a `practitionerId` filter
      rather than a separate mode, so the analytics narrow with it.
- [x] B6. Day analytics strip, counted server-side over the filtered rows.
      Utilisation EXCLUDES cancellations and no-shows: a doctor is not busy
      during an appointment nobody attended, and counting them would make the
      worst day of the month read as the busiest.
- [x] B7. `appointment:read` only. Verified against live sessions — pharmacist
      403, analyst 403, doctor and front desk 200 — plus nav tests asserting the
      link appears exactly where `can(role, 'appointment:read')` is true.
- [x] B8. Live over the existing SSE pipe.
- [x] **Checkpoint** — `scripts/verify/availability.sh` (85 assertions) and two
      browser tests. The live one runs TWO browser contexts: the doctor watches
      a day, the front desk books into it in a different session, and the
      doctor's free-slot count has to drop within 8 SECONDS — deliberately well
      under the 60-second poll, which would otherwise make the test pass while
      proving nothing.

      That checkpoint found THREE faults that each hid the next:
      1. `book()` emitted no event at all. Every other transition on an
         appointment did — check-in, call, move — so the calendar updated live
         for everything except a brand new booking, the one case where
         staleness means two receptionists sell the same 09:30.
      2. The web client's `EVENT_TYPES` list had no `appointment-changed` and no
         `queue-changed`. `EventSource` dispatches NAMED events, so a type
         absent from that list has no listener and is dropped on arrival — the
         queue's existing emit had been going nowhere too.
      3. `addWalkIn()` emitted nothing either, so a patient arriving at the
         counter took up to a minute to appear on the doctor's queue.

      Also fixed on the way: `/settings/schedules` was listed in the sidebar
      under `appointment:read` while the API gates saving a schedule on
      `clinic:update` — the front desk was offered a page where every save would
      be refused. A door onto a wall. Now `clinic:update`, with a nav test.

## Stage D — Clinical capture
- [x] D1. Vitals grid — units fixed per measure, a CRITICAL band distinct from
      merely out-of-range, and BMI derived on the Asian cut-offs (overweight from
      23, not 25: Indian guidance, because cardiometabolic risk rises at a lower
      BMI in South Asian populations and the WHO international bands would tell a
      large share of this product's patients they are a healthy weight).

      BMI is **not stored**. It is two numbers already on the record divided by
      each other, and a stored copy stops agreeing the first time somebody
      corrects a mistyped weight — leaving a record reporting a BMI its own
      height and weight do not produce.

      **The bug this uncovered.** `recordObservation` read `referenceLow`,
      `referenceHigh` and `interpretation` off the request, but
      `RecordObservation` never declared them, so `parseBody` stripped all three
      and the service wrote null **every time** — while the contract's own
      comment said the interpretation was "computed at write time and surfaced on
      the Snapshot". Every vital the product has ever recorded, a systolic of 210
      included, was stored with nothing marking it abnormal. The patient page
      already read that field, so it had been quietly claiming every reading was
      in range.

      Fixed by deriving all three **server-side from the LOINC code** and
      ignoring whatever the caller sends. A browser on last month's build would
      otherwise stamp last month's thresholds onto today's records, and "is this
      reading dangerous" is a clinical assertion — a field that says only what
      the caller chose to claim is worse than absent. The unit is overridden the
      same way: a weight filed in pounds under a kilogram code is not a
      validation message, it is a dose later calculated on the wrong body weight.

      Also: the two vitals displays were near-copies that had drifted. The
      consultation screen showed no flag at all — the one screen where it matters
      most — and the patient page rendered `CRITICAL` as "Below range". Both now
      use one `VitalsGrid`, and a null interpretation reads "Not range-checked"
      rather than "In range", because nothing having checked a weight is not the
      same as having checked it and found it fine.

- [x] D2. `diagnosis_catalogue_item` + a curated ICD-10 subset. **314 codes, not
      the planned 1,500, and that is a decision rather than an unfinished job.**

      An ICD-10 code written into a record travels onto insurance claims, into
      ABDM, and into whatever the next clinician reads. A wrong code is worse
      than no code, because free text is self-evidently a clinician's own words
      while a code carries the authority of a standard. Every entry seeded is one
      we are confident of; padding the list to a target by guessing would trade a
      visible gap for an invisible error. The gap is covered three ways instead:
      free text is always available, a clinic can add its own rows, and
      `diagnosis-catalogue.ts` documents loading a full licensed release — a
      procurement decision, like replacing the drug catalogue with a licensed
      formulary.

      Curation is also what makes a typeahead usable: searching "fever" in the
      full 70,000 returns dozens of qualifiers nobody at an outpatient desk will
      use and buries the one they want. The selection is weighted to what a 1–5
      doctor Indian OPD sees — vector-borne fever, tuberculosis, nutritional
      deficiency, the metabolic cluster — and holds almost no inpatient or
      oncological codes. WHO ICD-10, not ICD-10-CM; the two diverge and mixing
      them produces records that validate against neither.

      Migration `0011` asserts the shared-reference boundary in both directions:
      a SELECT policy admitting the system tenant must exist (or every clinic's
      typeahead is silently empty while the seed reports success), and **no write
      policy may admit it** — one clinic renaming a diagnosis must not rename it
      for every clinic on the deployment.

- [x] D3. Diagnosis typeahead, free text always first-class. Shown **alongside**
      the matches rather than only when the search fails: the commonest case is a
      doctor whose phrasing is close to a listed code but who means something
      more specific, and hiding the option whenever there are results would make
      the nearest wrong code the path of least resistance.

      **Ranking is on word boundaries, not string prefixes.** Typing "urti"
      returned *urticaria* first — a rare skin complaint — because it starts with
      those four letters, while URTI is a mid-string synonym on J06.9, among the
      commonest diagnoses in an Indian OPD. Now: exact whole word, then
      word-prefix, then substring, then trigram. Regex metacharacters are escaped
      first, so J02.9 no longer also matches J02X9.

      `POST /conditions` already accepted `code`/`codeSystem` and defaulted them
      to null — what was missing was any way for the screen to send them, so
      **every diagnosis the product had ever recorded was uncoded.** The
      data-quality screen's `diagnoses-coded` ratio needed no change; it moves on
      its own now.

- [x] D4. Dose, frequency, duration, route, quantity and instructions, with
      presets and free text underneath.

      **The most serious defect found in this stage.** Selecting a drug committed
      the line immediately with `frequency: '1-0-1'`,
      `timingRelativeToFood: 'AFTER_FOOD'` and `durationDays: 5` **hardcoded in
      the consultation screen** — for every drug, every time, whatever the doctor
      intended — and the panel then displayed those three values back as
      read-only chips with no way to change them. A patient could leave holding a
      printed prescription saying twice a day after food for five days for a drug
      meant once at night for three. Every field was already in the contract and
      in the table. Nothing was ever asking.

      Three more things in the same flow:
      * The quantity to dispense is now computed — doses per day × days, rounded
        **up**, because half a tablet cannot be dispensed and rounding down sends
        the patient home one short on the last day. Blank for SOS, where there is
        no daily total and a confident number would be a wrong one. 11 unit tests
        in `dosage.test.ts`.
      * A null timing rendered as "After food", so a line with no timing
        recorded displayed, and printed, an instruction nobody gave.
      * The client safety pre-check passed `isTeleconsultation: false`
        hardcoded, so a Schedule X drug in a teleconsultation passed the client
        check and was refused by the server **after** the doctor had filled in
        the dose — with the dialog that explains why never appearing.

      `PATCH /prescriptions/:id` added, because a mis-set dose could previously
      only be fixed by deleting the line and starting again. The drug itself is
      deliberately **not** editable: swapping the medicine would slide past the
      allergy and duplicate-therapy checks that ran when the line was added, and
      `safetyWarningsShown` would then describe a drug no longer on the line.

- [x] **Checkpoint** — 105 assertions in `consultation-flow.sh` plus a browser
      test that drives the whole screen: a systolic of 210 flagged as critical
      *and verified from the server* as stored CRITICAL, BMI appearing at 24.9
      once both numbers are in, a coded diagnosis chosen by keyboard, a free-text
      one taken as typed, a drug dosed at 0-0-1 for 3 days with the quantity
      auto-computed to 3, and that dose then revised in place — each one asserted
      against what the API actually holds, because the whole bug was a screen
      displaying values the doctor never chose.

      The browser run found one more: `Field` clones its single child to attach
      the id its label points at, so wrapping the presets and the input in a div
      handed the **div** that id — a label pointing at a div, and two elements
      sharing one id.

## Stage E — Follow-up and reminders
- [x] E1. The picker already existed and was **dead weight**: `followUpAfterDays`
      was stored and printed on the prescription, and nothing on earth read it.
      It now says what it will do — "a WhatsApp reminder will be scheduled for
      12 Oct when you sign this, if the patient has consented" — or, when the
      clinic has reminders off, says that instead of staying silent. A field with
      a consequence has to state it, or a doctor assumes a reminder went out.
- [x] E2. `scheduled_reminder`, plus migration `0012` with the grants (the
      generated DDL grants nothing, so `emr_app` had no privilege on the table at
      all) and assertions on the three things the design depends on: the partial
      due-index, the one-live-reminder-per-encounter unique index, and
      `communication_idempotency_uq`.
- [x] E3. `POST /jobs/run-due`, idempotent in three layers because the failure
      being guarded against is a patient getting the same message from their
      doctor twice:
      1. the claim — `UPDATE ... WHERE status = 'PENDING' ... FOR UPDATE SKIP
         LOCKED`, so two overlapping runs take disjoint sets;
      2. the `communication` idempotency key derived from the reminder's id, so
         even a claim that raced cannot produce two messages;
      3. the unique index, so the *scheduling* side cannot create two either.

      Scheduled **inside the signing transaction**, like the pharmacy enqueue, so
      a signed consultation cannot exist without its reminder and a failed
      signing leaves none behind. Not on autosave: `followUpAfterDays` saves
      every few seconds, and scheduling on change would create and cancel
      reminders as the doctor edited the number.

      Authenticated with `JOBS_SECRET` — a cron line has no user session and
      therefore no clinic. The guard compares in constant time, and an **empty
      secret disables the endpoint** rather than leaving it open. Clinics are
      enumerated through `ClinicDirectoryService`, which returns ids only; behind
      it is the platform connection, which holds grants on seven platform tables
      and nothing clinical, so reading a patient through it is a permission error
      rather than a leak. No fourth `SECURITY DEFINER` resolver was added.
- [x] E4. WhatsApp delivery, **consent checked at send time** rather than at
      scheduling — a patient who withdraws between the consultation and the
      reminder must not receive it, and a withdrawal has to take effect without
      anyone remembering to cancel things. Email is modelled and fails with "this
      deployment has no mail provider" rather than pretending. A missing approved
      template fails naming `follow_up_reminder`, because that is fixable in ten
      minutes and a silent non-send is discovered when a patient does not return.
      Also skipped — not failed — when the patient has already booked a future
      appointment: reminding somebody to book what they have booked is what makes
      a clinic turn reminders off.
- [x] E5. The clinic copy, off by default, sent after the patient's and never
      instead of it, and its failure never changes the reminder's outcome. The
      toggle refuses to save without a valid E.164 number. Audited, because it
      means a patient's name and follow-up date leave the record to a second
      phone.
- [x] E6. Reminder log on `/settings/reminders`, with the settings above it —
      the only question anybody brings is "did it go out, and if not why", and
      that is answered by the two together. `SKIPPED` is coloured neutral, not
      red: a patient who never consented was *correctly* not messaged, and
      painting that as a failure buries the real ones.
- [x] E7. The cron line in the README (with what the secret can and cannot do)
      and a `launchd` plist in the macOS guide. `JOBS_SECRET` documented in
      `.env.example`, `docker-compose.yml` and the guide's secret appendix. The
      README's "No reminder scheduling" gap is replaced by two honest ones: the
      product runs no timer, and no approved template ships.
- [x] **Checkpoint** — `scripts/verify/reminders.sh`, 48 assertions, all green.
      The one it exists for fires two `run-due` calls **concurrently** against a
      due reminder and asserts one claim, one attempt, one message and nothing
      left mid-flight. Also: it does not fire early, a later run claims nothing,
      a cancelled reminder is never sent, and a sent one cannot be cancelled.

      Three defects it found:
      1. **Claimed rows could be stranded in `SENDING`.** Two paths — an
         unexpected throw, and the row-vanished branch — returned without writing
         a terminal status, so the row was invisible until the 15-minute
         stale-claim sweep. Found because two such rows were sitting in the
         database from earlier debugging. Both paths now always write one.
      2. **`emr_migrator` is a SUPERUSER**, so forced RLS does not constrain it —
         superusers and `BYPASSRLS` roles bypass row-level security whether
         `FORCE` is set or not. Four migrations (`0007` and three written in this
         phase) claimed the opposite. All four corrected to state what `FORCE`
         actually buys: it matters for `emr_app`, which is `NOBYPASSRLS`, and it
         makes moving ownership to a non-superuser a one-line `ALTER` rather than
         an audit. **Worth doing:** move table ownership off a superuser and the
         documented property becomes true.
      3. **A latent test bug that only bit overnight.** The date helpers advanced
         a local `Date` by `getDay()` and then formatted with `toISOString()`, so
         on a UTC+5:30 machine a local Wednesday was still Tuesday in UTC between
         midnight and 05:30. The availability suite saved a weekday-3 session,
         asked for a Tuesday, and got no slots — passing every afternoon and
         failing overnight, which is worse than failing outright. All date
         arithmetic in the suites and the browser tests is now UTC throughout.

## Stage G — Clinic Admin analytics
- [x] G1. Filters: date range, doctor, location, service, payment method.
      **The service filter narrows revenue only, and the control says so.** An
      appointment does not record a service — `BookAppointment` accepts a
      `serviceItemId`, the booking path uses it to compute the end time and then
      discards it, because there is no column to put it in. So "appointments for
      a service" is a question this schema cannot answer. The filter is
      deliberately not applied to the appointment counts rather than applied
      wrongly, and the gap is listed below rather than hidden.
- [x] G2. Revenue. **Collected, invoiced and outstanding are three different
      numbers and all three are shown**, because reporting any one of them as
      "revenue" is how a clinic budgets against money it has not received.
      Outstanding is deliberately **not** range-filtered and says so on the
      figure — a debt from March is still a debt in June, and scoping it to the
      window would make it shrink as the window moved. Refunds get their own
      figure and collections stay gross, so a clinic can see that a refund
      happened at all.

      Per-doctor revenue comes from the **payment rows**, not from
      `invoice.paid_paise`. The dashboard's existing per-doctor figure sums
      `paid_paise` over a join to encounter, so its column does not reconcile
      with the collections total sitting above it on the same screen — two
      numbers for the same money. Per-service comes from invoice lines (a JSONB
      column, unnested) and measures what was **billed**, because a part-payment
      against a three-line invoice cannot be split between the lines without
      inventing a rule. The screen says which is which.
- [x] G3. Patients: new, returning, and distinct seen. A patient registered
      **and** seen in the range counts as new only — if both counted them, the
      two would add to more than the number of people who came.
- [x] G4. Appointments. **Both rates are over appointments that have CLOSED**,
      and the denominator is printed next to each: over all appointments a
      no-show rate counts tomorrow's bookings as attended. Null, not zero, when
      nothing has closed yet.

      Utilisation **reuses the Stage A slot derivation** rather than
      re-deriving from the pattern — pattern minus exceptions minus leave is
      subtle enough that a second implementation would eventually disagree with
      the calendar, and a utilisation figure contradicting the grid it describes
      is worse than none. Null when no schedule covers the range, with a link to
      set hours, because 0% reads as "nobody came" rather than "we do not know".
      Cancellations and no-shows contribute no booked minutes.
- [x] G5. Outstanding by age, from `issued_at` rather than `created_at` — an
      invoice drafted in March and issued in June has been owed since June, and
      ageing a draft would show a debt nobody has been asked to pay. All four
      buckets are always present: a table that omits "Over 60 days" when nothing
      is that old looks the same as one where the column was forgotten.
- [x] G6. CSV export per view, **built from the same `analytics()` result the
      screen renders**, so an export cannot disagree with the figures somebody is
      looking at. Quoted per RFC 4180 and asserted: a service called
      "Consultation, follow-up" breaks a naive join and opens in Excel with its
      columns shifted, which looks like bad data rather than a bad export.
      Downloaded as a plain link so the browser handles the filename and the
      progress, rather than fetched into a Blob.
- [x] **Checkpoint** — `scripts/verify/analytics.sh`, 56 assertions, green on the
      first run. Every figure is asserted against money and appointments the
      suite creates: ₹1000 invoiced with ₹400 collected, a second invoice settled
      by UPI, a ₹50 refund, and four appointments — one completed, one no-show,
      one cancelled, one still scheduled — so the 33% rates and the
      three-of-four-closed denominator are checked arithmetic rather than a
      plausible-looking number. The range cap is refused before any query runs,
      because utilisation derives slots across it.

      Also fixed: **the Reports dashboard had an "Export CSV" button with no
      handler** — it looked like an export and did nothing. It now leads to the
      screen that actually exports.

### Closed after Stage G
- [x] `appointment.service_item_id` exists (migration `0014`), the booking path
      stores it, and the analytics service filter now covers appointment counts
      as well as revenue. The screen says that appointments booked before the
      column existed carry null and drop out of a filtered view — they are
      genuinely uncategorised, and attributing them would be inventing history to
      make a chart look complete. The FK is `SET NULL` and the migration asserts
      it: cascading would delete every appointment ever booked under a service
      the moment a clinic retired it from its price list.

## Stage H — Lab  (separate; do not bundle)
- [x] H1. `lab_test_catalogue_item`, `lab_order`, `lab_result`, plus migration
      `0013`. 62 seeded tests — what a 1–5 doctor Indian OPD writes on a slip,
      not a pathology lab's price list.

      **THE WHOLE MODULE IS ABOUT THE UNREAD RESULT.** A clinic that orders a
      test and never looks at what came back is the failure this exists to
      surface, so "a result arrived" (`RESULTED`) and "a clinician read it"
      (`REVIEWED`) are two separate facts and nothing collapses them. Entering a
      result never marks it reviewed; only a person does, and it is audited.

      **Correcting a reviewed result UN-REVIEWS the order.** The doctor signed
      off on a haemoglobin of 9.1; they have not seen the corrected 10.4, and
      leaving the tick there would hide the new value behind one somebody put
      there for the old one. The previous result is superseded and **kept** — it
      may be why a patient was started on a drug — and a correction requires a
      stated reason.

      **ONE ROW PER TEST, not per requisition slip.** A CBC and a fasting glucose
      come back at different times and are acted on separately; one order holding
      both would read as "pending" until the slowest arrived, which is exactly
      when the fast one matters.

      **No "specimen collected" or "in transit" states.** The clinic does not run
      the lab — the patient goes down the road and the report comes back on paper
      or as a PDF — so nobody would ever update those, and modelling a state the
      clinic cannot observe would leave every order stuck in it.

      Interpretation is derived **server-side** from the reference range, never
      accepted from the caller: the same rule as the vitals, and the suite proves
      a caller claiming `CRITICAL` on a normal value is overruled. `CRITICAL` is
      half a range-width beyond either bound — a multiple rather than a fixed
      number, because a sodium 5 units high is unremarkable and a potassium 5
      units high is an emergency. Qualitative results get `ABNORMAL` or nothing;
      a narrative X-ray report is left **unflagged rather than guessed at**, and
      still appears in the review list.

      Ranges are **adult and not sex- or age-specific**, which is a real
      limitation stated in the schema, the seed and the interface rather than
      hidden. Haemoglobin alone differs by sex. The flag is a prompt to look.

      Migration `0013` is the narrowest in the schema, because a result is a
      measured fact about somebody's body: **no `DELETE` on `lab_result` for any
      role** (a role that can delete can erase the evidence of what a doctor
      acted on), and `emr_readonly` gets the orders but **not** the values —
      "how many results are overdue" and "what was Mrs Rao's haemoglobin"
      deserve different privileges.
- [x] H2. Report attachment: `lab_result.document_id` into `document_reference`,
      so a scanned report or a PDF from WhatsApp hangs off the result it belongs
      to.
- [x] H3. "Results to review" card, on the **doctor's and the nurse's**
      dashboards and placed **above the next patient** — an unread abnormal
      result should be seen before they call the next person in. It renders
      nothing when nothing is waiting, rather than occupying the same space
      saying zero, and goes red with words when something critical is unread.

      Four numbers, and the split is the value: a result nobody opened is a
      different problem from an order the patient never went for, and both differ
      from a critical value sitting unread. `overdue` is worded as the two things
      it might be, because the product cannot tell them apart and both need the
      same phone call.
- [x] **Checkpoint** — `scripts/verify/lab.sh`, 61 assertions, green on the first
      run. Ordering with and without the catalogue, the `RESULTED`/`REVIEWED`
      split, the server overruling a claimed interpretation, qualitative and
      narrative results, correction-supersedes-and-un-reviews, one live result
      enforced by the database, a resulted order refusing to be cancelled, and
      the role split — nurse enters a result but cannot order a test; reception,
      the pharmacist and the analyst get 403.

      The browser suite caught one thing worth keeping: `/lab` had been added to
      the route list **every** clinic role walks, so the receptionist walk fired
      two 403s. That was the API behaving correctly and the test asking the wrong
      question — reception holds no `labOrder:read` because a lab result is
      clinical content. Moved to a `CLINICAL_ROUTES` list used by the doctor,
      nurse and admin walks.

## Calendar rebuild and the drug catalogue, 2026-10-05

Asked for: the calendar to look like Google Calendar, and whether manual drug
entry exists.

### The calendar
- [x] **Overlapping appointments now sit side by side.** This was a defect, not a
      style gap. Every block was `inset-x-1`, so two appointments at the same
      time were drawn exactly on top of each other and the lower one was
      invisible — for a clinic running a token system, four people told "after
      ten", that hid the entire point of `capacity_per_slot`, and the page
      rendered perfectly while doing it. Lanes are the standard interval-graph
      colouring: sort by start with the longest first, accumulate clusters, and
      give each appointment the first lane whose occupant has ended. Clusters are
      independent, so two appointments at 09:00 do not narrow a lone 14:00 one.
      11 unit tests in `lanes.test.ts`.
- [x] **Week view is one column per DAY**, not per day-doctor pair. Three doctors
      over a week was twenty-one columns, unreadable at any width — and nobody
      scanning a week is choosing between doctors, they are looking for a day.
      The day view keeps one column per doctor, which is what a front desk works
      from. One `groupBy` prop, two honest answers.
- [x] A **"now" line** — red, only on today. On a clinic calendar it answers more
      than "what time is it": the gap between the line and the block being
      consulted is the running delay.
- [x] Mini-month sidebar for jumping further than the arrows reach. Paging a day
      view eleven times to reach the end of the month is what makes people stop
      using a calendar, and a date input cannot answer the question somebody
      actually has — which day of the week the 14th is.
- [x] Google Calendar's chrome where it earns its place: today's date in a
      filled circle, the day's column tinted, half-hour rules lighter than the
      hour, an hour gutter the labels cannot overlap, auto-scroll to the working
      day on mount, and a hover `+` instead of a grid of permanent dashed boxes
      competing with the appointments for attention.
- [x] **Date ordering fixed.** The header read "19 – Oct 25" while every other
      screen reads "25 Oct 2026", because the calendar used the default locale
      and the rest of the product uses date-fns `d MMM yyyy`. Two orderings on
      one page is how somebody misreads a date, which on a calendar means a
      patient told the wrong day.

### Manual drug entry
- [x] **Prescribing one always worked** and still does: the combobox offers
      "prescribe as typed" and the line stores a null `catalogueItemId`, with
      "Typed manually — allergy checking matches on the name only" shown on it.
- [x] **Keeping one did not exist, and D4 was marked complete anyway.** The
      original D4 said "add to catalogue for a missing molecule"; the diagnosis
      catalogue got `POST /diagnoses` and drugs never got the equivalent. That
      was an error in this file, now corrected and built.

      `POST /drugs` writes under the clinic's OWN tenant — migration `0013`
      asserts no write policy on a shared catalogue admits the system tenant, so
      one clinic cannot rename a drug for every clinic on the deployment. Adding
      the same drug twice returns the existing row: two doctors reaching for the
      same missing drug on the same morning is expected, not a conflict either
      should have to resolve.

      **The molecule is required and the dialog says why.** Safety is computed
      from the molecule — the class map is what catches "Mox 500" for a
      penicillin-allergic patient, since the brand contains no hint of
      penicillin. A row with a brand and no molecule would search well and check
      nothing, which is worse than being absent from the catalogue because a
      doctor would reasonably assume a catalogued drug had been checked.

      **Schedule stays null unless stated**, rather than defaulting to H like the
      seeded list. Those were each checked; a clinic's own row has not been, and
      Schedule X carries a telemedicine prohibition the server enforces — a wrong
      value either blocks a legitimate prescription or waves through one the law
      forbids.
- [x] Both fallbacks now show **alongside matches**, not only on an empty result
      set. They are different acts — "prescribe as typed" is this one
      prescription, "add to the clinic's list" keeps it — and a drug missing from
      the catalogue almost always has near-matches, so the old placement hid the
      second one entirely.
- [x] 9 new assertions in `consultation-flow.sh`: the role split, a molecule-less
      row refused, idempotent re-adding, the clinic's own drug searchable and
      prescribable, and the schedule stored null rather than guessed.

## Super Admin from the environment, at deploy time — 2026-10-06

Asked for: the Super Admin credential in `.env`, used automatically on deploy.

- [x] **`bootstrap-operator.ts`**, run as the last step of the migrate job:
      `migrate.js && seed.js && bootstrap-operator.js`. Reads
      `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_NAME`, `PLATFORM_ADMIN_PASSWORD`
      and `PLATFORM_ADMIN_ROLE`.

      It exists alongside `provision-operator.ts` rather than replacing it. That
      one is the interactive CLI — it generates a password and prints it once,
      which is right when somebody is at a terminal and useless on a PaaS host
      where there is no terminal and no convenient way to run a one-off command.

      **CREATE-ONLY, and that is the whole safety property of running on every
      deploy.** If the account exists, the password in the environment is NOT
      applied and the row is untouched. Otherwise changing the password in the
      console would be silently undone by the next `git push`, and the value in
      the env file would be the real credential forever. A redeploy is not a
      password rotation.

      **A placeholder or weak password FAILS THE DEPLOY** with a non-zero exit.
      Better a deployment that stops with a clear message than a live platform
      super-admin on a password copied out of `.env.example`. Unset is a
      supported no-op that says so in the log, so a deployment that provisions
      by hand keeps working; one of the two set is a loud error, because
      guessing which half was meant is worse than stopping.
- [x] **Fixed a flaw in my own check before shipping it.** The placeholder guard
      started as an exact-match set, and every entry on it was under twelve
      characters — so the length check rejected them first and the list never
      fired once. Worse, the realistic placeholder is not `changeme` but
      `ChangeMe123456`, long enough to pass a length check and exactly as
      guessable. Now substring stems matched after stripping case and
      punctuation, checked BEFORE the length rule so the error says "that is a
      placeholder" rather than inviting someone to pad it to length. Verified
      that `ChangeMe123456` and `SuperAdmin@1234` are both refused, and that the
      generated password trips nothing.
- [x] **`.env.example` carries the keys with NO password**, and says why: a
      committed default is a known way in for anyone who has cloned the repo.
      **`.env`** (gitignored, untracked — checked) has the real values with a
      freshly generated 16-character secret.
- [x] **Verified end to end against the running stack**, not just typechecked:
      the env password creates an operator that signs in at
      `POST /platform/auth/login` (201) and a wrong one is refused (401); a
      redeploy carrying a *different* env password leaves the stored argon2 hash
      byte-identical; placeholder, short and low-entropy passwords each exit 1;
      unset is a clean no-op. Test operators removed afterwards.

      One honest limit: the password is at rest in plaintext on whatever host
      holds the file, Dokploy's own environment store included. That is the
      trade for deploying without a terminal. Changing it in the console after
      the first sign-in makes the env value inert, which is what the log line
      tells the operator to do.

## A fresh deployment has no way in — 2026-10-06

Reported after deploying with Dokploy: no credential for the Super Admin
(operations console) panel. **Correct, and by design — but the design has a
hole next to it.**

`docker-compose.yml` runs `migrate.js && seed.js` and nothing else, and the
comment on the service says what the seed does: the shared drug catalogue and
"NOTHING else — no clinics, no patients, no accounts". `provision-operator.ts`
says the same: "The operations console has no self-service sign-up and no
default account, so this is the only way one comes to exist... an account that
ships with the software is an account everyone knows about."

That part is right and stays. Both scripts DO ship in the runner image
(`dist/database/provision-operator.js`, `dist/database/provision.js`), and both
run in it — verified, argon2 and pg resolve.

- [x] **`provision.ts` created a clinic with NO subscription row.** This is the
      hole, and it is on the path its own header calls "the only way into a
      fresh deployment". `FeatureGuard` resolves a clinic with no subscription
      to every flag false, so a freshly provisioned clinic came up with billing,
      reports, documents, WhatsApp, broadcasts, pharmacy, lab, analytics and
      import/export all off, and nothing said so.

      **Reproduced live before fixing**: provisioning a clinic through the
      shipped image left `has_sub = f`. After the fix, a subscription row is
      always written, and `--all-modules` writes a per-clinic override turning
      all eleven on — verified landing in the database as `self-hosted` with
      pharmacy, lab and analytics true.

      `--all-modules` is an EXPLICIT flag, never a default, because a clinic
      silently given modules nobody bought is the one direction the feature
      registry exists to prevent. It exists because a self-hosted single-clinic
      install has no price list and no console in use, and making that operator
      create a plan to get a working clinic is ceremony with no customer behind
      it.

      The command now PRINTS which of the two happened. Printing "clinic
      created" and stopping is what made the featureless case invisible, and
      whoever runs it is both the only person who can fix it and the only person
      looking at that moment.

      The arg parser also gained bare-flag support — it only collected
      `--key value` pairs, so `--all-modules` with nothing after it would have
      been dropped silently.
- [x] **Nothing seeds the plan catalogue**, which matters for the order of
      operations on a fresh server: the only code that creates a plan is the
      console's own Plans screen. So a new deployment has an empty `plan` table,
      and onboarding a clinic through the console has no plan to attach — which
      lands in the `unassigned` case above. Documented in the bootstrap sequence
      rather than "fixed", because inventing a default price list is not a
      decision to make in a migration.

## "The pharmacist is told to contact the admin" — 2026-10-06

Diagnosed against the live database, not guessed. **The pharmacist account was
fine and the guard was right. The PLAN was stale.**

`FEATURES` in `packages/contracts/src/features.ts` carries eleven keys. Every
plan row in the catalogue carried eight:

    billing, reports, whatsapp, documents, broadcasts,
    multiLocation, dataPortability, teleconsultation

Absent from all of them: **pharmacy, lab, analytics** — the three modules added
in the last three stages of work. `resolveFeatures` treats an absent key as
false, deliberately and correctly, so all three were off for every clinic on a
catalogue plan. Confirmed by query: `plan_pharmacy` was NULL on `pilot`,
`clinic` and `clinic-plus` alike.

**Why it looked like a pharmacist problem.** `landingRouteFor` sends a
pharmacist to `/pharmacy` and an analyst to `/analytics`, because neither has a
clinic dashboard to land on. So those two roles met the gate on the FIRST screen
after sign-in, which reads as a broken account rather than an unpriced module. A
doctor would have noticed later, on the lab tab. `nuvalyf` worked because it
happened to carry an explicit per-clinic override; `wasiq-testing` did not,
which is why it looked inconsistent.

**Why no test caught it.** `fixtures.mjs` gives the fixture clinic a feature
OVERRIDE turning all eleven on — correct for the clinical suites, which test
clinic behaviour rather than a price list. But it meant no test ever asked
whether a clinic on a REAL catalogue plan could reach the pharmacy. The gap was
between the plan catalogue and the feature registry, and nothing was looking
there.

- [x] **Migration `0017` backfills the absent keys**, and only the absent ones —
      `'{...}'::jsonb || features` puts the existing value on the right and the
      right operand wins, so an operator who deliberately switched a module off
      keeps that decision.

      It grants the three modules on `clinic-plus` ONLY. That is the top tier,
      and a top tier missing three shipped modules is unambiguously a mistake
      rather than a pricing decision. Every other plan gets them written as
      explicit FALSE: no behavioural change, but the console's plan editor
      renders from the registry, so they stop being invisible and can be priced
      deliberately. **The migration does not invent a price for a module nobody
      has priced** — changing that needs no migration, just the Plans screen or
      a per-clinic override.

      Applied to the running database. `wasiq-testing` now resolves pharmacy,
      lab and analytics to true.
- [x] **The migration asserts the gap is closed** — every plan must mention all
      eleven keys, and a clinic on the top tier must resolve `pharmacy` to true.
      That second assertion is the one that would have caught this.
- [x] **`platform.sh` now asserts it on every run**, reading `FEATURE_KEYS` from
      the API container's own build rather than a hardcoded list — so adding a
      twelfth feature fails the suite until somebody prices it. Also asserts no
      plan grants `analytics` without `reports`, since that dependency makes the
      grant a silent no-op.
- [x] **Onboarding a clinic with no plan no longer creates a featureless ghost.**
      Same symptom, different route, and worse: `planId` is optional and the
      service used to insert NO subscription row at all when it was omitted.
      `FeatureGuard` resolves a missing subscription to every flag false, so that
      clinic had all nine optional modules off and nobody was told — an absent
      row and a deliberate empty plan were indistinguishable.

      A subscription row is now always written, `plan: 'unassigned'` when none
      was chosen, with no features granted — inventing a feature set would be
      inventing a price, and a clinic given modules nobody sold it is the one
      direction the registry exists to prevent. The response carries
      `planAssigned`, and the console repeats the warning on the SUCCESS screen,
      not just on the form: that is the last moment anybody looks at the clinic
      before its staff do, and the first symptom otherwise is a staff member
      being told to contact the administrator who is reading that screen.

## "I reset the password and cannot sign in with it" — 2026-10-05

Reported symptom: a password was changed, the screen said so, the new password
did not work. **Two separate faults, either of which produces exactly that.**

- [x] **`settings/account` called no API.** The form's submit handler cleared the
      three fields and announced "Password changed. Your other sessions have been
      signed out." There was no `POST /auth/change-password` on the server at
      all. This is the one that matches the report: in the Doctor panel, change
      your own password, get told it worked, and the old password is still the
      only one that functions.

      It is now real, and the parts that are not obvious:

      * **The current password is verified first.** A valid session is not
        sufficient authority to change the credential that session rests on —
        otherwise a reception terminal left unlocked for two minutes becomes
        permanent ownership of a clinician's account, and a clinician's account
        signs prescriptions.
      * **A wrong current password counts against the lockout**, exactly like a
        failed sign-in. Without that, this form is an unthrottled oracle for
        guessing the current password of whatever account a session belongs to —
        the one place in the product where an attacker already holds a session
        and needs only the password.
      * **Other refresh sessions are revoked**, because the screen says they
        are. The caller's own access token survives so they are not ejected from
        the page they are standing on, but their refresh chain goes too, so the
        session they keep expires within the access-token TTL instead of staying
        renewable for weeks on a rotated credential. The toast reports the real
        count.
      * **`passwordChangedAt` is set to now**, and this is the one place that is
        correct — the USER chose this password. An administrator issuing a
        temporary one writes null, so the two cases stay distinguishable.
      * **No permission check**, deliberately. Every role must be able to change
        its own password, including the auditor who holds almost nothing.
        `@Authenticated()` is the whole requirement, and the user id comes from
        the verified token rather than the body, so the route cannot be aimed at
        somebody else's account.
      * Twelve characters, no composition rules. "One uppercase, one symbol"
        pushes people to `Password1!` and then to writing it on the monitor.
- [x] **The administrator's reset never checked its row count.** This one did
      write, so it mostly worked — but every table here is under FORCED row-level
      security, and an UPDATE whose row falls outside the caller's clinic does
      not raise. It affects zero rows and returns normally. So the endpoint could
      generate a password, hash it, store it nowhere, and hand it back: the
      administrator reads it out, the staff member cannot sign in, and nothing
      anywhere says why.

      That is not hypothetical here — it is the same shape that already bit
      sign-in, the clinic-status check and every audit write in this codebase,
      all of which silently affected nothing until their row counts were
      checked. Now `.returning()` and a `404` when it is not exactly one row.
- [x] **Verification that cannot pass against a mock.** Roughly 25 new
      assertions in `api-reads.sh`, and every one of them ends the same way: SIGN
      IN WITH IT. A 200 from the change endpoint proves nothing — the only proof
      is that the new password starts working and the old one stops. Both the
      self-service change and the administrator's reset are checked that way,
      against a throwaway account created and deactivated within the run so it
      cannot lock out a fixture the rest of the suite depends on.

      Also asserted: a wrong current password is refused, under-12 is refused,
      reusing the current password is refused, a reset for a non-existent user
      404s rather than returning a password stored nowhere, reception cannot
      reset somebody else's, and the auditor CAN reach the change route (refused
      on the password, not on a permission).

## Password reveal, every panel — 2026-10-05

- [x] **One `PasswordInput` in the UI kit, used by all six password fields.**
      Shared for the same reason `CredentialReveal` is: the handling rules are
      identical and writing them out six times is how one ends up without the
      auto-hide, or with a toggle that submits the form. There are now zero raw
      `type="password"` inputs left in the web app.

      Clinic sign-in (every clinical role arrives through it), the operations
      console sign-in, the three change-password fields, and the WhatsApp access
      token.

      Three details that are load-bearing rather than decorative:

      * **`type="button"`.** A button inside a form defaults to submit, so
        without it the toggle would attempt a sign-in with a half-typed password
        and burn a failed-login attempt against the lockout counter on every
        click.
      * **It re-hides itself after 20 seconds.** The risk at a clinic is not
        somebody reading over a shoulder during the two seconds it takes to
        check a password — it is the receptionist who reveals it, gets called
        away mid-sign-in, and leaves a credential in plaintext on a screen
        facing the waiting room. Twenty seconds is long enough that nobody
        checking their typing ever sees it expire.
      * **Keyboard-reachable**, not `tabIndex={-1}`. Somebody working the
        keyboard has the same reason to check what they typed.

      The reveal is worth most in three specific places. On the clinic sign-in,
      because there is no self-service reset — a password is issued by an
      administrator and read out, it is base64url so it mixes l/I/1 and O/0 and
      carries hyphens, and the only feedback on a typo is "email or password is
      incorrect", which does not say which. On the confirm-password pair, because
      "these do not match" between two masked fields gives you no way to tell
      WHICH field has the typo. And on the WhatsApp token, because that one is
      pasted rather than typed — a truncated copy or a leading space is invisible
      behind dots, and surfaces much later as reminders that silently never send.
- [x] **Two browser tests**, one per sign-in panel. They assert the input's
      `type` attribute flips, not that the icon changed — an icon swapping while
      the field stays masked is the failure that would look right in a
      screenshot and help nobody. They also type a wrong password, toggle, and
      confirm the page did not submit.

### Found while doing this — since FIXED, see the next section
- [x] **`settings/account` did not change your password.** Its `onSubmit`
      calls no API at all — it shows "Password changed. Your other sessions have
      been signed out." and clears the three fields. There is no
      `POST /auth/change-password` anywhere on the server; `grep` for
      `change-password` across `apps/api` and `packages/contracts` returns
      nothing.

      This is worse than an ordinary dead control, which is why it is listed
      rather than quietly left: the screen asserts a security action completed
      when nothing happened. Somebody who changes their password because they
      think it was seen will believe the old one no longer works and that other
      sessions were cut. Both claims are false.

      The reveal toggles now work on those three fields, which is what was
      asked for — but they are polish on a form that does not do its job, and
      the fix is an endpoint (verify the current password, hash the new one,
      set `passwordChangedAt`, revoke other refresh tokens), not a UI change.

## Staff passwords — reported 2026-10-05

Two complaints, one bug, and it was not in the staff code at all.

> "when the admin create an staff... password should be randomly generated as it
> is generated for the clinic admin, and even if i click on issue password, that
> password is not visible in the UI"

**The password was always randomly generated.** Both `invite` and `resetPassword`
call `randomBytes(9).toString('base64url')` — the same generator that mints the
clinic administrator's own password at provisioning. No screen in the product
asks anyone to type a staff password, and none ever did. It read as absent
because it was never legible on screen, which is the second complaint and the
actual defect.

- [x] **The session refetch was unmounting the app under the dialog.** The chain,
      every link of which looked correct alone:

      1. The staff mutation invalidates the session query — reasonably, so an
         administrator who renames or demotes someone sees their own sidebar
         change rather than a stale one.
      2. `SessionProvider` computed `isLoading` as
         `isRestoring || status === 'pending' || fetchStatus === 'fetching'`.
         That last clause is true during ANY refetch, including a background one.
      3. `RequireSession` in the authenticated layout replaces the **entire app**
         with a spinner while `isLoading` is true.
      4. The dialog unmounted, taking its React state with it — and the password
         is argon2-hashed before the row is written, so the only plaintext copy
         in existence was the one just discarded.

      Nothing threw and no request failed. The password appeared for a few
      hundred milliseconds and vanished with the dialog, which from the outside
      is indistinguishable from no password being generated.

      `isLoading` here does not mean "a request is in flight" — it means "we
      cannot yet say who this is". It is now a tested pure function,
      `isSessionLoading`, that short-circuits on having a session: once we know
      who the user is, we are never loading again whatever a refetch is doing.
      The cold-load case the old clause was protecting stays covered, because
      during restoration there is no session and `isRestoring`/`pending` still
      hold. **7 unit tests**, including the regression directly.

      This was only ever visible on the staff screen because that is the only
      place in the product that invalidates the session.
- [x] **Narrowed the invalidation.** Creating an account and issuing a password
      cannot change the acting user's own name or permissions, so they no longer
      ask for the session to be refetched. Editing still does — rename yourself
      and the sidebar should say so. Second line of defence rather than the fix.
- [x] **`passwordChangedAt` was being set to now on a staff reset.** Found while
      tracing the above. That field records when the USER last chose their own
      password, so stamping it at the moment an ADMINISTRATOR issues a temporary
      one asserts the opposite of what happened. It made the dialog's own
      sentence — "the account records that its password has never been changed
      from the one issued here" — untrue, and it is exactly the field a
      force-change-on-first-sign-in gate keys on. Nothing reads it yet, so this
      was not an open hole; it was a trap for whoever adds that gate, since every
      reset account would have looked as though its owner had already chosen a
      password. Now null, matching the operator reset in
      `platform-admin.service.ts`, which already got this right.
- [x] **Made the reveal harder to lose and easier to read.** The dialog is
      `mandatory` once a password is showing — Escape, an outside click and the
      corner close button are ordinary ways to change your mind while the form is
      open, and destructive once the only copy of a password is on screen. The
      password itself is set larger with wide tracking, because base64url mixes
      l/I/1 and O/0 and this gets read down a desk or over a phone, and it now
      says that it is case-sensitive and may contain a hyphen or underscore —
      the usual reason a correctly-read password is refused at sign-in.
- [x] **Two browser tests**, because only a real browser catches this: the unit
      test covers the predicate, and these cover the four links joined together.
      Both assert the password is STILL on screen after the refetch that used to
      destroy it, not merely that one was rendered.

## Where verification actually stands — 2026-10-05

Stated precisely, because "it typechecks" and "it works" are different claims
and conflating them is how a green build ships a broken register.

**Run, and green:**
- Typecheck, all four projects: `contracts`, `db`, `api`, `web` — clean.
- `eslint` on `apps/api` and `apps/web` — clean.
- 178 web unit tests, 7 files (7 new, on `isSessionLoading`).
- **32 NEW api unit tests, 2 files** — the first unit tests this service has
  had. `apps/api` now carries vitest with a deliberately narrow brief: almost
  everything here is only true against a real Postgres with RLS on, which is
  what the shell suites are for and what a mocked database would quietly fail to
  check. What belongs in a unit test is the logic that is wrong in ways a
  database cannot reveal — text decoding, CSV grammar, date arithmetic. Those 32
  cover exactly that, and every one of them is a case that fails SILENTLY in
  production: the BOM, the CP1252 fallback, the quoted comma, 31 February,
  DD/MM against MM/DD, the two-digit year.

**Written, typechecked, and NOT YET RUN AGAINST A DATABASE:**
- Migrations `0014`, `0015`, `0016` — unapplied. Their embedded assertions are
  the point of them and have never executed.
- `scripts/verify/pharmacy.sh` — new, never run.
- `scripts/verify/import.sh` — new, never run. ~60 assertions.
- `scripts/verify/research.sh` — new, never run. ~60 assertions.
- `scripts/verify/api-reads.sh` — the consent, share-link-revoke and document
  upload blocks are new and never run.
- `scripts/verify/availability.sh` — the idempotency block is new and never run.
- `apps/web/e2e/smoke.spec.ts` — 8 new tests, never run: 4 covering 25
  previously unguarded screens, 2 on the staff password reveal, 2 on the
  password-visibility toggle.
- `scripts/verify/api-reads.sh` — the password-change block (~25 assertions) is
  new and never run. It is the one that proves the reported bug is fixed, since
  it signs in with each password rather than trusting a 200.
- `all.sh` now runs 11 suites: `api-reads availability consultation-flow
  reminders analytics lab pharmacy import research broadcast platform`.

Docker has deliberately not been started. The next step is to apply the three
migrations and run the suites, and that needs confirmation before Docker comes
up.

## Dead controls, cleared 2026-10-05

Re-audited rather than trusted: every claim on the old list was checked against
the code before being acted on, and one turned out to be wrong in the dangerous
direction — see `pharmacy/lines/:id/fill` below.

- [x] **Consent could never be recorded or withdrawn.** The worst of them. The
      table, the read endpoint and the screen all existed; there was no POST or
      PATCH route anywhere, so the only consents in any database were the ones
      the verification fixtures inserted with raw SQL. That is not a tidiness
      problem: the WhatsApp send path refuses a patient with no
      `WHATSAPP_COMMUNICATION` consent, so **reminders and broadcasts were gated
      on something the product offered no way to obtain.**

      `POST /patients/:id/consents` and `POST /consents/:id/withdraw` now exist,
      with the dialogs behind the two buttons that did nothing. Every field is a
      DPDP requirement rather than bookkeeping, and none has a convenient default
      that would let somebody record a consent nobody gave: the notice VERSION is
      required, because "they consented" is not defensible without knowing which
      notice applied; the LANGUAGE is required, because the Act gives the data
      principal that choice and defaulting to English for a patient read the
      notice in Tamil makes the record untrue in exactly the way the provision
      exists to prevent.

      Re-recording a purpose supersedes rather than duplicating — two live
      consents for one purpose is a state nobody can act on. Withdrawal keeps the
      row: a message sent last week was lawfully sent, and erasing the consent
      would make it look otherwise in hindsight. No reason is required to
      withdraw, because making a patient justify exercising a right to a
      receptionist is a dark pattern.

      Recording is `consent:create` (reception included — the person who shows
      the notice is usually the person at the desk); withdrawing is
      `consent:update`, which is narrower, because it stops messages reaching
      that patient from the moment it lands.
- [x] **Document download, both ends.** `GET /documents/:id/download` and
      `GET /share/:token/file` had existed and audited since the module shipped,
      and nothing called either. On the clinic side the primary action on a
      document page was a `<Button>` with no `onClick`. On the public side a
      patient opened a share link, received an OTP, typed it correctly — **and
      met a button that did nothing.** Both are real links now; the share page
      keeps the OTP that worked, because the resolver re-verifies on every
      request rather than trusting that a previous call succeeded.
- [x] **Share links could not be revoked**, while the dialog said "it can be
      revoked at any time". The endpoint existed; the create response did not
      return the link's id, so the screen had nothing to call it with. It does
      now, and Revoke sits beside Copy — which is where it is needed, the moment
      somebody realises they pasted the link into the wrong chat.
- [x] **Broadcast cancel and test.** A broadcast to several hundred patients
      could be started and not stopped. The dispatcher checks between batches, so
      Stop takes effect within about a second — it cannot unsend what has gone,
      and the toast says so. Test send is offered only while it is still a draft:
      a WhatsApp template renders differently from how it reads in a form, and
      sending to the whole audience to find out is not a rehearsal.
- [x] **`patients/merge`** — the page's primary action did nothing while the
      endpoint, contract and service were complete. Wired through a dialog rather
      than straight to the button: a merge moves every encounter, prescription,
      invoice and document onto another record and is not easily undone, so the
      person pressing it sees both records and chooses which survives. The
      direction is the decision — the longer history usually wins, but not when
      the other has the correct spelling and a working phone number.
- [x] **Three stub settings pages.** Each rendered an unconditional "nothing
      here" with **no read path at all** — not one `api.get` — above a button
      with no handler. A clinic with templates in the database was told it had
      none. Consultation templates and prescription sets now read the endpoints
      that have existed all along and say plainly that creating them has no API
      yet. The consent-text page has no endpoint to read either, so it explains
      what actually matters — the notice VERSION recorded against each consent —
      instead of offering an upload button that cannot work.
- [x] **Browser coverage for all 25 unguarded screens** — ten pharmacy, six
      analytics, nine platform — across four new tests, including the operations
      console under its own operator session and its login page without one. A
      render check is not trivial here: every screen is gated on a session that
      resolves client-side, so a page whose component throws still answers 200
      with plausible markup. Only a real browser with console errors failing the
      run can tell.
- [x] **`appointment.service_item_id`.** The booking path accepted a service,
      used it to compute the end time and threw it away. Stored now, with
      migration `0014`; the analytics service filter applies to appointment
      counts as well as revenue, and the screen says that appointments booked
      before the column existed carry null and drop out — they are genuinely
      uncategorised, and attributing them would be inventing history to make a
      chart look complete. The FK is `SET NULL` and the migration asserts it:
      cascading would delete every appointment ever booked under a service the
      moment a clinic retired it from its price list.
- [x] **Idempotency on the two endpoints that move money and stock.**
      `POST /pharmacy/receipts` creates stock and `POST /pharmacy/sales` takes
      money, and a retry did both twice — the client sent an `Idempotency-Key`
      header nothing reads, and neither table had a column. Both now require the
      key in the BODY, with partial unique indexes doing the enforcing (migration
      `0015`) and the service returning the original row on a replay.
      `scripts/verify/pharmacy.sh` — the first API coverage the pharmacy has ever
      had — submits the identical receipt and the identical sale twice and
      asserts the shelf does not move.
- [x] **`POST /pharmacy/lines/:id/fill` needed nothing, and the comment claiming
      otherwise was wrong.** The audit flagged it as the most dangerous of the
      six, and its own code comment said a double-submit "would move stock twice,
      and the second movement would be indistinguishable from a genuine
      correction". Reading `fillLine`: it calls `reverseExisting` FIRST, returning
      the line's previous quantity to stock, and only then issues the new amount.
      It is a SET, not an ADD. A double-submit reverses and re-issues and the net
      stock is right. The cost is two extra ledger rows — noise in an append-only
      trail, not wrong stock. Comment corrected and the dead header removed; no
      machinery added for a problem that does not exist.

### Cleared in the second pass
- [x] **Document upload now exists.** `POST /documents` was missing entirely, so
      the Upload button was dead because there was nothing to call — a clinic
      could not attach a scanned report, an outside lab result or a signed
      consent form, which for a paper-heavy practice is most of a patient's file.
      Less work than the note assumed: `DocumentsService.upload` was already
      written, tenant-scoped and virus-scan-aware, and `StorageService.put`
      already enforced the MIME allowlist and the size cap. Only the route was
      absent.

      **Multipart, not base64 JSON.** A 25 MB file is 34 MB of base64, over the
      30 MB body limit, so the JSON route would have capped uploads near 22 MB
      with a confusing error at the boundary and held both copies in memory. The
      limits are declared on the Fastify plugin AS WELL AS in the storage
      service, which is not redundant: the service checks a buffer it has already
      been handed, so without the plugin limit a 2 GB upload is refused only
      after being received in full. `file.truncated` is checked too — Fastify
      truncates at the limit rather than throwing, and storing the short buffer
      would mean a document that opens as a corrupt half-page, which nobody would
      know was incomplete.

      **`PATIENT_UPLOAD` is refused, and the restrictive-looking choice would
      have been the broken one.** That type is held PENDING a virus scan, and
      both `download` and the share-link resolver refuse anything PENDING —
      correctly. But **nothing in this system ever sets `CLEAN`**: there is no
      scanner. A file filed that way would upload successfully and then be
      permanently unopenable, with no way to promote it. The gate is right and
      stays; what is missing is the scanner, so the type is unreachable rather
      than quietly accepted. This route is a member of staff attaching a file
      from the clinic's own machine, which carries a null scan status — the
      honest classification for a file the clinic produced itself.

      The api client learned about `FormData` for this, which needed one
      non-obvious thing: NO `Content-Type` header. Multipart needs a boundary
      token in it, the browser generates one when it sees a FormData body, and
      setting the type by hand produces a header with no boundary — which parses
      as a request with no parts at all, and reads as "the file never arrived"
      with nothing in it pointing at the header.
- [x] **The import wizard is real.** This was the worst screen in the product. The
      file was never uploaded or read; the column list it asked you to confirm was
      a hardcoded array of seven names; the result figures — "1,284 rows read",
      "1,207 ready", "54 possible duplicates", "23 problems" — were string
      literals; and the button under them said "Import the 1,207 ready rows" and
      had no handler. There was no `POST /imports` anywhere. A clinic admin would
      have come away believing their register was in, found out at the front desk,
      and had no idea which records to trust.

      Built rather than removed, because a clinic arriving from another system
      cannot start without it. Three steps, and the first two write nothing:
      `POST /imports` stores the file and returns its REAL headings and first
      three rows; `POST /imports/:id/validate` counts the rows against the actual
      contract; `POST /imports/:id/commit` inserts them in ONE transaction.
      `validate` and `commit` call the same `examine()`, so the preview cannot
      describe something other than what happens.

      **`import:execute` for the commit, `import:create` for the rest** — a
      narrower permission for the one step that changes the register. Everything
      before it is undone by closing the tab.

      The awkward parts were not the parsing. They were what a real export from a
      fifteen-year-old system contains, and each one fails SILENTLY:

      * **A UTF-8 BOM**, which Excel writes by default. Left in place it becomes
        part of the first heading, so "Name" arrives as "\uFEFFName", matches
        nothing, and every row is reported as missing a name.
      * **CP1252 text**, which most older Indian clinic software exports. Decoded
        as UTF-8 it does not throw — it substitutes U+FFFD where the accents
        were, so a name is quietly corrupted. The decoder falls back by LOOKING
        FOR replacement characters, and reports which encoding it used, because
        the clinic is the only one who can confirm a name looks right. Node's
        `latin1` is ISO-8859-1, not CP1252, and they differ exactly where Word's
        curly apostrophes live — so 0x80–0x9F is mapped by hand.
      * **DD/MM/YYYY, not MM/DD/YYYY.** 03/04/1990 is 3 April here and 4 March in
        an American export. Read backwards it still produces a valid date, still
        imports, and shifts a birthday by weeks — enough to change a paediatric
        dose and enough to stop a date-of-birth duplicate match. A two-digit year
        reads as the past, because a register holds no birthdays in the future.
      * **Rows that are entirely empty**, which a spreadsheet saved with
        formatting below the data writes by the hundred. Counted as rows they
        would tell the clinic their file has four times as many patients as it
        does, and report the difference as problems.
      * **An unrecognised entry in a sex column** is REPORTED, not defaulted to
        UNKNOWN. A record that reads as complete and is not is worse than one the
        clinic was asked about.

      **A SHARED MOBILE IS NOT A DUPLICATE**, and this is the rule most likely to
      be "tightened" by somebody who has not worked a clinic desk. A family of
      five on one handset is routine in this market; refusing four of them would
      leave a clinic unable to import its own register. The row is imported and
      flagged. Only an identical name on the same number, or the same name and
      date of birth, is treated as one person — EXACT matches, not the trigram
      similarity the front desk uses, because at the desk a human is looking at
      two records and a fuzzy prompt is useful, and here nobody is looking.

      Every imported record is tagged `imported`, permanently. The spelling, the
      number and the age came from the old system and were verified by nobody
      here; staff need to know that when the number does not ring. A stated age
      also gets `ageRecordedAt` set to the import date — an old register holding
      "34" says nothing about today without it, and a dose computed from a rotted
      age is wrong by years.

      **Excel workbooks are refused with an instruction** rather than parsed. The
      old picker accepted `.xlsx`, which it could afford to because it never
      opened the file; reading one means merged cells, multiple sheets and
      formula results that are not the displayed values. Pretending to accept it
      would mean reading a zip header as text and reporting every row as broken.

      `StorageService.putImport` is separate from `put` on purpose: a CSV is
      deliberately not on the document allowlist, because a spreadsheet handed to
      a clinician runs whatever a formula cell says, and widening the allowlist
      would also let somebody attach one to a patient's documents where a
      share-link recipient could download it.
- [x] **`POST /pharmacy/sales/:id/return` has a UI**, and it needed a read
      endpoint first. A return line must name the `stockBatchId`, and nothing
      returned one — the list gives totals and a line COUNT. That is why the
      endpoint sat implemented, audited and unreachable. `GET /pharmacy/sales/:id`
      now returns the lines with `returnableQuantity` computed server-side by the
      same arithmetic `recordReturn` enforces.

      The batch is not a detail a screen could guess: stock goes back on the
      batch it came off, and a strip sold from a batch expiring next month must
      return to THAT batch or the clinic dispenses it in March believing it has
      until December. The batch number and expiry are on every row because the
      person at the counter is holding the box. **The price is not editable** —
      the contract would accept any figure and the original line price is the
      only defensible one; refunding at today's price for goods bought at last
      month's turns the till into a way to move money without an auditable
      reason.
- [x] **`GET /broadcasts/:id/recipients` has a UI**, and failures sort first. Not
      a presentational nicety: a clinical broadcast is time-bound — closed
      tomorrow, camp on Sunday — so the patients it did not reach are the only
      ones anybody can still act on, and they are the minority of a long list.
      The failure reason is shown verbatim, because "number not on WhatsApp" is a
      phone call and "template was rejected" affects every recipient, and a
      generic "failed" tells you neither.
- [x] **`scripts/verify/research.sh`** (TODO G2) — 60-odd assertions on the one
      claim the analytics module makes that matters more than all its features:
      a Research Analyst cannot identify a patient. Asserted as an ABSENCE, which
      is the kind of guarantee that erodes silently — somebody adds a convenient
      lookup and nothing fails. Both halves are checked: no route takes a name, a
      number or an MRN, and the role holds no `patient:read`. Plus the three
      properties that make an extract safe to hand over — small cells suppressed
      rather than zeroed, subject keys salted per cohort so two extracts cannot
      be joined on them, and every export carrying the definition that produced
      it.
