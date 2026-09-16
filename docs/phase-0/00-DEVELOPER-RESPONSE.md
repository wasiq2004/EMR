# Developer Response — Phase 0 Technical Assessment

**Responding to:** EMR Project · Statement of Work v1.0 · Basic Clinic EMR System – India
**Response structure:** per SoW §19 (sections A–O)
**Covers SoW §4 items:** 4.1 – 4.12
**Date:** 2026-09-15
**Status:** Submitted for owner approval — no development has begun

> **SoW §4 STOP GATE acknowledged.** No application feature code has been written.
> The only code produced in Phase 0 is the database schema with its tenant-isolation
> policies and the security middleware chain, delivered so both can be reviewed and
> tested before any feature depends on them.

---

## Document map

This response follows the SoW §19 template. Each section is answered here in full;
where a topic needs engineering depth beyond a summary, the detail is in a linked annex.

| §19 | Section | SoW §4 ref | Annex |
|---|---|---|---|
| A | Overall assessment | — | this document |
| B | Scope gaps | — | this document |
| C | Stack | 4.2 | [Annex 1 — Technology Stack](./01-tech-stack-decision.md) |
| D | Architecture | 4.3 | [Annex 2 — Technical Assessment §2](./02-technical-assessment.md) |
| E | Database / ERD | 4.4 | [Annex 3 — Database Schema](./03-database-schema.md) |
| F | Security | 4.5 | [Annex 4 — API & Security Spec](./04-api-security-spec.md) |
| G | WhatsApp | 4.6 | [Annex 6 — WhatsApp Approach](./06-whatsapp-approach.md) |
| H | Medicine data | 4.7 | [Annex 7 — Drug Data Approach](./07-drug-data-approach.md) |
| I | Import / export | 4.8 | [Annex 8 — Import & Export Approach](./08-import-export-approach.md) |
| J | Timeline | 4.9 | [Annex 9 — Delivery Plan & Cost](./09-delivery-plan-and-cost.md) |
| K | Estimate | 4.10 | [Annex 9 — Delivery Plan & Cost](./09-delivery-plan-and-cost.md) |
| L | Team | — | this document + Annex 9 |
| M | Risks | 4.11 | [Annex 2 — Technical Assessment §3](./02-technical-assessment.md) |
| N | Questions | 4.12 | this document |
| O | Proposed changes | — | this document |

Additional annexes: [Annex 5 — Prototype Verification Script](./05-prototype-verification-script.md) (SoW §13 Phase 1 acceptance gate) and [Annex 10 — Benchmark Product Review](./10-benchmark-review.md) (SoW §3).

---

# A. Overall assessment

## **Recommended with changes.**

The system described in this SoW is buildable as specified, on proven technology, with
no unproven components. The document is unusually well-specified for its stage — the
tenant-isolation mandate (§10), the internal-note isolation requirement (§6.8), and the
instruction not to invent legal retention periods (§10) are all signs of a client who has
thought about the failure modes that matter.

**Four changes are recommended before development begins.** Each is explained in §B or §O.

1. **Two commercial decisions must be resolved first** — the drug catalogue licence and
   the prescription signing tier. Both block the Prescription module, which is the single
   largest module in the build. Neither is an engineering problem.
2. **The delivery timeline under a solo developer is approximately 9 months to pilot**,
   not the compressed schedule a 12-module scope might suggest. Detail and options in
   §J and Annex 9.
3. **A DPDP compliance workstream should be added as an explicit deliverable.** The SoW
   covers security controls well, but DPDP Rules 2025 impose obligations — consent
   records, breach notification, a data protection impact assessment — that are
   organisational, not only technical, and full compliance is due 14 May 2027.
4. **The Phase 1 prototype should be tested against a scripted UAT before Phase 2
   begins.** Doctor adoption is the highest-scoring risk in the register and the only one
   architecture cannot mitigate. Script supplied as Annex 5.

**What is not recommended against.** Nothing in the functional scope is unnecessary,
over-engineered, or technically ill-advised. The module set is disciplined and the
out-of-scope list (§12) is correctly drawn.

---

# B. Scope gaps

Requirements that are **technically necessary for safe operation** but are not stated, or
are stated too loosely to build against. Listed most consequential first.

### B1 — Clinic offboarding and data deletion procedure *(not stated)*

The SoW makes export a first-class capability (§7.2) but never says what happens when a
clinic leaves. Under DPDP this is a live obligation, not a courtesy: personal data must
not be retained past its purpose.

**Required:** a defined offboarding sequence — export generated and verified → grace
period → verified deletion → deletion certificate issued. The schema uses
`ON DELETE RESTRICT` throughout precisely so that this cannot happen accidentally.
**Needs an owner-approved policy**, not a developer assumption.

### B2 — Recovery objectives are unstated *(stated too loosely)*

§8 requires "automated encrypted backup strategy and documented restore procedure with
actual restore test". It does not state **RTO** (how long a clinic may be down) or **RPO**
(how much data may be lost). These two numbers determine the backup architecture and its
cost, and they cannot be inferred.

