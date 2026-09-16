# Indian Outpatient EMR — Technology Stack Decision Record

**Document:** Phase 0, Task 1.2 (Recommended Tech Stack)
**Status:** Recommended — awaiting client ratification
**Date:** 2026-09-15

---

## 0. How this stack was chosen

Most stack arguments are religious. This one isn't, because five hard constraints from the Statement of Work eliminate most of the options before taste enters the room. Every choice below traces back to one of these:

| # | Constraint | What it eliminates |
|---|---|---|
| **C1** | `clinic_id` tenant isolation is a **zero-tolerance** failure | ORMs that fight Postgres RLS; any "filter in application code" approach |
| **C2** | India DPDP Act 2023 + **DPDP Rules 2025**; health = likely Significant Data Fiduciary | Any vendor that processes patient data outside India by default |
| **C3** | Prescriptions must render **Indic scripts** (Devanagari / Tamil / Telugu / Bengali) correctly and be legally signed | PDF libraries without HarfBuzz-grade text shaping |
| **C4** | **1–5 doctor clinics** — realistic ARPU is ₹1,500–5,000 / clinic / month | Per-MAU / per-seat SaaS dependencies (Auth0, Clerk, etc.) |
| **C5** | ABDM readiness (M1 → M2 → M3) on **HL7 FHIR R4** | A FHIR-native document store as the primary OLTP database |

Constraint **C4** is the one teams forget. At ₹3,000/month per clinic, a per-MAU auth vendor and a per-message BSP markup can eat 30–40% of gross margin. The stack below is deliberately **boring, self-hosted, and owned**, because owned infrastructure is what makes the unit economics work at this price point.

---

## 1. The stack, in one table

| Layer | Choice | Version (Sept 2026) |
|---|---|---|
| **Language (everywhere)** | TypeScript | 5.9 |
| **Runtime** | Node.js LTS "Krypton" | 24.x |
| **Frontend** | Next.js (App Router) + React | 15.x / 19.x |
| **UI** | Tailwind CSS + shadcn/ui (Radix primitives) | 4.x |
| **Client state / data** | TanStack Query + TanStack Table | v5 |
| **Forms + validation** | React Hook Form + **Zod** (schemas shared with API) | Zod 4 |
| **API framework** | **NestJS** on the Fastify adapter | 12.x |
| **Database** | **PostgreSQL** with **forced Row-Level Security** | 18.6 |
| **Query layer / ORM** | **Drizzle ORM** + drizzle-kit migrations | latest |
| **Cache + queue** | Redis 7 + **BullMQ** | — |
| **Object storage** | **AWS S3 — ap-south-1 (Mumbai)**, SSE-KMS, presigned URLs | — |
| **PDF engine** | **Gotenberg** (containerised Chromium) + Noto font family | 8.x |
| **Auth** | Self-hosted: Argon2id + short-lived JWT + rotating refresh in Redis + TOTP MFA | — |
| **Search / dedup** | Postgres `pg_trgm` + `unaccent` + normalised E.164 phone | — |
| **WhatsApp** | **Meta Cloud API direct** (Tech Provider + Embedded Signup), India Local Storage enabled | — |
| **Observability** | OpenTelemetry → self-hosted Grafana LGTM (Mumbai) + Sentry (scrubbed) | — |
| **Infrastructure** | AWS **ap-south-1** — ECS Fargate, RDS Postgres, ElastiCache, S3, ALB | — |
| **IaC + CI/CD** | Terraform + GitHub Actions → ECR → ECS | — |
| **Monorepo** | pnpm workspaces + Turborepo | — |
| **Testing** | Vitest + Testcontainers (Postgres) + Playwright | — |

**One sentence:** a TypeScript monorepo — Next.js front end, NestJS API, Postgres with RLS as the tenant boundary, Redis/BullMQ for background work, Chromium for PDFs — running entirely inside AWS Mumbai.

### 1.1 Naming note: Next.js and NestJS are two different tools

These names are confusingly similar and are routinely mistaken for each other. They are unrelated projects doing opposite jobs:

| | **Next.js** | **NestJS** |
|---|---|---|
| Maintainer | Vercel | Kamil Myśliwiec / open source |
| Category | React **frontend** framework | Node.js **backend** framework |
| Role here | The screens clinic staff interact with | The API, security guards, workers, webhooks |
| Deployment | ECS Fargate `web` task | ECS Fargate `api` + `worker` tasks |

