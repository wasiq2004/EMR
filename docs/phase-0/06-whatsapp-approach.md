# Annex 6 — WhatsApp Approach

**Responds to:** SoW §4.6, §6.8, §6.9, §19 G
**Date:** 2026-09-15

---

## 1. Provider decision

**Official Meta Cloud API, direct, as a Tech Provider with Embedded Signup** — abstracted
behind a `MessagingProvider` interface so a BSP can be substituted without touching the
Inbox.

### 1.1 Three facts that constrain the design

1. **The On-Premises API is dead.** The final supported client version expired
   **23 October 2025**. Cloud API is the only option; any proposal built on on-prem is
   out of date.
2. **Cloud API Local Storage supports India.** Message payloads can be stored at rest in
   an Indian data centre, with content in the global "data in use" tier auto-deleted after
   60 minutes. **Must be enabled per WABA.** It materially simplifies the DPDP data-flow
   map, and a WABA without it is flagged as a compliance finding on the admin dashboard.
3. **From 1 October 2026, Meta bills per message for service *and* utility messages sent
   inside the open 24-hour window** — free since November 2024. A cost-model change, not
   a delivery change, and it lands within weeks of this document.

### 1.2 Direct vs BSP

| | **Meta Cloud API direct** | **BSP** (AiSensy, Interakt, Gupshup, 360dialog) |
|---|---|---|
| Per-message markup | None | $0.003–$0.010 |
| Each clinic owns its number | ✅ via Embedded Signup | Varies; some pool numbers |
| Template approval | Direct with Meta | BSP may hold pre-approved libraries |
| Onboarding effort | Higher — we build Embedded Signup | Lower |
| Support when Meta misbehaves | Meta only | BSP absorbs it |

**Direct is chosen** because in a multi-tenant SaaS each clinic needs its own WABA and
phone number — the prescription must come from *Dr. Sharma's Clinic*, not from the
platform — and Embedded Signup is the flow that lets a clinic attach its own number
during onboarding without us handling their credentials.

**But the abstraction is not optional.** Meta's template approval is opaque and
occasionally retroactive. `MessagingProvider` exposes `sendTemplate`,
`sendSessionMessage`, `handleWebhook` and `getTemplateStatus`; if a BSP's pre-approved
library becomes the faster path to launch, one adapter changes.

---

## 2. Webhook design (SoW §4.6)

The handler is deliberately minimal — Meta retries aggressively and disables endpoints
that time out.

```
POST /webhooks/whatsapp                         [@Public — no user context exists]
  │
  1. Verify X-Hub-Signature-256 HMAC against the app secret
     └─ constant-time comparison; 403 with empty body on mismatch
  │
  2. Resolve tenant from payload.phone_number_id
     └─ DATABASE LOOKUP against whatsapp_account — never trusted from the payload.
        This is the ONLY place tenant context originates externally.
        A miss is logged as a security event, not silently dropped.
  │
  3. Persist raw payload to webhook_event
     └─ UNIQUE(provider, provider_event_id) — idempotency under at-least-once delivery
  │
  4. Return 200 within 1 second
     └─ all real work enqueued to the whatsapp.inbound queue
```

**Subscription verification** (`GET /webhooks/whatsapp`) echoes Meta's `hub.challenge`
after verifying `hub.verify_token`.

**Idempotency** is the unique constraint on `provider_event_id`, not application logic.
Meta *will* redeliver, and a duplicate inbound message that creates a duplicate task or
fires a duplicate automation is a visible defect to the clinic.

---

## 3. Conversation mapping (SoW §6.8)

```
Inbound message from +91XXXXXXXXXX
  │
  ├─▶ normalise to E.164
  ├─▶ match against patient.mobile_e164 within the resolved clinic
  │
  ├── exactly one match ────▶ link to patient, thread into conversation
  ├── multiple matches ─────▶ UNLINKED QUEUE — family sharing one number is
  │                           routine, so this is expected, not exceptional
  └── no match ─────────────▶ UNLINKED QUEUE
  │
  └─▶ set last_inbound_at; window_expires_at = last_inbound_at + 24h
      └─▶ mark conversation unread; surface in Inbox
```

**The unlinked queue is a first-class feature, not an error path.** SoW §6.8 requires it,
and in the Indian market it will carry real volume: one mobile number commonly serves an
entire family. Staff link the conversation to the correct patient in one click, and that
action is audited.

**Conversation status** — `OPEN`, `WAITING`, `CLOSED` per SoW §6.8, with assignment to a
doctor or staff member.

**Retention gap flagged:** unlinked conversations contain health information about
someone who is not yet a patient of record — the weakest lawful-basis position in the
system. Proposed: auto-purge after 30 days unless linked. **Needs legal approval**
(§N Q9).

---

## 4. The 24-hour service window

This fails **silently** — Meta simply rejects the send — which is why it is computed and
persisted rather than inferred at send time.

```
                    Patient sends a message
                              │
        ┌─────────────────────▼──────────────────────┐
        │  window_expires_at = now() + 24 hours      │
        └─────────────────────┬──────────────────────┘
                              │
      ┌───────────────────────┴────────────────────────┐
      │                                                │
  now() < expires                                now() ≥ expires
      │                                                │
  SESSION message                              TEMPLATE message
  free-form; any content                       pre-approved only
  billable from 1 Oct 2026                     always billable
```

`whatsapp_conversation.window_expires_at` is written on every inbound message. The
messaging service reads it before every send and **automatically falls back** from
session to template — the clinic never sees a rejection caused by window state.

---

## 5. Template handling