**Proposed for approval:** RPO 5 minutes (PITR), RTO 4 hours. See §F.

### B3 — Virus scanning is optional; it should be mandatory *(stated too loosely)*

§8 says malware validation "as appropriate". For patient-supplied uploads that are later
re-served to staff and to other patients via share links, it is not optional — an
unscanned file in a clinical record is a distribution vector.

**Proposed:** mandatory scan on every patient upload; `virus_scan_status` must be `CLEAN`
before the file is viewable or shareable. Already implemented in the schema and
`ShareLinkService`.

### B4 — Practitioner departure and record ownership *(not stated)*

When a doctor leaves a clinic, their account is deactivated — but they authored clinical
records that must remain attributable, and they may have a legal right to a copy of
records they authored. The SoW is silent.

**Implemented defensively:** `created_by` is deliberately *not* a foreign key to
`app_user`, so provenance survives account deletion or anonymisation. **The policy
question remains open** and is a legal decision, not a developer one.

### B5 — Rate limiting and abuse protection *(not stated)*

§10 covers authentication and authorisation but not abuse. Without rate limiting, the
login endpoint permits credential stuffing and the public share-link resolver permits
token enumeration.

**Implemented:** 100 req/min per user, 10/min on auth endpoints, strict limits on
`/share/:token`, AWS WAF at the edge.

### B6 — Encounter amendment strategy is required but unspecified *(stated too loosely)*

§10 requires "Do not lose the previous value/history of finalized clinical information.
Define correction/amendment strategy" — correctly making this the developer's job to
propose.

**Proposed:** corrections append, never overwrite. A correction creates a new encounter
row linked via `amends_encounter_id`; the original is immutable, enforced by a database
trigger. Same principle for prescriptions (reissue) and invoices (credit note).
**Requires clinical sign-off.**

### B7 — Unlinked WhatsApp conversations need a retention rule *(not stated)*

§6.8 requires an unlinked conversation queue when patient matching is uncertain. Those
conversations contain health information about a person who is **not yet a patient of
record**, which is the weakest lawful-basis position in the system.

**Proposed:** unlinked conversations auto-purge after 30 days unless linked to a patient.
**Needs legal approval.**

### B8 — No accessibility conformance target *(stated too loosely)*

§11 lists accessibility qualitatively (contrast, labels, keyboard). No standard is named.

**Proposed:** WCAG 2.2 Level AA for core flows. Naming a standard makes it testable;
leaving it qualitative makes it unfalsifiable at UAT.

---

# C. Stack

**Full detail and the rejected alternatives: [Annex 1](./01-tech-stack-decision.md).**

| Layer | Choice | Primary reason |
|---|---|---|
| Language | TypeScript 5.9 | One language across API, UI and shared validation contracts |
| Runtime | Node.js 24 LTS | Supported to April 2028 |
| Frontend | Next.js 15 + React 19 + Tailwind 4 + shadcn/ui | Responsive web per §8; self-hosted, not on foreign edge |
| API | **NestJS 12** on Fastify | Its guards/interceptors/middleware *are* the §4.5 security requirements |
| Database | **PostgreSQL 18, forced RLS** | Transactional relational per §8; RLS makes §10 tenant isolation a database guarantee |
| Query layer | **Drizzle ORM** | SQL-first; RLS transaction pinning is explicit and auditable |
| Cache / queue | Redis 7 + BullMQ | §8 background work: reminders, PDF, import/export, webhooks |
| Object storage | AWS S3 ap-south-1, SSE-KMS | §8 private storage with signed access |
| PDF | **Gotenberg** (Chromium) + Noto fonts | Only mainstream option with correct Indic script shaping |
| Auth | Self-hosted Argon2id + JWT + Redis refresh + TOTP | §10 salted hashing, MFA for owner/admin/doctor |
| Cloud | **AWS ap-south-1 (Mumbai)** | India data residency by default |
| Monitoring | OpenTelemetry → Grafana LGTM (Mumbai) + Sentry (PII-scrubbed) | §8 observability with patient-data minimisation |
| CI/CD | GitHub Actions → ECR → ECS; Terraform | §8 repeatable CI/CD, separate dev/staging/prod |
| Testing | Vitest + Testcontainers + Playwright + k6 | §14 unit, integration, E2E, tenancy, load |

### The two choices that carry the most weight

**Drizzle over Prisma.** SoW §10 makes cross-tenant access a zero-tolerance failure. The
only way to guarantee that is Postgres Row-Level Security, which requires every query in
a request to run on one connection pinned inside a transaction carrying
`set_config('app.clinic_id', …, true)`. Drizzle makes that explicit and reviewable;
Prisma works against it and fails silently.

**Chromium PDF over a JavaScript PDF library.** Prescriptions must render Devanagari,
Tamil and other Indic scripts. Those require complex text shaping (conjuncts, reordered
vowel signs). Pure-JS PDF libraries get this wrong *silently* — producing a mis-shaped
drug name on a legal medical document. Chromium embeds HarfBuzz and gets it right.

