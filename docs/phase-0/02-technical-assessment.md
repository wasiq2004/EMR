# Technical Assessment

**Document:** Phase 0, Task 1 (parts 1.1, 1.3, 1.4)
**Companion:** Task 1.2 is delivered separately as [01-tech-stack-decision.md](./01-tech-stack-decision.md)
**Date:** 2026-09-15

---

## 1. Feasibility Review

### 1.1 Verdict

All twelve modules are feasible on the proposed stack. None requires unproven technology.

Verdicts use the four-value scale mandated by SoW §4.1:

| Verdict | Count | Meaning |
|---|---|---|
| **Feasible** | 8 | Buildable as specified; no external dependency |
| **Feasible with dependency** | 4 | Buildable, but blocked on something outside engineering control |
| **Requires clarification** | 2 (cross-cutting) | Cannot be specified until an owner decision is made |
| **Not recommended** | 0 | — |

The feasibility risk in this project is **not technical**. It is adoption: a doctor who
finds the encounter screen slower than a paper pad will abandon it in week two. §3 treats
this as a first-class risk, and [Annex 5](./05-prototype-verification-script.md) is
designed to measure it before a line of feature code is committed.

### 1.2 Module-by-module assessment

Effort is in engineering-weeks for **one senior full-stack developer**, excluding design
and QA (see [Annex 9](./09-delivery-plan-and-cost.md) for the full costed plan).

| SoW § | Module | Verdict | Effort | Dependency / constraint |
|---|---|---|---|---|
| 6.1 | **Clinic setup & configuration** | ✅ Feasible | 2w | — |
| 6.2 | **Patient registry** | ✅ Feasible | 3w | — |
| 6.3 | **Appointments & clinic queue** | ✅ Feasible | 2w | — |
| 6.4 | **Patient clinical snapshot** | ✅ Feasible | 2w | Depends on 6.5–6.7 existing first |
| 6.5 | **Consultation / encounter** | ✅ Feasible | 4w | — |
| 6.6 | **Prescription module** | ⚠️ **Feasible with dependency** | 5w | **Licensed drug catalogue** (owner procurement, §N Q1). Ships with allergy-only checking if unlicensed |
| 6.7 | **Reports & document management** | ✅ Feasible | 3w | Virus scanning must be mandatory, not "as appropriate" (§B3) |
| 6.8 | **WhatsApp communication inbox** | ⚠️ **Feasible with dependency** | 5w | **WABA provisioning + Meta template approval.** Calendar-bound and outside our control; started in Phase 1 |
| 6.9 | **Automation & reminders** | ⚠️ **Feasible with dependency** | 3w | Same Meta template dependency |
| 6.10 | **Billing-lite** | ✅ Feasible | 3w | Scope boundary must be contractual — this is where creep toward accounting begins |
| 6.11 | **Reporting dashboard** | ✅ Feasible | 2w | Read replica needed beyond ~200 clinics |
| 7.1 | **Import wizard** | ⚠️ **Feasible with dependency** | 2w | **Source data quality.** Generic CSV/XLSX in scope; legacy migration priced per clinic (§O4) |
| 7.2 | **Clinic data export** | ✅ Feasible | 2w | — |

### 1.3 Requires clarification — cross-cutting

Two items cannot be specified until the owner decides. Neither blocks Phase 1, both block
Phase 2 or 5.

| Item | SoW ref | Why it cannot be assumed |
|---|---|---|
| **Prescription signing tier** | §6.1, §6.6 | Visible signature block vs Aadhaar eSign/DSC changes the PDF pipeline, the document schema and per-doctor onboarding. A legal question, not a technical one (§N Q2) |
| **Data retention periods** | §10 | SoW §10 explicitly states the developer must not invent legal retention periods. Lifecycle jobs cannot be built until an approved policy exists (§N Q3) |

**Indicative total: 38 engineering-weeks** for the functional modules. With
infrastructure, hardening and pilot support the full programme is **36 weeks + 15%
contingency ≈ 41 weeks** under the solo model — see [Annex 9 §2](./09-delivery-plan-and-cost.md).

