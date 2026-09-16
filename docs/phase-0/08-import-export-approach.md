# Annex 8 — Import & Export Approach

**Responds to:** SoW §4.8, §7.1, §7.2, §19 I
**Date:** 2026-09-15

---

## 1. Principle

SoW §2 makes migration in and out a **first-class capability**, and §7.2 requires the
owner to obtain a broad export **without engineering intervention**. That is a
zero-lock-in commitment, and it is also a sales asset: a clinic that knows it can leave
is far more willing to arrive.

Two rules follow, and everything below derives from them:

1. **Export is self-service.** No ticket, no developer, no delay.
2. **Import never partially commits.** A half-imported registry is worse than none,
   because staff cannot tell which records are trustworthy.

---

## 2. Import wizard (SoW §7.1)

### 2.1 Supported formats

| Format | Phase 4 | Notes |
|---|---|---|
| CSV (UTF-8, UTF-16, Windows-1252) | ✅ | Encoding auto-detected — legacy Indian EMR exports are frequently not UTF-8 |
| XLSX | ✅ | First sheet by default; sheet selectable |
| XLS (legacy) | ✅ | Converted on upload |
| JSON | Adapter interface ready | Not built in MVP |
| Direct database migration | Adapter interface ready | Paid service per SoW §7.1 |

### 2.2 Workflow — exactly as mandated by §7.1

```
UPLOAD ──▶ MAP COLUMNS ──▶ VALIDATE ──▶ DUPLICATE REVIEW ──▶ PREVIEW ──▶ IMPORT ──▶ RECONCILE
```

| Stage | Behaviour |
|---|---|
| **Upload** | File to S3 under `clinics/{id}/imports/`. Row count and encoding detected. Max 50,000 rows per job |
| **Map columns** | Source headers auto-matched to target fields by name similarity; every mapping is user-confirmable. Mapping saved for reuse on the next file |
| **Validate** | Every row checked against the Zod contract. **Nothing is committed at this stage** |
| **Duplicate review** | Candidates surfaced against the live registry *and* against other rows in the same file |
| **Preview** | First 50 rows shown exactly as they will be created |
| **Import** | Single transaction per batch. Either the batch commits or none of it does |
| **Reconcile** | Downloadable report: input, imported, skipped, duplicates, failed — with a reason per row |

### 2.3 Validation — no silent drops

SoW §7.1: *"Do not drop invalid rows silently. Show row-level errors and reason."*

Every rejected row produces a structured error:

```json
{
  "rowNumber": 147,
  "sourceData": { "name": "Ramesh Kumar", "mobile": "987654321", "dob": "32/13/1985" },
  "errors": [
    { "field": "mobile", "code": "INVALID_LENGTH",
      "message": "Mobile must be 10 digits after the country code. Found 9." },
    { "field": "dob", "code": "INVALID_DATE",
      "message": "Not a valid date. Expected DD/MM/YYYY or YYYY-MM-DD." }
  ]
}
```

Written to `import_job.error_report_object_key` as a CSV the clinic can correct and
re-upload. The error file preserves the original row so the clinic edits their own data,
not ours.

### 2.4 Duplicate handling during import

Reuses the **live registry logic** — E.164 normalisation plus trigram name matching — so
import-time and front-desk behaviour cannot diverge. A duplicate rule that exists in two
places will eventually disagree with itself.

| Situation | Default | Overridable |
|---|---|---|
| Exact mobile + exact name match | Skip, report as duplicate | ✅ |
| Exact mobile, different name | Import (family sharing a number is routine) | ✅ |
| Fuzzy name ≥ 0.85, same DOB | Flag for review, do not import | ✅ |
| Duplicate **within the same file** | Flag both, import neither | ✅ |

**Nothing is auto-merged during import.** An incorrect merge is harder to unwind than a
duplicate.

### 2.5 Field mapping — patient import

| Target | Required | Accepted source variations |
|---|---|---|
| `full_name` | ✅ | name, patient_name, pname, Name |
| `mobile_e164` | — | mobile, phone, contact, mobile_no, cell |
| `date_of_birth` | — | dob, birth_date, DOB · DD/MM/YYYY, YYYY-MM-DD, DD-MM-YY |
| `age_years` | — | age · used when DOB absent; `age_recorded_at` set to import date |
| `gender` | — | sex, gender · M/F/O, Male/Female, 1/2 |
| `mrn` | — | patient_id, reg_no, uhid · preserved if present, generated if not |
| `address_line1`, `city`, `state`, `pincode` | — | Single-field addresses parsed best-effort |
| `abha_number` | — | abha, health_id |

**Unmapped source columns are preserved** in `patient.metadata` rather than discarded.
A clinic's legacy system often holds a column we did not anticipate but they rely on.

### 2.6 What is not in MVP

Encounter, prescription and document import. `import_job.entity_type` supports them and
the adapter interface is built, but per SoW §7.1 complex legacy migrations are a paid
service, quoted on sight of the source data. **Patient registry import is the MVP scope**
— it is what unblocks a clinic's first day.

---

## 3. Export package (SoW §7.2)

### 3.1 Complete manifest