---

# D. Architecture

**Full detail, request pipeline and job queues: [Annex 2 §2](./02-technical-assessment.md).**

```
                        ┌──────────────────────────────────────┐
  Clinic browsers ─────▶│  Route 53 → AWS WAF → ALB (TLS 1.2+) │
  Meta webhooks   ─────▶└─────────────────┬────────────────────┘
                                          │      AWS ap-south-1 (Mumbai)
   ┌──────────────────────────────────────┼─────────────────────────────┐
   │ PUBLIC SUBNET                        │                             │
   │  ┌─────────────────┐   ┌─────────────▼──────────┐                  │
   │  │ ECS: web        │   │ ECS: api               │                  │
   │  │ Next.js         │──▶│ NestJS — REST+webhooks │                  │
   │  │ UI + thin BFF   │   │ RBAC · audit · tenancy │                  │
   │  └─────────────────┘   └─────────────┬──────────┘                  │
   └──────────────────────────────────────┼─────────────────────────────┘
   ┌──────────────────────────────────────┼─────────────────────────────┐
   │ PRIVATE SUBNET             ┌─────────▼──────────┐                  │
   │                            │ Redis — BullMQ     │                  │
   │                            │ 7 queues           │                  │
   │  ┌─────────────────┐       └─────────┬──────────┘                  │
   │  │ ECS: gotenberg  │◀────────────────┤                             │
   │  │ Chromium → PDF  │       ┌─────────▼──────────┐                  │
   │  └─────────────────┘       │ ECS: worker        │                  │
   │                            │ reminders · PDF ·  │                  │
   │                            │ import · export ·  │                  │
   │                            │ webhook processing │                  │
   │                            └─────────┬──────────┘                  │
   │  ┌───────────────────────────────────▼──────────────────────────┐  │
   │  │  RDS PostgreSQL 18 — forced RLS · encrypted · Multi-AZ       │  │
   │  │  ├── audit_event (append-only, immutable)                    │  │
   │  │  └── PITR 5-min RPO ──▶ automated snapshots (35-day)         │  │
   │  └──────────────────────────────────────────────────────────────┘  │
   └────────────────────────────────────────────────────────────────────┘
                                          │
        ┌─────────────────────────────────▼─────────────────────────────┐
        │  S3 ap-south-1 — SSE-KMS · versioned · Block Public Access    │
        │  clinics/{clinic_id}/{documents|prescriptions|exports}        │
        │  └──▶ cross-region replication (backup copy, ap-southeast-1)  │
        └───────────────────────────────────────────────────────────────┘

  External ──▶ Meta Graph API (WhatsApp Cloud, India Local Storage ON)
  External ──▶ SMS gateway (fallback channel)
  External ──▶ ABDM gateway (roadmap, not MVP per SoW §12)

  ENVIRONMENTS: dev · staging · production — separate AWS accounts,
  no shared credentials, synthetic data only outside production (SoW §10)
```

### Tenancy — four enforcement layers (SoW §8, §10)

| Layer | Mechanism | Failure mode if absent |
|---|---|---|
| Database | Forced RLS on `app.clinic_id` | A missing `WHERE` returns another clinic's rows |
| Connection | `emr_app` role is `NOBYPASSRLS`, no DDL | A compromised API could disable policies |
| Cache | Redis keys prefixed `clinic:{id}:*` | A cache hit serves another clinic's data |
| Files | S3 keys prefixed `clinics/{clinic_id}/` | A leaked key is edited into another tenant's path |
| Jobs | `clinicId` in every payload, re-asserted on load | A replayed job mutates the wrong tenant |

### Backups (SoW §8)

| Element | Design |
|---|---|
| Database | RDS automated backups, 35-day retention, PITR — **RPO 5 min** |
| Object storage | S3 versioning + cross-region replication |
| Encryption | KMS at rest; backups inherit encryption |
| **Restore test** | Quarterly full restore drill to an isolated account, timed and documented. **First drill completed before the first paid production deployment**, per §8 |
| Target | **RTO 4 hours** — subject to owner approval (see §B2) |

---

# E. Database / ERD

**Full schema, indexes and RLS design: [Annex 3](./03-database-schema.md).**
**Code:** [`packages/db/src/schema/`](../../packages/db/src/schema/) · [`migrations/0001_roles_and_rls.sql`](../../packages/db/migrations/0001_roles_and_rls.sql)

All 15 SoW §9 domain entities are modelled, across 30 tables.

