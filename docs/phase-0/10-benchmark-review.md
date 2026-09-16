# Annex 10 — Benchmark Product Review

**Responds to:** SoW §3 (reference products to benchmark), §20
**Method:** desk review of public materials, vendor documentation and independent reviews
**Date:** 2026-09-15

---

## 0. Scope and honesty about its limits

SoW §3 asks for a review of three products *"for workflow understanding only"* — concepts,
friction points and feature depth, not visual design or proprietary implementation.

**This is a desk review.** It is based on public vendor materials, pricing pages and
independent review sites. It is genuinely useful for positioning and for spotting friction
patterns, but it is **not a substitute for hands-on trials**, and two findings below are
explicitly marked as unverified.

**Recommendation:** take a paid one-month trial of Practo Ray during Phase 1 (≈₹2,000–4,000)
and run the [Annex 5](./05-prototype-verification-script.md) script against it with one
pilot doctor. A competitor benchmark on the same measures as our own prototype is worth far
more than any amount of reading.

---

## 1. Practo Ray

**Studied for:** clinic workflow, appointments, patient history, prescriptions, record
sharing, migration/export behaviour.

### 1.1 What it is

The dominant incumbent in the Indian clinic software market. Practice management plus
EMR — appointments, scheduling, patient intake, patient portal, e-prescribing, billing —
serving clinics across India and several other markets. Offers in-person training, live
online sessions and documentation.

### 1.2 The commercially significant finding

**Practo Ray charges a per-booking marketplace fee on top of the subscription.**

Reported subscription is roughly ₹1,000–₹4,000/month, but appointments arriving through
the Practo patient-discovery marketplace incur a separate per-booking fee. For a clinic
seeing 30–50 patients a day, that reportedly adds **₹1,500–₹3,000/month** — potentially
doubling the effective cost.

**Why this matters to our positioning.** It is the sharpest available differentiator, and
it is structural rather than a feature gap:

| | Practo Ray | This product |
|---|---|---|
| Subscription | ₹1,000–4,000/mo | ₹3,000/mo (target) |
| Marketplace / per-booking fee | **Yes** | **None** |
| Patient acquisition model | Clinic is a supplier to Practo's marketplace | Clinic owns its patient relationship |
| Data export | Available; ease reported inconsistently | **First-class, self-service, 12-file package** |

The marketplace model creates a real tension: the vendor's growth depends on routing
patients through its own network, which is not always aligned with a clinic building its
own repeat base. A clinic that has felt that tension is our most persuadable prospect.

### 1.3 Workflow concepts worth adopting

| Concept | Adopt? | Note |
|---|---|---|
| Combined practice management + EMR | ✅ Already core | Confirms the SoW's "not a bare prescription tool" principle |
| Patient portal | ❌ Not MVP | SoW §12 excludes it; our equivalent is the WhatsApp channel plus share links |
| In-person onboarding and training | ✅ **Adopt** | Strongly signals that small Indian clinics do not self-onboard. Budget for it (Phase 6) |
| Multi-specialty template support | ✅ Already planned | `encounter_template` |
| Marketplace integration | ❌ **Deliberately reject** | See §1.2 |

### 1.4 Friction points to design against

- **Effective price is not the sticker price.** Our pricing must be predictable, which
  argues for the metered-WhatsApp-with-allowance model in [Annex 6 §8.3](./06-whatsapp-approach.md) rather than
  variable pass-through billing.
- **Breadth across many markets implies configuration depth.** A 1–5 doctor Indian OPD
  does not want to configure a system built to also serve Brazil. **Our advantage is a
  deliberately narrower default** — opinionated setup, minimal configuration, usable on
  day one.

---

## 2. DocPulse

**Studied for:** structured clinical records, appointment/patient engagement, reminders,
modular expansion.

### 2.1 What it is

Cloud HMS spanning solo doctors through multi-specialty centres, hospitals and clinic
chains, across India, the Middle East and Africa. Telemedicine, prescription and billing
management, integrated EMR/EHR, and department coordination. Pricing on request, free
trial available.

### 2.2 The structural finding

**DocPulse scales upward into hospital territory; we deliberately do not.**

Its positioning spans solo practice to hospital chains, which means the product carries
departments, inter-departmental coordination and hospital-grade modules. That breadth is
a genuine strength for a growing group — and a cost for a two-doctor clinic that must
navigate around concepts it will never use.

This validates the SoW §12 out-of-scope list. **Resisting the pull toward IPD, wards and
full LIS is the product decision**, and the temptation will arrive from the first
ambitious pilot clinic rather than from the roadmap.

### 2.3 Concepts worth adopting

| Concept | Adopt? | Note |
|---|---|---|
| Modular expansion | ✅ Already the architecture | Nest modules; add without re-platforming |
| Telemedicine | ❌ Not MVP | SoW §12. Note the NMC constraint: **Schedule X cannot be prescribed via telemedicine** — already in the schema |
| Reminders and engagement | ✅ Already core | Ours is WhatsApp-first rather than multi-channel-generic |
| Pricing on request | ❌ **Reject** | Opaque pricing is friction for a 2-doctor clinic. **Publish the price** |

### 2.4 Where we should be better

**Onboarding time.** A product serving hospital chains cannot make solo-clinic setup
trivial — the configuration surface exists whether or not a small clinic needs it.

