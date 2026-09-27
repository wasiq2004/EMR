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