### 1.3 Scope boundaries to write into the contract

The following are **out of scope** for Phases 1–2 and should be named explicitly, because
each is a natural place for a clinic to assume inclusion:

| Out of scope | Why | Earliest |
|---|---|---|
| Inpatient / IPD, wards, admissions | Entirely different workflow and data model | Not planned |
| Pharmacy stock and inventory | Separate domain; large surface | Phase 3 |
| Full accounting, GST filing, TDS | Billing-Lite is invoice + payment record only | Not planned |
| Lab/LIS device integration (HL7 v2) | Per-device driver work | Phase 3 |
| Insurance / NHCX claims (ABDM M4) | Requires M1–M3 first | Phase 3+ |
| Native mobile apps | Responsive web covers the pilot | Phase 3 |
| Teleconsultation video | Third-party embed if required | Phase 3 |
| ABDM M1/M2/M3 **certification** | Architecture is ABDM-*ready*; certification is a separate engagement | See `01 §6.3` |

---

## 2. System Architecture

### 2.1 Topology

```
                            ┌─────────────────────────────────────┐
  Clinic browsers ─────────▶│  Route 53  →  AWS WAF  →  ALB (TLS) │
  Meta webhooks   ─────────▶└──────────────────┬──────────────────┘
                                               │  ap-south-1 (Mumbai)
        ┌──────────────────────────────────────┼──────────────────────────────┐
        │  PUBLIC SUBNET                       │                              │
        │   ┌────────────────────┐   ┌─────────▼──────────┐                   │
        │   │ ECS: web           │   │ ECS: api           │                   │
        │   │ Next.js 15         │──▶│ NestJS 12 (Fastify)│                   │
        │   │ UI + thin BFF      │   │ REST + webhooks    │                   │
        │   └────────────────────┘   └─────────┬──────────┘                   │
        └──────────────────────────────────────┼──────────────────────────────┘
        ┌──────────────────────────────────────┼──────────────────────────────┐
        │  PRIVATE SUBNET                      │                              │
        │                            ┌─────────▼──────────┐                   │
        │                            │  Redis (BullMQ)    │                   │
        │                            └─────────┬──────────┘                   │
        │                                      │ 7 queues                     │
        │   ┌──────────────────┐     ┌─────────▼──────────┐                   │
        │   │ ECS: gotenberg   │◀────│ ECS: worker        │                   │
        │   │ Chromium → PDF   │     │ BullMQ consumers   │                   │
        │   └──────────────────┘     └─────────┬──────────┘                   │
        │                                      │                              │
        │   ┌──────────────────────────────────▼─────────────────────────┐    │
        │   │  RDS PostgreSQL 18 — forced RLS, encrypted at rest         │    │
        │   │   ├── audit_event (append-only; UPDATE/DELETE revoked)     │    │
        │   │   └── BACKUP: PITR (RPO 5 min) + automated snapshots,      │    │
        │   │        35-day retention, KMS-encrypted                     │    │
        │   └────────────────────────────────────────────────────────────┘    │
        └─────────────────────────────────────────────────────────────────────┘
                                               │
                    ┌──────────────────────────▼──────────────────────────┐
                    │  S3 ap-south-1 — SSE-KMS, versioned, no public ACL  │
                    │  clinics/{clinic_id}/documents|prescriptions|exports│
                    │  BACKUP: versioning + cross-region replication      │
                    └─────────────────────────────────────────────────────┘

  Egress ──▶ Meta Graph API (WhatsApp Cloud, India Local Storage enabled)
  Egress ──▶ SMS gateway (fallback channel)
  Egress ──▶ ABDM gateway (roadmap; excluded from MVP per SoW §12)

  ENVIRONMENTS (SoW §8): dev · staging · production
    separate AWS accounts · no shared credentials · synthetic data only
    outside production · promotion by CI/CD, never by manual deploy
```

### 2.1a Backup and restore (SoW §8)

