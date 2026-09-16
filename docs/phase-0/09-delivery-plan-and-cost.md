# Annex 9 — Delivery Plan & Cost Estimate

**Responds to:** SoW §4.9 (delivery plan), §4.10 (cost estimate), §19 J / K / L
**Team model:** solo senior full-stack developer, part-time QA and design
**Currency:** INR, fixed price per milestone
**Date:** 2026-09-15

---

## 1. Basis of estimate

### 1.1 Rate assumptions

Stated explicitly so they can be adjusted rather than argued over.

| Role | Monthly rate | Allocation |
|---|---|---|
| Senior full-stack developer | ₹1,75,000 | 1.0 FTE, Phases 0–6 |
| QA engineer | ₹1,40,000 (at 0.25 FTE = ₹35,000) | Phases 2–6 |
| UI/UX designer | ₹1,60,000 (at 0.25 FTE = ₹40,000) | Phases 0–1 only |
| External security tester | ₹75,000 one-off | Phase 5 |

A month is taken as 4.33 weeks. Phase prices are rounded to the nearest ₹2,500.

### 1.2 What is included

Design, development, automated testing, code review, documentation, deployment
configuration, and the SoW §16 handover artefacts for the phases listed.

### 1.3 What is excluded

| Excluded | Why | Treatment |
|---|---|---|
| Drug catalogue licence | Owner procurement decision (§N Q1) | Pass-through at cost |
| Aadhaar eSign / DSC integration | Depends on signing tier decision (§N Q2) | Change request, ~₹1,50,000 |
| ABDM M1/M2/M3 certification | SoW §12 excludes live ABDM from MVP | Separate engagement |
| Per-clinic legacy data migration | SoW §7.1 permits this as a paid service | Quoted per clinic on sight of data |
| Legal / DPDP advisory | Developer is not a legal advisor (SoW §18) | Owner procures |
| Native mobile apps | SoW §12 | Out of scope |
| Cloud infrastructure charges | Consumption-based | Billed at cost, see §5 |

---

## 2. Phase plan

Mapped one-to-one onto the SoW §13 phase structure, including its acceptance gates.

### Phase 0 — Technical assessment · 2 weeks · ₹1,10,000

**Output (SoW §13):** Section 4 response, stack, architecture, ERD, security plan,
effort/cost, risks, assumptions.

**Delivered:** this response and its ten annexes, plus the database schema with tenant
isolation policies and the security middleware chain — delivered as code specifically so
both can be reviewed before any feature depends on them.

**Gate:** owner written approval to proceed.

---

### Phase 1 — UX / prototype & design system · 4 weeks · ₹2,15,000

**Output:** clickable core flows — registration, queue, patient snapshot, consultation,
Rx, reports, WhatsApp inbox.

| Week | Work |
|---|---|
| 1 | Design system: typography, colour, spacing, form patterns, clinical data density. Component inventory |
| 2 | Registration, duplicate handling, queue screens |
| 3 | Patient Snapshot, encounter, prescription with safety warnings |
| 4 | Reports, inbox, PDF layout; **UAT sessions with 5 pilot clinics** (Annex 5) |

**Gate:** founder and selected clinic users complete the scripted flows without developer
guidance. Measured by [Annex 5](./05-prototype-verification-script.md), which carries a
documented go / rework / stop decision.

**Dependencies:** sample prescription formats, clinic branding, 5 recruited pilot clinics.

---

### Phase 2 — Core EMR backend + frontend · 12 weeks · ₹6,30,000

**Output:** auth/RBAC, clinic/user, patient, appointment, queue, encounter, Rx, files,
PDF, audit baseline. The largest phase by a wide margin.

| Weeks | Work |
|---|---|
| 1–2 | Infrastructure: Terraform, dev/staging/prod accounts, CI/CD, migrations, seed data |
| 3–4 | Auth, MFA, session management, RBAC guard, tenant middleware, audit interceptor |
| 5 | Clinic setup, users, locations, services/fees |
| 6–7 | Patient registry: search, duplicate detection, merge tool |
| 8 | Appointments and live queue |
| 9–10 | Encounter: SOAP capture, vitals, diagnoses, templates, finalisation |
| 11 | Prescription: drug search, safety warnings, signing |
| 12 | Documents, S3 upload/download, **PDF generation and golden-file regression suite** |

**Gate:** synthetic end-to-end tests pass; staging demo approved.

**Dependencies:** drug catalogue decision and signing-tier decision — **both required
before week 11**, and both are owner decisions.

---

### Phase 3 — Communication & automation · 5 weeks · ₹2,62,500

**Output:** WhatsApp integration, inbox, internal notes, secure links, reminder jobs,
opt-out/consent controls.

| Weeks | Work |
|---|---|
| 1 | WABA provisioning, Embedded Signup, webhook receiver with signature verification |
| 2 | Inbound matching, unlinked queue, conversation threading, service-window tracking |
| 3 | Outbound: template vs session selection, delivery receipts, failure handling |
| 4 | Reminder engine, quiet hours, opt-in/opt-out, consent capture |
| 5 | Secure share links with OTP; internal-note isolation tests |

