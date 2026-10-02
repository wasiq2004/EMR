# Phase 3 — Calendar, clinical capture, follow-up and money

A plan, not a build. Written after reading the existing scheduling, clinical and
billing code rather than from the request alone, because four of the seven asks
are partly built already and two of them cannot work as described without
infrastructure this product does not have.

Read [Before anything is built](#before-anything-is-built) first. Three questions
there changed what gets made; all three are now answered and recorded in
[§3 Decisions](#3-before-anything-is-built).

**Decided 2026-10-02:**

| Question | Answer |
|---|---|
| Doctor registration number | **Optional and visible** — which is current behaviour, so no change |
| Reminder channel | **WhatsApp now, email later** — channel-agnostic machinery, email stubbed |
| Scheduler | **Cron calls `POST /jobs/run-due`** — idempotent, matches usage aggregation |

---

## 1. What already exists

More than the request assumes. Worth knowing before scoping.

| Already built | Where |
|---|---|
| `appointment` with `scheduled_start` / `scheduled_end`, `arrived_at`, `called_at`, `completed_at`, `queue_position`, `is_walk_in` | `schema/patient.ts` |
| Status machine: `SCHEDULED → CONFIRMED → ARRIVED → IN_PROGRESS → FULFILLED`, plus `CANCELLED` / `NOSHOW` | `schema/shared.ts` |
| Appointment list, booking form, live queue screen | 139 / 222 / 280 lines of UI |
| **Slot length already comes from the service** — `service_item.default_duration_minutes` | booking form |
| Vitals as `observation` — code, system, display, numeric value, unit, reference range | `schema/clinical.ts` |
| Diagnosis as `condition` — code, code system, display text, chronic flag, onset | `schema/clinical.ts` |
| Drugs as `medication_request` — dose, frequency, duration, route, food timing, instructions | `schema/clinical.ts` |
| **`follow_up_after_days` and `follow_up_instructions` already on `encounter`** | `schema/clinical.ts` |
| Invoices, line items, payments, part-payment and refunds | `modules/billing` |
| WhatsApp template sending, consent-gated | `modules/comms` |

So the work is narrower than it looks in three places and wider in two.

---

## 2. What does not exist, and blocks parts of the request

### 2.1 There is no scheduler. Nothing in this product runs on a timer.

The only `setInterval` in the API is the SSE heartbeat. Usage aggregation is a
`POST` endpoint that an external scheduler is *expected* to call, and nothing
calls it.

**This blocks follow-up reminders entirely.** A reminder is by definition a thing
that happens later with nobody present. Storing a follow-up date is easy and
already half-built; *delivering* a message on that date needs a process that wakes
up. Options in [§4.3](#43-follow-up-and-reminders).

### 2.2 There is no mail provider.

Nothing SMTP, SES, SendGrid or otherwise. `otp.service.ts` logs the code instead
of sending it, and says so. **Email reminders cannot be delivered today.**
WhatsApp can.

### 2.3 There is no lab module.

No `lab_order`, no `lab_result`, no `imaging_*`. "Lab reports, lab" in the request
is a module, not a field — the blueprint scoped it at roughly the size of the
pharmacy module that took this project a full phase.

### 2.4 There is no practitioner availability model.

No working hours, no days off, no per-doctor session pattern. A calendar without
it will cheerfully offer 3am on a Sunday, and "completely customizable" slots have
nothing to be customized *against*.

### 2.5 There is no diagnosis code catalogue.

`condition.code` and `condition.code_system` exist; nothing populates them. The
only catalogue in the product is `drug_catalogue_item` (49 seeded molecules).
**Typeahead for diagnosis has nothing to read from.**

### 2.6 There is no `CHECKED_OUT` status.

The machine ends at `FULFILLED`, set when the doctor finalises. The request wants
reception to close the visit explicitly, which is a state after that.

---

## 3. Before anything is built

Three answers change the shape of the work. The first is not a preference — it is
a conflict in the request.

### 3.1 The doctor registration number — this one contradicts itself

> "Doctor register number should be requested. dont make it required. have it in
> optional but not visible."

Three problems, in order of seriousness:

1. **Not visible means nobody can enter it.** A field that is requested and
   invisible is a field that stays empty.
2. **The system requires it to sign.** `REQUIRES_MEDICAL_REGISTRATION` gates
   `encounter:finalize` and `prescription:sign`. A doctor without one cannot
   finalise a consultation or sign a prescription — not as a rule we invented, but
   because the registration number is a legally required element of a valid Indian
   e-prescription and would otherwise print blank on the document.
3. **So "optional and invisible" means no doctor at this clinic can ever complete
   a consultation.** The staff screen already warns about exactly this.

What was probably meant is one of these. It needs deciding before the staff form
is touched:

| Option | Effect |
|---|---|
| **Optional and visible** ← **CHOSEN** | Add a doctor without it; they cannot sign until it is filled in; the existing warning tells them why. **No code change needed — this is current behaviour.** |
| Optional, visible only to Clinic Admin | The doctor does not see their own number; an administrator maintains it. Small change. |
| Optional and the signing gate removed | Doctors sign without a registration number. Prescriptions print with a blank statutory field. **Not advisable**, and a decision for you to make explicitly rather than for me to infer. |

### 3.2 Reminders — which channel, and what runs them

Email is not deliverable today. Two independent decisions:

**Channel — DECIDED: WhatsApp now, email later.** The reminder machinery is built
channel-agnostic: `scheduled_reminder.channel` is an enum of `WHATSAPP | EMAIL`,
WhatsApp delivers, and an email attempt records a `FAILED` row reading "no mail
provider configured" rather than vanishing. Connecting a provider later is then a
service implementation and a config value, not a rewrite.

**Scheduler.** A reminder needs something that wakes up. Three ways, cheapest
first:

| Approach | Cost | Trade-off |
|---|---|---|
| In-process timer in the API | None | Dies with the container; fires twice if you run two API replicas |
| **A `POST /jobs/run-due` endpoint plus the host's cron** ← **CHOSEN** | Near none | Needs a cron entry on the server; this is how usage aggregation is already designed |
| A queue with a worker (BullMQ on the existing Redis) | A worker container | Correct under replicas, retries, visible failures |

The second matches the grain of what is already here and is what was chosen. It
must be **idempotent** — a cron that fires twice, or a retry after a timeout, must
not message a patient twice. The reminder row is claimed with a conditional
`UPDATE ... WHERE status = 'PENDING'` before the send, so a second caller finds
nothing to claim.

### 3.3 Reminders to the admin's phone

Deliverable, with three caveats worth knowing before it is promised to anyone:

- WhatsApp Business API only allows **pre-approved template messages** outside a
  24-hour window. An admin notification needs its own template, approved by Meta.
- The admin's number must be a real WhatsApp number.
- It sends **patient information to a personal phone**. Fine — it is the clinic's
  own data — but it should be a setting a clinic turns on, not a default, and it
  should be in the audit trail.

---

## 4. The plan

Ordered so that each stage is usable on its own, and so the stages that need
decisions come after the ones that do not.

### 4.1 Stage A — Practitioner availability (foundation for the calendar)

A calendar is not meaningful without it.

- `practitioner_schedule`: practitioner, location, weekday, start, end, slot
  minutes, effective dates — a doctor's recurring pattern
- `schedule_exception`: a date, a reason, optional replacement hours — leave,
  holidays, a one-off late start
- Derive bookable slots from pattern minus exceptions minus booked appointments
- Settings → Doctor schedules, under Clinic Admin

**Why first:** without it, "15-minute slots, completely customizable" has nothing
to customize. Slot length becomes per-doctor-per-session rather than a constant.

### 4.2 Stage B — The calendar

- `GET /calendar` returning appointments plus derived free slots for a range
- Views: **day, 3-day, week, month**, and a **per-doctor column** day view, which
  is the one a three-doctor clinic actually uses
- Click an empty slot → booking dialog pre-filled with that doctor, date and time
- Drag to resize or move → reschedule, with a confirmation because it moves a
  patient's appointment
- Filters: doctor, location, status, appointment type, "mine only"
- Day analytics strip above the grid: booked / arrived / in consultation /
  completed / no-show / cancelled, free slots remaining, utilisation %
- **Where it appears:** Doctor panel (their own by default, toggle to all),
  Front Desk (all doctors by default). *Not* Pharmacy or Analytics — neither role
  holds `appointment:read`
- Live updates over the existing SSE pipe, so a booking made at the front desk
  appears on the doctor's calendar without a refresh

### 4.3 Stage C — Check-in and check-out

- Add `CHECKED_OUT` to the status enum
- Front desk: **Check in** (`SCHEDULED/CONFIRMED → ARRIVED`, sets `arrived_at`,
  puts them in the queue) and **Check out** (`FULFILLED → CHECKED_OUT`)
- Doctor's "start consultation" already moves `ARRIVED → IN_PROGRESS`
- Finalising already moves it to `FULFILLED`

**One question embedded here:** should check-out require the consultation to be
finalised, and should it prompt to raise the invoice? My reading of the request is
yes to both — check-out is the moment the visit is commercially and clinically
closed. Flagging it because it is a rule, not a button.

### 4.4 Stage D — Clinical capture with typeahead

The fields exist; the capture experience does not.

- **Vitals**: a structured grid — BP, pulse, temperature, SpO₂, weight, height,
  BMI derived — with units fixed per measure so a range filter means something
  later. The data-quality screen already measures unit completeness and will show
  this improving.
- **Diagnosis**: typeahead over a diagnosis catalogue, **plus free text**. Needs a
  new `diagnosis_catalogue` table and a seeded ICD-10 subset — the full ICD-10 is
  ~70,000 codes and useless at a clinic counter; a curated 1,500-code Indian
  outpatient subset is the right size. Free text is always allowed and is stored
  as `display_text` with a null `code`, which is exactly what the data-quality
  metric already counts.
- **Drugs**: typeahead already exists over `drug_catalogue_item`; add structured
  dose / frequency / duration / route pickers with free text allowed, and
  "add to catalogue" for a molecule the clinic uses that is not there
- **The pattern throughout**: pick from the list *or* type your own. A clinic that
  cannot record what it saw because the dropdown lacks it will stop using the
  product.

### 4.5 Stage E — Follow-up and reminders

- Follow-up picker on the consultation screen — optional, as asked. Quick choices
  (1 week, 2 weeks, 1 month, 3 months) plus a date. **The columns already exist.**
- `scheduled_reminder`: what, to whom, when, channel, status, attempts, sent-at
- A `POST /jobs/run-due` endpoint that sends anything due, idempotent, driven by
  host cron (pending [§3.2](#32-reminders--which-channel-and-what-runs-them))
- Reminder to the patient over WhatsApp, consent-gated like everything else
- Optional copy to the clinic's admin number, off by default
- A visible log: what was sent, to whom, whether it landed. The existing
  `communication` table already models delivery state

### 4.6 Stage F — Billing from the visit

Billing exists; the connection to the visit does not.

- Raise an invoice from the consultation and from check-out, pre-filled from the
  service on the appointment
- Patient billing tab: all invoices, what is paid, what is outstanding
- Part-payment and refunds already work

### 4.7 Stage G — Clinic Admin analytics

Currently one `summary` endpoint over 14 days.

- Date range, doctor, location, service, payment method filters
- **Revenue**: collected, outstanding, by method, by doctor, by service
- **Patients**: new vs returning, registrations over time
- **Appointments**: booked, completed, no-show rate, cancellation rate,
  utilisation against available slots — which Stage A makes computable
- **Invoice summary**: raised, settled, outstanding ageing
- CSV export of each

### 4.8 Stage H — Lab (separate, and larger)

`lab_order`, `lab_result`, reference ranges, abnormal flagging, report attachment,
and the doctor's "results to review" card that the blueprint lists as a P0 and
that cannot exist without this.

**Scoped separately on purpose.** It is comparable in size to the pharmacy module.
Putting it in the same stage as a calendar would mean neither lands.

---

## 5. Sequencing

| Stage | Depends on | Rough size |
|---|---|---|
| A — Availability | — | Small |
| B — Calendar | A | Large |
| C — Check-in/out | — | Small |
| D — Clinical capture | Diagnosis catalogue | Medium–large |
| E — Follow-up + reminders | §3.2 decision | Medium |
| F — Billing from visit | — | Small–medium |
| G — Admin analytics | A, for utilisation | Medium |
| H — Lab | — | Large, separate |

C and F are small and independent — they can land first and be useful
immediately. A → B is the longest pole. H should not start until the rest is done.

---

## 6. Where this matches Practo Ray, and where it deliberately does not

From the competitive study already in `docs/`:

**Matching:** calendar plus queue as the operational spine, role-based access,
prescription-to-invoice linkage, reports across appointments, patients, income and
payments.

**Deliberately different:** this product's reminders are consent-gated per patient
and per purpose, because Indian DPDP consent is modelled explicitly here rather
than as a clinic-wide setting. And analytics stay de-identified for the analyst
role. Both are existing decisions this phase should not quietly undo.

---

## 7. What I am NOT doing without an answer

- Touching the doctor registration field — [§3.1](#31-the-doctor-registration-number--this-one-contradicts-itself)
  has to resolve first, because two of the three readings break prescribing
- Building email reminders — there is nothing to send them with
- Starting the lab module — too large to bundle