Our SoW §6.1 acceptance criterion is *"a new clinic can be configured without
engineering/database changes and can create its first patient and appointment."* We
should hold ourselves to something sharper: **a solo GP is seeing patients within 30
minutes of signup, unassisted.** That is a measurable, defensible claim and it is the
kind of thing a broad-market product structurally cannot match.

---

## 3. UniteEMR

**Studied for:** EMR structure, specialty workflows, integrations, communication concepts.
SoW §3 describes it as *"useful as a future regional benchmark."*

### 3.1 Finding: insufficient public information

⚠️ **Public material on UniteEMR is thin**, and it did not appear in independent Indian
EMR comparison coverage during this review. No substantive feature or pricing detail
could be verified.

**I am not going to characterise a product I could not verify.** Fabricated competitor
analysis in a client deliverable is worse than an acknowledged gap.

### 3.2 What the SoW's framing tells us anyway

The description *"future regional benchmark"* suggests the owner sees a UAE or wider
regional expansion path — consistent with SoW §12 excluding **NABIDH/eClaims/eRx from the
India MVP**, which implies they are a later possibility rather than a permanent exclusion.

**Architectural consequence, already handled:** the integration adapter layer (SoW §8)
means a future regional regulatory integration is a new adapter, not a re-platform —
exactly as ABDM is treated. No MVP work is needed now, but the seam exists.

### 3.3 Action

If regional expansion is a genuine roadmap item, the owner should supply access or a
contact. **Otherwise recommend deprioritising it** — it is the least informative of the
three benchmarks for MVP decisions.

---

## 4. Synthesis — where this product should win

Reviewing all three together, the incumbents are mature and feature-rich. **Competing on
feature count is unwinnable and, per SoW §20, explicitly not the objective.**

Four defensible positions emerge, each traceable to an architectural decision already made:

### 4.1 Predictable, all-in pricing

No marketplace fees, no per-booking charges, no pricing-on-request. One subscription plus
a metered WhatsApp allowance shown in the console. **Enabled by** the self-hosted stack
that avoids per-seat SaaS dependencies ([Annex 1 §2.4](./01-tech-stack-decision.md)).

### 4.2 Genuine zero lock-in

Self-service, one-click, 12-file export **with the original document files and a checksum
manifest** — plus a README so the next vendor can read it. Most competitors offer export;
few make it a selling point, and fewer make it trivial. **Enabled by** [Annex 8 §3](./08-import-export-approach.md).

### 4.3 Deliberate narrowness

Built for 1–5 doctor outpatient clinics and nothing else. No wards, no departments, no
multi-country configuration surface. **Target: patients being seen within 30 minutes of
signup.** This is a positioning choice enforced by the SoW §12 scope discipline.

### 4.4 Compliance as a feature, not a footnote

India-only data residency by default, DPDP-ready consent architecture, forced RLS tenant
isolation, immutable audit. As DPDP enforcement approaches its **14 May 2027** deadline,
this shifts from invisible to a procurement checkbox — and retrofitting it later is a
migration nobody wants.

---

## 5. What must not be copied

Per SoW §3 — benchmark the **concepts**, not the implementation.

| Prohibited | Why |
|---|---|
| Visual design, layout, colour, iconography | Copyright; also, imitation forfeits the differentiation above |
| Proprietary code or assets | Copyright |
| Drug catalogue data | Licensed data. **This is the specific risk** — a scraped competitor catalogue is both a licence breach and the unmaintained-data liability in [Annex 7 §2](./07-drug-data-approach.md) |
| Clinical content, templates, protocols | Likely licensed or clinically reviewed by a third party |
| Screenshots in marketing material | Trademark and copyright |

**What may be studied:** workflow order, field placement rationale, where users get stuck,
which features are foregrounded, onboarding sequence, pricing structure — ideas and
patterns, not expression.

---

## 6. Recommended follow-up during Phase 1

| Action | Cost | Value |
|---|---|---|
| **One-month Practo Ray trial; run the Annex 5 script against it** | ₹2,000–4,000 | Benchmark on identical measures — the single most useful competitive input available |
| DocPulse demo (free trial available) | Free | Verify the onboarding-complexity hypothesis in §2.4 |
| Ask each pilot doctor what they use now and what they abandoned | Free | **Highest-value input in this annex.** Abandonment reasons are more informative than feature lists |
| Obtain UniteEMR access, or deprioritise | — | Currently unverifiable |

Question 3 is already built into the Annex 5 opening script: *"How do you register and
record patients today, and what is the single most irritating part of that?"*

---

## Sources

- [Practo Ray — Capterra product listing and pricing](https://www.capterra.com/p/167778/Ray/)
- [Practo Ray pricing and per-booking fees analysis](https://www.cufront.com/blog/practo-ray-pricing-india-worth-it-2026)
- [Practo Ray reviews — SourceForge](https://sourceforge.net/software/product/Practo-Ray/)
- [Best clinic management software in India 2026 — comparison](https://ring2doc.com/blog/best-clinic-management-software-india-2026)
- [DocPulse — clinic management software](https://docpulse.com/solutions/clinic-management-software-system/)
- [DocPulse — EMR for hospitals, India 2026](https://docpulse.com/blog/best-emr-software-for-hospitals-in-india-2026-guide-for-doctors-clinic-owners/)
- [Best EMR software in India 2026 — features, pricing, reviews](https://www.adrine.in/blog/best-emr-software-india)
