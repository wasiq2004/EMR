# API & Security Middleware Specification

**Document:** Phase 0, Task 3
**Implementation:** [`apps/api/src/common/`](../../apps/api/src/common/)
**Date:** 2026-09-15

---

## 1. Conventions

| Aspect | Decision |
|---|---|
| Base path | `/v1` — version in the path, not a header |
| Transport | HTTPS only, TLS 1.2+, HSTS with preload |
| Auth | Access JWT (10 min) in an `httpOnly` `Secure` `SameSite=Lax` cookie |
| Refresh | Rotating opaque token, server-side in Redis + `refresh_session`, 30 days |
| Validation | Zod schemas from `packages/contracts`, shared verbatim with the frontend |
| Errors | RFC 9457 Problem Details; never leaks SQL, stack traces or internal ids |
| Idempotency | `Idempotency-Key` header required on all POST that dispatch or charge |
| Concurrency | `If-Match` with the row `version`; a stale write returns 409 |
| Pagination | Keyset (`?after=<cursor>&limit=`), never `OFFSET` |
| Rate limits | 100 req/min per user; 10/min on auth; 300/min per clinic on the webhook |

**Tenant identification.** `clinic_id` is read from the verified JWT **only**.
It is never accepted from a path parameter, query string, body or header. There
is no endpoint of the form `/v1/clinics/:clinicId/patients` — that shape invites
an IDOR, and the tenant is already unambiguous from the token.

---

## 2. Endpoint surface

Each endpoint declares exactly one permission from the matrix in §4. Permissions
are enforced by the global `RbacGuard`; a route declaring none is denied.

### Authentication

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/v1/auth/login` | `@Public` | Argon2id verify; throttled 10/min/IP; returns MFA challenge if enabled |
| POST | `/v1/auth/mfa/verify` | `@Public` | TOTP; mandatory for OWNER_ADMIN and DOCTOR |
| POST | `/v1/auth/refresh` | `@Public` | Rotates; reuse of a consumed token revokes the whole chain |
| POST | `/v1/auth/logout` | authenticated | Revokes the session immediately |
| GET | `/v1/auth/me` | authenticated | Current user, role, clinic |

### Clinic & users

| Method | Path | Permission |
|---|---|---|
| GET / PATCH | `/v1/clinic` | `clinic:read` / `clinic:update` |
| GET / POST | `/v1/users` | `user:read` / `user:create` |
| PATCH / DELETE | `/v1/users/:id` | `user:update` / `user:delete` |

### Patient registry

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/v1/patients/search?mobile=` | `patient:read` | E.164-normalised; **< 50 ms** |
| GET | `/v1/patients/search?name=` | `patient:read` | Trigram fuzzy; **< 200 ms** |
| GET | `/v1/patients/duplicates?…` | `patient:read` | Pre-registration duplicate check |
| POST | `/v1/patients` | `patient:create` | Rejects unless a duplicate check ran in this session |
| GET / PATCH | `/v1/patients/:id` | `patient:read` / `patient:update` | |
| GET | `/v1/patients/:id/snapshot` | `patient:read` | Aggregate; **< 1 s**; content varies by role |
| POST | `/v1/patients/:id/merge` | `patient:merge` | Never automatic; full audit chain |

### Queue & appointments

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/v1/queue` | `appointment:read` | Live queue; `@SkipAudit` (high-volume poll) |
| POST | `/v1/queue` | `appointment:create` | Walk-in → appointment in `ARRIVED` |
| PATCH | `/v1/queue/:id/position` | `appointment:update` | Sparse reorder |
| PATCH | `/v1/appointments/:id/status` | `appointment:update` | |

### Encounter & clinical

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/v1/encounters` | `encounter:create` | Opens a draft |
| GET | `/v1/encounters/:id` | `encounter:read` | Metadata only |
| GET | `/v1/encounters/:id/clinical` | `encounterClinicalContent:read` | **Separate permission** — reception cannot read the narrative |
| PATCH | `/v1/encounters/:id` | `encounterClinicalContent:update` | 409 if finalised |
| **POST** | **`/v1/encounters/:id/finalise`** | **`encounter:finalize`** | **DOCTOR only + registration number required** |
| POST | `/v1/encounters/:id/amend` | `encounterClinicalContent:create` | Creates a new linked encounter |
| GET / POST | `/v1/encounters/:id/internal-notes` | `internalNote:read` / `internalNote:create` | Clinicians only; structurally undispatchable |
| POST | `/v1/observations` | `observation:create` | Nurse may record vitals pre-encounter |
| POST | `/v1/conditions` | `condition:create` | |
| GET / POST | `/v1/patients/:id/allergies` | `allergy:read` / `allergy:create` | |

