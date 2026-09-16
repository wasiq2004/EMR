# Annex 7 — Prescription & Drug Data Approach

**Responds to:** SoW §4.7, §6.6, §19 H
**Date:** 2026-09-15

---

## 1. The decision, stated plainly

**This is a procurement decision, not an engineering one, and it blocks the Prescription
module.**

Drug search with interaction and contraindication warnings requires a licensed, actively
maintained Indian drug database. No free, comprehensive, reliable source exists, and the
consequences of pretending otherwise are clinical rather than commercial.

### 1.1 The failure mode that matters

The dangerous outcome is not "we have no interaction data". It is **shipping an
incomplete catalogue while the interface implies interactions are being checked.**

A doctor who knows the system does not check interactions applies their own judgement. A
doctor who believes it checks, and receives no warning, reasonably concludes there is no
interaction. **The second doctor is in a worse position than the first**, and the product
created that position.

This drives a hard design rule:

> **If interaction checking is not licensed, the interaction UI is absent entirely — not
> present and empty, not greyed out, not "coming soon".** Absence of a feature is
> honest; a non-functioning safety feature is not.

---

## 2. Options

| Option | Cost (indicative) | Capability | Verdict |
|---|---|---|---|
| **A — Licensed Indian formulary** | ₹1,00,000–4,00,000 / year | Brands, molecules, strengths, forms, interactions, contraindications, paediatric dosing, regular updates | **Required before any interaction-checking claim** |
| **B — Curated pilot subset** (~2,000 molecules) | Build cost only (~1 week) | Search, allergy cross-check, free text. **No interaction engine** | **Acceptable for pilot** |
| **C — Free / scraped sources** | — | Incomplete, unmaintained, licence-ambiguous | **Not recommended** |
| **D — Third-party API** | Per-call | Outsources data currency; adds latency and an external dependency on the prescribing hot path | Not recommended for MVP |

### 2.1 Recommendation

**Ship Option B for the pilot; move to Option A before advertising interaction checking
or onboarding beyond the pilot.**

Rationale: allergy cross-checking — the single highest-value safety check in outpatient
practice — is derived from the clinic's **own** `allergy_intolerance` records and
requires no licence at all. That gets most of the clinical safety benefit for none of the
procurement delay.

Option C is rejected not on cost but on liability: an unmaintained catalogue silently
decays, and a discontinued or reformulated drug appearing as current is a patient-safety
defect with the vendor's name on it.

---

## 3. Data model

**Implementation:** `drug_catalogue_item` in [`packages/db/src/schema/clinical.ts`](../../packages/db/src/schema/clinical.ts)

### 3.1 Shared vs clinic-owned rows

The SoW mandates `clinic_id` on every table, but a 100,000-row catalogue must not be
duplicated per tenant. Resolved with a reserved system tenant:

```
drug_catalogue_item
  ├── clinic_id = SYSTEM_CLINIC_ID  → shared catalogue, readable by all, writable by none
  └── clinic_id = <real clinic>     → that clinic's custom formulations, private to it
```

The RLS policy widens **reads** to include the system tenant while restricting **writes**
to the clinic's own rows. A clinic can add a compounded preparation; it can never modify
the catalogue every other clinic prescribes from.

### 3.2 Fields

| Field | Purpose |
|---|---|
| `brand_name`, `molecule_name` | Both searchable — Indian doctors use both interchangeably |
| `search_normalized` | Trigram-indexed, normalised by **database trigger** so imports and API writes normalise identically |
| `strength`, `dosage_form`, `route` | Printed on the prescription |
| `drug_schedule` | H / H1 / X — **Schedule X may not be prescribed via telemedicine** |
| `is_narcotic` | Additional confirmation step |
| `catalogue_version` | Stamped onto every prescription for traceability |

---

## 4. Search behaviour

**Target: p95 < 300 ms**, because it runs while the doctor is typing.

```
Doctor types "amox"
  │
  ├─▶ trigram match on search_normalized (GIN index)
  │     covers brand AND molecule in one index
  │
  ├─▶ rank: clinic favourites → exact prefix → trigram similarity
  │
  └─▶ results show: brand · molecule · strength · form
      with an allergy flag rendered inline where the molecule matches
      a recorded allergy for THIS patient
```

**Clinic favourites are ranked first** and learned from prescribing history. A GP
prescribes from perhaps 150 drugs; surfacing those first is the difference between
20 seconds and 5 seconds per line item, which compounds across a 40-patient day.

---

## 5. Safety warnings (SoW §6.6)

### 5.1 What is checked, per option