| SoW §9 entity | Table(s) | FHIR R4 |
|---|---|---|
| Clinic / Location | `clinic`, `clinic_location`, `service_item` | Organization, Location, HealthcareService |
| User / Practitioner | `app_user` | Practitioner + PractitionerRole |
| Patient | `patient`, `patient_merge_log` | Patient |
| Appointment | `appointment` | Appointment |
| Encounter | `encounter`, `encounter_internal_note`, `encounter_template` | Encounter |
| Observation | `observation` | Observation |
| Condition / Diagnosis | `condition` | Condition |
| Allergy / Intolerance | `allergy_intolerance` | AllergyIntolerance |
| MedicationRequest | `medication_request`, `drug_catalogue_item`, `prescription_template` | MedicationRequest |
| Document / DiagnosticReport | `document_reference` | DocumentReference |
| Communication | `communication`, `whatsapp_account`, `whatsapp_conversation`, `webhook_event` | Communication |
| Task / Reminder | `task` | Task |
| Consent | `consent` | Consent |
| Invoice / Payment | `invoice`, `payment` | Invoice, PaymentReconciliation |
| AuditEvent | `audit_event` | AuditEvent |

Supporting: `refresh_session`, `share_link`, `import_job`, `export_job`.

### Notable constraints and history strategy (SoW §19 E)

- **`clinic_id NOT NULL` on every table**, with `ON DELETE RESTRICT` — deleting a clinic
  fails loudly rather than silently erasing clinical history
- **Forced RLS on every table**, verified by a migration assertion that fails the build if
  any table is unprotected
- **Append-only audit** — triple-enforced by RLS policy, grant-level `REVOKE`, and a trigger
- **Finalised records are immutable** — database triggers reject edits to a finalised
  encounter or its prescriptions; corrections append (see §B6)
- **Optimistic concurrency** — `version` column with a stale-write trigger, because two
  receptionists editing one patient is routine
- **Trigram indexes** on normalised patient name and drug search, normalised by trigger so
  imports and API writes normalise identically
- **Partial indexes** on every hot working set (live queue, open encounters, active
  allergies, undelivered messages) so they stay small as history grows

### FHIR-readiness (SoW §9)

The store is normalised relational, not FHIR-document. FHIR R4 is the **ABDM wire
format**, not a storage model — storing FHIR JSON would make every clinically useful
query a JSON traversal. Enum values mirror the corresponding FHIR valuesets by name, and
mapping happens at the API edge, so standards-based export can be added without
rebuilding the database, exactly as §7.2 requires.

---

# F. Security

**Full detail, RBAC matrix and the adversarial test suite: [Annex 4](./04-api-security-spec.md).**

| SoW §10 control | Implementation |
|---|---|
| **Authentication** | Argon2id (OWASP params); 10-min access JWT in `httpOnly`/`Secure`/`SameSite` cookie; rotating 30-day refresh stored server-side for instant revocation |
| **MFA** | TOTP, **mandatory for Owner/Admin and Doctor** — the roles that can finalise clinical records |
| **Passwords** | Argon2id PHC-format; never plaintext, never reversible, never in any response contract |
| **Authorization** | Global `RbacGuard`, **deny by default** — an endpoint declaring no permission is unreachable, not public. 5 roles × 21 resources × 9 actions, server-side |
| **Tenant isolation** | Four layers (see §D). Verified by a 14-test adversarial suite in CI that replays every endpoint across tenant boundaries; any 200 fails the build |
| **Encryption** | TLS 1.2+ with HSTS in transit; KMS at rest for RDS, S3 and backups |
| **Secrets** | AWS Secrets Manager, injected as ECS task secrets. `gitleaks` in pre-commit and CI. No secrets in source, bundle or repository |
| **Sessions** | Server-side refresh store enables immediate revocation on dismissal or suspicion; clinic suspension re-checked on **every request**, not at token expiry |
| **Audit** | Global interceptor writing immutable `audit_event`: actor, action, resource, outcome, IP, user agent, request id, timestamp. Covers create/update/finalise/share/export/privileged access |
| **Clinical edits** | Append-only amendment; database-enforced (§B6) |
| **Consent** | Six separate categories (treatment, data processing, **WhatsApp**, marketing, third-party sharing, ABDM), each independently withdrawable per DPDP |
| **Logging** | Structured logs with a PII redaction layer; clinical free text and tokens never logged. Sentry `beforeSend` scrubbing |
| **Support access** | **Zero standing access.** No human database credentials. Break-glass via AWS SSM Session Manager: time-boxed, requires a ticket reference, CloudTrail-logged, alerts on use |
| **Data lifecycle** | Configurable retention per data class. **Periods are proposed, not asserted** — the owner must supply the approved legal policy (SoW §10 explicitly forbids the developer inventing these). See §N |
| **Backup/restore** | See §D. RPO 5 min, RTO 4 h proposed; quarterly drills; **first drill before first paid production deployment** |
| **SDLC** | Dependabot + `pnpm audit` blocking on high severity; PR review required; secret scanning; external security test before production |
| **Testing data** | Synthetic generator only. A CI check fails the build if a non-production environment is pointed at a production database |
| **Environments** | Separate AWS accounts for dev / staging / production. No shared credentials, no production data outside production |

### The internal-note guarantee (SoW §6.8)

> *"Internal notes must be technically impossible to send to the patient accidentally."*

