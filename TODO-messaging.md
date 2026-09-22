# Messaging — live inbox, broadcast, WhatsApp connection

Modelled on the Z-Chat patterns, adapted where an EMR differs from a marketing
CRM. Checkpoint after every five.

## The three places this deliberately differs from Z-Chat

1. **Consent is a gate, not a preference.** `consent_scope` already separates
   `WHATSAPP_COMMUNICATION` from `MARKETING_COMMUNICATION`. A prescription
   reminder and a "health camp on Sunday" broadcast are not the same act, and
   the second one needs its own recorded consent. The audience builder counts
   and excludes on that basis, and says how many it excluded and why.
2. **No phone numbers in the URL.** Z-Chat already does this; here it is
   stronger, because a URL carrying a patient identifier ends up in the browser
   history, the referrer header and any screenshot of a clinic screen.
3. **The inbox is scoped by RLS like everything else.** The SSE stream is
   per-clinic and the event payload carries no clinical content — only ids the
   recipient is already entitled to fetch.

## Stage 1 — Foundation

- [x] 1. Token encryption: `access_token_encrypted` needs a real cipher
- [x] 2. Migration: message templates, broadcasts, broadcast recipients
- [ ] 3. WhatsApp account connect / verify / disconnect API
- [ ] 4. Settings → WhatsApp screen
- [ ] 5. Template sync and listing

> **CHECKPOINT 1** — a clinic can connect a number and see its templates

## Stage 2 — The live inbox

- [ ] 6. SSE hub on the API: tenant-scoped, Redis fan-out for multi-replica
- [ ] 7. `GET /events` endpoint + BFF streaming passthrough
- [ ] 8. `useServerEvents` — one shared stream, backoff, give-up
- [ ] 9. Conversation list: search, unread, assignment, unlinked
- [ ] 10. Chat window: bubbles, monotonic status ticks, optimistic send

> **CHECKPOINT 2** — two browsers, one conversation, messages appear live

- [ ] 11. The 24-hour window: countdown, composer lock, template re-engagement
- [ ] 12. Patient context panel + link an unlinked conversation
- [ ] 13. Mark-read on open, unread badges live

> **CHECKPOINT 3** — the inbox behaves like a chat client

## Stage 3 — Broadcast

- [ ] 14. Audience builder with consent gating and an exclusion breakdown
- [ ] 15. Broadcast create / preview / test-send
- [ ] 16. Send: queue, rate limit, per-recipient status
- [ ] 17. Retry failures, cancel a running broadcast
- [ ] 18. Broadcast UI

> **CHECKPOINT 4** — a broadcast reaches only patients who consented

## Stage 4 — Finish

- [ ] 19. Webhook receiver: inbound messages and status callbacks
- [ ] 20. Tests: API suite, unit, browser
- [ ] 21. Docker, README, final verification
