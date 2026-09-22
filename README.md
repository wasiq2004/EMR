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

Nothing can be signed into yet: there are no clinics and no accounts. Create
one.

```bash
pnpm --filter @emr/api provision \
  --name "Sunrise Family Clinic" \
  --slug sunrise \
  --admin-email owner@sunriseclinic.in \
  --admin-name "Vikram Rao" \
  --city Pune --state Maharashtra --pincode 411005 --phone "+912025530012"
```

It prints a one-time password. Read it out rather than sending it — no mail
provider is connected, and saying so plainly beats pretending an email was sent.
It is not stored in plaintext and cannot be shown again. Then open
<http://localhost:3000> and sign in.

Everything else — staff, services, consent text, the WhatsApp number — is set up
from Settings by that administrator.

Secrets have no defaults. Compose refuses to start and names the missing
variable, because a default secret is one that everyone who has ever cloned this
repository knows, and it works — which is how it reaches production.

---

## What ships in the database

Nothing but the drug catalogue.

There are no clinics, no patients and no accounts. A system that ships with a
fictional clinic inside it invites two failures: it gets demonstrated against
records shaped to make the demonstration work, and sooner or later a real
deployment carries invented patients alongside real ones with nothing marking
which is which.

The catalogue is reference data rather than sample data — without it the
prescribing screen has nothing to search. It is a working list for an Indian
outpatient clinic and explicitly **not** a licensed formulary: no interaction
data, no contraindications, no paediatric dosing, no pregnancy categories. That
is exactly why the prescribing module performs none of those checks and the
interface shows nothing about them.

---

## Verify it

Three suites, each testing something the others cannot. Each run builds a clinic,
asserts against it, and deletes it.

```bash
docker compose up -d

bash scripts/verify/all.sh       # 120 API cases across four suites
bash scripts/verify/browser.sh   # 7 walks, every screen, every role

pnpm --filter @emr/web test -- --run   # 112 cases of pure logic
```

**The suites create their own data.** `scripts/verify/fixtures.mjs` provisions a
clinic with a random slug, registers patients through the real API — including
the acceptance traps: three family members on one number, a HIGH-criticality
penicillin allergy, a patient with a stated age and no date of birth — and
removes the whole tenant afterwards, even when a suite fails.

Building fixtures through the API rather than by insert means the fixture itself
proves the path works: a patient cannot be registered without a duplicate check
having run, because the server enforces that.

Three things are written directly, because no API can create them: an inbound
WhatsApp conversation arrives by webhook, an approved template is approved by
Meta, and consent is captured on paper.

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

- **WhatsApp is connectable but this deployment has no credential.** A clinic
  connects its own number in Settings; the credential is verified against Meta
  before it is stored. Without one the client SIMULATES sending — every message
  is recorded with its real lifecycle, each simulated send is logged at warn,
  and the settings screen says "Recorded only" rather than "Live". Nothing ever
  reports a delivery that did not happen.
- **No mail provider.** Provisioning a clinic and inviting a staff member both
  return a one-time password to read out rather than pretending an email was
  sent.
- **No reminder scheduling.** There was a settings screen for it that reported
  "Reminder settings saved" and made no request at all; it has been removed
  rather than left in place looking functional. The rules, the scheduler and
  the quiet-hours window still need building.
- **No inbound webhook.** Delivery receipts never arrive, so a message shows as
  sent and never advances to delivered or read.
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

## The operations console

A second application at `/platform`, for whoever runs the deployment rather than
a clinic. Overview of the estate, every clinic with its plan and usage, suspend
and restore, plan changes, and an append-only log of what operators did.

```bash
pnpm --filter @emr/api provision-operator   --email ops@yourcompany.in --name "Your Name" --role PLATFORM_ADMIN
```

**It holds no patient data.** Not redacted, not access-logged — absent. That is
enforced by a grant, not a policy: the console runs on its own connection as
`emr_platform`, a role with privileges on five platform tables and on `clinic`,
and none at all on `patient`, `encounter`, `communication` or `app_user`. It
cannot read a medical record because the database refuses, and
`0005_platform_plane.sql` asserts that grant list on every migration — add a
privilege to a clinical table and the deployment fails rather than shipping a
console that can read records.

Activity inside a clinic is visible only as `clinic_usage_daily`: integers and a
date, written by a job that runs inside each tenant's own context. The console
reads counts. It never reads rows.

The two identity systems are separate — different table, different cookie,
different token audience. A clinic administrator gets 401 on every console
endpoint and an operator gets 401 on every clinical one, both verified in
`scripts/verify/platform.sh`.

Changing a clinic's state requires a written reason, because suspending one
stops a doctor mid-consultation. The reason goes into a log the clinic can be
shown and that no operator can edit — a trigger rejects UPDATE and DELETE.

**What it deliberately cannot do:** impersonate a clinic user, read a clinic's
own audit trail, or open a patient record. Supporting a clinic that needs
someone to look at their data is a break-glass procedure at the infrastructure
level, time-boxed and separately logged — not a button in a console.

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
