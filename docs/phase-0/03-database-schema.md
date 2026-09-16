# Database Schema & Entity Definitions

**Document:** Phase 0, Task 2
**Implementation:** [`packages/db/src/schema/`](../../packages/db/src/schema/) (Drizzle ORM) and [`packages/db/migrations/0001_roles_and_rls.sql`](../../packages/db/migrations/0001_roles_and_rls.sql)
**Target:** PostgreSQL 18
**Date:** 2026-09-15

This document explains the *design*; the schema files carry the authoritative
definitions and inline clinical/security annotations. Read them together.

---

## 1. Entity inventory and FHIR R4 mapping

All 15 core entities mandated by the SoW are present. Where one SoW concept maps
to more than one table, the split is noted and justified.

| # | SoW entity | Table(s) | FHIR R4 resource | Note |
|---|---|---|---|---|
| 1 | Clinic / Location | `clinic`, `clinic_location`, `service_item` | Organization, Location, HealthcareService | Location split so a growing practice can open a second site without migration; `service_item` carries the SoW §6.1 services/fees catalogue |
| 2 | User / Practitioner | `app_user` | Practitioner + PractitionerRole | Collapsed: one role per user per clinic keeps the RLS predicate simple |
| 3 | Patient | `patient` | Patient | Plus `patient_merge_log` for duplicate resolution |
| 4 | Appointment | `appointment` | Appointment | Also serves as the live queue — see §3.1. Status set matches SoW §6.3 exactly |
| 5 | Encounter | `encounter` | Encounter | Plus `encounter_internal_note` (physically isolated, §4.4) and `encounter_template` (SoW §6.5) |
| 6 | Observation (Vitals) | `observation` | Observation (vital-signs profile) | One row per measurement, LOINC-coded |
| 7 | Condition (Diagnoses) | `condition` | Condition | Coded **or** free text; uncoded must be permitted |
| 8 | AllergyIntolerance | `allergy_intolerance` | AllergyIntolerance | Safety-critical read path |
| 9 | MedicationRequest | `medication_request` | MedicationRequest | Plus `drug_catalogue_item` reference data and `prescription_template` (SoW §6.6) |
| 10 | DiagnosticReport / Document | `document_reference` | DocumentReference / DiagnosticReport | Metadata only; binaries in S3 |
| 11 | Communication | `communication` | Communication | Plus `whatsapp_account`, `whatsapp_conversation` (with Open/Waiting/Closed status and the unlinked queue per SoW §6.8), `webhook_event` |
| 12 | Task | `task` | Task | Terminates several safety mechanisms in a tracked human action |
| 13 | Consent | `consent` | Consent | One row per purpose — six categories per SoW §10, independently withdrawable |
| 14 | Invoice / Payment | `invoice`, `payment` | Invoice, PaymentReconciliation | Split for partial and mixed-tender payments |
| 15 | AuditEvent | `audit_event` | AuditEvent | Append-only, triple-enforced |

**Supporting tables** (not SoW-mandated, required by the architecture):
`refresh_session`, `share_link`, `import_job`, `export_job`.

**Total: 30 tables.**

### 1.1 Why not store FHIR resources directly

FHIR R4 is the ABDM *wire format*, not a storage model. Storing FHIR JSON
documents would make every clinically useful query — "all diabetic patients due
for follow-up", "this month's collections", "prescriptions containing this
molecule" — a JSON traversal instead of an indexed scan.

The schema is therefore normalised relational, with a mapping layer at the API
edge. Each table's header comment names its FHIR resource, and enum values
mirror the corresponding FHIR valueset by name, so ABDM M2/M3 work is
serialisation rather than migration.

---

## 2. Tenancy model

### 2.1 The rule

Every table carries `clinic_id UUID NOT NULL` with a foreign key to `clinic(id)`
and `ON DELETE RESTRICT`. The single exception is `clinic` itself, which *is*
the tenant and expresses its boundary on `id`.

`ON DELETE RESTRICT` rather than `CASCADE` throughout, deliberately: a
`DELETE FROM clinic` should fail loudly, not silently erase a clinic's entire
clinical history. Tenant offboarding is an explicit, audited, multi-step
procedure that begins with an export.

### 2.2 Four boundaries, not one

`clinic_id` on the table is necessary but not sufficient. The boundary is
re-asserted at every layer that could bypass the one below it:

| Layer | Mechanism | Failure mode if omitted |
|---|---|---|
| Database | Forced RLS keyed on `app.clinic_id` | A missing `WHERE` returns another clinic's rows |
| Connection | `emr_app` role is `NOBYPASSRLS`, no DDL | A compromised API disables policies |
| Cache | Redis keys prefixed `clinic:{id}:*` | A cache hit serves another clinic's data |
| Object storage | S3 keys prefixed `clinics/{clinic_id}/` | A leaked key is mutated into another tenant's path |
| Background jobs | `clinicId` in every payload, re-asserted against the loaded row | A replayed job mutates the wrong tenant |

### 2.3 The system tenant

Shared reference data (the drug catalogue) is owned by the reserved UUID
`00000000-0000-0000-0000-000000000000`. `sharedReferencePolicy()` lets every
clinic **read** those rows while restricting **writes** to their own
`clinic_id` — so a clinic may add a custom formulation but can never modify the
catalogue every other clinic prescribes from.

This satisfies the "`clinic_id` on every table" mandate without duplicating a
100,000-row drug catalogue per tenant.

---

## 3. Notable modelling decisions

### 3.1 The queue is not a table

Roughly 60–80% of patients at a 1–5 doctor Indian OPD are walk-ins who are
queued and never "booked". A separate `queue` table would create two sources of
truth for "who is waiting", which reliably diverges under concurrent front-desk
edits.

Instead a walk-in creates an `appointment` already in `ARRIVED` status, and the
queue is a query served by a partial index:

```sql
CREATE INDEX appointment_live_queue_idx
  ON appointment (clinic_id, queue_position, arrived_at)
  WHERE status IN ('ARRIVED','IN_PROGRESS');
```

The index stays at tens of rows no matter how many years of history accumulate.
`queue_position` uses sparse integers (10, 20, 30…) so a patient can be
re-prioritised without renumbering — the front desk reorders constantly.

### 3.2 Age as well as date of birth

`patient` carries both `date_of_birth` and the pair `age_years` +
`age_recorded_at`. Indian outpatient registration frequently captures a stated
age rather than an exact DOB. Storing a bare age would silently rot; storing the
age *and the date it was stated* lets current age be derived correctly, which
matters directly for paediatric dosing.

### 3.3 Coded *or* free text, never coded-only

`condition.display_text` is `NOT NULL` while `condition.code` is nullable. Doctors
in this segment will not code every diagnosis, and refusing to save an uncoded
one is the fastest available way to lose adoption (risk R6). The same principle
governs `medication_request.drug_display_name`, which allows prescribing
outside the catalogue.

### 3.4 Money in paise, as integers

Every monetary column is `bigint` in paise. Floating-point currency arithmetic
produces reconciliation errors that are tedious to locate and embarrassing to
explain to a clinic.

### 3.5 Corrections append; they never overwrite

Three entities are legally significant once finalised: `encounter`,
`medication_request`, `invoice`. For each, a correction creates a new row
referencing the original (`amends_encounter_id`, a new prescription, a credit
note). Database triggers reject in-place edits (migration §8), so this holds
even if application logic is refactored incorrectly.

`allergy_intolerance` follows the same principle via `refuted_at` — a disproved
allergy is marked, never deleted, because the fact that it was once recorded is
itself clinically relevant.

### 3.6 `created_by` is not a foreign key

`created_by` and `updated_by` are plain UUIDs, not FKs to `app_user`. A staff
account may be deleted or anonymised under a DPDP erasure request, and the
provenance of a clinical record must survive that. Actor identity at the time of
the action is preserved immutably in `audit_event`, where it is denormalised
rather than referenced.

---

## 4. Row-Level Security design

### 4.1 The predicate

```sql
clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid
```

Three properties, all deliberate:

- `'app.clinic_id'` is set per-transaction by `TenantDb.run()` using
  `set_config(..., true)`, so it cannot leak into the next request on a pooled
  connection.
- The `true` second argument to `current_setting` means "missing is OK" —
  returns NULL rather than raising.
- `nullif(..., '')` converts both the unset and empty cases to NULL. A NULL
  comparison matches **no rows**.

**This fails closed.** Absence of tenant context yields zero rows. There is no
code path in which a missing context returns everything — which is the failure
mode that turns a bug into a breach.

`WITH CHECK` mirrors `USING` on every policy. `USING` alone would permit
*writing* a row into another tenant while preventing reading it back.

### 4.2 FORCE, not merely ENABLE

`ENABLE ROW LEVEL SECURITY` does not apply to the table owner. Without `FORCE`,
anything connecting as `emr_migrator` — a migration, a maintenance script, a
misconfigured connection string — silently bypasses every policy.