A boolean flag does not satisfy "technically impossible" — one defective
`WHERE is_internal = false` sends a doctor's private note to a patient. The
implementation is structural:

- `encounter_internal_note` is a **physically separate table**
- the messaging worker connects as `emr_worker_messaging`, which holds **no privileges
  on that table at all**
- an ESLint rule forbids the messaging module from importing it
- CI asserts the privilege is absent on every build

The worker cannot read the rows, therefore it cannot send them.

---

# G. WhatsApp

**Full detail, message flows and cost model: [Annex 6](./06-whatsapp-approach.md).**

**Approach: official Meta Cloud API direct, as a Tech Provider with Embedded Signup**,
abstracted behind a `MessagingProvider` interface so a BSP can be substituted without
touching the Inbox.

Three facts that shape the design, all current:

1. **The On-Premises API is dead** — final version expired 23 October 2025. Cloud API is
   the only option.
2. **Cloud API Local Storage supports India** — message payloads can rest in an Indian
   data centre. Must be enabled per WABA; it materially simplifies the DPDP data-flow map.
3. **From 1 October 2026, Meta bills per message for service *and* utility messages sent
   inside the open 24-hour window** — previously free since Nov 2024. This is a cost-model
   change, and it lands within weeks.

### Estimated recurring cost (SoW §4.6)

| Item | Rate | Per clinic / month |
|---|---|---|
| Utility template (reminders, prescription ready) | ₹0.16 / message | ~₹200 |
| Service messages in window (billable from 1 Oct 2026) | ~₹0.16 / message | ~₹190 |
| Authentication (OTP for share links) | ₹0.13 / message | ~₹15 |
| **Pass-through total, ~80 msg/day clinic** | | **≈ ₹390–420** |

Against a ₹3,000/month subscription that is **13%+ of revenue**. **Recommendation:** meter
sends per clinic from day one and price as a bundled allowance plus overage — never
"unlimited". `communication.cost_paise` and
`whatsapp_conversation.billable_message_count` exist in the schema for this.

---

# H. Medicine data

**Full detail and licensing options: [Annex 7](./07-drug-data-approach.md).**

**This is a procurement decision, not an engineering one, and it blocks the Prescription
module.**

Drug search with interaction and contraindication warnings requires a licensed,
actively maintained Indian drug database. No free, comprehensive, reliable source exists.

The dangerous failure mode is subtle: shipping an incomplete catalogue while the UI
implies interactions are being checked. **A doctor who trusts a check that is not actually
running is in a worse position than one who knows there is no check.**

| Option | Cost | Capability | Recommendation |
|---|---|---|---|
| **Licensed Indian formulary** | ₹1–4 L/yr (indicative) | Brands, molecules, interactions, contraindications, paediatric dosing | Required before advertising interaction checking |
| **Curated pilot subset** (~2,000 molecules) | Build cost only | Search + **allergy cross-check only**; interaction UI absent entirely | Acceptable for pilot |
| Free/scraped sources | — | Incomplete, unmaintained, licence-ambiguous | **Not recommended** |

**Free-text fallback is mandatory in every option.** `medication_request.drug_display_name`
is `NOT NULL` while `catalogue_item_id` is nullable — a doctor must always be able to
prescribe something not in the catalogue, per SoW §6.6.

**Traceability:** `catalogue_version_at_prescribing` is stamped on every prescription, so
a later clinical review can establish exactly what reference data was in force.

---

# I. Import / export

**Full detail, field mapping and validation rules: [Annex 8](./08-import-export-approach.md).**

### Import (SoW §7.1)

CSV/XLSX, via the mandated workflow: **upload → map columns → validate → duplicate review
→ preview → import → reconciliation report**.

- **Staged and validated in full before any row is committed.** A half-imported registry
  is worse than none, because staff cannot tell which records are trustworthy.
- **No row is dropped silently** — every rejection produces a row-level error with a
  reason, in a downloadable report.
- Import job id plus summary counts: input, imported, skipped, duplicates, failed.
- Duplicate detection reuses the live registry logic (E.164 normalisation + trigram name
  match), so import-time and desk-time behaviour cannot diverge.
- Adapter interface permits additional migration sources later without schema change.

### Export (SoW §7.2) — complete manifest

| File | Content | Status |
|---|---|---|
| `patients.csv` | Demographics and identifiers | ✅ |
| `appointments.csv` | Appointment history and statuses | ✅ |
| `encounters.csv` | Encounter header + clinical note references | ✅ |
| `observations.csv` | Vitals / observations | ✅ |
| `diagnoses_conditions.csv` | Problems / diagnoses | ✅ |
| `allergies.csv` | Recorded allergies / intolerances | ✅ |
| `prescriptions.csv` | Headers + medicine line items, documented structure | ✅ |
| `documents.csv` + `/documents` | Metadata plus **original files** | ✅ |
| `communications.csv` | Communication metadata/content per retention policy | ✅ |
| `billing.csv` | Invoices and payments | ✅ |
| `audit_metadata.csv` | Event/export log; security internals not exposed | ✅ |
| `manifest.json` | Row counts, SHA-256 per file, schema version | ✅ added |
| FHIR/JSON | Roadmap — interfaces designed so it needs no rebuild | Designed |