| Element | Design |
|---|---|
| Database | RDS automated backups, 35-day retention, point-in-time recovery |
| **RPO** | **5 minutes** — proposed, requires owner approval (§B2) |
| **RTO** | **4 hours** — proposed, requires owner approval (§B2) |
| Object storage | S3 versioning plus cross-region replication |
| Encryption | KMS at rest; backups inherit the key |
| **Restore drill** | Quarterly full restore to an isolated account, timed and documented. **First drill completed before the first paid production deployment**, as SoW §8 requires |
| Scope of drill | Database + object storage + application boot + a scripted smoke test — restoring a database nobody can log into is not a restore |

### 2.2 API request pipeline

Every authenticated request traverses the same ordered chain. The order is
security-critical: tenant context must be established **before** any handler touches the
database, and the audit record must be written **after** the outcome is known.

```
  1. ALB / WAF            TLS termination, IP reputation, rate limit at edge
  2. helmet + CORS        Strict origin allowlist per clinic subdomain
  3. ThrottlerGuard       Per-IP and per-user rate limiting (Redis-backed)
  4. JwtAuthGuard         Verify access token signature + expiry; reject if jti revoked
  5. TenantContextMiddleware
                          Extract clinic_id from JWT claim; verify clinic active and not
                          suspended; bind { clinicId, userId, role, requestId } into
                          AsyncLocalStorage for the request lifetime
  6. RolesGuard           Evaluate the RBAC matrix for (role, resource, action).
                          Deny by default — an endpoint with no declared permission is
                          unreachable, not public
  7. ZodValidationPipe    Validate body/query/params against the shared contract schema
  8. Controller → Service
  9. TenantDb.run()       Opens ONE transaction, issues
                          set_config('app.clinic_id', …, true) and
                          set_config('app.user_id', …, true), then runs all queries on
                          that pinned connection. RLS enforces the boundary in Postgres
 10. AuditInterceptor     On completion, append an immutable audit_event row capturing
                          actor, role, action, resource, outcome, IP, user agent, request
                          id and timestamp
 11. Response             Serialise; strip any field not present in the response contract
```

**Design rule:** steps 5, 6, 9 and 10 are registered **globally**, never per-controller.
A reviewer can verify enforcement from `main.ts` alone. Opting *out* requires an explicit
`@Public()` or `@SkipAudit()` decorator, and every use of those decorators is enumerated
in the security review checklist.

### 2.3 Background job queues

Seven BullMQ queues. Every job payload carries `clinicId` and is asserted against the
record it loads; a worker that receives a job whose payload `clinicId` disagrees with the
loaded row's `clinic_id` fails hard and raises a P1 alert, because that condition should
be unreachable.

| Queue | Trigger | Work | Retry | Notes |
|---|---|---|---|---|
| `pdf.render` | Encounter finalised | Compose HTML → Gotenberg → S3 → emit `whatsapp.send` | 3, exp. backoff | Idempotent on `prescription_id` |
| `whatsapp.send` | PDF ready; reminder due | Resolve template vs session message, call Cloud API, persist message id | 5, exp. backoff | Respects 24-h window logic |
| `whatsapp.inbound` | Webhook received | Match to patient by E.164, thread into conversation, open/extend service window | 3 | Webhook itself acks in <1s |
| `reminder.schedule` | Nightly cron + appointment write | Compute due reminders per clinic timezone and quiet hours | 3 | Deduplicated per appointment |
| `import.process` | Import wizard upload | Parse, validate, dedupe, stage, commit; write row-level error log | 1 (manual) | Never partially commits |
| `export.build` | Export requested | `COPY … TO CSV` per entity + S3 document bundle → zip → presigned URL | 2 | Streamed; never buffered in memory |
| `maintenance` | Cron | Audit archival, session cleanup, orphaned-upload sweep, template status refresh | 3 | — |

### 2.4 Webhook consumer

Meta delivers WhatsApp events to a single public endpoint. The handler is deliberately
minimal, because Meta retries aggressively and disables endpoints that time out:

1. Verify `X-Hub-Signature-256` HMAC against the app secret — constant-time comparison.
   Reject unsigned or mismatched payloads with 403 and no body.
2. Resolve the target tenant from the payload's `phone_number_id`, mapped through
   `clinic_whatsapp_account`. **This is the only place in the system where tenant context
   comes from an external party**, so it is resolved by database lookup, never trusted from
   the payload, and a miss is logged as a security event rather than silently dropped.
3. Persist the raw payload to `webhook_event` with a uniqueness constraint on Meta's event
   id — this gives idempotency under Meta's at-least-once delivery.
4. Return **200 within 1 second**. All real work is enqueued to `whatsapp.inbound`.

Webhook routes bypass `JwtAuthGuard` (there is no user) but are explicitly registered in
the security review checklist as the system's only unauthenticated write path.

### 2.5 Signed URL and share-link generation

Two distinct mechanisms, frequently conflated, with different threat models:

**Internal access (staff viewing a document).** A short-lived S3 presigned URL, TTL
**5 minutes**, generated only after the RBAC guard has confirmed the requesting user's
role may read that resource and RLS has confirmed the object belongs to their clinic.
The S3 key always embeds `clinics/{clinic_id}/…`, so a leaked key from one tenant cannot
be mutated into another tenant's path without failing the bucket policy condition.

**External sharing (a patient or referred consultant receiving a report).** Never a raw
presigned URL — those cannot be revoked, cannot be audited on access, and leak the bucket
structure. Instead a `share_link` row: opaque 256-bit token, explicit expiry, optional OTP
challenge to the patient's registered mobile, a max-access counter, and a revocation flag.
Every access appends an `audit_event`. The share endpoint resolves the token server-side
and streams the object; the S3 URL is never exposed to the recipient. Full design in
`04 §6`.

### 2.6 Data flow: encounter finalisation

The system's most consequential transaction, shown end to end because it touches nine
components and is the path most likely to be got subtly wrong:

```
Doctor clicks "Sign & Finalise"
   │
   ├─▶ POST /v1/encounters/:id/finalise        [RolesGuard: DOCTOR only]
   │
   ├─▶ TenantDb.run() — ONE transaction:
   │      • re-read encounter FOR UPDATE, assert is_finalized = false
   │      • assert encounter.clinic_id matches context (belt and braces over RLS)
   │      • write Condition / Observation / MedicationRequest rows
   │      • set is_finalized = true, finalized_at, finalized_by, version += 1
   │      • append audit_event (action = ENCOUNTER_FINALIZED)
   │      • COMMIT
   │
   ├─▶ enqueue pdf.render { clinicId, prescriptionId }   [after commit, not inside]
   │
   ├─▶ worker: compose HTML (clinic letterhead, Noto fonts, signature block)
   │        → Gotenberg → PDF → SHA-256 hash
   │        → S3 clinics/{clinic_id}/prescriptions/{id}.pdf  (SSE-KMS)
   │        → persist document row + hash + signature
   │
   └─▶ enqueue whatsapp.send { clinicId, communicationId }
            → 24-h window open?  session message with document
            → window closed?     approved utility template + document
            → persist provider message id; delivery receipts update status via webhook
```

**Two rules encoded here.** Jobs are enqueued *after* commit, never inside the
transaction, so a rolled-back finalisation can never dispatch a prescription to a patient.
And the PDF hash is persisted at generation time, so any later dispute about document
content is resolvable against the audit trail.

---

## 3. Risk Register

Scoring: Likelihood and Impact each 1–5; Score = L × I. Clinical-safety and data-breach
risks are escalated one band above their arithmetic score, because their consequences are
not financially symmetric with their probability.

### R1 — Cross-tenant clinical data leakage

| | |
|---|---|
| **Category** | Security / regulatory — **critical** |
| **Likelihood** | 2 (low, but non-zero in any multi-tenant system) |
| **Impact** | 5 — reportable DPDP breach (penalties to ₹250 crore), total loss of clinical trust, likely end of the product |
| **Score** | 10 → **escalated to CRITICAL** |