**The API is not built in Next.js.** Next.js can technically serve APIs (Route Handlers, Server Actions), and for a simple CRUD SaaS that is a legitimate way to collapse the stack into one deployable. Four properties of *this* project rule it out:

1. **It undermines the tenant boundary (C1).** Isolation depends on `set_config('app.clinic_id', …, true)` holding across a connection pinned to one transaction for the life of the request. Next.js's request/serverless execution model gives no reliable control over connection pinning. The failure mode is a pooled connection carrying one clinic's setting into another clinic's request.
2. **Audit and RBAC cannot be enforced globally.** Next.js middleware runs on the Edge runtime — no Node APIs, no database access — so it cannot evaluate a role against the database or append an `audit_event` row. Enforcement would have to be invoked by hand in every route handler. A regulated system needs enforcement provable from a single registration point, which is exactly what NestJS global guards and interceptors provide.
3. **No background-work model.** PDF rendering, WhatsApp dispatch, reminder scheduling, CSV import and full-clinic export are BullMQ consumers in long-lived Node processes. Next.js hosts none of these, so a separate backend service is required regardless — the "single deployable" saving is illusory.
4. **Wrong security perimeter.** Meta WhatsApp webhooks and future ABDM callbacks are non-browser clients calling the backend directly. Coupling that endpoint's scaling, release cadence and network exposure to the frontend deployment is architecturally backwards. The NestJS service sits in a private subnet and scales independently.

Next.js's scope is therefore: UI rendering, routing, and a thin BFF for auth-cookie handling and request proxying — subject to the rule in §2.6 that **clinical data is never server-rendered on third-party foreign infrastructure**. It is self-hosted in `ap-south-1` beside the API, not on Vercel.

---

## 2. The six decisions people actually argue about

### 2.1 Postgres + **Drizzle ORM**, not Prisma

This is the single most consequential choice in the project, and it is driven by **C1**.

The tenant boundary must be enforced by the **database**, not by remembering to write `WHERE clinic_id = ?`. One forgotten clause in one query is a cross-tenant clinical data leak — a reportable breach under DPDP, with penalties up to ₹250 crore. The mechanism for this in Postgres is Row-Level Security, driven by a transaction-local session variable:

```sql
-- Set once per request, inside the transaction
SELECT set_config('app.clinic_id', $1, true);   -- true = transaction-scoped

-- Every tenant table carries this policy
CREATE POLICY tenant_isolation ON patients
  USING      (clinic_id = current_setting('app.clinic_id')::uuid)
  WITH CHECK (clinic_id = current_setting('app.clinic_id')::uuid);

-- CRITICAL: table owners bypass RLS unless you force it
ALTER TABLE patients FORCE ROW LEVEL SECURITY;
```

Two facts make this hard for a "managed" ORM:

1. `SET LOCAL` / `set_config(..., true)` only works if **every query in the request runs on the same pooled connection, inside one transaction**. Leak the connection back to the pool mid-request and the next tenant inherits your setting.
2. Policies must be **version-controlled alongside migrations**, or they drift.

Drizzle wins on both. It is SQL-first, so the transaction and the `set_config` call are explicit and auditable; and it can declare policies in the schema (`pgPolicy`) so they ship with `drizzle-kit` migrations rather than living in a hand-maintained SQL file.

Prisma can do it — via client extensions wrapping every call in `$transaction` — but it is working against the grain, historically fragile with pooling, and the failure mode is silent. For a system where the failure mode is "a clinic sees another clinic's patients", choose the tool where the boundary is visible in the code.

> **Companion control — two database roles.** The API connects as `emr_app` (`NOBYPASSRLS`, no DDL rights). Migrations run as `emr_migrator` (the owner). The API physically cannot disable a policy, and `FORCE ROW LEVEL SECURITY` means even the owner is subject to policies during normal operation. This is defence in depth *on top of* the tenant middleware, not instead of it.

**Why not MongoDB or a FHIR-native store?** Outpatient EMR data is intensely relational (patient → encounter → prescription → line items → invoice) and demands transactional integrity on finalisation. FHIR R4 is a *wire format for ABDM*, not a storage model. Store normalised Postgres and **map to FHIR R4 resources at the API edge** — which keeps M2/M3 certification a serialisation problem, not a migration.

---

### 2.2 **NestJS**, not bare Express/Fastify, not FastAPI, not Go

Read Task 3 of the brief again. It asks for:

- Tenant Context Middleware → **NestJS middleware** + `AsyncLocalStorage` request scope
- Server-side RBAC matrix → **NestJS Guards** (`@Roles('DOCTOR')`, CASL abilities)
- Audit Logger Interceptor → **NestJS Interceptors**

Those are NestJS's three native primitives. The framework's structure *is* the security architecture the SoW is asking for, applied declaratively and globally rather than remembered per route. That matters for auditability: a reviewer can prove the audit interceptor is global from one line of `main.ts`, instead of grepping 200 route handlers.

Secondary reasons:

- **End-to-end TypeScript.** Zod schemas in `packages/contracts` become the single source of truth for API validation, OpenAPI generation, and front-end form types. A field rename breaks the build, not production.
- **Hiring.** NestJS + Postgres is the deepest talent pool in India at this budget. Go is faster and FastAPI is pleasant, but neither buys anything here — this is a CRUD-and-workflow system, not a compute-bound one — and both cost you the shared-types advantage.

Run it on the **Fastify adapter** (roughly 2× Express throughput, same Nest API surface).

---

### 2.3 **Gotenberg (Chromium)** for PDFs, not `@react-pdf/renderer`

Driven by **C3**. A prescription in Maharashtra may need `पॅरासिटामॉल ५०० मिग्रॅ` on it. Devanagari and the southern scripts require **complex text shaping** — conjuncts, reordered vowel signs, ligature substitution — which is HarfBuzz's job. Chromium embeds HarfBuzz and gets it right. `@react-pdf/renderer` and most pure-JS PDF libraries do not, and the failure mode is *silently mangled drug names on a legal medical document*. That is not acceptable.

So: **HTML + CSS Paged Media → Chromium → PDF**, with Noto Sans and Noto Sans Devanagari (plus the relevant regional Noto faces) embedded as subsetted WOFF2.

Why **Gotenberg** rather than Puppeteer inside the API process:

| | Puppeteer in-process | Gotenberg sidecar |
|---|---|---|
| Chromium zombie processes | Your problem | Contained |
| Memory spike blast radius | Kills your API | Kills one container |
| Scaling | Coupled to the API | Independent Fargate task |
| Cold start | Per worker | Warmed pool |

Gotenberg is a container that takes HTML and returns a PDF over HTTP. It isolates the single most memory-hostile component in the system. The rendering worker (BullMQ) calls it, streams the result to S3, and enqueues the WhatsApp dispatch job.

**Mitigating the layout-overflow risk** (named in the Task 1.4 risk register): `@page` margin boxes for the running header and footer (clinic letterhead, doctor registration number, page *n* of *m*), plus a **golden-file snapshot test suite** — a fixture set of pathological prescriptions (22 drugs, 400-character instructions, long Tamil drug names, a three-line clinic address) rendered in CI and diffed against approved PDFs. Layout regressions fail the build.

**Signing.** The IT Act makes a secure electronic signature legally equivalent to a wet signature, and NMC rules require the prescription to carry the practitioner's signature and registration number. Phase 1 ships a **cryptographic signature over the PDF hash**, bound to the doctor's authenticated session, plus a visible signature block (name, qualifications, NMC/state registration number, timestamp). Phase 2 adds **eSign / DSC** (Aadhaar eSign or an HSM-backed token) for a PKCS#7 signature embedded in the PDF. This is an open question in §6 — it has cost and onboarding implications.

---

### 2.4 Auth: **build it**, don't buy it

Driven by **C4** and **C2**. Auth0, Clerk and WorkOS price per monthly active user and store identity data outside India. For a clinic product at ₹3,000/month with roughly six staff logins, you would be paying a foreign processor a recurring per-head fee to hold Indian practitioner identity data — bad economics *and* an extra cross-border disclosure to document under DPDP.

The requirement is genuinely modest: five fixed roles, one tenant per user, no social login, no SAML in Phase 1. That is a well-trodden build:

- **Argon2id** password hashing (`node-argon2`, memory-hard, current OWASP parameters)
- **Access JWT, 10-minute TTL**, claims: `sub`, `clinic_id`, `role`, `jti`
- **Refresh token, 30-day, rotating, stored server-side in Redis** — server-side storage is what gives you *instant revocation*, which you need the moment a receptionist is dismissed
- Both in `httpOnly`, `Secure`, `SameSite=Lax` cookies — never `localStorage`
- **TOTP MFA mandatory for Owner/Admin and Doctor** roles, since they can finalise clinical records
- Login throttling and lockout, per IP and per account

