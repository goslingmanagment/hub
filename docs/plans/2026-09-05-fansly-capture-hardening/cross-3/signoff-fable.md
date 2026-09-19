# Sign-off — Fable

**Accept.**

Re-checked against the code and HARs: diagnosis numbers (29 272 calls/day; lilly-2 ≈
135 pages × 48 runs), per-pathname check derivation, the slot-rebase trap
(`page-sync.ts:1585-1612, 1930-1944`), the SOCKS5-auth rejection in playwright-core 1.60,
trims staying (#224). The UI-walk HAR has 14 `POST /message/ack`, 7 `POST /status`, 18
`/it/pis`, and in the session HAR acks fire in runs with no preceding `GET /message`, so
"the live tab acks without opening a conversation" holds. Stage 1e's
`lastSeenGeneration: null` for head-discovered threads is better than my proposal: the
upsert keeps null out of the monotonic stamp (`page-dm.ts:18-20`) and the next certified
full scan hides a null row it did not see (`page-dm.ts:258-262`) — exactly #214.

Material corrections (none changes the decision):

1. **D1 row, recorded rationale.** My final position in round 2 rests on one concrete
   difference — Playwright drives Chromium over CDP (the `Runtime.enable` artefact),
   Firefox over Juggler/BiDi — and explicitly concedes "parity with the IP population" as
   soft and unmeasurable. The table lists parity first; the owner should decide on the
   CDP argument, not the soft one.
2. **Stage 1g, quiet hours.** "8 h pause = +50% daily rate" is not how this scheduler
   behaves: missed slots are never caught up (`scheduleDuePageSync` advances
   `last_scheduled_slot` once per cycle, `page-sync.ts:1930-1952`), and capped lanes defer
   to the next UTC day (`config-registry.ts:185-243`). A pause reduces daily calls; it does
   not compress them. The correct reason to postpone quiet hours is the missing shift
   answer, and the trade-off to show the owner is lag, not rate.
3. **Stage 1c, where the admission hook lives.** The durable cooldown only reaches
   `verifySession` (`connections.ts`, `page-proxies.ts`, onboarding), the probes and the
   lanes if it is enforced inside `createSyncRateLimitWaiter` /
   `reserveSyncProviderRateLimit`, and only while `syncSharedRateLimitEnabled` is on — with
   it off the adapter falls back to in-process chains (`adapter.ts:2230-2262`) and no hook
   exists. Make the hook independent of that flag (check the cooldown in `request()`
   itself) or pin the flag as a Fansly boot invariant.
4. **Stage 1c floor.** A 30-minute floor overrides a shorter `Retry-After`; fine as
   policy, but "respect the full Retry-After" and "floor 30 min" read as contradictory.
5. **Stage 3 acceptance, add:** helper-issued requests carry all four identity headers on
   100% of canary attempts (1b's identity-present columns) — per-id paths such as
   `/group/{id}/` have no app twin for the header-identity comparison.