| Check | Option B (pilot) | Option A (licensed) |
|---|---|---|
| **Allergy cross-check** — prescribed molecule vs recorded allergies | ✅ | ✅ |
| Allergy class cross-check (e.g. all penicillins) | Partial — curated class map | ✅ |
| Duplicate therapy (same molecule twice) | ✅ | ✅ |
| Drug–drug interaction | **❌ UI absent** | ✅ |
| Contraindication vs recorded condition | **❌ UI absent** | ✅ |
| Paediatric weight-based dosing | **❌ UI absent** | ✅ |
| Pregnancy category | **❌ UI absent** | ✅ |
| Schedule X telemedicine restriction | ✅ | ✅ |

### 5.2 Warning behaviour

SoW §6.6: *"any automated warning is advisory and must not prescribe autonomously."*

**Our reading:** "advisory" means the system must not alter or refuse the prescription on
its own — the clinician decides. It does not mean the warning must be easy to miss.

**Proposed** (confirmation requested, §N Q11):

| Severity | Presentation | Override |
|---|---|---|
| HIGH-criticality allergy match | **Modal, requires acknowledgement** | Typed reason, persisted |
| Class-level allergy match | Modal, requires acknowledgement | Typed reason, persisted |
| Duplicate therapy | Inline banner | Single dismiss |
| Schedule X via telemedicine | **Modal, blocks** — this is a legal restriction, not clinical judgement | None |

**The system never changes a prescription by itself.** It warns, records what it warned
about, records the clinician's response, and proceeds as instructed.

### 5.3 Evidence trail

`medication_request.safety_warnings_shown` (JSONB) persists every warning displayed, and
`safety_override_reason` persists the clinician's stated reason.

This serves both parties: it is the clinic's evidence of safe practice, and the product's
evidence of having warned. Without it, a later clinical review cannot establish what the
system said at the moment of prescribing.

---

## 6. Free-text prescribing (SoW §6.6)

**Mandatory in every option.** `medication_request.drug_display_name` is `NOT NULL` while
`catalogue_item_id` is nullable.

A doctor must always be able to prescribe something outside the catalogue — a compounded
preparation, an imported drug, a newly launched brand. Refusing to save an uncatalogued
prescription is the fastest available route to abandonment (risk R6).

**Consequence, stated honestly:** allergy cross-checking on free-text entries degrades to
string matching, which is weaker than molecule-id matching. The UI indicates when a drug
is uncatalogued so the clinician knows which checks apply.

---

## 7. Dosage conventions

Indian outpatient practice has its own shorthand, and the product should speak it.

| Clinician input | Stored | Patient-facing output |
|---|---|---|
| `1-0-1` | `frequency = "1-0-1"` | "1 tablet in the morning and 1 at night" |
| `1-1-1` | `frequency = "1-1-1"` | "1 tablet three times a day" |
| `0-0-1` | `frequency = "0-0-1"` | "1 tablet at night" |
| `SOS` | `frequency = "SOS"` | "Take only when needed" |
| `BD`, `TDS`, `QID` | Normalised to the numeric pattern | Expanded to plain language |

Per SoW §6.6: shorthand in the clinician UI, **patient-friendly instructions on output**.
Translation happens at PDF render, not at entry, so the clinician's speed is never traded
against the patient's comprehension.

---

## 8. Prescription templates (SoW §6.6)

`prescription_template` stores reusable medicine combinations per doctor or clinic — "URI
adult standard", "paediatric fever ≤ 20 kg".

Applying a template creates **editable draft line items**, never a finalised
prescription. Per SoW §6.4, clinical facts are not carried forward as current without
user action; the same principle applies to templated prescribing.

---

## 9. Migration path from Option B to Option A

Designed so the switch is data, not a rebuild:

1. `drug_catalogue_item` rows are versioned and sourced — the pilot subset carries
   `catalogue_version = 'pilot-v1'`
2. Licensed data loads as a new version under the system tenant
3. Existing `medication_request` rows retain `catalogue_version_at_prescribing`, so
   history stays interpretable
4. Interaction and contraindication tables are **additive child tables** — no change to
   `medication_request`
5. The interaction UI is behind a feature flag keyed on catalogue capability, so it
   appears when, and only when, the data behind it exists

**Estimated switch effort: 1–2 weeks**, mostly data mapping and the interaction UI.

---

## 10. Owner decision required

Per SoW §18, the drug catalogue / licensing decision is an owner input. It is needed
**before Phase 2 week 11**.

| If the answer is | Then |
|---|---|
| **License now** | Provide vendor and licence terms; +1–2 weeks to Phase 2; full safety feature set at launch |
| **Pilot subset** | Phase 2 proceeds as quoted; **interaction UI absent**; product materials must not claim interaction checking |
| **Undecided at week 11** | Default to pilot subset to protect the schedule, and treat the licensed upgrade as a Phase 7 change request |
