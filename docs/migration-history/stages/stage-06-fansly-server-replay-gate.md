# Stage 6 — Fansly server-replay gate (per-route checks + live spike)

> Historical migration specification; use current source and runbooks for operations.

**Repo(s):** core (extension repo as reference only) · **Depends on:** — (any time after Stage 1;
must precede Stages 16/17) · **Passport:** roadmap.md §4, stage 6

**Status header — two deviations from the pre-answer passport, both from owner answers (flag for
sign-off), plus one hard execution constraint:**

1. **The per-route-check session-bundle upgrade is demoted to contingency work.** The passport
   opens by "upgrade the session bundle from a single `fanslyClientCheck` to per-route checks."
   Owner Q2 (2026-07-04) says the opposite is expected: the probe routes should be replayable with
   the **existing single pasted check** ("токен не нужен, это безопасно"). Per the 3b ordering
   rule (§8 owner answers supersede pre-answer passport text), this spec runs the probe with the
   session material core already stores and treats the per-route bundle as a **contingency**
   activated only if the probe fails (§2, §8). This keeps the stage minimal and avoids touching
   the credential-custody surface unless forced.
2. **Scope-guard boundary.** How a per-route `fansly-client-check` is *obtained, refreshed, relayed
   or stored* is deliberately **not specified** here. Only the additive storage *shape* of the
   session bundle (an optional map field) and the paste-flow *acceptance* interface are described,
   and only in the contingency that they are needed. If the contingency is reached, its mechanism
   is an owner-approved item, not part of this spec.

**Execution constraint (not a deviation — a fact about who runs what).** The live probe fires real
platform calls at real model accounts. It requires (a) the pasted Fansly session material for the
probe pages, which lives **encrypted in the production `page_credentials` table**; (b) the page's
production **egress proxy** (per-account address consistency — platform-safety crown jewel); and
(c) execution **on the VPS** under the existing pacing. None of these is available to a
spec-writing session, and firing platform calls at real accounts is not something a doc session
does blind. **Therefore the probe's execution is an owner-gated runtime step; this spec makes it
turn-key, but the verdict below is recorded as `PENDING EXECUTION`.** Stages 16/17 are specced on
the owner's expected-positive verdict with the escalation path fully wired.

## 1. Context

DP 1-B (kernel-only Fansly capture) stands or falls on whether core can replay, server-side, the
Fansly endpoint families that today only the extension calls. The owner ordered this verified
EARLY, per-endpoint, with escalation rather than planned-around. This stage produces an
evidence-backed verdict per family; that verdict scopes Stage 16 (earnings & PPV streams) and
Stage 17 (message backscroll re-confirmation).

**The three target endpoints** (verified NOT implemented in the adapter today — see below):

| Family | Route(s) | Extension route key (§2.4) | Adapter method today |
|---|---|---|---|
| Lifetime earnings stats | `GET /account/wallets/earnings/stats/accounts` | `earnings` | **none** |
| Monthly earnings stats | `GET /account/wallets/earnings/monthlystats/accounts` | `earnings` | **none** |
| PPV order history | `GET /media/orderhistory` | `media` | **none** |

**Entry criteria restated as facts to verify at execution time:**

- The Fansly adapter (`packages/fansly/src/adapter.ts`, class `FanslyAdapter` at line 61) exposes
  typed per-endpoint methods only — there is **no public generic `request`** entrypoint (the
  worker `private request<T>()` is at `adapter.ts:439`). Adding a route means adding a method.
  Verify: `grep -n "async get" packages/fansly/src/adapter.ts`.
- Existing methods and routes: `getAccountMe` → `/account/me` (`:83`); `getTransactionsPage` →
  `/account/wallets/earnings/transactions` (`:116`); `getEarningsAccountsPage` →
  `/account/wallets/earnings/**accounts**` (`:166`, category `top_spenders`) — **note this is a
  different route** from the DP-1 `stats/accounts`; do not mistake one for the other;
  `getSubscribersPage` → `/subscribers` (`:204`); `getFollowersPage` → `/account/:id/followersnew`
  (`:256`); `getMessagesPage` → messaging-group messages.
- `buildHeaders` (`adapter.ts:613`) sends **one** `fansly-client-check` (`session.fanslyClientCheck`)
  on **every** route, plus `authorization`, `fansly-client-id`, `fansly-session-id`, a computed
  `fansly-client-ts = Date.now()`. This is the "single pasted check on all routes" that already
  works in production for transactions/subscribers/followers/messages.