Generated by `COPY … TO CSV` streamed directly to S3 — never buffered in memory, so a
clinic with 100,000 encounters exports without an out-of-memory failure. **Every export
writes an audit event**, because a full clinical export is precisely what a departing
employee would do.

---

# J. Timeline

**Full plan, phase gates and dependencies: [Annex 9](./09-delivery-plan-and-cost.md).**

Mapped to the SoW §13 phase structure. **Assumes a solo developer with part-time QA and
design support.**

| Phase | SoW §13 output | Effort | Cumulative |
|---|---|---|---|
| **0** Technical assessment | This response | 2 wk | wk 2 |
| **1** UX / prototype & design system | Clickable core flows + UAT (Annex 5) | 4 wk | wk 6 |
| **2** Core EMR backend/frontend | Auth/RBAC, clinic, patient, appointment, queue, encounter, Rx, files, PDF, audit | 12 wk | wk 18 |
| **3** Communication & automation | WhatsApp, inbox, internal notes, secure links, reminders, opt-out | 5 wk | wk 23 |
| **4** Billing / reporting / portability | Billing-lite, reports, import, export | 5 wk | wk 28 |
| **5** Hardening & pilot release | Monitoring, backup/restore drill, security test, performance | 4 wk | wk 32 |
| **6** Pilot support & stabilisation | Bug fixes, analytics, onboarding docs | 4 wk | wk 36 |

**≈ 36 weeks + 15% contingency ≈ 41 weeks ≈ 9.5 months to pilot exit.**

> ⚠️ **This is the honest solo-developer number and the client should see it plainly.**
> Adding one mid-level full-stack developer from Phase 2 compresses this to
> **≈ 24 weeks (5.5 months)** for roughly ₹6 L additional cost — the best
> value-per-rupee change available to this plan. Options modelled in Annex 9 §4.

### Critical-path dependencies (owner-supplied, per SoW §18)

| Needed by | Input | Blocks |
|---|---|---|
| **Before Phase 1** | Sample prescription formats, clinic branding | Rx layout, PDF template |
| **Before Phase 1** | 5 pilot clinic users | UAT gate (Annex 5) |
| **Before Phase 2** | **Drug catalogue decision** | Prescription module |
| **Before Phase 2** | **Prescription signing tier decision** | Rx finalisation, PDF |
| **Before Phase 3** | WhatsApp business account / BSP decision | All messaging |
| **Before Phase 3** | Approved consent / privacy / legal text | Consent capture |
| **Before Phase 4** | Anonymised sample import files | Migration mapping |
| **Before Phase 5** | Approved data-retention policy | Lifecycle jobs |

---

# K. Estimate

**Full breakdown and assumptions: [Annex 9 §3](./09-delivery-plan-and-cost.md).**

### One-time build — fixed price per milestone (INR)

| Phase | Deliverable | Fixed price |
|---|---|---|
| 0 | Technical assessment (this response) | ₹1,10,000 |
| 1 | UX / prototype & design system | ₹2,15,000 |
| 2 | Core EMR backend + frontend | ₹6,30,000 |
| 3 | Communication & automation | ₹2,62,500 |
| 4 | Billing / reporting / portability | ₹2,62,500 |
| 5 | Hardening & pilot release *(incl. external security test)* | ₹2,85,000 |
| 6 | Pilot support & stabilisation | ₹1,00,000 |
| | **Total one-time** | **₹18,65,000** |
| | Contingency @ 15% *(drawn only against approved change requests)* | ₹2,80,000 |
| | **Total with contingency** | **₹21,45,000** |

**Rate assumptions** — stated so they can be adjusted rather than argued:
senior full-stack ₹1,75,000/month · QA 0.25 FTE ₹35,000/month · UI/UX ₹40,000/month
(Phases 0–1 only) · external security test ₹75,000 one-off (Phase 5).

### Recurring — monthly

| Item | Pilot (5 clinics) | ~100 clinics |
|---|---|---|
| AWS ap-south-1 (compute, RDS, Redis, S3, ALB) | ₹18,000 | ₹65,000 |
| Monitoring, error tracking, domains | ₹3,000 | ₹8,000 |
| WhatsApp pass-through *(≈₹400/clinic)* | ₹2,000 | ₹40,000 |
| SMS fallback | ₹500 | ₹8,000 |
| **Subtotal** | **₹23,500** | **₹1,21,000** |
| Drug catalogue licence *(if taken)* | **Not quoted — owner decision** | ₹8,000–33,000 |
| Support / maintenance retainer *(optional, post-Phase 6)* | ₹45,000 | ₹45,000 |

**Per-clinic infrastructure cost at 100 clinics ≈ ₹1,210/month**, which is what makes a
₹3,000/month subscription viable.

