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
- [ ] 10. Documents: upload URLs, share links with OTP

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
- [ ] 18. Point the frontend at the real API and retire the mock path
- [ ] 19. Docker: Postgres and Redis with health checks and init
- [ ] 20. Docker: API image, multi-stage

> **CHECKPOINT 4** — `docker compose up` brings up db, redis and api

## Stage 5 — Finish

- [ ] 21. Docker: web image, multi-stage, standalone output
- [ ] 22. `docker-compose.yml` wired end to end with env and health gates
- [ ] 23. Migrate and seed inside the container, verify the stack live
- [ ] 24. Browser tests against the real backend
- [ ] 25. UI polish pass

> **CHECKPOINT 5** — full stack verified in Docker

## Stage 6 — Handover

- [ ] 26. README and runbook
- [ ] 27. Final verification: build, lint, unit, e2e, docker
- [ ] 28. Final commit