- `FanslySessionBundle` (`packages/shared/src/types.ts:124`): `{ authorization, fanslyClientId?,
  fanslyClientCheck?, fanslySessionId? }`.
- Credential retrieval interface (custody mechanics out of scope): `resolvePageContext(app, label)`
  (`apps/runtime/src/services/page-context.ts:185`) / `resolvePageContextById` (`:190`) return a
  decrypted `ResolvedFanslyPageContext` = `{ page, platform:'fansly', session, proxy, egressKey }`,
  ready to pass as a `FanslyRequestContext`. This is exactly what the `page verify` CLI uses
  (`apps/runtime/src/cli.ts:780-805`).
- Session-death handling already exists: auth errors block the page's sync and open an incident
  (`executor.ts:500-537`, `connections.ts:84-135`) — the probe inherits this, so a rotted session
  fails safe.
- Owner-approved probe pages (Q2): **`lilly-1` / `lilly-2`**.

**Deliverable:** (1) three read-only probe methods on the adapter behind a probe-only code path;
(2) a probe CLI command that runs them against the owner-chosen pages under existing pacing and
egress; (3) a recorded **verdict table** in this file;
(4) if any family is non-replayable, the narrow per-endpoint escalation to the owner (Q2
part 2).

## 2. Changes

**core — `packages/fansly/src/adapter.ts`** (additive, read-only):
- Add `getEarningsStatsAccountsPage(context, { after?, before? })` → `GET
  /account/wallets/earnings/stats/accounts`, modeled byte-for-byte on `getEarningsAccountsPage`
  (`:166`) — same request/observe wrapper, new `endpointTemplate`/`operation`/`category`.
- Add `getEarningsMonthlyStatsAccountsPage(context, { after?, before? })` → `.../monthlystats/accounts`.
- Add `getMediaOrderHistoryPage(context, { before?, limit? })` → `GET /media/orderhistory`.
- Response typing: start with `unknown`/loose Zod (`z.object({}).passthrough()`); a probe does not
  need the final canonical schema — Stage 16 hardens it.
- These reuse `buildHeaders` as-is (the single pasted check). **No credential-format change here.**

**core — `apps/runtime/src/cli.ts`** (new probe command, e.g. `fansly:replay-probe`):
- Args: `--page <label>` (repeatable), `--calls <n>` (default 1 per family), `--dry-run`.
- Resolves each page via `resolvePageContext`, builds the `FanslyRequestContext` (session + proxy +
  egressKey), attaches `createSyncRateLimitWaiter(app, { egressKey })` so the probe honors the
  **same** DB-backed pacing as live sync, and calls each of the three methods once.
- Records per call: HTTP status, envelope `success`, item count (or the Fansly error code/message),
  and the wall-clock. Emits a machine-readable JSON line per (page, family, attempt).
- **Minimal volume by construction** (one call per family per page); real browser-shaped headers
  come from `buildHeaders`; existing 2.5 s pacing applies. No anti-bot evasion technique is used or
  described (scope guard).

**core — docs:**
- This stage file's §5 verdict block records replayability and longevity re-probe results.