**Gate:** inbound / outbound / status / failure scenarios pass on a staging test number.

**Dependencies:** WhatsApp business account decision; approved consent and privacy text.
**Meta template approval takes 1–3 business days per template and can be rejected without
explanation** — templates are submitted in week 1, not week 3.

---

### Phase 4 — Billing / reporting / portability · 5 weeks · ₹2,62,500

**Output:** billing-lite, reports, CSV import, duplicate handling, export package, job logs.

| Weeks | Work |
|---|---|
| 1–2 | Billing-lite: service items, invoices, payments, receipts, collection reporting |
| 3 | Reporting dashboard (SoW §6.11) and CSV report export |
| 4 | Import wizard: upload, mapping, validation, duplicate review, reconciliation report |
| 5 | Full export package (12-file manifest), streamed generation, audit events |

**Gate:** test clinic import/export reconciles expected record counts.

**Dependency:** anonymised sample import files from the owner.

---

### Phase 5 — Hardening & pilot release · 4 weeks · ₹2,85,000

**Output:** monitoring, backup/restore, permission tests, security testing, performance
fixes, onboarding.

| Weeks | Work |
|---|---|
| 1 | Observability: OpenTelemetry, dashboards, alerting, job/webhook failure visibility |
| 2 | **Backup and restore drill** — full timed restore to an isolated account, documented |
| 3 | **External security test**; remediation of critical and high findings |
| 4 | Load testing to stated capacity assumptions; p95 tuning; onboarding documentation |

**Gate:** production readiness checklist signed; restore drill completed.

Includes ₹75,000 for the external security assessment, which SoW §14 requires and which
must not be self-administered.

---

### Phase 6 — Pilot support & stabilisation · 4 weeks (part-time) · ₹1,00,000

**Output:** bug fixes, usage analytics, workflow refinements, onboarding documentation.

Priced at approximately 0.5 FTE, since the work is reactive. Covers the first five pilot
clinics through their first month of live use.

**Gate:** pilot exit metrics reviewed before wider rollout.

---

## 3. Cost summary

### 3.1 One-time build

| Phase | Duration | Fixed price |
|---|---|---|
| 0 — Technical assessment | 2 wk | ₹1,10,000 |
| 1 — UX / prototype | 4 wk | ₹2,15,000 |
| 2 — Core EMR | 12 wk | ₹6,30,000 |
| 3 — Communication & automation | 5 wk | ₹2,62,500 |
| 4 — Billing / reporting / portability | 5 wk | ₹2,62,500 |
| 5 — Hardening & pilot release | 4 wk | ₹2,85,000 |
| 6 — Pilot support | 4 wk | ₹1,00,000 |
| **Total** | **36 wk** | **₹18,65,000** |
| Contingency @ 15% | +5 wk | ₹2,80,000 |
| **Total with contingency** | **41 wk** | **₹21,45,000** |

**Contingency is drawn only against approved change requests**, per SoW §17 — it is not a
buffer the developer spends silently.

### 3.2 Payment schedule (proposed)

| Trigger | % | Amount |
|---|---|---|
| Phase 0 approval | 6% | ₹1,10,000 |
| Phase 1 gate passed | 12% | ₹2,15,000 |
| Phase 2 — week 6 progress review | 17% | ₹3,15,000 |
| Phase 2 gate passed | 17% | ₹3,15,000 |
| Phase 3 gate passed | 14% | ₹2,62,500 |
| Phase 4 gate passed | 14% | ₹2,62,500 |
| Phase 5 gate passed | 15% | ₹2,85,000 |
| Phase 6 complete | 5% | ₹1,00,000 |

Phase 2 is split because twelve weeks is too long a gap between payments for either party.

---

## 4. Team options — the decision worth making now

The solo model is what was requested and is fully costed above. The alternative is
presented because the trade-off is unusually favourable and the owner should see it.

| Option | Team | To pilot | One-time cost | Bus factor |
|---|---|---|---|---|
| **A — Solo** *(as quoted)* | 1 dev + 0.25 QA + 0.25 design | **41 wk (~9.5 mo)** | ₹21,45,000 | **1 — unmitigated** |
| **B — Solo + 1 dev from Phase 2** | 2 dev + 0.5 QA + 0.25 design | **24 wk (~5.5 mo)** | ₹27,50,000 | 2 |
| **C — Full team** | 3 dev + 1 QA + 0.5 DevOps + 0.5 design | **19 wk (~4.5 mo)** | ₹38,00,000 | 3 |

### Why Option B is recommended

- **17 weeks earlier to revenue.** At even 20 clinics × ₹3,000/month, four months of
  earlier launch is ₹2,40,000 of recovered revenue against ₹6,05,000 of additional cost —
  and that understates it, because earlier launch also means earlier learning.
- **It removes risk R12.** Under Option A, developer illness or departure halts delivery
  entirely. There is no mitigation for this in a solo model; documentation and
  owner-controlled accounts limit the damage but do not remove the stoppage.
- **It makes code review real.** SoW §15 lists code review in the Definition of Done. A
  solo developer reviewing their own work satisfies the letter of that and not the intent.