Revisit this **only** if a client demands hospital SSO. It is roughly a two-week build against a permanent margin tax.

---

### 2.5 WhatsApp: **Meta Cloud API direct**, behind a swappable interface

Three facts that change the architecture, all current as of today:

1. **The On-Premises API is dead** — the final client version expired on 23 October 2025. Cloud API is the only option. Any vendor proposal built on on-prem is out of date.
2. **Cloud API Local Storage supports India.** Message payloads can be stored at rest in an Indian data centre, with content in the global "data in use" tier auto-deleted after 60 minutes. **This must be switched on per WABA** — it is the difference between a clean DPDP data-flow map and an awkward one.
3. **From 1 October 2026, Meta bills per message for service *and* utility messages sent inside the open 24-hour window** — previously free since November 2024. That is about two weeks away, and it changes the cost model of the Inbox feature, not just of reminders.

**Direct (Tech Provider + Embedded Signup) vs a BSP (AiSensy / Interakt / Gupshup / 360dialog).** Go direct. In a multi-tenant SaaS, each clinic needs **its own WABA and phone number** — the prescription has to come from *Dr. Sharma's Clinic*, not from your platform. Embedded Signup is the flow that lets a clinic attach its own number during onboarding without you touching it. Direct also removes the BSP's per-message markup (roughly $0.003–$0.010), which matters at clinic-scale volumes.

But **wrap it in a `MessagingProvider` interface from day one** (`sendTemplate`, `sendSessionMessage`, `handleWebhook`, `getTemplateStatus`). Meta's template approval process is opaque and occasionally brutal; if a BSP's pre-approved template library becomes the faster path to launch, you swap one adapter, not the Inbox.

**Cost model to put in front of the client now.** Utility template ≈ **₹0.16**, marketing ≈ ₹0.86, authentication ≈ ₹0.13 per delivered message. A clinic sending 40 appointment reminders and 40 prescription deliveries per day runs ≈ **₹390/month** in pass-through Meta fees — rising once the 1 October 2026 service-message change lands. Against a ₹3,000/month subscription that is **13%+ of revenue**. Recommendation: meter WhatsApp sends per clinic from day one and price it as a bundled allowance plus overage, never as "unlimited".

**The internal-note safety requirement is a schema decision, not a UI one.** Do not use a boolean flag on a shared `communications` table — a single bug in a `WHERE is_internal = false` clause sends a doctor's private note to a patient. Use **two physically separate tables**: `communication` (externally dispatchable, the only table the WhatsApp worker can read) and `encounter_internal_note` (no dispatch path exists in the codebase). The worker's database role is granted `SELECT` on the first and **not on the second**. Then it is impossible by construction, not by discipline.

---

### 2.6 Hosting: **AWS ap-south-1 (Mumbai)**, self-managed containers

Driven by **C2**. Two clarifications on the law, because teams routinely over- and under-react to it:

- The DPDP Act **does not impose blanket data localisation.** Rule 15 of the DPDP Rules 2025 uses a *negative list*: transfers abroad are permitted unless the government restricts a specific country. No country has been notified so far.
- **However**, the government may bar offshore transfer of specified data categories for **Significant Data Fiduciaries**, and health platforms are among the most likely to be designated. Sectoral rules and ABDM policy also point toward in-country storage.

The commercially correct posture is therefore to **store and process everything in India by default**, so that an SDF designation, an ABDM audit, or a hospital-group procurement questionnaire costs you nothing. Full DPDP compliance is due by **14 May 2027**, with consent-manager obligations biting around **November 2026**. Build for it now — retrofitting residency after 200 clinics have onboarded is a migration nobody wants.

Concretely, this rules out Vercel (SSR of patient data on foreign edge nodes), Auth0/Clerk, US-region Supabase, and any log or APM vendor ingesting un-scrubbed PHI.

**Pilot topology (5 clinics), AWS ap-south-1:**

```
Route 53 → ALB (TLS 1.2+, AWS WAF)
  ├── ECS Fargate : web       (Next.js,  0.5 vCPU / 1 GB × 2)
  ├── ECS Fargate : api       (NestJS,   0.5 vCPU / 1 GB × 2)
  ├── ECS Fargate : worker    (BullMQ — PDF, WhatsApp, reminders, import/export)
  └── ECS Fargate : gotenberg (Chromium sidecar, private subnet only)
        │
        ├── RDS PostgreSQL 18  (db.t4g.small, encrypted, PITR, private subnet)
        ├── ElastiCache Redis  (cache.t4g.micro, encrypted in transit)
        └── S3 ap-south-1      (SSE-KMS, versioned, Block Public Access, presigned URLs only)
```