### Explicitly excluded from this estimate

Drug catalogue licence · Aadhaar eSign/DSC integration · ABDM certification · per-clinic
bespoke data migration (quoted separately per SoW §7.1) · native mobile apps · any SoW §12
out-of-scope item.

---

# L. Team

### Proposed for this engagement (per the agreed solo model)

| Role | Allocation | Phases | Responsibility |
|---|---|---|---|
| **Senior full-stack developer** | 1.0 FTE | 0–6 | Architecture, API, frontend, database, integrations, deployment |
| **QA engineer** | 0.25 FTE | 2–6 | Test automation, tenancy suite, UAT coordination |
| **UI/UX designer** | 0.25 FTE | 0–1 | Design system, prototype, clinical workflow screens |
| **External security tester** | One engagement | 5 | Pre-production vulnerability assessment (SoW §14) |
| **Clinical reviewer** *(owner-supplied)* | Advisory | 1, 2, 5 | Sign-off on RBAC matrix, prescription layout, safety warnings |

### Roles the solo developer absorbs, and the risk of that

| Absorbed role | Risk | Mitigation |
|---|---|---|
| DevOps | Infrastructure work competes with feature work | Terraform from day one; ECS not Kubernetes; managed services throughout |
| DBA | Schema and index decisions unreviewed | Schema delivered in Phase 0 specifically so it can be reviewed externally before anything depends on it |
| Security engineer | Self-review has blind spots | External security test in Phase 5 is a line item, not optional |
| **Bus factor of 1** | **Illness or departure halts delivery** | **Unmitigated.** Documentation-as-you-go and owner-controlled cloud accounts (SoW §16) limit the damage, but do not remove the risk |

**Bus factor is the honest weakness of the solo model** and the owner should weigh it
against the ~₹6 L cost of adding a second developer (Annex 9 §4).

---

# M. Risks

**Full register with likelihood, impact, scoring and controls: [Annex 2 §3](./02-technical-assessment.md).**

| ID | Risk | Score | Headline mitigation |
|---|---|---|---|
| **R4** | **Duplicate patient registration** | 20 CRITICAL | Search-before-create enforced by workflow; E.164 normalisation; trigram matching; merge tool that never runs automatically |
| **R6** | **Doctor adoption failure** | 20 CRITICAL | Templates, copy-forward, keyboard-first; **measured by the Annex 5 UAT before Phase 2 begins** |
| **R3** | **Prescription PDF overflow / Indic corruption** | 15 CRITICAL | Chromium/HarfBuzz; CSS Paged Media; golden-file snapshot tests; post-render text assertion |
| **R5** | **Drug catalogue licensing gap** | 16 HIGH | Resolve before Phase 2; ship allergy-only checking with interaction UI absent if unlicensed |
| **R2** | **WhatsApp window / template / pricing** | 12 HIGH | Persisted window state with automatic template fallback; two templates per purpose; per-clinic metering; multi-channel fallback |
| **R1** | **Cross-tenant data leakage** | 10 CRITICAL* | Forced RLS + `NOBYPASSRLS` role + 14-test adversarial CI suite |
| R7 | Clinic internet instability | 12 | Draft outbox, IndexedDB cache, explicit pending-changes banner |
| R8 | Import data quality | 12 | Staged, validated, never partially committed; priced separately |
| **R12** | **Solo-developer bus factor** | 12 HIGH | **New.** See §L — partially unmitigated |
| R9 | WABA suspension by Meta | 8 | Quality-rating monitoring; transactional templates only |
| R10 | DPDP Significant Data Fiduciary designation | 9 | Already building to the stricter posture |
| R11 | Report query cost at scale | 6 | Read replica and materialised views from ~200 clinics |

*\* escalated above arithmetic score — consequences are not symmetric with probability.*

---

# N. Questions — owner decisions required before build

Per SoW §17, these are raised as decisions rather than guessed. **Items 1–4 are blocking.**