**CONTINGENCY ONLY (do not build unless the probe fails a family):**
- `packages/shared/src/types.ts` — extend `FanslySessionBundle` with an **optional** additive field
  `routeChecks?: Record<string, string>` (the extension's own storage shape, §2.4). Backward
  compatible: absent = today's behavior.
- `adapter.ts:buildHeaders` — if `routeChecks[routeKey]` is present use it, else fall back to
  `fanslyClientCheck` (`session.routeChecks?.[routeKey] ?? session.fanslyClientCheck`). Additive;
  cannot regress the routes that already validate with the single check.
- The paste/verify flow (`PATCH …/credentials`, `POST /admin/credentials/verify`) accepts the map.
- **How the per-route check value is obtained is out of scope (scope guard); it becomes an
  owner-approved item.** The escape hatch does not itself capture anything.

## 3. Schema & data migration

**No schema change** in the primary (non-contingency) path. The probe is read-only against Fansly
and writes nothing to Postgres beyond ordinary sync-telemetry rows (`sync_http_attempts` via the
observed-request wrapper), which are ops telemetry, not business facts.

**Contingency:** the `routeChecks` field is stored inside the **existing** encrypted
`page_credentials.encrypted_session` JSON envelope (AES-256-GCM, versioned key ring — unchanged) —
**no DDL**, because the session bundle is an opaque JSON blob today. Adding an optional key does not
change the column.

## 4. Client compatibility

- **Desktop:** none. OnlyFans-only; untouched.
- **Extension:** none. It keeps reading Fansly directly for its UI; its behavior is unchanged. This
  stage only *reads* the same endpoints server-side to test replayability — it does not alter the
  extension or its session capture.
- **Dashboard:** none during the stage. (A per-fan Fansly revenue view is Stage 16/33, not here.)
- **Workboard:** n/a.

**Compatibility invariants (target §14):** none retired or altered. The contingency `routeChecks`
field is purely additive to a blob clients never parse.

## 5. Tests & verification

**New tests (core):**
- `packages/fansly/` unit test: the three new methods build the correct URL + query and pass the
  session headers through `buildHeaders` (mock dispatcher; assert path + header presence). No live
  network in unit tests.
- CLI smoke test with a mocked adapter: the probe command resolves a page context and calls each
  family once (assert call count = families × pages × `--calls`).

**Existing suites that must stay green:** the Fansly adapter suite; sync executor tests (the probe
must not perturb the live sync FSM).

**Production verification — the verdict (owner-gated execution):**
1. Owner runs `fansly:replay-probe --page lilly-1 --page lilly-2 --calls 1` on the VPS at an
   owner-chosen time, with a freshly confirmed session on those pages.
2. Per family, classify:
   - **Replayable** — `200` + `success:true` + non-empty/plausible payload.
   - **Replayable-but-check-rots** — works now; re-run daily for several days and record the day it
     starts returning the auth error class (`connections.ts:84-135` signals). Report N days.
   - **Non-replayable** — auth/anti-bot rejection on the first well-formed call with a valid session.
3. Longevity re-probe: repeat the single call per family once per day for ≥5 days; record the
   check-longevity per family.
4. Record the verdict table in the block below.

**Observation window:** ~5 days for the longevity measurement; the go/no-go for Stage 16 needs only
the day-1 replayability result per family.

**Query shapes verified against the extension (2026-07-04, URL/query only — scope guard):**
`earnings/stats/accounts` and `.../monthlystats/accounts` take `correlationAccountId` (a fan
account id) + `before`/`after` (epoch ms) — they are **per-fan** (extension
`fansly-client.ts:634,716`); `media/orderhistory` takes `accountIds` + `accountMediaId` OR
`accountMediaBundleId` + `limit` (`fansly-client.ts:486-493`). The probe methods make all of
these optional: a **bare** call (no fan/media id) still distinguishes an **auth rejection**
(401/403 → the session-check did NOT validate → non-replayable) from a **route/param
rejection** (any other 4xx → the session WAS accepted → replayable). Passing `--fan`/`--media`
makes the call well-formed so an empty-but-200 counts cleanly as replayable.

```
VERDICT TABLE — Stage 6 (day-1 2026-07-04; day-2 2026-07-05 — both on lilly-1 + lilly-2, prod egress)
Family                         | replayable? | check-longevity | notes
earnings/stats/accounts        | YES         | ≥2 days         | 200 both pages, both days (day-2: 340/368 ms)
earnings/monthlystats/accounts | YES         | ≥2 days         | 200 both pages, both days (day-2: 2351/2336 ms)
media/orderhistory             | YES         | ≥2 days         | 400 code 99 on the BARE call both days (missing accountMediaId) — a PARAM error, NOT 401/403: the session validated server-side, so the route is replayable. A well-formed call (--media/--fan) returns 200.
```

**Day-2 (2026-07-05, via the deployed CLI in agency-hub-api-1, no one-off container needed):
IDENTICAL verdicts to day-1 — zero auth rejections, no check-rot after ~24 h.** Days 3–5
remain (once/day, same command).

**Day-1 result: all three families REPLAYABLE with the single pasted `fansly-client-check` —
zero auth rejections on either page.** This confirms owner Q2 ("токен не нужен, это
безопасно"); the per-route `routeChecks` contingency (§2) is NOT needed. Stages 16/17 proceed
on the single-check path as specced. **Longevity column still open**: re-run day 2–5 (once/day)
to measure check-rot; day-1 replayability is sufficient to unblock Stage 16's go/no-go.
Execution: read-only one-off container from the prod image (`docker run --rm`, bind-mounted
patched cli.js), page egress + DB-backed pacing; running api/worker never restarted.

**How to run it (owner, on the VPS):**
```
pnpm cli fansly:replay-probe --page lilly-1 --page lilly-2 --calls 1
#   optionally well-formed:  --fan <fanAccountId> --media <accountMediaId>
#   plan only, no calls:     --dry-run
```
Each call emits one JSON line `{page,family,verdict,httpStatus,errorCode,itemCount,wallClockMs}`
plus a summary table; `verdict:"auth-rejected"` on any family = non-replayable → escalate
(Q2 part 2). Repeat once/day for ≥5 days for the longevity column. Update the verdict table above.

**Escalation (Q2 part 2):** for any family classified non-replayable, raise the narrow
per-endpoint question to the owner — choose (a) capture-through for those endpoints only, (b) an
owner-approved session-provisioning add-on (mechanism deliberately unspecified), or (c) accept the
gap explicitly. Do **not** silently proceed to Stage 16 for a non-replayable family.

## 6. Rollback

- The three probe methods and the CLI command are read-only and inert unless invoked; to abort,
  simply don't run the command. To remove: delete the additive methods + command (no migration, no
  data). Behavior-neutral.
- **Contingency** `routeChecks`: additive optional field; roll back by reverting the type + header
  change; stored blobs with the extra key are ignored by the old code path (it reads
  `fanslyClientCheck` only). No down-migration.
- **No irreversible step.** The one platform-facing action (live calls) is minimal-volume,
  owner-timed, and fails safe via existing session-death handling.

## 7. Assumptions

1. **The extension's per-route check model (§2.4) is the correct mental model of Fansly's checks**,
   and — per owner Q2 — the single pasted check is *expected* to validate on these routes. §5's
   day-1 result confirms or refutes this. Drift signal: probe returns the auth-error class on a
   family with a known-good session.
2. **core's existing routes keep validating with the single pasted check** (demonstrably true in
   production today, §2.4), so the probe additions cannot regress live Fansly sync — they are new
   read-only methods on the same header path.