**Estimated pilot run-rate: roughly US$180–220/month** (≈ ₹16,000–19,000), excluding WhatsApp pass-through. At around 100 clinics, expect US$600–900/month with Multi-AZ RDS. Per-clinic infrastructure cost at scale lands near **₹80–150/month**, which is what makes a ₹3,000 price point viable.

**Is Supabase Mumbai a shortcut?** Honestly, yes — it is a real option. Supabase runs in `ap-south-1`, gives you Postgres with first-class RLS, storage and auth on day one, and would compress Phase 1 by perhaps three to four weeks. The trade-offs: you inherit their auth model (harder to meet the exact five-role + MFA + audit spec), your audit trail and PHI sit with a third-party processor you must name in the DPDP records of processing, and self-hosting later is a real migration. **Use Supabase only if the client's priority is speed-to-pilot over control.** For a product whose differentiator is compliance and zero lock-in, own the Postgres.

---

## 3. Two things nobody puts in the stack table, and both will bite

### 3.1 Flaky clinic internet is a first-class requirement

A receptionist mid-registration on a 4G dongle that drops for 20 seconds must not lose the form. Budget for it in Phase 1:

- TanStack Query with an **IndexedDB persister** for cached patient and queue reads
- A **draft outbox**: encounter notes and registration forms autosave locally every 3 seconds and replay on reconnect with an idempotency key
- Optimistic UI on queue operations, with visible reconciliation
- A persistent **"offline — N changes pending"** banner. Never a silent failure.

This is deliberately *not* full offline-first: no CRDTs, no local Postgres. Full offline-first roughly triples the cost, and the conflict-resolution complexity is genuinely dangerous in a clinical context. Degrade gracefully; don't pretend to be offline-capable.

### 3.2 The drug catalogue is a procurement problem, not an engineering one

Drug search with safety warnings (interactions, allergy cross-checks, paediatric dosing) requires a **licensed, maintained** Indian drug database. There is no free, reliable, comprehensive one. Options: license a commercial Indian formulary, or ship a curated ~2,000-molecule catalogue for the pilot with allergy cross-checking only and no full interaction engine.

Storage pattern, given the "`clinic_id` on every table" mandate: a reserved `SYSTEM_CLINIC_ID` UUID owns global catalogue rows, with the RLS policy widened to `clinic_id IN (current_setting('app.clinic_id')::uuid, SYSTEM_CLINIC_ID)` **on catalogue tables only**. Per-clinic favourites and custom formulations live under the real `clinic_id`.

This needs a client decision and a budget line before Phase 1 planning. Flagged in §6.

---

## 4. Explicitly rejected

| Rejected | Why |
|---|---|
| MongoDB / document store | Relational clinical data; needs transactional finalisation and FK integrity |
| FHIR-native server (e.g. HAPI) as primary DB | FHIR is the ABDM wire format, not the OLTP model; would cripple query performance |
| Prisma | Fights transaction-pinned RLS; silent failure mode on the tenant boundary |
| Auth0 / Clerk / WorkOS | Per-MAU cost against ₹3,000 ARPU; identity data offshore (C2, C4) |
| Vercel / Netlify hosting | SSR of patient data on foreign edge nodes |
| `@react-pdf/renderer`, wkhtmltopdf | Broken or absent Indic complex-script shaping; wkhtmltopdf unmaintained |
| Elasticsearch | `pg_trgm` handles fuzzy patient search well past 10M rows; not worth the ops burden |
| Kubernetes (Phase 1) | ECS Fargate suffices at this scale; revisit around 500 clinics |
| Microservices | A 1–5 doctor EMR is a modular monolith. Nest modules give the seams without the distributed-systems tax |
| Any WhatsApp On-Premises API | Sunset 23 October 2025 |

---

## 5. What this buys you against the SoW