| # | Question | Blocks | Recommendation |
|---|---|---|---|
| **1** | **Drug catalogue:** license a commercial Indian formulary, or ship a curated pilot subset with allergy-only checking? | **Phase 2** | Pilot subset for launch; license before claiming interaction checking |
| **2** | **Prescription signing tier:** visible signature block + session-bound hash, or full Aadhaar eSign / DSC? | **Phase 2** | Tier 1 for MVP; eSign as a Phase 7 change request |
| **3** | **Data retention periods** per data class. *SoW §10 explicitly forbids the developer inventing these* — owner must supply the approved legal policy | **Phase 5** | Engage a DPDP practitioner; Annex 3 §6 proposes defaults **for approval only** |
| **4** | **Approved consent, privacy and notice text**, per purpose, per language | **Phase 3** | Owner-supplied per SoW §18 |
| 5 | **WhatsApp commercial model:** bundled allowance + overage, or clinic brings its own BSP account? | Phase 3 | Bundled allowance + overage |
| 6 | **RTO / RPO targets** (§B2) | Phase 5 | RPO 5 min, RTO 4 h |
| 7 | **Clinic offboarding and deletion policy** (§B1) | Phase 5 | Export → grace → verified deletion → certificate |
| 8 | **Practitioner departure / record ownership** (§B4) | Phase 2 | Legal decision |
| 9 | **Unlinked WhatsApp conversation retention** (§B7) | Phase 3 | 30-day purge unless linked |
| 10 | **Accessibility target** (§B8) | Phase 1 | WCAG 2.2 AA on core flows |
| 11 | **Allergy warning behaviour:** SoW §6.6 says warnings are "advisory". We read this as *must not autonomously alter the prescription*, and propose a modal requiring acknowledgement plus a typed override reason. Confirm this matches intent | Phase 2 | Modal + typed override |
| 12 | **Team model:** confirm solo delivery at ~9.5 months, or add a second developer for ~24 weeks at ~₹6 L more | **Phase 2** | Add the second developer |
| 13 | **Pilot clinic recruitment** — 5 doctors and their receptionists (Annex 5 §2) | Phase 1 gate | Begin recruiting now |

### Assumptions made, stated explicitly (SoW §4.12)

1. English-only UI at launch; message templates translatable. Indic support is required in
   **PDF rendering** from day one, which is a different requirement.
2. Single AWS region (ap-south-1). No multi-region active-active.
3. Each clinic operates one WhatsApp number.
4. Peak load ≤ 100 clinics × 60 patients/day. Capacity assumptions in Annex 2 §4.
5. Browser support: current and previous major versions of Chrome, Edge and Safari;
   Firefox best-effort. **No Internet Explorer.**
6. Owner supplies cloud account ownership per SoW §16.
7. Billing-Lite means invoice + payment record only — no ledger, GST filing or TDS.

---

# O. Proposed changes

Each is a recommendation with justification and impact, per SoW §17.

### O1 — Add a DPDP compliance workstream as an explicit deliverable

**Why.** The SoW covers technical security thoroughly but treats DPDP as implied. DPDP
Rules 2025 impose organisational obligations — records of processing, a data protection
impact assessment, breach notification procedure, consent manager readiness — that are
not code. Health platforms are among the most likely to be designated Significant Data
Fiduciaries, and full compliance is due **14 May 2027**.

**Impact.** +1 week engineering (consent management surfaces, subject-access export) plus
external legal input the owner procures. **Recommend adding to Phase 5.**

### O2 — Add a second developer from Phase 2

**Why.** Solo delivery is ~41 weeks; two developers is ~24 weeks. Beyond schedule, it
removes the bus factor (R12) and provides code review, which is a stated §15 Definition
of Done requirement that is weak when self-administered.

**Impact.** +≈₹6,00,000. **Best value-per-rupee change in this plan.**

### O3 — Adopt UUIDv7 instead of UUIDv4 for primary keys

**Why.** Random v4 keys insert at random points in the B-tree, causing page splits and
write amplification on append-heavy tables (`observation`, `audit_event`). UUIDv7 is
time-ordered and remains a 128-bit UUID. PostgreSQL 18 ships `uuidv7()` natively.

**Impact.** One-line change, zero cost, measurable benefit within a year. Currently
implemented as v4 pending this decision.

### O4 — Move the Import wizard from Phase 4 to Phase 6, or price it separately

**Why.** SoW §7.1 already notes complex legacy migrations may be a paid service. Import
mapping is per-clinic bespoke work whose effort depends entirely on source data quality —
unknowable until a real file is seen. Fixed-pricing it invites either padding or disputes.

**Impact.** Removes ~₹1,20,000 of uncertainty from the Phase 4 fixed price; quoted per
clinic on sight of sample data. **The generic CSV/XLSX wizard stays in Phase 4.**

### O5 — Make the Phase 1 UAT a formal gate, not a review

**Why.** SoW §13 Phase 1's acceptance gate is "clinic users can complete scripted flows
without developer guidance". Annex 5 turns that into measurable criteria with a
documented go / rework / stop decision. Adoption (R6) is the highest-scoring risk and the
only one architecture cannot address.

**Impact.** No cost change; ~1 week of calendar time for sessions and analysis, already in
the Phase 1 estimate.

### O6 — Add Confirmed to the appointment status set

**Why.** SoW §6.3 lists *Scheduled, Confirmed, Checked-in, In Consultation, Completed,
Cancelled, No-show*. Our initial enum omitted Confirmed. **Corrected** — noted here so the
change is visible rather than silent.

**Impact.** None; corrected in Phase 0.

---

## Approval

Per SoW §21, this response is submitted for written owner approval. **No Phase 1 work will
begin until it is approved and questions 1–4 in §N are answered**, since each blocks a
module rather than merely informing it.

| Approval | Name / Signature | Date |
|---|---|---|
| Project Owner / Product Owner | | |
| Developer / Technical Partner | | |
| Scope revisions agreed (if any) | | |