**Cause.** A query reaching the database without the tenant predicate: a forgotten
`WHERE clinic_id`, a raw SQL escape hatch, a background job trusting its own payload, a
cache key without a tenant prefix, or a pooled connection reused across requests while
still carrying the previous tenant's session variable.

**Mitigations.**
- *Preventive:* Postgres RLS with `FORCE ROW LEVEL SECURITY` on every tenant table — the
  boundary lives in the database, not in application discipline. The API connects as
  `emr_app` (`NOBYPASSRLS`, no DDL rights), so it is not able to disable a policy. All
  queries run inside `TenantDb.run()`, which pins one connection for the transaction.
  Redis keys are prefixed `clinic:{id}:*`; S3 keys are prefixed `clinics/{clinic_id}/`;
  BullMQ payloads carry and re-assert `clinicId`.
- *Detective:* an **adversarial tenancy test suite** in CI (`04 §7`) replays every endpoint
  with Clinic A's token against Clinic B's resource identifiers — any response other than
  404/403 fails the build. A nightly job asserts that every table carrying a `clinic_id`
  column has both an enabled and a forced policy; a new table without one fails the check.
- *Corrective:* documented DPDP breach-notification runbook; per-tenant audit export to
  reconstruct exactly what was accessed.

**Residual:** Low. **Owner:** Tech Lead. **Review:** every release.

---

### R2 — WhatsApp delivery failure: service window, template rejection, and the October 2026 pricing change

| | |
|---|---|
| **Category** | Integration / commercial |
| **Likelihood** | 4 — near-certain to occur at least once per clinic |
| **Impact** | 3 — patient does not receive their prescription; clinic loses confidence in the channel |
| **Score** | 12 → **HIGH** |

**Cause.** Three distinct failure modes conflated under one heading because they present
identically to the clinic ("the patient didn't get it"):

1. The 24-hour service window has closed, so a free-form message is silently rejected.
2. Meta rejects or pauses a message template, which can happen without warning and
   retrospectively.
3. **From 1 October 2026** Meta bills per message for service *and* utility messages inside
   the open window, which were free from November 2024. This is a cost risk, not a delivery
   risk, but it lands in the same sprint.

**Mitigations.**
- *Preventive:* the messaging service computes window state from persisted inbound
  timestamps before every send and automatically falls back from session message to an
  approved utility template. Maintain **two approved templates per purpose** so a rejection
  of one does not halt the channel. Template status is refreshed nightly by the
  `maintenance` queue and surfaced in the admin console before it becomes an incident.
- *Preventive (commercial):* meter every send per clinic from day one. Price as a bundled
  allowance plus overage — never "unlimited". Present the ₹390/clinic/month baseline from
  `01 §2.5` to the client before pricing is fixed.
- *Detective:* delivery receipts reconcile against sent messages; any prescription not
  marked delivered within 15 minutes raises a front-desk task via the `Task` entity.
- *Corrective:* every dispatch has a fallback path — SMS via a secondary provider, a
  printable copy, and an authenticated share link. **A prescription is never dependent on a
  single channel.**

**Residual:** Medium. **Owner:** Integrations. **Review:** monthly, and immediately after 1 Oct 2026.

---

### R3 — Prescription PDF layout overflow or Indic script corruption

| | |
|---|---|
| **Category** | Clinical safety |
| **Likelihood** | 3 |
| **Impact** | 5 — a truncated dosage line or a mis-shaped drug name is a patient-harm event and a liability |
| **Score** | 15 → **CRITICAL** |

**Cause.** Long or numerous drug entries overflow the page; a long clinic address pushes
content under the footer; or the renderer fails to shape Devanagari/Tamil conjuncts,
producing a drug name that reads as a different word.

**Mitigations.**
- *Preventive:* Chromium (HarfBuzz) rendering via Gotenberg — the only mainstream option
  with correct complex-script shaping; pure-JS PDF libraries are rejected for exactly this
  reason (`01 §2.3`). Layout uses CSS Paged Media with `@page` margin boxes for running
  header and footer, so content can never occupy the letterhead or signature zone. Hard
  server-side caps on free-text fields, enforced in the Zod contract rather than only in
  the UI.