### Prescription

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/v1/drugs/search?q=` | `prescription:read` | Trigram; **< 200 ms** |
| POST | `/v1/prescriptions` | `prescription:create` | Draft; returns safety warnings |
| POST | `/v1/prescriptions/check` | `prescription:read` | Allergy + interaction pre-check |
| **POST** | **`/v1/encounters/:id/prescriptions/sign`** | **`prescription:sign`** | **DOCTOR only + registration number required**; enqueues `pdf.render` |

### Documents & sharing

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/v1/documents/upload-url` | `document:create` | Presigned PUT, type + size bound into signature |
| GET | `/v1/documents/:id/download-url` | `document:read` | Presigned GET, 5 min TTL |
| POST | `/v1/documents/:id/share` | `document:share` | Creates a `share_link` — see §6 |
| DELETE | `/v1/share-links/:id` | `document:share` | Immediate revocation |
| GET | `/share/:token` | `@Public` | Anonymous recipient; OTP-gated; audited |

### WhatsApp

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/v1/inbox/conversations` | `communication:read` | |
| POST | `/v1/inbox/conversations/:id/reply` | `communication:create` | Auto-selects session vs template |
| **POST** | **`/webhooks/whatsapp`** | **`@Public`** | HMAC-verified; acks < 1 s; see §7 of doc 02 |
| GET | `/webhooks/whatsapp` | `@Public` | Meta subscription verification challenge |

### Billing, reports, portability

| Method | Path | Permission |
|---|---|---|
| GET / POST | `/v1/invoices` | `invoice:read` / `invoice:create` |
| POST | `/v1/invoices/:id/payments` | `payment:create` |
| GET | `/v1/reports/:type` | `report:read` |
| POST | `/v1/imports` | `import:create` |
| POST | `/v1/imports/:id/commit` | `import:execute` |
| POST | `/v1/exports` | `export:create` |
| GET | `/v1/audit-events` | `auditEvent:read` |

**Unauthenticated routes — the complete list (5).** `POST /v1/auth/login`,
`POST /v1/auth/mfa/verify`, `POST /v1/auth/refresh`, `GET /share/:token`,
`/webhooks/whatsapp`. Plus `/healthz`. A CI test asserts the count of `@Public()`
decorators, so a sixth cannot be added without a deliberate checklist update.

---

## 3. Tenant Context Middleware

**Implementation:** [`tenant-context.middleware.ts`](../../apps/api/src/common/tenancy/tenant-context.middleware.ts), [`tenant-db.service.ts`](../../apps/api/src/common/tenancy/tenant-db.service.ts)

Runs globally, after JWT verification, before every controller.

1. Extract `clinic_id`, `sub`, `role`, `jti` from the **verified** token.
2. **Re-check clinic status on every request** (30-second Redis cache). A
   suspended clinic must stop working immediately, not when 10-minute tokens
   expire.
3. **Check `jti` against the revocation set.** A dismissed employee's token dies
   on revocation, not on expiry.
4. Bind `{ clinicId, userId, role, requestId, ip, userAgent }` into
   `AsyncLocalStorage` for the whole async call tree.

### 3.1 Why AsyncLocalStorage and not a parameter

Passing a context object down the call stack can be forgotten. AsyncLocalStorage
cannot: `TenantDb` reads the context itself and **throws if it is absent**.
There is no function signature a developer can satisfy while omitting the
tenant.

### 3.2 The RLS binding — the critical 10 lines

```ts
async run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
  const ctx = TenantContext.require();          // throws if absent — fail closed

  return this.db.transaction(async (tx) => {    // PINS ONE POOLED CONNECTION
    await tx.execute(sql`SELECT set_config('app.clinic_id', ${ctx.clinicId}, true)`);
    await tx.execute(sql`SELECT set_config('app.user_id',   ${ctx.userId},   true)`);
    return work(tx);                            // all queries on the pinned conn
  });
}
```

Three properties, each load-bearing:

- **`transaction()` pins one connection** for the callback's duration. Without
  this, a later query in the same request can land on a different pooled
  connection that has no tenant setting — and RLS then returns zero rows, or
  worse, the setting from a previous request.
- **`set_config(..., true)` is transaction-local.** It is discarded at
  COMMIT/ROLLBACK and cannot leak onto the next borrower of that connection.
- **`TenantContext.require()` throws.** A missing context aborts the request
  rather than proceeding unfiltered.

Direct use of the Drizzle client is blocked by an ESLint `no-restricted-imports`
rule. The single sanctioned escape hatch,
`runUnscopedPlatformOperation(reason, …)`, logs a warning, is enumerated in the
security checklist, and is unreachable from an HTTP handler.

---

## 4. RBAC Matrix

**Implementation:** [`permissions.ts`](../../apps/api/src/common/rbac/permissions.ts), [`rbac.guard.ts`](../../apps/api/src/common/rbac/rbac.guard.ts)

Legend: ● full · ◐ read only · ○ none

| Resource | OWNER_ADMIN | DOCTOR | RECEPTIONIST | NURSE_ASSISTANT | AUDITOR |
|---|:---:|:---:|:---:|:---:|:---:|
| Clinic settings | ● | ◐ | ◐ | ◐ | ◐ |
| Users | ● | ◐ | ○ | ○ | ◐ |
| Patient demographics | ● | ● | ● | ◐+update | ○ |
| Patient merge | ● | ○ | ○ | ○ | ○ |
| Appointments / queue | ● | ● | ● | ◐+update | ○ |
| Encounter **metadata** | ◐ | ● | ◐ | ◐ | ○ |
| Encounter **clinical content** | ◐ *(audit-tagged)* | ● | **○** | ◐ | ○ |
| **Encounter finalise** | **○** | **●** | **○** | **○** | **○** |
| Internal notes | **○** | ● | **○** | **○** | **○** |
| Observations (vitals) | ◐ | ● | ○ | ● | ○ |
| Conditions | ◐ | ● | ○ | ◐ | ○ |
| Allergies | ◐ | ● | ○ | ◐+create | ○ |
| Prescriptions | ◐ | ● | ○ | ◐ | ○ |
| **Prescription sign** | **○** | **●** | **○** | **○** | **○** |
| Documents | ●(no delete) | ● | ● | ◐+create | ○ |
| Document share | ● | ● | ● | ○ | ○ |
| WhatsApp inbox | ● | ● | ● | ● | ○ |
| Tasks | ● | ● | ● | ● | ○ |
| Consent | ● | ◐+create | ● | ◐ | ◐ |
| Invoices / payments | ● | ◐ | ● | ○ | ○ |
| Reports | ● | ◐ | ○ | ○ | ◐ aggregate only |
| Audit events | ◐ | ○ | ○ | ○ | ◐ |
| Import | ● | ○ | ○ | ○ | ○ |
| Export | ● | ● | ○ | ○ | ○ |

### 4.1 Four decisions that need a doctor's sign-off, not just a product owner's

**OWNER_ADMIN can read clinical content but cannot author or sign it.** SoW §5 grants
Clinic Owner / Super Admin visibility of "all clinic data subject to policy", so read
access is granted. Authorship is not: an administrator — even the practice owner — is
not necessarily a registered medical practitioner, and allowing them to produce a
document bearing a practitioner's NMC registration number is a legal problem, not a
permissions preference. An owner who also practises holds a separate `DOCTOR` account.

Because the owner reads records they did not author, every such access is tagged
`OWNER_CLINICAL_ACCESS` in `audit_event` (see `ELEVATED_VISIBILITY_PERMISSIONS` in
[`permissions.ts`](../../apps/api/src/common/rbac/permissions.ts)). This is a
transparency measure rather than a restriction — a practice can show its clinicians
exactly when management viewed a clinical record, which is what makes the access
acceptable to them.

**Internal notes stay clinician-only, including against OWNER_ADMIN.** A policy choice
under §5's "subject to policy" clause, and the reasoning is practical rather than legal:
clinicians will not write candid working notes they believe management reads, and a
private-note feature nobody trusts is worse than no feature. **Configurable if the owner
decides otherwise** — flagged for their decision rather than silently assumed.

**RECEPTIONIST sees encounter metadata but not the narrative.** They need to
know Dr. Sharma saw the patient at 10:15 and the visit is complete, in order to
bill and schedule. They do not need the clinical history. This is why
`encounter:read` and `encounterClinicalContent:read` are separate permissions
rather than one.

**AUDITOR reads the trail, not the patient.** An audit role with PHI access
defeats the purpose of having one. Reports served to an AUDITOR are
aggregate-only, enforced by a distinct response contract rather than by a UI
choice.

**NURSE_ASSISTANT records vitals and allergies but cannot diagnose or
prescribe.** Allergy *create* is granted deliberately — the nurse is usually the
person who asks the question at triage, and blocking it means the allergy is
never recorded.

### 4.2 Two gates on signing

Holding `DOCTOR` is necessary but not sufficient. `RbacGuard` additionally
checks that the practitioner has a `medical_registration_number` on file, because
it is a legally required element of a valid Indian e-prescription and would
otherwise print blank on the PDF.

### 4.3 Deny by default

`RbacGuard` is registered as a global `APP_GUARD`. A route declaring neither
`@RequirePermission` nor `@Public` is **denied**, and the denial is logged as a
developer error. Adding a controller without considering authorisation produces
a 403, never an open endpoint.

---

## 5. Audit Logger Interceptor

**Implementation:** [`audit.interceptor.ts`](../../apps/api/src/common/audit/audit.interceptor.ts)

Registered as a global `APP_INTERCEPTOR`. Every request is audited without
feature code participating — coverage is verifiable from one line of `main.ts`.

**Captured per the SoW:** actor (id, name, role, USER/SYSTEM/EXTERNAL), action,
outcome, target resource type and id, patient id, IP, user agent, request id,
HTTP method/path/status, timestamp, duration.

### 5.1 Four properties worth noting

**Failures are audited, not just successes.** A 403 is recorded as
`SERIOUS_FAILURE`. Repeated denials for one actor indicate either a broken UI or
an escalation attempt, and both are worth seeing.

**An audit write never fails the user's request.** A doctor cannot be blocked
from finalising a consultation because the audit table is briefly unavailable.
But a dropped audit row is a compliance gap, so the failure logs at ERROR, alerts,
and the writer buffers to a durable local queue and replays — the loss window is
bounded rather than open-ended.

**`patient_id` is populated wherever determinable.** This is what makes "who
accessed this patient's record?" — the DPDP subject-access query — a single
indexed lookup instead of a full scan.

**Free-text clinical values are hashed, not copied.** `change_summary` records
that a field changed and a hash of the value, not the value itself. Otherwise
the audit log becomes a second, uncontrolled copy of the clinical record with
different retention rules.

### 5.2 `@SkipAudit()`

Applied to exactly two routes: `/healthz` and `GET /v1/queue` (polled every few
seconds; would otherwise dominate the table). **Never** applied to anything that
reads or writes patient data. Enumerated in the security checklist and counted
by a CI test.

---

## 6. Secure File Sharing

**Implementation:** [`signed-url.service.ts`](../../apps/api/src/common/storage/signed-url.service.ts), [`share-link.service.ts`](../../apps/api/src/common/storage/share-link.service.ts)

Two mechanisms, different threat models. Conflating them is the common mistake.

| | **Internal** (staff) | **External** (patient / consultant) |
|---|---|---|
| Mechanism | S3 presigned URL | `share_link` token, streamed through the API |
| TTL | 5 min read / 15 min upload | 72 h default, 7 d max |
| Revocable | ✗ | ✓ immediately |
| Access audited | At issuance | **Every access** |
| Extra auth | Session already verified | Optional OTP to registered mobile |
| Access cap | — | Default 10 |
| Bucket exposed | To the staff member only | Never |

### 6.1 Why external sharing is not a presigned URL

A presigned URL cannot be revoked once issued, generates no access record,
works for anyone the link is forwarded to, and discloses the bucket name and key
structure. For a patient's lab report every one of those is unacceptable.

`ShareLinkService` instead issues an opaque 256-bit token, stores only its
SHA-256, and streams the object through the API. Notable details:

- **OTP defaults to ON** for every document type except prescriptions and
  invoices the patient is already expecting. Defaulting to open and relying on
  staff to tick a box is how clinical documents end up in forwarded WhatsApp
  threads.
- **Every failure returns an identical message.** Unknown token, expired,
  revoked and exhausted are indistinguishable, so the endpoint cannot be used to
  probe for valid tokens.
- **Unscanned patient uploads cannot be shared** — `virus_scan_status` must be
  `CLEAN`.

### 6.2 Object key structure

```
clinics/{clinic_id}/{category}/{yyyy}/{mm}/{uuid}.{ext}
```

The tenant prefix is structural. The bucket policy denies any request outside
`clinics/`, and `SignedUrlService` re-verifies the prefix against the caller's
own clinic before signing. A key leaked from one tenant cannot be edited into
another tenant's path and replayed. Reaching that check's exception means RLS
and the key prefix disagree, which should be unreachable — so it pages.

---

## 7. Verification: the adversarial tenancy test suite

This is the control that turns "we designed it correctly" into "it is correct on
this commit". It runs in CI on every push, against a real PostgreSQL via
Testcontainers.

### 7.1 Fixture

Two fully populated clinics — Clinic A and Clinic B — each with all five roles
and a complete clinical record set.

### 7.2 Assertions

| # | Test | Pass condition |
|---|---|---|
| T1 | **Endpoint sweep.** Every route in the OpenAPI document replayed with A's token against B's resource ids | 404 or 403. **Any 200 fails the build.** |
| T2 | **Write sweep.** Every mutating route attempted with A's token against B's resources | Rejected; B's row unchanged |
| T3 | **Cross-tenant insert.** Attempt to insert a row with `clinic_id = B` while context is A | Rejected by `WITH CHECK` |
| T4 | **No-context query.** Query with `app.clinic_id` unset | **Zero rows**, never all rows |
| T5 | **Forced RLS.** Every table with `clinic_id` has `relrowsecurity AND relforcerowsecurity` and ≥ 1 policy | Zero unprotected tables |
| T6 | **App role privileges.** `emr_app` has `NOBYPASSRLS` and no DDL | Asserted from `pg_roles` |
| T7 | **Audit immutability.** `UPDATE` and `DELETE` on `audit_event` as `emr_app` | Both raise |
| T8 | **Internal-note isolation.** `emr_worker_messaging` has no privilege on `encounter_internal_note` | Asserted from `information_schema.table_privileges` |
| T9 | **RBAC matrix.** Every (role × endpoint) pair exercised against the expected matrix value | No divergence |
| T10 | **Signing gate.** DOCTOR without a registration number attempts to sign | 403 |
| T11 | **Public route count.** Count of `@Public()` and `@SkipAudit()` decorators | Matches the checklist exactly |
| T12 | **Redis key prefixes.** All keys written during the suite | Every key begins `clinic:{uuid}:` |
| T13 | **S3 key prefixes.** All object keys generated during the suite | Every key begins `clinics/{uuid}/` |
| T14 | **Connection pinning.** Concurrent requests from A and B interleaved on a pool of size 1 | No cross-contamination of `app.clinic_id` |

T14 is the one most teams omit, and it is the one that catches the specific
regression this architecture is most exposed to: someone refactoring a query out
of `TenantDb.run()` and onto a fresh connection.

### 7.3 Additional gates

- **Nightly:** the T5 query run against production, alerting on any result
- **Pre-commit + CI:** `gitleaks` for secrets
- **Dependency:** `pnpm audit` and Dependabot, blocking on high severity
- **Pre-release:** the `/security-review` checklist, covering every `@Public()`,
  `@SkipAudit()` and `runUnscopedPlatformOperation` call site

---

## 8. Open items

1. **MFA enrolment grace period.** Mandatory TOTP for OWNER_ADMIN and DOCTOR is
   specified; how many days a new doctor may operate before enrolment is
   enforced is a client decision. Recommend 7.
2. **Session lifetime for shared front-desk machines.** A 30-day refresh token
   is wrong for a reception PC used by three people per shift. Recommend a
   per-role refresh TTL: 30 days for DOCTOR, 12 hours for RECEPTIONIST.
3. **Break-glass access.** A doctor needing another clinic's record in an
   emergency is out of scope for Phase 1 and should stay out until ABDM consent
   flows (M3) provide the lawful mechanism.
