# Phase 0 Prototype Verification Script

**Document:** Phase 0, Task 4
**Audience:** the session facilitator, the observer, and the pilot participants
**Format:** moderated, think-aloud, 60 minutes per clinic
**Participants:** 5 pilot doctors (plus their receptionists — see §2.2)
**Date:** 2026-09-15

---

## 1. Why this runs before Phase 1

Risk **R6 — doctor adoption failure** is the highest-scoring risk in the
register (`02 §3`), and it is the only one that architecture cannot mitigate. A
doctor who finds the encounter screen slower than a paper pad abandons the
product in week two, and no amount of correct multi-tenancy compensates.

This script exists to find that out now, against a clickable prototype, rather
than after 16 weeks of engineering.

### 1.1 What is being measured

| # | Measure | Target | Why this number |
|---|---|---|---|
| M1 | New patient registration, end to end | **< 60 s** | The SoW constraint. Above this, the front desk reverts to a paper register during morning rush |
| M2 | Duplicate correctly identified before creating a record | **5 of 5 participants** | Risk R4. A miss here means a split clinical record |
| M3 | Time to first meaningful action on the Snapshot | **< 15 s** | If orientation takes longer, doctors stop opening it |
| M4 | Allergy contraindication noticed **before** signing | **5 of 5** | Safety-critical. A single miss blocks Phase 1 sign-off |
| M5 | Complete encounter + prescription + sign | **< 4 min** | A typical Indian OPD consultation is 5–8 minutes total |
| M6 | Unprompted task completion (no facilitator help) | **≥ 80% of steps** | Measures whether the UI teaches itself |
| M7 | SUS score | **≥ 68** | Industry median; below this, redesign before building |

### 1.2 What is explicitly NOT being measured

Visual design preferences, colour, logo placement, and feature requests. Capture
them in the parking lot (§8) and move on. This session is about whether the
workflow is faster than paper.

---

## 2. Before the session

### 2.1 Recruitment criteria

Five doctors, deliberately varied — five enthusiasts will tell you the product
is wonderful and teach you nothing:

| Slot | Profile | Purpose |
|---|---|---|
| 1 | Solo GP, currently on **paper** | The core market and the hardest conversion |
| 2 | Solo GP, currently on **another EMR** | Surfaces migration friction and unfavourable comparisons |
| 3 | 2–3 doctor practice with a **dedicated receptionist** | Tests the multi-user queue handoff |
| 4 | Specialist (paediatrician or dermatologist) | Higher prescription complexity; weight-based dosing |
| 5 | Doctor aged **50+, self-described low computer confidence** | The strongest test of M6. If this participant succeeds, the UI is genuinely learnable |

Include at least one doctor who prescribes in a regional script (Hindi, Tamil,
Telugu or Bengali), to validate the Indic rendering path (risk R3) with a real
practitioner rather than only with a test fixture.

### 2.2 Bring the receptionist

**Flows 1 and 2 are receptionist tasks.** Testing them with a doctor produces
misleading data: doctors are slower at registration than the person who does it
200 times a week, and they will not notice friction that a receptionist would
find intolerable.

- **Preferred:** each participating clinic sends both the doctor and their
  receptionist. The receptionist runs Flows 1–2; the doctor runs Flows 3–5.
- **Fallback:** where only the doctor attends, the facilitator performs Flows
  1–2 while the doctor observes and comments, and M1/M2 are recorded as
  **not measured** for that session rather than being recorded from doctor
  timings. Do not contaminate the dataset.

### 2.3 Environment

- Prototype on a **laptop the participant does not own**, at 1366×768 — the
  resolution of a typical clinic desktop, not the facilitator's MacBook
- Mouse and keyboard, not a trackpad
- **Throttle the network to 3G** for at least one session, to test the offline
  banner and draft outbox (`01 §3.1`)
- Screen and audio recording, with written consent
- One facilitator, one silent observer taking timings

### 2.4 Test data to seed

The traps below are the point of the exercise. A prototype that only handles
clean data has not been tested.

| Fixture | Purpose |
|---|---|
| **+91 98765 43210** with **three** registered family members (Sunita Devi 34F, Ramesh Kumar 38M, Aarav Kumar 6M) | Flow 1 duplicate trap |
| **Mohd Imran** and **Mohammed Imran**, different numbers, same DOB | Fuzzy-match trap |
| **Lakshmi Narayanan**, 52F, documented **Penicillin — HIGH criticality** allergy | Flow 4 safety trap |
| A patient with **no DOB**, age stated as 45 | Age-capture path |
| A patient with **22 active medications** | PDF overflow trap (risk R3) |
| A drug with a long Devanagari name | Indic rendering check |

