# Clinic EMR

An electronic medical record for small Indian outpatient clinics — one to five
doctors, a front desk, and a nurse. Multi-tenant: many independent clinics on one
deployment, isolated from each other by the database rather than by application
code.

---

## Run it

You need Docker and about four minutes on a cold build.

```bash
cp .env.example .env
node -e "const c=require('crypto');for(const k of ['JWT_SECRET','APP_DB_PASSWORD','WORKER_DB_PASSWORD','READONLY_DB_PASSWORD','POSTGRES_PASSWORD'])console.log(k+'='+c.randomBytes(48).toString('base64url'))"
# paste those five lines over the CHANGE_ME values in .env

docker compose up --build
```

Then open <http://localhost:3000> and sign in as any of these with the password
`demo1234`:

| Email | Role | What it can do |
|---|---|---|
| `priya.k@sunriseclinic.in` | Receptionist | Register, queue, bill. No clinical content. |
| `anjali.mehta@sunriseclinic.in` | Doctor | Consult, prescribe, sign. |
| `rakesh.iyer@sunriseclinic.in` | Doctor | Same, but **no registration number** — cannot sign. |
| `fatima.s@sunriseclinic.in` | Nurse | Vitals and allergies. Cannot diagnose or prescribe. |
| `owner@sunriseclinic.in` | Clinic Admin | Settings, staff, reports. Cannot sign a prescription. |
| `compliance@sunriseclinic.in` | Auditor | The audit trail. **No patient data at all.** |

Secrets have no defaults. Compose refuses to start and names the missing
variable, because a default secret is one that everyone who has ever cloned this
repository knows, and it works — which is how it reaches production.

Set `SEED_DEMO_DATA=false` for a real clinic. The shared drug catalogue still
seeds; the demo patients do not.

---

## What the demo data is

Not decoration. Every seeded patient is a fixture from
[the prototype verification script](./docs/phase-0/05-prototype-verification-script.md),
the scripted acceptance test this build is measured against:

- **`+91 98765 43210` carries three registered family members.** Searching that
  number at the front desk is how you find out whether the duplicate check works.
- **Mohd Imran and Mohammed Imran share a date of birth** on different numbers.
- **Lakshmi Narayanan is HIGH-criticality penicillin-allergic**, and the obvious
  prescription for a sore throat is a penicillin. Try prescribing Mox 500.
- **One patient has a stated age and no date of birth**, which is the common case
  and which most EMRs refuse to accept.
- **Govind Rao Deshpande is on enough medicines to overflow a prescription page.**

Seeding the traps means the system can be walked through the acceptance script
from the first minute, rather than demonstrated on clean data that hides the
failures the script exists to find.

---

## Verify it

Three suites, each testing something the others cannot.

```bash
# 1. The API, against the running stack: reads, auth, role separation
bash scripts/verify/all.sh                # 77 cases

# 2. Pure logic — safety checks, formatting, the RBAC matrix, colour contrast
pnpm --filter @emr/web test -- --run      # 112 cases

# 3. Every screen, every role, in a real browser
cd apps/web && npx playwright test        # 7 walks
```

The first two need `docker compose up` first. The browser suite starts its own
dev server and talks to the containerised API.

**Why the API suites run against a real Postgres and not a mock.** Every bug
found while wiring this up compiled cleanly and would have passed a unit test
with a mocked database: row-level security silently refusing a write, a session
cookie that is never read because Nest middleware under Fastify receives the raw
Node request, a timestamp arriving as a string from a raw query. A mock agrees
with whatever the code expects, which is exactly the thing under test.

**Why the browser suite exists.** Every screen is gated on a session that
resolves client-side, so the HTML the server returns is a loading spinner. A page
whose component throws on render still answers 200 with plausible markup —
checking status codes proved nothing, and a real render error shipped past it
once. So: a real browser, and any console error fails the run.

---

## How it is put together

```
apps/
  api/          NestJS on Fastify. Every request passes through tenant context,
                a deny-by-default RBAC guard, an audit interceptor and an
                RFC 9457 error filter — all registered globally in app.module.ts
                so enforcement can be verified from one file.
  web/          Next.js App Router. Holds no database connection and evaluates
                no permissions; app/api/[...path] forwards to the API with the
                session cookie attached, which is what lets the API sit on a
                private network.
packages/
  contracts/    Zod schemas and the RBAC matrix, compiled into BOTH sides. A
                field rename breaks the build rather than production.
  db/           Drizzle schema and the SQL migrations.
scripts/verify/ The API suites.
docs/phase-0/   The technical assessment, schema design and security spec.
```

