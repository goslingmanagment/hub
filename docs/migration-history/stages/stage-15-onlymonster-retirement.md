# Stage 15 — OnlyMonster parity gate + retirement

**Repo(s):** core (ops + small code) · **Depends on:** 14 · **Passport:** roadmap.md §4, stage 15

**Status header — stage collapsed per Q1 (the master's own instruction).** The passport's
fleet-wide parity report and per-page stream disablement assume a live OnlyMonster feed. Q1
(re-verified live 2026-07-04): production runs **no** OnlyMonster sync streams and **zero**
OnlyMonster-sourced transaction rows exist. There is no feed to retire and nothing to compare —
the "parity gate" degenerates to a *verify-zero* checklist, and the stage's real work is: remove
OnlyMonster from the OnlyFans stream plans (so it can never silently restart), quarantine the
code path, revoke credentials, and have the owner cancel the bill. Code *deletion* stays in
Stage 18 as planned.

## 1. Context

DP 2-A ends here: one OnlyFans vendor, one bill. Because production already runs OFAPI-only, the
remaining risk is *latent re-activation* — the OnlyMonster streams are still registered for
OnlyFans pages in code (`resolveStreamsForScope`, `sync-control.ts:40-87`;
`getSyncStreamsForPlatform`, `page-sync.ts:533`) and would run again if page credentials were
ever pasted. This stage closes that door and formally ends the vendor relationship.

**Entry criteria restated as facts to verify:**
- Stage 14 exited: chargebacks + tracking-link users flowing from OFAPI (the two feeds that were
  OnlyMonster-exclusive); depth verdict recorded.
- Verify-zero re-check (prod): `SELECT count(*) FROM transactions t JOIN pages p ON
  p.id=t.platform_account_id WHERE p.platform='onlyfans' AND t.source='onlymonster'` → 0; no
  `sync_runs` rows for OnlyFans `light`/`transactions`/`fan_identities` streams in 30 d; zero
  egress to `omapi.onlymonster.ai` in logs over 7 d.
- Grep all three repos for OnlyMonster consumers (base URL, `onlyMonsterBaseUrl`,
  `OnlyFansAdapter`) — expect: core only (verified: adapter `packages/onlyfans/src/adapter.ts`,
  wired at `bootstrap.ts:166-169`, base URL knob `config-registry.ts:126`).

**Deliverable:** OnlyMonster structurally unreachable from the planner; stale sync state cleaned;
credentials revoked; bill cancelled by the owner; all of it recorded in `decisions.md`.

## 2. Changes

**core — stream-plan removal (small code):**
- `resolveStreamsForScope` (`services/sync-control.ts:40-87`): OnlyFans scopes drop the
  OnlyMonster-backed streams (`light`, `transactions`, `fan_identities` in their OnlyMonster
  form). NB after Stage 14, `fan_identities` is OFAPI-backed and **stays**; `transactions` for
  OnlyFans is webhook+REST (no pull stream needed) — the OnlyFans `transactions` pull stream is
  removed from the plan; `light` page-metadata refresh must first be confirmed OFAPI-covered
  (Stage 14's OFAPI account reads / existing `ofapiAccountHealth` lane) — if not yet, re-point
  `executeLightChunk`'s OnlyFans branch to the OFAPI account endpoint before removing.
- `getSyncStreamsForPlatform('onlyfans')` (`page-sync.ts:533`) updated to match.
- Stale-state cleanup: `pausePageSync` (`page-sync.ts:1809`) any remaining OnlyFans
  `page_sync_states` rows for removed streams, then delete those state rows in a follow-up
  migration (they are ops state, not facts).
- **Adapter quarantine, not deletion:** `OnlyFansAdapter` stays compilable; `bootstrap.ts:166-169`
  keeps constructing it (inert — nothing schedules it). A code comment + `decisions.md` entry
  mark it quarantined-until-Stage-18. `onlyMonsterBaseUrl` (`config-registry.ts:126`) description
  updated to "retired vendor — quarantined".

**ops — vendor offboarding (owner-executed, in order):**
1. Re-run the verify-zero checklist (above) and record results in `decisions.md`.
2. Revoke/rotate any stored OnlyMonster credentials (none expected in `page_credentials` — the
   Stage 14 eligibility check found no page credentials; verify).
3. Owner cancels the subscription — **last step, only after** the checklist is signed.
   **Owner-confirmed 2026-07-04: cancellation authorized, no old-page export needed** — there is
   no OnlyMonster history worth preserving for pages outside core, so Stage 5 stays moot and no
   one-shot export precedes cancellation. NB the cancellation itself is a commercial action only
   the owner can perform (log into the vendor, cancel billing); the execution session prepares
   and signs the verify-zero checklist, the owner clicks cancel.

## 3. Schema & data migration

**No schema change.** One ops-state cleanup migration (delete `page_sync_states` /
`page_sync_cursors` rows for removed OnlyFans streams) — idempotent, touches no fact tables.

## 4. Client compatibility

- **Desktop / extension / dashboard:** none visible. Dashboard sync-health views stop listing the
  removed streams for OnlyFans pages (server-driven; no dashboard code change expected — verify
  the sync UX summary tolerates absent streams).
- **Workboard:** n/a.

**Compatibility invariants (target §14):** untouched.

## 5. Tests & verification

**New tests:** `resolveStreamsForScope('onlyfans', …)` excludes retired streams (unit);
planner integration: an OnlyFans page schedules only OFAPI-era streams; light-metadata coverage
test (page metadata still refreshes via the OFAPI path).

**Existing suites:** planner/executor suites; sync-control tests.

**Production verification (exit criteria):**
- Zero OnlyMonster egress over 7 days post-deploy (log grep for `omapi.onlymonster.ai`).
- Reports serve normally (dashboard revenue pages, Telegram digest) — spot-check vs pre-deploy.
- `decisions.md` entry: verify-zero results + owner's cancellation confirmation.

## 6. Rollback

- Stream-plan removal is a code revert away; the quarantined adapter is intact until Stage 18.
- Vendor account: per the passport, assume short-term reactivatable if something surfaces — but
  after cancellation this is the owner's commercial risk, accepted by signing the checklist.
  **The cancellation is the one irreversible-ish step and is owner-executed, last.**

## 7. Assumptions

1. **No undiscovered OnlyMonster consumer** — grep of all three repos at execution (entry
   criterion). Drift signal: any hit outside `packages/onlyfans` + `bootstrap.ts` + config.
2. **`light`-stream page metadata is OFAPI-replaceable** (account endpoint carries
   username/display/counters). Verify before removing the stream; if a field is OFAPI-absent,
   keep a reduced OFAPI-backed light refresh rather than the OnlyMonster one.
3. **Stage 14's OFAPI chargebacks/tracking feeds are live** — the exclusives are covered before
   the vendor door closes.
4. **Q1's zero-rows finding still holds at execution** (re-check is step 1).

## 8. Task breakdown

1. **Stream-plan removal + light-coverage check + stale-state cleanup migration.** Done-check:
   unit/integration tests; staging planner cycle schedules no OnlyMonster streams. *(≤1 session)*
2. **Quarantine markers + config description + `decisions.md` entry.** Done-check: grep shows
   quarantine comment; registry text updated. *(≤0.2 session)*
3. **(Last, ops/owner) Verify-zero checklist in prod → credentials sweep → owner cancels bill →
   record everything in `decisions.md` and this file.** *(ops)*