---

## 3. Facilitator opening script

> Read verbatim. It calibrates expectations and protects data quality.

> "Thank you for your time. This is an early prototype of an EMR for clinics
> like yours — some of it is clickable, some is not yet built.
>
> Two things to keep in mind. First, **we are testing the software, not you.**
> If something is confusing, that is a defect we need to find, and finding it
> today saves us months. Please do not be polite about it.
>
> Second, please **think aloud** — tell me what you are looking for, what you
> expect to happen, and when something surprises you. Silence is hard for me to
> learn from.
>
> I will not help unless you are truly stuck, because I need to see where the
> design fails. If I stay quiet, that is why.
>
> Before we start: how do you register and record patients today, and what is
> the single most irritating part of that?"

Record the answer. It is the benchmark everything else is compared against.

---

## FLOW 1 — Register a new patient, with a duplicate trap

**Performed by:** receptionist (or facilitator, per §2.2)
**Target:** < 60 seconds · **Measures:** M1, M2, M6

### Scenario given to the participant

> "A woman walks in without an appointment. She says her name is **Sunita
> Sharma**, she is **34**, and her mobile is **98765 43210**. She has not been
> here before. Please register her and note that she has come for fever and
> body ache."

**The trap:** that number already has three registered patients, one of whom is
**Sunita Devi, 34F** — plausibly the same person under a different surname, or
plausibly a different family member. The system must surface this, and the
participant must make a deliberate choice rather than blindly creating a fourth
record.

### Steps

| # | Action | Expected system behaviour | Time |
|---|---|---|---|
| 1.1 | Open patient search | Search field focused on load; no click needed | |
| 1.2 | Type `9876543210` | Results appear progressively; **< 50 ms** after last keystroke | |
| 1.3 | Observe results | **Three patients shown on this number**, each with name, age, gender, last visit | |
| 1.4 | Decide | "Register new patient" is available but **visually secondary** to selecting an existing one | |
| 1.5 | Choose "Register new" | Form opens with the mobile **pre-filled**; name field focused | |
| 1.6 | Enter name and age | Age accepted **without** a date of birth | |
| 1.7 | Observe | A soft warning appears: *"Sunita Devi, 34F is already registered on this number. Same person?"* | |
| 1.8 | Confirm different person | Warning dismissible with an explicit reason | |
| 1.9 | Save | MRN generated and displayed; patient record opens | |

### Pass / fail

| Criterion | Pass |
|---|---|
| Total elapsed time | **< 60 s** |
| Participant saw the three existing patients before creating a new one | Yes |
| Participant noticed the Sunita Devi soft warning | Yes |
| Participant completed without facilitator help | Yes |
| Mobile number accepted in whatever format typed | Yes |

### Observer prompts (only if the participant is silent)

- "What were you expecting to see after typing the number?"
- "How did you decide this was a new patient and not one of the three?"
- "Was anything on that screen unnecessary?"

### ⚠️ Escalation

If **2 or more** participants create a duplicate without noticing the existing
records, **Flow 1 fails** and the registration screen must be redesigned before
Phase 1. This is risk R4 materialising in the prototype, which is exactly where
you want to find it.

---

## FLOW 2 — Add the patient to the live queue

**Performed by:** receptionist · **Target:** < 15 seconds · **Measures:** M6

### Scenario

> "Sunita is registered. Dr. Mehta is running about 20 minutes behind. Put her
> in today's queue for him — and then a second patient arrives who is elderly
> and unwell, and needs to be seen before her."

### Steps

| # | Action | Expected behaviour | Time |
|---|---|---|---|
| 2.1 | Add to queue from the patient record | Single action; no separate "create appointment" form | |
| 2.2 | Select doctor | Defaults to the only/last-used doctor | |
| 2.3 | Confirm | Patient appears in the queue with token number and wait time | |
| 2.4 | Add the second patient | Same flow | |
| 2.5 | **Reprioritise** the elderly patient above Sunita | Drag, or an explicit "move up" — completes in **one gesture** | |
| 2.6 | Observe | Queue reorders immediately; a second screen would reflect it within ~2 s | |

### Pass / fail

| Criterion | Pass |
|---|---|
| Queue add | < 15 s |
| Reorder | Achieved without entering an edit screen |
| Participant understood their position in the queue at a glance | Yes |

**Additional check (clinics with a receptionist present):** have the doctor's
screen open simultaneously. Confirm the doctor sees the reordered queue without
a manual refresh. Contention at the front desk is a real failure mode and this
is the only session in which it can be observed.

---