| Purpose | Category | Fallback template |
|---|---|---|
| Appointment reminder | Utility | ✅ second variant maintained |
| Appointment confirmation | Utility | ✅ |
| Prescription ready | Utility | ✅ |
| Report ready | Utility | ✅ |
| Follow-up due | Utility | ✅ |
| Missed appointment | Utility | ✅ |
| Share-link OTP | Authentication | ✅ |

**Two approved templates are maintained per purpose.** Meta can reject or pause a template
without warning and retroactively; a single template per purpose means one rejection halts
that channel entirely.

Template status is refreshed nightly by the `maintenance` queue and surfaced on the admin
dashboard **before** it becomes an incident.

**Content policy — prescriptions and reports.** Per SoW §6.8, complete medical information
is **not** placed in message text by default. The message carries a brief notice plus a
secure share link (Annex 4 §6); the clinical content stays behind an authenticated,
revocable, audited endpoint.

---

## 6. Opt-in / opt-out (SoW §6.8, §6.9)

| Element | Implementation |
|---|---|
| Consent capture | `consent` row with scope `WHATSAPP_COMMUNICATION`, separate from marketing and treatment consent |
| Granularity | Per purpose. A patient may accept appointment reminders and refuse marketing |
| Opt-out | `whatsapp_conversation.is_opted_out`, honoured **immediately** across all queues |
| Inbound STOP | Keyword detection sets opt-out and confirms in one reply |
| Re-opt-in | Requires a fresh consent record; a prior withdrawn consent is never reused |
| Clinical override | **None.** A prescription is never sent to an opted-out patient — it falls back to print or share link |

---

## 7. Delivery states and failure handling

```
QUEUED ──▶ SENT ──▶ DELIVERED ──▶ READ
   │         │
   │         └──▶ FAILED (provider error code persisted)
   └──▶ FAILED (pre-send validation: opted out, no number, window+no template)
```

| Failure | Detection | Response |
|---|---|---|
| Transient network / 5xx | Job exception | BullMQ retry ×5, exponential backoff |
| Template rejected | Provider error code | Auto-fallback to second template; alert admin |
| Number invalid | Provider error code | Mark patient contact suspect; **create front-desk Task** |
| Patient opted out | Pre-send check | Blocked before send; fall back to print |
| Window closed, no template | Pre-send check | Auto-select template; if none approved, Task |
| **Not delivered within 15 min** | Reconciliation sweep | **Create Task on the front-desk worklist** |
| WABA suspended | Nightly quality poll | Alert owner; all sends queue rather than fail |

**SoW §6.9 compliance — the critical property:** *"A failed WhatsApp/SMS/email service
cannot cause loss of an encounter."* Messaging jobs are enqueued **after** the clinical
transaction commits, never inside it. A rolled-back finalisation cannot dispatch a
prescription, and a failed dispatch cannot roll back a clinical record. Failed jobs are
visible in the admin console and manually retryable.

---

## 8. Cost model (SoW §4.6)

### 8.1 Rates

| Category | Rate (India) | Use |
|---|---|---|
| Utility template | ₹0.16 | Reminders, prescription ready, follow-up |
| Authentication | ₹0.13 | Share-link OTP |
| Marketing | ₹0.86 | **Not used** — transactional only |
| Service (in-window) | Free until 30 Sep 2026, **~₹0.16 thereafter** | Inbox replies |

### 8.2 Per-clinic projection

Typical clinic, 40 patients/day, 26 days/month:

| Message type | Volume/month | Cost |
|---|---|---|
| Appointment reminders | 1,040 | ₹166 |
| Prescription ready | 1,040 | ₹166 |
| Follow-up reminders | 200 | ₹32 |
| Inbox replies (in-window) | 300 | ₹48 *(from Oct 2026)* |
| Share-link OTP | 100 | ₹13 |
| **Total** | **2,680** | **≈ ₹425** |

**≈14% of a ₹3,000/month subscription.**

### 8.3 Commercial recommendation

- Meter every send per clinic from day one — `communication.cost_paise` and
  `whatsapp_conversation.billable_message_count` exist for this
- Price as a **bundled allowance plus overage**, never "unlimited"
- Suggested: 2,000 messages included, ₹0.30/message beyond — the margin on overage covers
  Meta's rate plus the platform's own cost
- Show clinics their usage in the admin console, so overage is never a surprise

---

## 9. Provider dependencies and risks

| Dependency | Owner | Lead time | Risk |
|---|---|---|---|
| Meta Business verification | Owner | 1–3 weeks | Rejection requires document resubmission |
| WABA + number per clinic | Clinic, via Embedded Signup | Same day | Number must not be on personal WhatsApp |
| Template approval | Developer | 1–3 business days each | Rejection without explanation |
| Tech Provider onboarding | Owner + developer | 1–2 weeks | Prerequisite for Embedded Signup |
| India Local Storage | Per WABA config | Immediate | Must be verified enabled |

**Scheduling consequence:** Meta Business verification and Tech Provider onboarding are
started during **Phase 1**, not Phase 3, because they are calendar-bound and outside our
control. Templates are submitted in **week 1 of Phase 3**, not the week they are needed.

---

## 10. What is deliberately not built

| Excluded | Why |
|---|---|
| Personal WhatsApp automation | Prohibited by SoW §6.8 and by Meta's terms |
| WhatsApp Flows / interactive forms | Not required for MVP; adds template complexity |
| Chatbot / auto-reply beyond opt-out | SoW §12 excludes autonomous clinical interaction |
| Voice or video via WhatsApp | Not in scope |
| Broadcast marketing campaigns | Marketing templates cost 5× utility and risk the quality rating that the clinic's transactional messaging depends on |
