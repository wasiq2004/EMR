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

- [ ] 6. Patients: search, duplicate check, register, update, snapshot, merge
- [ ] 7. Scheduling: live queue, walk-ins, reorder, appointments
- [ ] 8. Clinical: encounters, observations, conditions, allergies, internal notes
- [ ] 9. Prescribing: drug search, lines, safety checks, finalise and sign
- [ ] 10. Documents: upload URLs, share links with OTP

> **CHECKPOINT 2** — the whole consultation flow works against the database

## Stage 3 — Operational API

- [ ] 11. Communication: conversations, messages, the unlinked queue
- [ ] 12. Tasks
- [ ] 13. Billing: invoices, payments
- [ ] 14. Reports
- [ ] 15. Settings: clinic, staff, services, templates, reminders

> **CHECKPOINT 3** — every endpoint the frontend calls exists for real

## Stage 4 — Data, wiring and containers

- [ ] 16. Audit trail endpoint, import and export
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