| SoW mandate | Mechanism |
|---|---|
| Strict `clinic_id` isolation | Postgres **forced** RLS + `emr_app` NOBYPASSRLS role + Nest tenant middleware + Redis key prefix `clinic:{id}:*` + BullMQ job payload assertion + S3 key prefix `clinics/{clinic_id}/…` |
| Zero cross-tenant leakage | Automated **adversarial tenancy test suite** in CI (Testcontainers): every endpoint replayed with Clinic A's token against Clinic B's resource IDs; any 200 fails the build |
| FHIR R4 alignment | Normalised Postgres + a FHIR mapping layer at the API edge; ABDM M1/M2/M3 become serialisation work |
| Immutable audit log | Append-only `audit_event` table, `REVOKE UPDATE, DELETE` from `emr_app`, populated by a global Nest interceptor |
| Zero standing production access | No human DB credentials; break-glass via AWS SSM Session Manager with a mandatory ticket reference, time-boxed, CloudTrail-logged and alerting |
| No secrets in repo or bundle | AWS Secrets Manager + ECS task secret injection; gitleaks in pre-commit and CI |
| Internal notes can never be sent | Physically separate table; the worker's DB role has no `SELECT` grant on it |
| Zero lock-in export | Postgres `COPY … TO CSV` per entity, streamed into a zip with the S3 document bundle, via a BullMQ job |

---

## 6. Open questions blocking full ratification

1. **Prescription signing tier.** Visible signature block plus session-bound hash (Phase 1), or full Aadhaar eSign / DSC (cost, plus onboarding friction per doctor)? *Affects Phase 1 scope.*
2. **Drug catalogue source.** License a commercial Indian formulary, or ship a curated pilot subset with allergy-only checking? *Affects Phase 1 budget and clinical safety claims.*
3. **ABDM scope in Phase 1.** Build ABDM-ready (FHIR mapping layer in place, certification deferred), or pursue M1 certification during Phase 1? M1 is typically 2–4 weeks; M2 is 4–12.
4. **WhatsApp commercial model.** Bundled allowance plus overage, or clinic brings its own BSP account? Materially changes onboarding UX and gross margin.
5. **Speed vs control on the data layer.** Confirm self-managed RDS (recommended) over Supabase Mumbai (about 3–4 weeks faster to pilot, more third-party processor exposure).

---

## Sources

- [DPDP Rules 2025 — Rule 15, transfer of personal data outside India](https://www.dpdpa.com/dpdparules/rule15.html)
- [DPDP Rules 2025 — practical guide and compliance checklist](https://www.scrut.io/post/dpdp-rules)
- [DPDP Rules 2025 — India compliance deadlines by May 2027](https://www.macksofy.com/blog/dpdp-rules-2025-compliance-deadlines)
- [India's new cross-border data transfer framework](https://ksandk.com/data-protection-and-data-privacy/indias-new-cross-border-data-transfer-framework/)
- [ABDM milestones M1–M4: hospital software integration guide](https://nirmitee.io/blog/abdm-integration-milestones-m1-m2-m3-m4-multi-software-guide/)
- [ABDM FHIR integration guide 2026](https://www.adrine.in/blog/abdm-fhir-integration-guide-2026)
- [WhatsApp On-Premises API sunset — Meta for Developers](https://developers.facebook.com/docs/whatsapp/on-premises/sunset)
- [WhatsApp Cloud API data privacy, security and Local Storage — Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/data-privacy-and-security/)
- [WhatsApp Business API pricing in India, 2026](https://myoperator.com/blog/whatsapp-business-api-pricing-india-2026)
- [WhatsApp Business API pricing 2026 — conversation categories and what changed](https://blueticks.co/blog/whatsapp-business-api-pricing-2026)
- [Digital prescriptions in India: rules, process and tools](https://www.coveryou.in/blog/digital-prescriptions-india-rules-process-tools/)
- [Digital health apps and telemedicine — legal guide, India (CMS)](https://cms.law/en/int/expert-guides/cms-expert-guide-to-digital-health-apps-and-telemedicine/india)
- [Drizzle ORM — Row-Level Security documentation](https://orm.drizzle.team/docs/rls)
- [Postgres RLS for multi-tenant SaaS — the production pattern](https://theroadtoenterprise.com/blog/postgres-rls-multi-tenant-saas)
- [PostgreSQL 18 released](https://www.postgresql.org/about/news/postgresql-18-released-3142/)
- [Node.js 24.11.0 enters LTS](https://nodejs.org/en/blog/release/v24.11.0)
- [Announcing NestJS 11 — Trilon](https://trilon.io/blog/announcing-nestjs-11-whats-new)
- [Managed PostgreSQL comparison 2026](https://selfhost.dev/blog/managed-postgresql-comparison-2026/)
- [AWS RDS pricing India / Mumbai 2026](https://www.itforsme.in/pricing/aws-rds-india)