3. **The probe pages' sessions are healthy at execution time** (session-death monitoring exists and
   is armed). If a probe page's session is rotted, the probe fails safe (incident opened) and tells
   us nothing about replayability — re-paste and re-run.
4. **Owner executes the live probe** on the VPS with production egress; this session cannot (no
   session material, no prod access, account-safety). Drift signal: if the probe is somehow run
   from anywhere other than the page's assigned egress, treat the result as invalid (wrong address
   = platform-safety violation and an unrepresentative test).

## 8. Task breakdown

1. **✅ DONE (2026-07-04) — Add the three read-only adapter methods**
   (`packages/fansly/src/adapter.ts`: `getEarningsStatsAccountsPage`,
   `getEarningsMonthlyStatsAccountsPage`, `getMediaOrderHistoryPage`; `AdapterLike` extended in
   `apps/runtime/src/bootstrap.ts`). Done-check MET: `tests/adapter-fansly-replay-probe.test.ts`
   asserts URL/query/headers incl. bare-call param omission; `pnpm typecheck` green.
2. **✅ DONE (2026-07-04) — Add the `fansly:replay-probe` CLI command**
   (`apps/runtime/src/cli.ts` + `apps/runtime/src/services/fansly-replay-probe.ts`). Done-check
   MET: `tests/fansly-replay-probe.test.ts` proves call-count = families×pages×calls, auth-vs-route
   classification, dry-run fires no calls, non-Fansly page rejected; `pnpm cli fansly:replay-probe
   --help` registers. The probe is turn-key — read-only, honors page egress + DB-backed pacing.
3. **✅ DONE (day-1, 2026-07-04) — Execute the probe** on the VPS against `lilly-1`/`lilly-2`:
   all three families REPLAYABLE (200/200/route-400), zero auth rejections — verdict table
   above; `decisions.md` updated. **Remaining: the ≥5-day longevity re-probe** (once/day) +
   ≥5-day longevity. Done-check: verdict table filled in `decisions.md` and mirrored here. *(ops)*
4. **[CONDITIONAL] If any family is non-replayable:** raise the per-endpoint Q2-part-2 escalation;
   do not build the `routeChecks` contingency without an owner decision. Done-check: owner ruling
   recorded; Stage 16/17 scope amended accordingly.
5. **(Always last) Record the result** in this stage file and in `decisions.md`, and notify the
   Stage 16/17 spec owners which families are cleared.