- **Option C shows diminishing returns.** Going from 2 to 3 developers buys only 5 weeks
  for ₹10,50,000, because Phase 2's work has genuine sequential dependencies — auth and
  tenancy must exist before anything else can be built on them. Parallelism does not help
  where the critical path is narrow.

### Where parallelism actually helps

| Phase | Parallelisable? | Why |
|---|---|---|
| 0 | No | Single analytical deliverable |
| 1 | Partly | Design and prototype can overlap; the UAT cannot be rushed |
| **2** | **Yes, substantially** | After auth/tenancy (weeks 1–4), the patient, encounter, prescription and document tracks are largely independent |
| 3 | Partly | WhatsApp integration is a critical path; reminders and consent can run alongside |
| 4 | **Yes** | Billing, reporting and import/export are fully independent |
| 5 | No | Hardening is inherently sequential and integrative |
| 6 | No | Reactive |

---

## 5. Recurring costs

### 5.1 Pilot — 5 clinics

| Item | Monthly |
|---|---|
| ECS Fargate (web, api, worker, gotenberg) | ₹6,500 |
| RDS PostgreSQL db.t4g.small + storage | ₹3,200 |
| ElastiCache Redis cache.t4g.micro | ₹1,100 |
| ALB + data transfer | ₹2,200 |
| S3 + KMS | ₹400 |
| NAT / VPC endpoints | ₹3,200 |
| CloudWatch, backups, snapshots | ₹1,400 |
| **AWS subtotal** | **₹18,000** |
| Sentry, uptime monitoring, domains | ₹3,000 |
| WhatsApp pass-through (≈₹400/clinic) | ₹2,000 |
| SMS fallback | ₹500 |
| **Total pilot** | **₹23,500** |

### 5.2 At ~100 clinics

| Item | Monthly |
|---|---|
| AWS (scaled compute, Multi-AZ RDS, read replica) | ₹65,000 |
| Monitoring and tooling | ₹8,000 |
| WhatsApp pass-through | ₹40,000 |
| SMS fallback | ₹8,000 |
| **Total** | **₹1,21,000** |
| **Per clinic** | **₹1,210** |

### 5.3 Not quoted — owner decisions

| Item | Indicative | Depends on |
|---|---|---|
| Drug catalogue licence | ₹1,00,000–4,00,000 / year | §N Q1 |
| Aadhaar eSign per-signature | ₹1–5 per signature | §N Q2 |
| DPDP legal advisory | Owner-procured | §N Q3 |
| Support retainer (post-Phase 6) | ₹45,000 / month | Optional |

**Gross margin check.** At 100 clinics × ₹3,000 = ₹3,00,000 monthly revenue against
₹1,21,000 infrastructure = **~60% gross margin before support costs** — viable, but only
because the stack avoids per-seat SaaS dependencies. Adding a per-MAU auth vendor would
cut this by roughly a third.

---

## 6. Capacity assumptions (SoW §11)

Stated so they are testable, since SoW §11 requires the developer to state them.

| Dimension | Pilot | Design target | Redesign needed beyond |
|---|---|---|---|
| Clinics | 5 | 500 | ~2,000 |
| Patients per clinic | 5,000 | 50,000 | 500,000 |
| Encounters/day/clinic | 60 | 150 | 400 |
| Concurrent users | 15 | 1,500 | 5,000 |
| Documents stored | 10 GB | 2 TB | 20 TB |
| Peak API req/s | 5 | 300 | 1,000 |

**No architecture redesign is required to move from tens to hundreds of clinics**, per
SoW §11. The scaling path is horizontal ECS tasks, an RDS read replica for reporting, and
materialised views — all additive. The first genuine redesign point is roughly 2,000
clinics, where tenant sharding would be considered.

### Performance targets — p95 (SoW §11)

| Operation | p95 target | Validation |
|---|---|---|
| Patient search by mobile | **< 150 ms** | k6 load test, Phase 5 |
| Patient search by name (fuzzy) | **< 400 ms** | k6 load test, Phase 5 |
| Patient snapshot (full load) | **< 1,200 ms** | k6 load test, Phase 5 |
| **Encounter save** | **< 500 ms** | k6 load test, Phase 5 |
| Encounter finalise (incl. commit) | < 800 ms | k6 load test, Phase 5 |
| Drug catalogue search | < 300 ms | k6 load test, Phase 5 |
| Live queue refresh | < 200 ms | k6 load test, Phase 5 |
| PDF generation (async) | < 5 s | Measured in Phase 2 |

Validated under realistic small-clinic load: 100 clinics seeded with two years of
history, 50 concurrent users, at the peak-hour request profile.

### Browser support matrix (SoW §11)

| Browser | Support |
|---|---|
| Chrome / Edge (Chromium) | Current + previous major — **primary target** |
| Safari (macOS / iOS) | Current + previous major |
| Firefox | Best effort; tested each release, not release-blocking |
| Internet Explorer | **Not supported** |
| Android Chrome / iOS Safari | Essential workflows only (queue, snapshot, view Rx) |

Desktop/laptop at 1366×768 is the primary design target — the resolution of a typical
clinic desktop.