## FLOW 3 — Patient Snapshot and opening an Encounter

**Performed by:** doctor · **Target:** Snapshot usable in < 15 s · **Measures:** M3, M6

### Scenario

> "You are Dr. Mehta. **Lakshmi Narayanan** is next. She is a returning patient.
> Before you see her, get oriented: what should you know about her? Then start
> the consultation."

**The setup:** Lakshmi has a documented **Penicillin allergy, HIGH
criticality**, two chronic conditions, and four previous encounters. This flow
establishes whether the allergy is *noticed* — Flow 4 then tests whether it is
*acted upon*.

### Steps

| # | Action | Expected behaviour | Time |
|---|---|---|---|
| 3.1 | Open the patient from the queue | Single click from the queue row | |
| 3.2 | Snapshot loads | **Fully rendered < 1 s** | |
| 3.3 | Observe orientation | Allergies visible **without scrolling**, visually distinct from everything else | |
| 3.4 | Review history | Last 3 visits summarised; expandable, not requiring navigation away | |
| 3.5 | Check current medications | Active prescriptions visible on the same screen | |
| 3.6 | Start consultation | One clear primary action | |
| 3.7 | Encounter opens | Chief complaint focused; previous visit's notes available to copy forward | |

### Pass / fail

| Criterion | Pass |
|---|---|
| **Participant verbalises the Penicillin allergy unprompted** | **5 of 5 — mandatory** |
| Time to first meaningful action | < 15 s |
| Participant found the last visit's diagnosis without help | Yes |
| Participant did not need to navigate away and back | Yes |

### Critical observer question — ask after 3.5, before 3.6

> "Without scrolling back — what do you already know about this patient?"

Write down the **order** in which they mention things. If the allergy is not in
the first three items, the Snapshot hierarchy is wrong. This single question is
the most informative moment in the entire session.

### ⚠️ Escalation

If **any** participant fails to notice the allergy during Flow 3, the Snapshot
layout is a patient-safety defect and must be redesigned before Phase 1.

---

## FLOW 4 — Prescribe, with a safety trap, and sign

**Performed by:** doctor · **Target:** < 4 min for Flows 3+4 combined · **Measures:** M4, M5, M6

### Scenario

> "Lakshmi has a throat infection. Please record your findings and prescribe
> what you would normally prescribe. Then complete the visit."

**The trap:** the natural prescription for a throat infection is **Amoxicillin**
— a penicillin. Lakshmi is documented as HIGH-criticality penicillin-allergic.
The system must warn, the doctor must notice, and the override path must require
a deliberate act.

Do **not** hint. If the participant selects Amoxicillin, let them.

### Steps

| # | Action | Expected behaviour | Time |
|---|---|---|---|
| 4.1 | Record chief complaint and examination | Free text; templates and last-visit copy-forward available but not forced | |
| 4.2 | Add a diagnosis | Accepts **free text** without requiring an ICD code | |
| 4.3 | Search the drug catalogue: type `amox` | Results **< 200 ms**; brand and generic both matched | |
| 4.4 | Select Amoxicillin 500 mg | **⚠️ Allergy warning fires — blocking, not a toast** | |
| 4.5 | Read the warning | States the substance, the criticality, and the date recorded | |
| 4.6 | Choose an alternative (or override) | Override requires typing a reason; it is not a single "OK" | |
| 4.7 | Set dosage | `1-0-1` accepted directly; before/after food selectable | |
| 4.8 | Add 2 more drugs | Each < 20 s | |
| 4.9 | **Preview** before signing | Preview is the **exact** artefact the patient receives | |
| 4.10 | Check the preview | Letterhead, registration number, all drugs present, nothing truncated | |
| 4.11 | Sign and finalise | Confirmation states clearly that this cannot be edited afterwards | |

### Pass / fail

| Criterion | Pass |
|---|---|
| **Allergy warning noticed and acted upon** | **5 of 5 — mandatory** |
| Override required a typed reason | Yes |
| Participant previewed before signing | ≥ 4 of 5 |
| Flows 3+4 combined | < 4 min |
| Participant understood finalisation is irreversible | Yes |

### Additional check — the overflow fixture

With at least two participants, load the **22-medication** patient and open the
preview. Confirm: no truncation, the header repeats on page 2, page numbering
reads "1 of 2", and the signature block is not orphaned. With the
regional-script participant, confirm the Devanagari/Tamil drug name renders
correctly — **ask them to read it aloud**. A mis-shaped conjunct is invisible to
a non-reader of the script and is precisely the failure mode risk R3 describes.

---

## FLOW 5 — PDF generation and WhatsApp dispatch

