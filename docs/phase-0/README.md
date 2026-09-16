# Phase 0 — Technical Assessment

**Project:** Basic Clinic EMR System – India
**Responding to:** Statement of Work v1.0
**Status:** Complete — submitted for owner approval per SoW §4 STOP GATE and §21
**Date:** 2026-09-15

---

## ▶ Start here

# **[00-DEVELOPER-RESPONSE.md](./00-DEVELOPER-RESPONSE.md)**

That is the deliverable. It answers SoW §19 sections A–O and SoW §4 items 4.1–4.12 in
full, and is the document to review and sign. Everything else in this folder is an annex
it links to.

---

## Annexes

| # | Annex | Answers |
|---|---|---|
| 01 | [Technology Stack Decision](./01-tech-stack-decision.md) | §4.2 · §19 C |
| 02 | [Technical Assessment](./02-technical-assessment.md) | §4.1 feasibility · §4.3 architecture · §4.11 risks · §19 D, M |
| 03 | [Database Schema & Entity Definitions](./03-database-schema.md) | §4.4 · §9 · §19 E |
| 04 | [API & Security Middleware Specification](./04-api-security-spec.md) | §4.5 · §10 · §19 F |
| 05 | [Prototype Verification Script](./05-prototype-verification-script.md) | §13 Phase 1 acceptance gate · §14 UAT |
| 06 | [WhatsApp Approach](./06-whatsapp-approach.md) | §4.6 · §6.8 · §6.9 · §19 G |
| 07 | [Prescription & Drug Data Approach](./07-drug-data-approach.md) | §4.7 · §6.6 · §19 H |
| 08 | [Import & Export Approach](./08-import-export-approach.md) | §4.8 · §7 · §19 I |
| 09 | [Delivery Plan & Cost Estimate](./09-delivery-plan-and-cost.md) | §4.9 · §4.10 · §11 · §13 · §19 J, K, L |
| 10 | [Benchmark Product Review](./10-benchmark-review.md) | §3 · §20 |

---

## Code delivered in Phase 0

No application feature code has been written, per the SoW §4 STOP GATE. The only code
produced is the security substrate — delivered now so it can be reviewed and tested
**before** any feature depends on it.

| Path | Purpose |
|---|---|
| [`packages/db/src/schema/`](../../packages/db/src/schema/) | Drizzle schema — all 15 SoW §9 entities across 30 tables |
| [`packages/db/migrations/0001_roles_and_rls.sql`](../../packages/db/migrations/0001_roles_and_rls.sql) | Database roles, forced RLS, audit immutability, finalisation triggers |
| [`apps/api/src/common/tenancy/`](../../apps/api/src/common/tenancy/) | Tenant context middleware and the RLS-bound transaction provider |
| [`apps/api/src/common/rbac/`](../../apps/api/src/common/rbac/) | Permission matrix and the deny-by-default authorisation guard |
| [`apps/api/src/common/audit/`](../../apps/api/src/common/audit/) | Global audit interceptor writing immutable `audit_event` rows |
| [`apps/api/src/common/storage/`](../../apps/api/src/common/storage/) | Presigned S3 URLs and the authenticated share-link generator |

---

## Reading routes

**Owner / commercial reviewer** — 30 minutes
`00` §A (verdict) → §B (scope gaps) → §J/§K (timeline and cost) → §N (your decisions) → §O (proposed changes)

**Technical reviewer** — 2 hours
`00` §C/§D → Annex 01 (why this stack) → Annex 03 (data model) → Annex 04 (how the tenant boundary is enforced)

**Security reviewer** — 90 minutes
Annex 03 §4 → [`0001_roles_and_rls.sql`](../../packages/db/migrations/0001_roles_and_rls.sql) → Annex 04 §3–§7 (ending with the adversarial tenancy suite)

**Clinical reviewer** — 45 minutes
Annex 02 §1 (feasibility) → Annex 07 §5 (safety warnings) → Annex 05 (what pilot doctors will be asked to do)

---

## Headline numbers

| | |
|---|---|
| **Verdict** | Recommended with changes |
| **Timeline to pilot** | 41 weeks (~9.5 months) solo · **24 weeks with a second developer** |
| **One-time build** | ₹18,65,000 (₹21,45,000 with contingency) |
| **Recurring — pilot** | ₹23,500 / month |
| **Recurring — 100 clinics** | ₹1,21,000 / month (≈ ₹1,210 per clinic) |
| **Modules** | 12 of 12 feasible · 4 with external dependency · 0 not recommended |

---

## Phase 0 exit criteria

Phase 1 does not begin until all of these are true:

- [ ] Owner approves the Developer Response (SoW §21 signature block)
- [ ] **§N questions 1–4 answered** — each blocks a module, not merely informs it
- [ ] Team model confirmed: solo at ~9.5 months, or +1 developer at ~5.5 months (§N Q12)
- [ ] Schema reviewed against the clinic's real workflow, entity by entity (Annex 03)
- [ ] RBAC matrix signed off by a **practising doctor**, not only the product owner (Annex 04 §4)
- [ ] Adversarial tenancy suite runs green in CI against the Phase 0 schema (Annex 04 §7)
- [ ] Five pilot clinics recruited — doctors **and** their receptionists (Annex 05 §2.2)
- [ ] Owner inputs per SoW §18 scheduled against the Annex 09 §2 dependency table