- *Detective:* a **golden-file snapshot suite** in CI — pathological fixtures (22 drugs,
  400-character instructions, long Tamil and Devanagari drug names, three-line clinic
  address, longest-registered practitioner name) rendered and diffed against approved PDFs.
  Any pixel drift fails the build. Additionally, a post-render assertion that the generated
  PDF's extracted text contains every drug name that was submitted — this catches silent
  shaping and truncation failures that a human reviewer would miss.
- *Corrective:* mandatory on-screen preview before signing; the doctor sees the exact
  artefact the patient will receive.

**Residual:** Low. **Owner:** Tech Lead + clinical reviewer. **Review:** every release touching the PDF template.

---

### R4 — Duplicate patient registration

| | |
|---|---|
| **Category** | Clinical data quality |
| **Likelihood** | 5 — will happen daily without active mitigation |
| **Impact** | 4 — a split record means allergies and history are invisible at the point of prescribing |
| **Score** | 20 → **CRITICAL** |

**Cause.** This is harder in India than in most markets, and the naive design fails:

- One mobile number routinely serves an entire family, so mobile is **not** a unique key
- Name transliteration is unstable — Mohd / Mohammed / Muhammad, Lakshmi / Laxmi
- Date of birth is frequently unknown; patients state an approximate age
- There is no universal identifier that can be mandated (Aadhaar cannot be made compulsory)