**Performed by:** doctor, then observed by both · **Target:** PDF < 5 s · **Measures:** M6

### Scenario

> "You have signed the prescription. Send it to the patient, and then show me
> how you would check that she actually received it."

### Steps

| # | Action | Expected behaviour | Time |
|---|---|---|---|
| 5.1 | Sign completes | PDF generation starts automatically; no separate "generate" step | |
| 5.2 | Wait | PDF ready **< 5 s**; progress is visible, not a frozen screen | |
| 5.3 | Dispatch prompt | Offers WhatsApp (default), print, and download | |
| 5.4 | Send via WhatsApp | Confirms the destination number **before** sending | |
| 5.5 | Observe status | Status moves QUEUED → SENT → DELIVERED, visible in the UI | |
| 5.6 | Check delivery | Participant can find delivery status **without asking the facilitator** | |
| 5.7 | Simulated failure | Facilitator triggers a failure; a **Task** appears on the front-desk worklist | |
| 5.8 | Fallback | Participant finds print or an alternative channel | |

### Pass / fail

| Criterion | Pass |
|---|---|
| PDF ready | < 5 s |
| Destination number confirmed before send | Yes |
| Participant located delivery status unaided | ≥ 4 of 5 |
| Participant found a fallback after the simulated failure | Yes |

### Questions to ask here

- "If a patient calls tomorrow saying they never got it, what would you do?"
- "Would you send this to the patient, or hand them a printout? Why?"

The second question matters commercially. If most doctors would print anyway,
the WhatsApp cost model in `01 §2.5` needs revisiting — and it is cheaper to
learn that here than after the integration is built.

---

## 6. Session close (10 minutes)

### 6.1 SUS questionnaire

Administer the standard 10-item System Usability Scale. Target **≥ 68**.

### 6.2 Three closing questions

1. "Compared with how you work today, would this make your day faster or
   slower? By roughly how much?"
2. "What is the **one thing** that would stop you using this?"
3. "If this cost ₹3,000 a month, would you buy it? What would make that an easy
   yes?"

Record verbatim. Question 2 is the single most valuable output of the session.

---

## 7. Observer recording sheet

One per participant.

```
Participant: ____  Role: ____  Date: ____  Current system: paper / EMR (____)

  FLOW              TIME     UNAIDED   NOTES
  1  Registration   ____ s   Y / N     Duplicate seen?     Y / N
  2  Queue          ____ s   Y / N     Reorder in 1 gesture? Y / N
  3  Snapshot       ____ s   Y / N     Allergy unprompted?  Y / N  Position: __ of __
  4  Prescribe      ____ s   Y / N     Warning acted on?    Y / N  Previewed? Y / N
  5  Dispatch       ____ s   Y / N     Found status?        Y / N

  Facilitator interventions (count): ____
  Moments of visible confusion (timestamp + what):
    ____________________________________________
  Moments of visible delight:
    ____________________________________________
  Verbatim — "the one thing that would stop me using this":
    ____________________________________________

  SUS score: ____        Faster or slower than today: ____
  Would buy at ₹3,000/mo:  Yes / No / Conditional (____________)
```

---

## 8. Parking lot

Feature requests, visual preferences and "could it also…" belong here. Log them,
thank the participant, move on. Reviewing them across all five sessions afterwards
separates a real pattern from one doctor's habit.

---

## 9. Decision gate

Aggregate across all five sessions and apply these rules literally. The value of
a gate is that it is decided before you know the result.

| Outcome | Condition | Action |
|---|---|---|
| 🟢 **Proceed** | All mandatory criteria met; SUS ≥ 68; ≥ 4 of 5 say "faster than today" | Begin Phase 1 as scoped |
| 🟡 **Proceed with rework** | Mandatory criteria met; SUS 55–67, **or** 2+ participants exceeded a time target | Redesign the failing screens and re-test those flows only, with 2 participants. ~1 week |
| 🔴 **Stop and redesign** | **Any** mandatory safety criterion failed (allergy missed in Flow 3 or 4), **or** SUS < 55, **or** ≥ 3 say "slower than today" | Do not start Phase 1. Redesign and re-run the full script |

### Mandatory criteria — a single failure triggers 🔴

1. Allergy noticed unprompted in Flow 3 — **5 of 5**
2. Allergy warning acted upon in Flow 4 — **5 of 5**
3. No participant created a duplicate without seeing the existing records
4. No participant signed a prescription containing truncated or mis-rendered text

These four are patient-safety criteria. They are not negotiable against
schedule pressure, and agreeing that in advance — before anyone is invested in a
delivery date — is the reason this section exists.