| File | Content | Row scope |
|---|---|---|
| `patients.csv` | Demographics, identifiers, status, ABHA | All, including merged (with merge pointer) |
| `appointments.csv` | Appointment history and statuses | All |
| `encounters.csv` | Encounter header, clinical notes, finalisation state | All |
| `observations.csv` | Vitals and measurements with units and timestamps | All |
| `diagnoses_conditions.csv` | Problems and diagnoses, coded and free text | All |
| `allergies.csv` | Allergies and intolerances with criticality and reaction | All |
| `prescriptions.csv` | Prescription headers plus medicine line items | All |
| `documents.csv` | Document metadata with a path into `/documents` | All |
| `/documents/` | **Original uploaded files**, foldered by patient | All |
| `communications.csv` | Communication metadata and content per retention policy | Per approved policy |
| `billing.csv` | Invoices and payments | All |
| `audit_metadata.csv` | Event log: actor, action, resource, timestamp | Security internals excluded |
| `manifest.json` | Row counts per file, SHA-256 per file, schema version, generation timestamp | — |
| `README.txt` | Plain-language description of every file and column | — |

`manifest.json` and `README.txt` are additions beyond the SoW. The manifest lets the
receiving system verify nothing was truncated in transfer; the README means a clinic's
next vendor can interpret the package without contacting us, which is what zero lock-in
actually requires.

### 3.2 Prescription line-item structure (SoW §7.2)

§7.2 asks for "medicine line items in a documented structure". Denormalised one row per
line item — a nested structure inside a CSV cell is technically compact and practically
useless to whoever receives it:

```csv
prescription_id,encounter_id,patient_mrn,prescribed_date,practitioner_name,
practitioner_reg_no,line_no,drug_name,molecule,strength,dosage_form,route,
frequency,food_relation,duration_days,quantity,instructions,status
```

### 3.3 Generation

```
Owner requests export
  │
  ├─▶ export_job row created; audit_event written
  │     (a full clinical export is precisely what a departing employee would do —
  │      it must be visible)
  │
  ├─▶ export.build queue
  │     ├── COPY (SELECT …) TO STDOUT WITH CSV HEADER   ← streamed, never buffered
  │     ├── stream each file directly into a zip on S3
  │     ├── copy document binaries into /documents/
  │     └── compute SHA-256 per file → manifest.json
  │
  ├─▶ presigned download URL, 7-day expiry
  │
  └─▶ S3 lifecycle deletes the bundle after 7 days
        (PHI must not accumulate in object storage)
```

**Streaming matters.** A clinic with 100,000 encounters must export without an
out-of-memory failure. `COPY … TO STDOUT` streams from Postgres straight into the zip.

**RLS applies to the export.** The `COPY` statements run inside `TenantDb.run()`, so the
tenant boundary holds even here — an export cannot leak another clinic's rows.

### 3.4 Timing

| Clinic size | Expected |
|---|---|
| 5,000 patients / 20,000 encounters | < 2 min |
| 50,000 patients / 200,000 encounters | < 15 min |
| Plus documents | ~1 min per GB |

Asynchronous with progress reporting; the owner is notified when ready.

---

## 4. FHIR / JSON export — roadmap (SoW §7.2)

> *"Design interfaces/schema so standards-based export can be added without rebuilding
> the database."*

This requirement is satisfied by the schema design rather than by deferred work:

| Requirement | How it is already met |
|---|---|
| Entities map to FHIR resources | Every table's header comment names its FHIR R4 resource |
| Enums map to FHIR valuesets | Enum values mirror FHIR valueset codes **by name**, not by lookup table |
| Coded data is preserved | `code` + `code_system` columns on `observation`, `condition`, `allergy_intolerance` |
| Identifiers survive | `abha_number`, `abdm_hfr_id`, `abdm_hpr_id` present from day one |
| Provenance exists | `audit_event` supports FHIR Provenance and AuditEvent |

**Adding FHIR export is a serialisation layer, not a migration.** Estimated 2–3 weeks when
required — most of it ABDM profile conformance rather than data access.

---

## 5. Data lifecycle

⚠️ **SoW §10: *"developer must not invent legal retention periods."***

The table below is a **proposal requiring owner legal approval**, not an assertion.
Nothing here is implemented as a default until the owner supplies an approved policy.
Retention is configurable per data class precisely so that this is a setting, not a code
change.

| Data class | Proposed | Basis — for the owner's advisor to confirm |
|---|---|---|
| Clinical records | Indefinite while clinic active | NMC digital record retention (≥ 3 years); continuity of care |
| `audit_event` | 7 years | Regulatory investigation window |
| `webhook_event` raw payloads | 90 days | Contains patient message content; debugging purpose expires |
| Unlinked WhatsApp conversations | 30 days unless linked | Weakest lawful basis in the system (§B7) |
| `refresh_session` | Expiry + 30 days | Anomalous-login forensics |
| Export bundles | 7 days | PHI must not accumulate in object storage |
| `share_link` rows | Expiry + 90 days | Access history is itself auditable |
| `consent` | **Never deleted** | Proving consent was held at the time of past processing is the record's purpose |

---

## 6. Clinic offboarding (scope gap §B1)

Not specified in the SoW, and required under DPDP. Proposed sequence:

```
1. Owner requests offboarding
2. Full export generated, verified against manifest checksums, delivered
3. Owner confirms receipt in writing
4. 30-day grace period — account read-only, no new data accepted
5. Verified deletion: database rows, S3 objects, backups past their cycle
6. Deletion certificate issued, listing what was deleted and when
7. audit_event and the certificate retained per the approved policy
```

`ON DELETE RESTRICT` throughout the schema means this cannot happen by accident — a
casual `DELETE FROM clinic` fails loudly. **Needs owner policy approval** (§N Q7).