Migration §5 applies `FORCE` to every table carrying a `clinic_id` column, using
a generated loop rather than a hand-maintained list, so a newly added table
cannot be forgotten. Migration §12 then re-runs the same query as an assertion
and **fails the migration** if any table is unprotected.

### 4.3 Four database roles

| Role | Privileges | Purpose |
|---|---|---|
| `emr_migrator` | Owner, DDL | Migrations only, from CI |
| `emr_app` | DML, `NOBYPASSRLS`, **no DDL** | The API |
| `emr_worker_messaging` | Narrow grants; **none** on `encounter_internal_note` | WhatsApp/SMS dispatch |
| `emr_readonly` | `SELECT`, still RLS-bound | Analytics, read replica |

Because `emr_app` cannot execute DDL, application code is structurally incapable
of running `ALTER TABLE ... DISABLE ROW LEVEL SECURITY`. A compromised API
process cannot switch the tenant boundary off.

### 4.4 Internal notes: the structural guarantee

The SoW requires that internal notes be *technically* incapable of external
dispatch. A boolean flag on a shared table does not achieve this — one defective
`WHERE is_internal = false` sends a doctor's private note to the patient.

The implementation:

- `encounter_internal_note` is a separate table
- `emr_worker_messaging` — the only role that can dispatch messages — holds
  **no privileges on it at all** (migration §7)
- an ESLint `no-restricted-imports` rule forbids the messaging module from
  importing the table
- the CI security suite asserts the privilege is absent on every build

The worker cannot read the rows, therefore it cannot send them. The guarantee is
structural, not procedural.

### 4.5 Audit immutability: three independent controls

| Control | Mechanism | Defeats |
|---|---|---|
| (a) | RLS policies permit only `SELECT` and `INSERT` | Application bug |
| (b) | `REVOKE UPDATE, DELETE, TRUNCATE` from `emr_app` | A policy misconfiguration |
| (c) | `BEFORE UPDATE OR DELETE` trigger raising unconditionally | A privilege-grant mistake |

Any one alone is defeatable. Together, no application-reachable path can alter
history.

---

## 5. Indexing strategy

Every index leads with `clinic_id`. This is not stylistic: the RLS predicate
filters on `clinic_id` on every query, so an index that does not lead with it
cannot serve the filter and the planner falls back to a scan that RLS then
discards. **An RLS-protected table with non-tenant-leading indexes performs
catastrophically**, and the symptom appears only once a second tenant exists.

### 5.1 Partial indexes for hot working sets

Clinical tables are append-heavy and grow indefinitely, while the queries that
matter touch a small active subset. Partial indexes keep those queries on
index sizes measured in kilobytes:

| Index | Predicate | Serves |
|---|---|---|
| `appointment_live_queue_idx` | `status IN ('ARRIVED','IN_PROGRESS')` | The queue screen, polled constantly |
| `encounter_clinic_open_idx` | `is_finalized = false AND status = 'IN_PROGRESS'` | "Resume draft" prompt |
| `allergy_clinic_patient_active_idx` | `refuted_at IS NULL` | Every prescribing safety check |
| `medication_request_clinic_active_idx` | `status = 'ACTIVE'` | "Currently taking" on the Snapshot |
| `communication_undelivered_idx` | `status IN ('QUEUED','SENT') AND direction='OUTBOUND'` | Delivery reconciliation sweep (R2) |
| `task_clinic_open_idx` | `status IN ('REQUESTED','ACCEPTED','IN_PROGRESS')` | The worklist |
| `invoice_clinic_unpaid_idx` | `status='ISSUED' AND paid_paise < total_paise` | Outstanding dues report |

### 5.2 Trigram indexes for fuzzy search

`patient.name_normalized` and `drug_catalogue_item.search_normalized` carry GIN
trigram indexes. Normalisation (lowercase, unaccent, whitespace collapse) is
performed by a **database trigger**, not application code, so rows written by
imports and background jobs normalise identically to rows written through the
API — otherwise duplicate detection silently degrades exactly where data quality
is already weakest.

### 5.3 Performance targets

| Query | Target | Basis |
|---|---|---|
| Patient search by mobile | < 50 ms | Front desk must complete registration in < 60 s |
| Patient fuzzy name search | < 200 ms | Typed interactively |
| Drug catalogue search | < 200 ms | Typed interactively during prescribing |
| Patient Snapshot (full load) | < 1 s | Below this, doctors stop opening it |
| Live queue refresh | < 100 ms | Polled every few seconds |

---

## 6. Data retention