**Mitigations.**
- *Preventive:* search-before-create is enforced by the workflow — the registration form is
  not reachable without a prior mobile search. When a number already exists, the receptionist
  is shown **all patients on that number** as a picker ("Is this Sunita Devi, 34F, last seen
  12 Aug?") before "Register new" is offered. Fuzzy matching on `pg_trgm` over a normalised
  name, combined with gender and age band, surfaces likely duplicates across different
  numbers. Phone numbers are normalised to E.164 at write time, so `98765 43210`,
  `+919876543210` and `09876543210` collide correctly.
- *Detective:* a nightly duplicate-candidate report per clinic, scored and queued for
  front-desk review through the `Task` entity.
- *Corrective:* a **merge tool** that re-parents encounters, prescriptions, documents and
  allergies onto a surviving record, writes a full `audit_event` chain, and retains the
  merged-from identifier permanently for traceability. **Merging is never automatic** — a
  wrong merge is harder to undo than a duplicate, so it always requires human confirmation.

**Residual:** Medium — irreducible without a national identifier. **Owner:** Product + Tech Lead. **Review:** monthly against the duplicate-rate metric.

---

### R5 — Drug catalogue licensing gap and clinical safety liability

| | |
|---|---|
| **Category** | Commercial / clinical / legal |
| **Likelihood** | 4 |
| **Impact** | 4 — blocks the Prescription module, or ships it with safety claims the data cannot support |
| **Score** | 16 → **HIGH** |

**Cause.** Prescription safety warnings require a licensed, actively maintained Indian drug
database covering brands, molecules, strengths, interactions and contraindications. No
free, comprehensive, reliable source exists. The failure mode is subtle and dangerous:
shipping an incomplete catalogue while the UI implies the system is checking for
interactions. A doctor who trusts a check that is not actually running is in a worse
position than one who knows there is no check at all.

**Mitigations.**
- *Preventive:* resolve the licence **before Phase 1 planning** — it is a budget line, not
  an engineering task (`01 §6.2`). If no licence is obtained, Phase 1 ships allergy
  cross-checking only (which is derived from the clinic's own `AllergyIntolerance` data and
  requires no licence), with **interaction checking absent from the UI entirely** rather
  than present and unreliable.
- *Preventive (legal):* the prescribing doctor remains the clinical decision-maker. Explicit
  product terms, plus a visible in-product statement of what is and is not checked.
- *Detective:* catalogue version and last-updated date displayed in the prescribing screen
  and stamped into each `MedicationRequest`, so any future clinical review can establish
  exactly what data was in force at the time of prescribing.
- *Corrective:* the catalogue is a versioned, swappable data source behind an interface,
  so a licensed database can replace the pilot subset without touching the prescribing UI.

**Residual:** Medium until the licence decision is made. **Owner:** Client + Product. **Review:** blocking item for Phase 1 kickoff.

---

### Secondary risks — monitored, not yet mitigated in depth

| ID | Risk | L | I | Score | Position |
|---|---|---|---|---|---|
| R6 | **Doctor adoption failure** — encounter entry slower than paper | 4 | 5 | 20 | The largest *business* risk. Mitigated by note templates, last-visit copy-forward, keyboard-first navigation, and measured directly by the `05` verification script before feature code is written |
| R7 | **Clinic internet instability** — dropouts mid-consultation | 4 | 3 | 12 | Draft outbox + IndexedDB cache + explicit pending-changes banner (`01 §3.1`). Not full offline-first, which is deliberately rejected |
| R8 | **Import data quality** from incumbent systems | 4 | 3 | 12 | Import is per-clinic bespoke work; time-boxed and priced separately. Staged, validated, never partially committed |
| R9 | **WABA number suspension** by Meta for quality rating | 2 | 4 | 8 | Per-clinic quality monitoring; opt-out honoured immediately; templates kept strictly transactional |
| R10 | **Significant Data Fiduciary designation** under DPDP | 3 | 3 | 9 | Already building to the stricter posture (India-only processing, DPIA-ready records, annual audit trail). Full compliance due 14 May 2027 |
| R11 | **Reports query cost** against RLS-filtered tables at scale | 3 | 2 | 6 | Read replica and materialised views from ~200 clinics; RLS predicates are index-backed by design (`03 §5`) |
| **R12** | **Solo-developer bus factor** — illness or departure halts delivery entirely | 3 | 4 | 12 | **Partially unmitigated.** Documentation-as-you-go, owner-controlled cloud accounts (SoW §16), and infrastructure-as-code limit the damage but do not prevent the stoppage. The only real mitigation is a second developer — costed as Option B in [Annex 9 §4](./09-delivery-plan-and-cost.md) |

---

## 4. Assessment conclusion

The architecture satisfies all five SoW mandates, and every mandate is enforced by a
mechanism that fails closed rather than by a convention that engineers must remember:

| Mandate | Enforcement | Fails how? |
|---|---|---|
| Tenant isolation | Forced RLS + `NOBYPASSRLS` app role | Query returns zero rows |
| FHIR R4 alignment | Normalised store + edge mapping layer | Compile error on contract drift |
| Immutable audit | `REVOKE UPDATE, DELETE` from `emr_app` | Database rejects the write |
| Internal notes undispatchable | Separate table, no `SELECT` grant to worker | Worker cannot read the row |
| Zero lock-in | `COPY … TO CSV` per entity + document bundle | — |

**The two decisions that must precede Phase 2** are commercial rather than technical: the
drug catalogue licence (**R5**) and the prescription signing tier. Both carry budget
implications and both constrain the Prescription module, the largest in the build.

**Recommended immediate action:** run the [Annex 5](./05-prototype-verification-script.md)
verification script with five pilot doctors at the end of Phase 1, *before* Phase 2
begins. R6 — adoption — ties for highest-scoring risk in this register, and it is the only
one that cannot be mitigated by architecture.

### 4.1 Performance, capacity and browser support

SoW §11 requires the developer to state p95 performance targets, capacity assumptions and
a supported browser matrix. All three are in
[Annex 9 §6](./09-delivery-plan-and-cost.md), alongside the load-testing method used to
validate them in Phase 5.

Headline targets: patient search **p95 < 150 ms**, patient snapshot **p95 < 1,200 ms**,
encounter save **p95 < 500 ms**. Capacity: no architecture redesign required to reach
**500 clinics**; first genuine redesign point is ~2,000.
