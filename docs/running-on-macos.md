# Running the Clinic EMR on macOS

A complete, tested walkthrough for getting this stack running on a Mac — Apple
Silicon or Intel. Follow it top to bottom the first time; after that you only
need [Daily use](#daily-use).

**Two things to know before you start.**

1. The product ships with **no data at all** — no clinics, no accounts, no demo
   patients. Nothing can be signed into until you create a clinic in
   [step 5](#5-create-your-first-clinic). That is deliberate: software that ships
   with a known account ships with a known way in.
2. `.env.example` has **seven** secrets and Docker Compose **refuses to start**
   without four of them. The generator in the root `README.md` only emits five.
   Use the command in [step 3](#3-generate-the-secrets) instead — it emits all
   seven.

---

## Contents

- [What you need](#what-you-need)
- [1. Install the prerequisites](#1-install-the-prerequisites)
- [2. Get the code](#2-get-the-code)
- [3. Generate the secrets](#3-generate-the-secrets)
- [4. Start the stack](#4-start-the-stack)
- [5. Create your first clinic](#5-create-your-first-clinic)
- [6. Create an operations-console account](#6-create-an-operations-console-account)
- [7. Sign in](#7-sign-in)
- [8. Turn on the optional modules](#8-turn-on-the-optional-modules)
- [Daily use](#daily-use)
- [Sending follow-up reminders](#sending-follow-up-reminders)
- [Developing with hot reload](#developing-with-hot-reload)
- [Running the tests](#running-the-tests)
- [Ports and URLs](#ports-and-urls)
- [Troubleshooting](#troubleshooting)
- [Resetting everything](#resetting-everything)
- [Appendix: what each secret does](#appendix-what-each-secret-does)

---

## What you need

| | Version | Why |
|---|---|---|
| **macOS** | 13 Ventura or newer | Anything that runs a current Docker |
| **Docker** | Compose v2 (`docker compose`, no hyphen) | Runs Postgres, Redis, the API and the web app |
| **Node.js** | **24 or newer** | Only needed to generate secrets and to run tests or hot reload |
| **pnpm** | 10.20.0 | Pinned by `packageManager`; `corepack` installs the right one |
| **RAM for Docker** | 4 GB minimum, 6 GB comfortable | Postgres 18 plus a Next.js production build |
| **Disk** | ~3 GB | Images, node_modules and a Postgres volume |

> **Apple Silicon (M1–M4):** nothing special to do. `postgres:18-alpine` and
> `redis:7-alpine` both publish native `arm64` images, so there is no
> `platform:` override and no Rosetta emulation anywhere in this stack.

---

## 1. Install the prerequisites

### Docker

Pick one. All three provide the `docker compose` command this project uses.

```bash
# Docker Desktop — the usual choice
brew install --cask docker
open -a Docker          # must be running before any compose command

# OrbStack — lighter and faster on Apple Silicon, drop-in replacement
brew install --cask orbstack

# colima — CLI only, no GUI
brew install colima docker docker-compose
colima start --cpu 4 --memory 6
```

If you chose **Docker Desktop**, give it enough memory or the Next.js build will
be killed part-way through:

> Docker Desktop → **Settings** → **Resources** → set **Memory** to at least
> **6 GB** → **Apply & restart**

Confirm Docker is up before continuing:

```bash
docker info > /dev/null && echo "Docker is running"
```

### Node.js 24 and pnpm

```bash
# Homebrew
brew install node@24
brew link --overwrite node@24

# …or fnm, if you juggle Node versions
brew install fnm
fnm install 24 && fnm use 24
```

`pnpm` comes from Corepack, which ships with Node — this pins the exact version
the repository expects rather than whatever is globally installed:

```bash
corepack enable
```

Check both:

```bash
node --version    # v24.x.x or higher
pnpm --version    # 10.20.0
```

---

## 2. Get the code

```bash
git clone <your-repository-url> emr
cd emr
```

> **Clone it. Do not copy the folder from a Windows machine.**
>
> `node_modules/` is gitignored, so a clone never carries it — but a zip, AirDrop
> or USB copy does. pnpm's `node_modules/.bin` entries are platform-specific:
> Windows gets `.cmd` and `.ps1` shims, and the Unix ones lose their execute bit
> crossing a filesystem that does not carry permissions. The result is
> `Permission denied` and `Exit status 126` the first time you run anything
> through pnpm. See [that entry in Troubleshooting](#pnpm-fails-with-permission-denied-and-exit-status-126).
>
> If you have already copied it, the fix is in that entry — you do not need to
> re-clone.

> **Where you put it matters on a Mac.** Keep the repository somewhere under your
> home directory. Docker Desktop shares `/Users` by default; a path under
> `/Volumes` or an external disk usually is not shared, and the bind mounts in
> `docker-compose.yml` will fail with a file-sharing error.

Install dependencies. You can skip this if you only ever want the Docker stack,
but you will need it for tests, hot reload and the secret generator:

```bash
pnpm install
```

---

## 3. Generate the secrets

```bash
cp .env.example .env
```

Now generate **all seven** secrets and write them into `.env` in one step:

```bash
node -e '
const c = require("crypto"), fs = require("fs");
const keys = [
  "ENCRYPTION_KEY",       // encrypts each clinic stored WhatsApp token
  "JWT_SECRET",           // signs access tokens
  "APP_DB_PASSWORD",      // the API role
  "WORKER_DB_PASSWORD",   // the messaging worker role
  "PLATFORM_DB_PASSWORD", // the operations console role
  "READONLY_DB_PASSWORD", // analytics and support
  "POSTGRES_PASSWORD",    // the migration/owner role
];
let env = fs.readFileSync(".env", "utf8");
for (const k of keys) {
  const secret = c.randomBytes(48).toString("base64url");
  env = env.replace(new RegExp("^" + k + "=.*$", "m"), k + "=" + secret);
}
fs.writeFileSync(".env", env);
console.log("Wrote " + keys.length + " secrets into .env");
'
```

Verify none were missed. This must print nothing — note the `^` and `=`, which
match an actual assignment rather than the `CHANGE_ME` mentioned in the comment
at the top of the file:

```bash
grep -E '^[A-Z_]+=CHANGE_ME' .env
```

> **Why seven separate secrets and not one.** `JWT_SECRET` is rotated routinely;
> rotating it signs everyone out, which is the point. `ENCRYPTION_KEY` protects
> each clinic's stored WhatsApp token — rotating *that* makes every stored token
> permanently unreadable and forces every clinic to reconnect. They are separate
> so the routine operation cannot cause the catastrophic one. The five database
> passwords belong to five roles with deliberately different privileges; see the
> [appendix](#appendix-what-each-secret-does).

> `.env` is gitignored and nothing in `.env.example` is a working secret. The API
> refuses to boot in production if it finds a development default.

---

## 4. Start the stack

```bash
docker compose up --build
```

First run takes roughly **4–6 minutes** — it pulls two images, installs
dependencies twice and produces a production Next.js build. Leave the terminal
open to watch the logs, or add `-d` to detach.

Four services come up in order. `migrate` runs once and exits `0`; that is
correct, not a crash:

```
postgres   healthy
redis      healthy
migrate    exited (0)   ← applies migrations, seeds the drug catalogue, stops
api        healthy
web        healthy
```

Check it in another terminal:

```bash
docker compose ps
curl -s -o /dev/null -w "api  %{http_code}\n" http://localhost:4000/v1/readyz
curl -s -o /dev/null -w "web  %{http_code}\n" http://localhost:3000/login
```

Both should report `200`. `readyz` proves Postgres answers, not merely that the
process started.

---

## 5. Create your first clinic

There are no accounts yet. This creates a clinic **and** its first administrator
in one transaction — a clinic with no administrator cannot be signed into, and an
administrator with no clinic is meaningless, so you never get one without the
other.

Run it **inside the api container**. That container already holds the right
database URL; running it on your Mac would reach for `localhost:5432` with a
default password and fail, because this stack deliberately publishes Postgres on
`5433` with a generated one.

```bash
docker compose exec api node dist/database/provision.js \
  --name "Sunrise Family Clinic" \
  --slug sunrise \
  --admin-email owner@sunriseclinic.in \
  --admin-name "Vikram Rao" \
  --city Pune --state Maharashtra --pincode 411005 \
  --phone "+912025530012"
```

It prints something like:

```
  Clinic created: Sunrise Family Clinic
  Slug:           sunrise
  Administrator:  Vikram Rao <owner@sunriseclinic.in>

  One-time password:  HjWrb7fHAV2Q
```

**Copy that password now.** It is not stored in plaintext and cannot be shown
again. No mail provider is connected, so nothing was emailed — read it out to the
administrator, who will be asked to change it on first sign-in. If it is lost,
issue a new one from the operations console (see
[step 6](#6-create-an-operations-console-account)) or re-run with a different
slug.

| Flag | Required | Notes |
|---|---|---|
| `--name` | yes | Display name |
| `--slug` | yes | The clinic's subdomain. Lower-case, digits, hyphens. Cannot be changed later |
| `--admin-email` | yes | Their sign-in |
| `--admin-name` | yes | |
| `--city` `--state` `--pincode` `--phone` | no | Settable later from Settings |
| `--registration-number` | no | Clinic registration, settable later |

Safe to run again for a *different* clinic. It refuses to overwrite an existing
slug, because a command someone runs twice by accident must not reset a live
clinic's administrator.

---

## 6. Create an operations-console account

The operations console is the vendor-side panel: clinics, plans, operators,
deployment settings and health. It is **a different identity system** — its own
table, cookie and database role — and it holds **no patient data at all**. That
is enforced by database privileges, not by hidden screens.

```bash
docker compose exec api node dist/database/provision-operator.js \
  --email ops@yourcompany.in \
  --name "Wasiq" \
  --role PLATFORM_ADMIN
```

It prints a one-time password with the same rules as above.

| Role | Can do |
|---|---|
| `SUPPORT` | Read clinics, usage, plans and health. Changes nothing |
| `OPERATOR` | Suspend and restore clinics, assign plans, edit the catalogue |
| `PLATFORM_ADMIN` | All of the above, plus manage operators, onboard clinics and reset a clinic administrator's password |

Default is `SUPPORT` if you omit `--role` — the least authority that does the job
is the right default for an account that reaches every customer.

> **Once you have a `PLATFORM_ADMIN`, you never need these CLI scripts again.**
> Everything they do is available in the console at
> **Clinics → Onboard a clinic** and **Clinic detail → Reset admin password**.

---

## 7. Sign in

| Panel | URL | Use the credential from |
|---|---|---|
| **Clinic** | <http://localhost:3000/login> | [Step 5](#5-create-your-first-clinic) |
| **Operations console** | <http://localhost:3000/platform/login> | [Step 6](#6-create-an-operations-console-account) |

Which panel a person lands in is decided by their role. There are seven:

| Role | Lands on | Panel |
|---|---|---|
| `OWNER_ADMIN` | `/today` | Clinic Admin |
| `DOCTOR` | `/today` | Doctor |
| `RECEPTIONIST` | `/today` | Front Desk |
| `NURSE_ASSISTANT` | `/today` | Nursing |
| `PHARMACIST` | `/pharmacy` | Pharmacy |
| `RESEARCH_ANALYST` | `/analytics` | Analytics |
| `AUDITOR` | `/audit` | Compliance |

Add staff from **Settings → Staff and roles** as the clinic administrator. Each
new account gets its own one-time password, shown once.

---

## 8. Turn on the optional modules

Every feature flag **defaults to off**. A brand-new clinic gets the core record —
patients, appointments, consultations, prescriptions — and nothing else, until a
plan grants more. That is a safe default, but it will look broken if you are not
expecting it.

Three plans are seeded for you:

| Plan | Monthly | Practitioners | Modules |
|---|---|---|---|
| `pilot` | ₹1,499 | 1 | Documents, billing, data export |
| `clinic` | ₹2,999 | 3 | + WhatsApp, reports |
| `clinic-plus` | ₹4,999 | 8 | Everything — broadcasts, teleconsultation, pharmacy, analytics, multi-location |

Assign one in the console:

**Operations console → Clinics → your clinic → Plan → Set a plan**

To switch a single module on for one clinic without changing its plan, use
**Modules → Change modules** on the same screen. Each module is three-state:

- **Inherit** — follow the plan, so a later plan change reaches this clinic
- **On** / **Off** — set for this clinic specifically, regardless of plan

Dependencies apply automatically: turning on Broadcasts turns on WhatsApp,
because a broadcast with no channel does nothing.

---

## Daily use

```bash
# Start (detached)
docker compose up -d

# Follow logs
docker compose logs -f api
docker compose logs -f web

# Stop, keeping the database
docker compose down

# Restart one service
docker compose restart api

# A shell inside a container
docker compose exec api sh
docker compose exec postgres psql -U emr_migrator -d emr
```

### Sending follow-up reminders

Reminders are scheduled when a consultation is signed, and sent by a separate
endpoint that nothing calls on its own. For development, calling it by hand is
usually enough:

```bash
# Reads JOBS_SECRET out of the .env the stack was started with.
curl -fsS -X POST http://localhost:4000/v1/jobs/run-due \
  -H "Authorization: Bearer $(grep '^JOBS_SECRET=' .env | cut -d= -f2-)"
```

It prints counts — `{"claimed":3,"sent":2,"skipped":1,"failed":0,"recovered":0}`
— and is safe to run as often as you like, including twice at once. Rows are
claimed before anything is sent, and the send carries an idempotency key, so a
patient cannot receive the same reminder twice.

If you want it running on a schedule on your Mac, `launchd` rather than `cron`
is the native way. Save this as
`~/Library/LaunchAgents/local.emr.reminders.plist`, with your own secret in
place of the placeholder:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.emr.reminders</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/curl</string>
    <string>-fsS</string>
    <string>-X</string><string>POST</string>
    <string>http://localhost:4000/v1/jobs/run-due</string>
    <string>-H</string>
    <string>Authorization: Bearer PUT_YOUR_JOBS_SECRET_HERE</string>
  </array>
  <key>StartInterval</key><integer>600</integer>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
```

Then:

```bash
launchctl load ~/Library/LaunchAgents/local.emr.reminders.plist
launchctl list | grep local.emr.reminders      # confirm it is registered
launchctl unload ~/Library/LaunchAgents/local.emr.reminders.plist   # to stop
```

`StartInterval` is seconds, so 600 is every ten minutes. `RunAtLoad` is false on
purpose — loading the agent should not fire a send immediately, because the
first thing you do after editing the plist is reload it.

**Nothing is actually delivered unless a clinic has connected WhatsApp.** Without
a credential the client simulates the send and logs at warn; the reminder and the
message row still record their real lifecycle, which is what makes the behaviour
testable locally. A clinic also needs an approved template named
`follow_up_reminder`, and without one the reminder fails saying so.

### After you change code

| You changed | Do this |
|---|---|
| API source | `docker compose build api && docker compose up -d api` |
| Web source | `docker compose build web && docker compose up -d web` |
| A `packages/db` schema file | `pnpm db:generate`, then `docker compose build migrate && docker compose run --rm migrate` |
| A hand-written migration in `packages/db/migrations` | `docker compose build migrate && docker compose run --rm migrate` |
| `.env` | `docker compose up -d --force-recreate` |

> **Migrations are baked into the image.** The migration runner reads them from
> the installed `@emr/db` package inside the container, so a new `.sql` file on
> your Mac is invisible until you rebuild `migrate`. If a migration you just
> wrote is skipped, that is why.

**Always read the build output, not just its last line.** A failed
`docker compose build` leaves the previous image in place and prints nothing
conclusive at the end, so the container keeps serving stale code and your new
pages return `404`. This is the single most confusing failure mode in this
project:

```bash
docker compose build web 2>&1 | grep -iE "error|failed" || echo "build clean"
```

---

## Developing with hot reload

The Docker stack runs a production build, which is right for checking behaviour
and wrong for writing code. For hot reload, run Postgres and Redis in Docker and
the two apps on your Mac.

```bash
# 1. Infrastructure only.
#
#    `up -d postgres redis` does NOT stop api and web if they are already
#    running — they keep holding 4000 and 3000, and `pnpm dev` below will
#    collide with them. Stop them explicitly.
docker compose stop api web
docker compose up -d postgres redis

# 2. Apply migrations from the host.
#    The port and password come from your .env, not from the defaults.
export MIGRATION_DATABASE_URL="postgres://emr_migrator:$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)@localhost:5433/emr"
pnpm db:migrate
pnpm db:seed

# 3. Both apps, with reload
pnpm dev
```

`pnpm dev` runs the API on **4000** and the web app on **3000** — the same ports
the Docker stack uses, which is why step 1 stops those two containers.

The API needs its own environment when run this way. Create `apps/api/.env`:

```bash
cat > apps/api/.env <<EOF
DATABASE_URL=postgres://emr_app:$(grep '^APP_DB_PASSWORD=' .env | cut -d= -f2-)@localhost:5433/emr
MIGRATION_DATABASE_URL=postgres://emr_migrator:$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)@localhost:5433/emr
PLATFORM_DATABASE_URL=postgres://emr_platform:$(grep '^PLATFORM_DB_PASSWORD=' .env | cut -d= -f2-)@localhost:5433/emr
REDIS_URL=redis://localhost:6380
JWT_SECRET=$(grep '^JWT_SECRET=' .env | cut -d= -f2-)
ENCRYPTION_KEY=$(grep '^ENCRYPTION_KEY=' .env | cut -d= -f2-)
STORAGE_DRIVER=local
STORAGE_LOCAL_PATH=/tmp/emr-objects
PUBLIC_BASE_URL=http://localhost:3000
CORS_ORIGINS=http://localhost:3000
EOF
```

Other useful commands:

```bash
pnpm typecheck      # every package
pnpm lint           # every package
pnpm build          # production build of everything
pnpm dev:api        # API only
pnpm dev:web        # web only
```

---

## Running the tests

### Unit tests — no stack needed

```bash
pnpm --filter @emr/web test
```

132 tests. Covers the permission matrix, navigation boundaries for every panel,
WCAG contrast on both themes, formatting and prescribing-safety rules.

### API suites — stack must be up

These build a clinic, exercise it and delete it again, so they never depend on
data they did not create:

```bash
docker compose up -d
bash scripts/verify/all.sh
```

Expect **120 passing** across four suites:

| Suite | Assertions | Checks |
|---|---|---|
| `api-reads.sh` | 42 | Reads, authentication, role separation |
| `consultation-flow.sh` | 41 | Front desk → signed prescription → paid invoice |
| `broadcast.sh` | 15 | Consent gate, deduplication, a real send |
| `platform.sh` | 22 | The operations console and the boundary it sits behind |

**Run them through `all.sh`, not individually.** Only `all.sh` derives
`MIGRATION_DATABASE_URL` from your `.env` and builds the fixture clinic the other
three read from; called directly they fail on password authentication. If you do
need one on its own, export the URL and create fixtures first:

```bash
export MIGRATION_DATABASE_URL="postgres://emr_migrator:$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)@localhost:5433/emr"

# `up` prints `export VAR=...` lines rather than writing a file, so eval them
# into your shell — that is how the suites receive the clinic id and credentials.
eval "$(node scripts/verify/fixtures.mjs up)"

bash scripts/verify/api-reads.sh

# Always tear down, even after a red run.
node scripts/verify/fixtures.mjs down "$VERIFY_CLINIC_ID"
```

The fixture clinic is deleted at the end of every run, including a failing one,
so a red suite never leaves a tenant behind.

### Browser suite

```bash
pnpm --filter @emr/web exec playwright install chromium   # first time only
bash scripts/verify/browser.sh
```

It starts its own dev server on port **3210** so it cannot disturb anything you
have open on 3000.

---

## Ports and URLs

Every port is **deliberately non-default**, so this stack cannot collide with a
Postgres or Redis you already run on your Mac.

| Service | Host port | Container | Change via |
|---|---|---|---|
| Web | **3000** | 3000 | `WEB_PORT` |
| API | **4000** | 4000 | `API_PORT` |
| Postgres | **5433** | 5432 | `POSTGRES_PORT` |
| Redis | **6380** | 6379 | `REDIS_PORT` |
| Playwright dev server | 3210 | — | `playwright.config.ts` |

| URL | |
|---|---|
| <http://localhost:3000/login> | Clinic sign-in |
| <http://localhost:3000/platform/login> | Operations console |
| <http://localhost:4000/v1/healthz> | Process is alive |
| <http://localhost:4000/v1/readyz> | Postgres answers |

Connect a GUI client such as TablePlus or Postico:

```
Host      localhost
Port      5433
Database  emr
User      emr_migrator
Password  the POSTGRES_PASSWORD value in .env
```

> Connecting as `emr_migrator` **bypasses nothing** — every tenant table is under
> `FORCE ROW LEVEL SECURITY`, which applies to the table owner too. Without
> `app.clinic_id` set you will see zero rows, not all rows. That is the isolation
> working, not a broken connection. To look at one clinic's data:
>
> ```sql
> SELECT set_config('app.clinic_id', '<clinic-uuid>', false);
> SELECT full_name FROM patient;
> ```

---

## Troubleshooting

### `docker compose up` exits immediately naming a variable

```
error while interpolating services.api.environment: required variable
PLATFORM_DB_PASSWORD is missing a value
```

A secret is still `CHANGE_ME` or absent. Compose requires four of the seven
outright: `ENCRYPTION_KEY`, `JWT_SECRET`, `APP_DB_PASSWORD`,
`PLATFORM_DB_PASSWORD`. Re-run the generator in
[step 3](#3-generate-the-secrets), then `grep -E '^[A-Z_]+=CHANGE_ME' .env` must
print nothing.

### pnpm fails with `Permission denied` and `Exit status 126`

```
sh: /Users/you/EMR/apps/api/node_modules/.bin/tsx: Permission denied
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @emr/api@0.1.0 migrate: `tsx src/database/migrate.ts`
Exit status 126
```

Exit code **126** means the file was found but is not executable. You copied the
project from another machine — almost always Windows — and `node_modules` came
with it, so the binaries in `.bin` are either Windows shims or Unix files that
lost their execute bit in transit.

Rebuild them natively:

```bash
rm -rf node_modules apps/*/node_modules packages/*/node_modules
pnpm install
```

Nothing else is affected: your `.env`, the Docker images and the database are all
fine, because none of them come from `node_modules`. If `emr-migrate-1` has
already exited `0`, your schema is up to date and you may not need the host-side
migrate command at all — it belongs to the
[hot-reload path](#developing-with-hot-reload), not to the Docker one.

### `Bind for 0.0.0.0:3000 failed: port is already allocated`

Something else owns the port. Find it and either stop it or move ours:

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN
```

Then edit `WEB_PORT` in `.env` and `docker compose up -d --force-recreate web`.

### `Cannot connect to the Docker daemon`

Docker is not running. `open -a Docker` (or `colima start`) and wait for it to
report ready.

### New pages return 404 after a rebuild

The build failed and Compose kept the previous image. Read the output properly:

```bash
docker compose build web 2>&1 | grep -iE "error|failed"
```

The usual cause is a lint error — `react/no-unescaped-entities` on an apostrophe
or a quote inside JSX text is the most common. Fix it, rebuild, then
`docker compose up -d --force-recreate web`.

### A migration I just wrote is skipped

Migrations live inside the image. Rebuild the runner:

```bash
docker compose build migrate && docker compose run --rm migrate
```

If it is *still* skipped, Docker reused a cached source layer:

```bash
docker compose build --no-cache migrate && docker compose run --rm migrate
```

### `provision.js` fails to connect from my Mac

Its fallback URL is `localhost:5432` with a default password, and this stack uses
`5433` with a generated one. Run it inside the container as shown in
[step 5](#5-create-your-first-clinic), or export `MIGRATION_DATABASE_URL` first.

### A query returns zero rows and I know the data is there

Tenant isolation, working as designed. See the note under
[Ports and URLs](#ports-and-urls) about `app.clinic_id`.

### A feature is missing from the clinic panel

Its flag is off. Check **Operations console → Clinics → your clinic → Modules**.
Everything defaults to off until a plan grants it — see
[step 8](#8-turn-on-the-optional-modules).

### The API is healthy but the web app shows nothing

The browser reaches the API through the web app's own `/api` proxy. Confirm
`CORS_ORIGINS` and `PUBLIC_BASE_URL` in `.env` both match the URL you are
actually using, then `docker compose up -d --force-recreate web`.

### Builds are killed part-way through

Docker has too little memory. Raise it to 6 GB in Docker Desktop → Settings →
Resources, or `colima start --memory 6`.

---

## Resetting everything

```bash
# Stop and delete the containers, keep the database
docker compose down

# Delete the database and the uploaded files too — everything goes
docker compose down -v

# Also remove the built images
docker compose down -v --rmi local
```

After `down -v` you are back to a blank deployment: re-run
[step 4](#4-start-the-stack) onward, including provisioning. Nothing survives,
by design.

---

## Appendix: what each secret does

Five database passwords, because there are five roles with deliberately
different privileges. The separation is the security model, not bookkeeping.

| Variable | Role | What it can do |
|---|---|---|
| `POSTGRES_PASSWORD` | `emr_migrator` | Owner. Runs DDL. The application never holds it |
| `APP_DB_PASSWORD` | `emr_app` | The API. `NOBYPASSRLS`, no DDL — structurally incapable of disabling a tenant policy |
| `WORKER_DB_PASSWORD` | `emr_worker_messaging` | Reminders. Holds **no privilege** on `encounter_internal_note` |
| `PLATFORM_DB_PASSWORD` | `emr_platform` | The console. `BYPASSRLS`, but granted on only seven platform tables — it cannot read a patient because it has no grant to |
| `READONLY_DB_PASSWORD` | `emr_readonly` | `SELECT` only, for analytics and support |

| Variable | Protects | Rotation consequence |
|---|---|---|
| `JWT_SECRET` | Access tokens | Everyone is signed out. Routine |
| `ENCRYPTION_KEY` | Each clinic's stored WhatsApp token | **Every stored token becomes unreadable** and every clinic must reconnect. Not routine |

That last row is why the two are separate variables: an operation you want to do
monthly must not trigger one you can never undo.