### Tenant isolation

Every table carries `clinic_id` and every table has **forced** row-level
security. The predicate is
`clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid`, which
fails closed: with no context set, a query returns nothing rather than
everything.

Four database roles. The API connects as `emr_app`, created `NOBYPASSRLS` with no
DDL rights, so application code is structurally incapable of switching a policy
off. Migrations connect as a different role entirely, and the messaging worker
holds no privilege at all on `encounter_internal_note`.

`TenantDb.run()` is the only sanctioned path to the database. It opens a
transaction — which pins one pooled connection — and sets `app.clinic_id` as a
**transaction-local** setting, so the value is discarded at COMMIT and cannot
leak onto the next request that borrows the same connection. Issuing that setting
outside a transaction is the classic way multi-tenant RLS is silently defeated.

### The three places a tenant boundary is crossed

Sign-in, token refresh and share-link redemption all have to find a row before
any tenant exists, because the thing they are looking up is what establishes the
tenant. They do it through three `SECURITY DEFINER` functions in
[`0002_pre_tenant_resolvers.sql`](./packages/db/migrations/0002_pre_tenant_resolvers.sql),
owned by a `NOLOGIN` role, each answering one question and returning nothing but
identifiers. The caller then re-enters through the ordinary scoped path and reads
the row under RLS like everything else.

Every crossing in the system is one of those three function bodies, on one
screen, and the migration fails if a fourth appears.

---

## What it deliberately does not do

The prescribing module checks allergies (exact and by drug class), duplicate
therapy, and the teleconsultation prohibition. It does **not** check
drug-to-drug interactions, contraindication
against a recorded condition, weight-based paediatric dosing or pregnancy
category, because each needs a licensed formulary that has not been procured.

Nothing about those checks appears anywhere in the interface — not a disabled
panel, not a "coming soon", not an empty interactions section. A doctor who
believes interaction checking is running and sees no warning reasonably concludes
there is no interaction, and the product put them in that position. Absence of a
feature is honest; a non-functioning safety feature is not.

One of those four is different in kind. An allergy warning is clinical
judgement, so it blocks but can be overridden with a reason that is written into
the record. Schedule X drugs and narcotics in a teleconsultation are barred by
the Telemedicine Practice Guidelines — that is law, and there is no reason a
doctor can write down that makes it lawful, so the refusal has no override at
all. Offering a box to type one into would be offering to help break it.

The checks that do run are computed **on the server** and the server's result is
what gets stored. The browser runs the same checks against the same class table
in `@emr/contracts`, but that copy is for latency — a warning has to appear
before the doctor commits, not after.

---

## Known gaps

- **WhatsApp is wired but not connected.** The conversation model, the 24-hour
  window, template handling and the unlinked-message queue all exist and are
  seeded. There is no Business API credential, so nothing is actually sent.
- **No mail provider.** Inviting a staff member returns a one-time password to
  read out rather than pretending an email was sent.
- **Teleconsultation is recorded, not conducted.** A consultation can be marked
  remote — which enforces the Schedule X prohibition and adds the required
  declaration to the printed prescription — but there is no video calling in the
  product. The doctor uses whatever they already use.
- **Local disk object storage.** `STORAGE_DRIVER=s3` exists; the local driver is
  the default and is not suitable for more than one API replica.
- **`next build` fails on Windows without Developer Mode.** Next's standalone
  output needs symlink permission. The compile succeeds; only the copy step
  fails. Docker builds on Linux and is unaffected.

---

## Appearance

Light and dark, switchable from the header or Settings → My account. Three
states, not two: **System** follows the machine and is the default, **Light** and
**Dark** override it.

The third state matters on a clinic desktop that dims itself in the evening — on
System the app follows without a reload. The choice lives in `localStorage`, so
it is per browser and never reaches the server: the reason to want dark mode is
usually the room, not the person.

Dark is a separate palette rather than an inversion, and `theme.test.ts` measures
every foreground/background pair in both themes against WCAG 2.2 AA
programmatically — a dark mode nobody has measured is how the one warning that
matters ends up at 1.4:1.

---

## Ports

Deliberately not 5432 or 6379, so this stack cannot collide with a Postgres or
Redis already running on the machine.

| Service | Host port |
|---|---|
| Web | 3000 |
| API | 4000 |
| Postgres | 5433 |
| Redis | 6380 |

All four are overridable in `.env`.