> ### ⚠️ These periods are a PROPOSAL, not an assertion
>
> **SoW §10 states: *"developer must not invent legal retention periods."*** We are
> complying with that instruction. The table below is a starting point for the owner's
> legal advisor to confirm, amend or replace. **No period below is implemented as a
> default**, and no lifecycle deletion job runs, until the owner supplies an approved
> retention policy (Developer Response §N Q3).
>
> Retention is **configurable per data class** precisely so this stays a setting rather
> than a code change — which makes complying with the eventual policy a configuration
> task, not a migration.

The tension a policy has to resolve: DPDP Rules 2025 require storage limitation
(personal data must not outlive its purpose), while clinical and NMC obligations require
retention. These pull in opposite directions, and choosing between them is a legal
judgement rather than an engineering one.

| Data class | **Proposed** | Considerations for the owner's advisor |
|---|---|---|
| Clinical records (encounter, prescription, observation, condition, allergy) | Indefinite while clinic active | NMC digital record retention (≥ 3 years); continuity of care; limitation periods for clinical negligence claims |
| `audit_event` | 7 years | Regulatory investigation window; DPDP breach-investigation needs |
| `webhook_event` raw payloads | 90 days | Contains patient message content; the debugging purpose expires quickly |
| Unlinked WhatsApp conversations | 30 days unless linked | Health information about someone **not yet a patient of record** — the weakest lawful-basis position in the system |
| `refresh_session` | Expiry + 30 days | Anomalous-login forensics |
| `export_job` bundles | 7 days | PHI must not accumulate in object storage |
| `share_link` rows | Expiry + 90 days | Access history is itself auditable |
| `consent` | **Never deleted** | Proving consent *was* held at the time of past processing is the record's entire purpose. This one we are confident of |

### 6.1 Clinic offboarding

Not specified in the SoW, and required under DPDP. Proposed sequence — **also requires
owner policy approval**:

```
export generated + verified  →  owner confirms receipt  →  30-day read-only grace
   →  verified deletion (rows, S3 objects, backups past cycle)
   →  deletion certificate issued
```

`ON DELETE RESTRICT` throughout the schema means this cannot happen by accident: a
casual `DELETE FROM clinic` fails loudly rather than silently erasing a clinic's history.

---

## 7. Deviations and items for ratification

### 7.1 UUIDv4 vs UUIDv7 — recommended deviation

The SoW mandates UUIDv4, and the schema complies via `gen_random_uuid()`.

**We recommend UUIDv7 instead.** Random v4 keys insert at random points in the
B-tree, causing page splits, index bloat and write amplification. On
append-heavy tables — `observation`, `audit_event`, `communication` — this is
measurable within a year. UUIDv7 is time-ordered, so inserts append to the right
edge of the index, and it remains a 128-bit UUID with no type change.
PostgreSQL 18 ships `uuidv7()` natively.

The change is one line in `primaryKeyColumn()`. **Client decision required** —
we have implemented the mandated v4 pending that decision.

### 7.2 One user row per clinic

A doctor practising at two clinics has two `app_user` rows. Cross-clinic user
identity would require a user→clinic join table and a materially more complex
RLS predicate. At 1–5 doctor scale the duplication is cheap and the security
simplification is valuable. **Revisit if the product targets multi-site groups.**

### 7.3 `is_finalized` is not on every table

The SoW lists `is_finalized` among the audit fields required on every table. It
is implemented on the three entities where finalisation is meaningful —
`encounter`, `invoice`, and (derived from the parent encounter)
`medication_request`. A `is_finalized` column on `audit_event` or
`clinic_location` would be dead weight that implies a lifecycle those entities
do not have. `created_at`, `created_by`, `updated_at`, `updated_by` and
`version` are present on every table as mandated.

### 7.4 Dependencies on open questions

| Open question (`01 §6`) | Schema impact if the answer changes |
|---|---|
| Prescription signing tier | `document_reference.signature_value` widens to hold a PKCS#7 blob; adds `signature_algorithm`, `certificate_serial` |
| Drug catalogue source | `drug_catalogue_item` gains interaction and contraindication child tables |
| ABDM scope in Phase 1 | `patient.abha_number`, `clinic.abdm_hfr_id`, `app_user.abdm_hpr_id` are already present; M2 adds a care-context linkage table |

---

## 8. Verification

Migration §12 runs immediately after the table migrations and **fails the build**
if any table carrying `clinic_id` lacks forced RLS or a policy:

```sql
SELECT c.relname FROM pg_class c
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'clinic_id'
WHERE c.relkind = 'r'
  AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
       OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid));
-- must return zero rows
```

The runtime counterpart — the adversarial tenancy test suite that replays every
endpoint across tenant boundaries — is specified in
[04 §7](./04-api-security-spec.md).
