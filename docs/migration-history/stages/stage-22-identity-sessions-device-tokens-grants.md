# Stage 22 — Identity: all-roles sessions, device tokens, grants, attribution

**Repo(s):** core · **Depends on:** 19 (declarative middleware) · **Passport:** roadmap.md §4,
stage 22

**Status header — one verified correction to the passport (no owner action needed):** the
passport lists "staged flips" among attribution gaps. Verified NOT a gap:
`commitStagedConfigChange` takes `userId` and writes `config_audit_log.userId`
(`services/staged-config.ts:174,189-232`, `schema.ts:2237`). The real gaps are: contact log (no
actor column — `schema.ts:1837-1872`), snoozes (no actor — `schema.ts:1177-1201`), manual sync
triggers (principal not threaded — `server.ts:2545-2574`), and gateway reads (closed already in
Stage 9). One enum note: `content_manager` removal is TS-level + row-migration; the PG enum
*value* is left in place unless a full type rebuild is free at execution (PG cannot drop enum
values in place — not worth a table rewrite for a dead label; documented as cosmetic debt).

## 1. Context

Chatters are API-key-only principals (`roleCanUseSession` = owner/team_lead only,
`auth.ts:93-95`) — the workboard's real blocker; assignments are delete-on-unassign
(`unassignUserFromPage` hard-deletes, `repositories/auth.ts:93-100`) so "who had access in June"
is unanswerable; bearer keys are unexpiring and human-shaped rather than device-shaped. This
stage makes every human role session-capable, introduces device tokens bound to humans, replaces
assignments with an append-only grant log (model- and page-scope), and closes the attribution
gaps — with BOTH credential kinds accepted until clients migrate (24/32).

**Entry criteria restated as facts to verify:**
- Stage 19's policy layer live (`auth` vocabulary enforced) — the middleware is what device
  tokens extend.
- No other auth work in flight (crown-jewel rule).
- Break-glass tested: owner password login + an owner API path verified working BEFORE any
  enforcement change (record the drill).
- Verified substrate: sessions table `auth_sessions` (digest, expiry — `schema.ts:1469-1487`);
  keys `api_keys` (prefix `agency_hub_core_`, digest, revocation-only — `schema.ts:1489-1506`,
  `auth.ts:41,391-394`); argon2id + timing-equalized verify + in-memory backoff
  (`auth.ts:240,606-614,499-589`); `content_manager` legacy-only
  (`creatableUserRoles`, `packages/shared/src/types.ts:104-106`; legacy-read test
  `tests/api.integration.test.ts:1997`).

**Deliverable:** chatter password login works; device tokens issue/revoke/expire while old keys
still work; `access_grants` is the grant source with a live-permissions projection exactly
equal to pre-migration assignments; contact log/snoozes/manual syncs attributed.

## 2. Changes

**core — all-roles sessions** (`services/auth.ts`): `roleCanUseSession` → all human roles
(`:93-95`); `roleNeedsPassword` opens to chatter (`:85-87`) with `password_hash` remaining
nullable (a chatter without a password simply cannot session-login yet);
`setUserPassword`/`PATCH /admin/users/:username/password` (`auth.ts:262`, `server.ts:2414`)
accepts chatters — the invite flow v1 is deliberately admin-set-password (owner/team_lead sets
it, tells the chatter, optional `must_change_password` boolean forcing a change on first
session login). `roleCanUseApiKey` (`:89-91`) unchanged (chatter keys keep working — invariant).

**core — device tokens** (new table + `services/auth.ts` + middleware):
- `device_tokens` modeled on `auth_sessions` (the verified only-expiring-token precedent):
  digest-stored, prefix `agency_hub_device_`, bound to `user_id`, `label` (machine name),
  `expires_at` (default 90 d, refreshed on use up to a hard cap), `last_used_at`, `revoked_at/_reason`.
- Issue on session login (`POST /api/v1/auth/device-tokens` — session-authenticated, returns raw
  token once) + owner-admin issue/revoke routes beside the api-key ones (`server.ts:2455-2484`
  pattern).
- `resolvePrincipal` (`server.ts:484-498`): bearer parse discriminates by prefix —
  `agency_hub_core_` → `authenticateApiKeyToken` (unchanged), `agency_hub_device_` → new
  `authenticateDeviceToken` (digest lookup, expiry + revocation check, resolves the OWNING
  HUMAN's principal — `authMethod:'device_token'`; **nothing is ever attributed to a bare
  device**: `actor` = the human, the device id travels as metadata). Stage 19's `kind:'apiKey'`
  declarations accept both (additive vocabulary `kind:'bearer'` alias — decide naming at
  execution, zero route re-annotation either way).
- Deprecation schedule declared (not enforced): chatter API keys retire after Stages 24 + 32
  confirm fleet migration; until then both kinds are first-class (target §14 bearer-key
  invariant).

**core — grants** (`access_grants` + projection):
- Schema per target §7.2 (§3). `scope_type='org'|'model'|'page'` (org = future-proof label;
  single-tenant per DP 9-A — no org table, `scope_id=0` for org-scope).
- Live-permissions projection: `resolveAssignedPageIds(userId)` — expands page-grants directly
  and model-grants through `pages.model_id` (**present and future pages**: expansion is at
  read time, not materialized), preserving the exact `assignedPageIds` enforcement shape
  (`auth.ts:82,671,691`) so the Stage 19 middleware is untouched. Cache per request as today.
- Migration: every `user_page_assignments` row → an active page-scope grant
  (`granted_by=NULL` legacy marker, `granted_at=created_at`) — parity-checked (§5); the
  assign/unassign routes (`server.ts:2426,2442`) re-implement as grant insert / revoke-stamp
  (`revoked_by`, `revoked_at`) — **no more hard deletes**; `user_page_assignments` stays
  read-only for one release as a shadow check, then drops (follow-up migration).
- Model-scope admin: `POST /admin/users/:username/models` grant/revoke routes + minimal
  dashboard list (grant admin UI expansion is Stage 33).

**core — attribution gap closes:** `workboard_contact_log.acted_by_user_id` (nullable FK, SET
NULL) threaded from the contact route (`server.ts:1136-1142`); `workboard_snoozes.created_by_user_id`
(routes `:1104-1160`); manual sync triggers thread `principal.user.id` into
`requestPageSync`'s reason/audit (`server.ts:2545-2574`) and the operator observation (Stage 7's
producer 6 picks it up). Rule adopted for review + lint (Stage 35 formalizes): **no kernel write
API without a principal parameter.**

**core — `content_manager`:** removed from `userRoles` TS (`types.ts:104`) after a prod row
check (`SELECT count(*) FROM users WHERE role='content_manager'`; if >0 → migrate rows to
`chatter` with owner confirmation); DB enum value stays (dead, documented — Status header).

## 3. Schema & data migration

```sql
-- 00NN_identity_grants.sql
CREATE TABLE device_tokens (
  id bigserial PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT '', token_digest text NOT NULL UNIQUE, key_prefix text NOT NULL,
  expires_at timestamptz NOT NULL, last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz, revoked_reason text
);
CREATE TABLE access_grants (
  id bigserial PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('org','model','page')),
  scope_id bigint NOT NULL DEFAULT 0,
  granted_by bigint REFERENCES users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by bigint REFERENCES users(id) ON DELETE SET NULL, revoked_at timestamptz
);
CREATE INDEX access_grants_user_active_idx ON access_grants (user_id) WHERE revoked_at IS NULL;
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE workboard_contact_log ADD COLUMN acted_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE workboard_snoozes    ADD COLUMN created_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL;

-- backfill: assignments → grants (idempotent via NOT EXISTS guard)
INSERT INTO access_grants (user_id, scope_type, scope_id, granted_at)
SELECT upa.user_id, 'page', upa.platform_account_id, upa.created_at
FROM user_page_assignments upa
WHERE NOT EXISTS (SELECT 1 FROM access_grants g WHERE g.user_id=upa.user_id
                  AND g.scope_type='page' AND g.scope_id=upa.platform_account_id AND g.revoked_at IS NULL);
```
Parity verification query: for every user, `resolveAssignedPageIds` over grants == the
assignment-table set (a one-shot diff script; must be exactly equal before the read path flips).

## 4. Client compatibility

- **Desktop:** nothing breaks — its chatter bearer key keeps working verbatim; device-token
  login is Stage 24's adoption. SSE re-auth (`server.ts:1460-1483`) gains the device-token
  branch with identical close-on-revoke semantics.
- **Extension:** same — bearer key untouched until Stage 32.
- **Dashboard:** owner/team_lead sessions unchanged; gains minimal user/grant admin (chatter
  password set, model-grant management); chatter dashboard login remains BLOCKED at the route
  policy level (chatters are session-capable but the dashboard's routes stay
  owner/team_lead-gated — the workboard app is the chatter surface, Stage 34).
- **Workboard:** the kernel substrate it needs is now complete (sessions + grants + attribution);
  DP 4b/4c stay deferred — nothing here forecloses them (kernel sessions are the substrate
  either way).

**Compatibility invariants (target §14):** chatter bearer keys (`agency_hub_core_`) — preserved,
dual-accepted; retirement only after 24/32, recorded then.

## 5. Tests & verification

**New tests:** chatter password login succeeds + `must_change_password` flow (integration);
device token issue → authenticate → expire (clock) → 401 → revoke → 401; **parallel-acceptance**
(same user: api key AND device token both work in one test run); grant expansion property tests
— model-scope grants a future page automatically (create page after grant → access), deny-wins
(revoked grant + active grant on same scope → the active one governs; revoke all → 403);
parity diff = 0 on a seeded assignment set; attribution columns populated by contact/snooze/
trigger routes.

**Existing suites:** full auth suite, api.integration (legacy content_manager read test updated
per the enum outcome), SSE re-auth tests.

**Production verification (exit criteria):**
- Chatter password-login succeeds on a test account (prod smoke).
- Device token issue/revoke round-trip while the same user's old key still works.
- "Who had access to page X in June" answered by a grant-history query (run it, record it).
- Live-permissions projection exactly equals pre-migration assignments (the parity diff, run in
  prod before flipping the read path).

## 6. Rollback

- Read-path flip (assignments → grants) is a code toggle for one release (shadow table kept);
  reverting re-reads `user_page_assignments` (still intact until the follow-up drop).
- Device tokens/sessions are additive; disable issuance to freeze adoption. Dual credential
  acceptance means no client is ever locked out by a rollback.
- The assignment-table DROP is the one destructive step — it ships **only after** a full release
  cycle of grant-path parity, in its own migration, owner-acknowledged.

## 7. Assumptions

1. **argon2id/session machinery unchanged** (keep-list); backoff stays in-memory per instance —
   acceptable at current scale, revisit at Stage 25 multi-replica (note there).
2. **DP 4b/4c deferred** — no IdP, no access-grain change beyond model-scope existing; claim
   leases are Stage 23's, not access control.
3. **`assignedPageIds` shape is load-bearing** for middleware + SSE filtering — the projection
   must preserve it exactly (tests pin it).
4. **Prefix-discriminated bearer parsing is safe**: `agency_hub_core_` and `agency_hub_device_`
   are disjoint by construction (`API_KEY_PREFIX`, `auth.ts:41`).
5. **Single-tenant (DP 9-A)** recorded: `scope_type='org'` rows use `scope_id=0`; no org table
   exists by decision — written into `decisions.md` as the invariant.

## 8. Task breakdown

1. **Migration + grants repo + expansion + parity script.** *(1 session)*
2. **All-roles sessions + password lifecycle + must-change flow.** *(0.5–1 session)*
3. **Device tokens (issue/auth/expire/revoke + SSE re-auth branch + admin routes).** *(1
   session)*
4. **Assignment routes → grant writes; read-path flip behind toggle; shadow parity.** *(0.5–1
   session)*
5. **Attribution columns + route threading + content_manager row check/TS removal.** *(0.5
   session)* *(parallel with 3)*
6. **(Last) Deploy; prod smokes (login, dual-credential, history query, parity diff); flip read
   path; record results here. Assignment-table drop ships next release.** *(ops)*

---

## Progress

**Session 1 (2026-07-06, branch `kernel/stage-21-event-stream-v2` continued as the chain — Stage 22
commits c4dbcc6 + 89dc253 land on the SAME branch tip after Stage 21; ordering deviation per the
standing owner "continue": substrate is green-local Stage 19, deploy follows the chain):**

§8 checklist — **Tasks 1–5 BUILT** (two commits):
- [x] **Task 1** (c4dbcc6) — migration **0065** (device_tokens, access_grants + partial/scope
  indexes, users.must_change_password, workboard attribution columns, idempotent
  assignments→grants backfill with granted_by NULL = legacy marker); grants repo
  (idempotent insert / stamp revoke / history / resolveGrantedPageAssignments with the EXACT
  listUserPageAssignments row shape + read-time model expansion); `grants:parity` CLI
  (exit 1 on any user diff).
- [x] **Task 2** (89dc253) — roleCanUseSession opens to chatter; NEW roleCanUseDashboard keeps
  the dashboard owner/team_lead (spec's "chatter dashboard login remains BLOCKED"); admin
  setPassword accepts chatters + mustChangePassword flag; changeOwnPassword (verify current →
  set → clear flag → revoke ALL sessions → re-login); **must-change gate enforced
  UNCONDITIONALLY in the policy hook** (allowlist me/logout/authChangePassword) — new behavior,
  deliberately outside the log/enforce comparison.
- [x] **Task 3** (89dc253) — device tokens end-to-end: agency_hub_device_ prefix, digest-stored,
  90 d sliding expiry (bump throttled to ≥1 d gains) capped at 365 d;
  authenticateBearerToken prefix dispatch in resolvePrincipal AND both SSE re-auth branches;
  requireApiKeyUser widened to device_token (execution decision: keep kind:"apiKey", no
  re-annotation); self-issue POST /auth/device-tokens (any-session) + owner admin trio.
- [x] **Task 4** (89dc253) — assign/unassign + issueChatterApiKey page-bind DUAL-WRITE
  (grant + legacy row) while ACCESS_GRANTS_READ_ENABLED=false; flip switches reads to the
  projection AND freezes legacy writes. EXECUTION INTERPRETATION RECORDED: spec's "assignments
  read-only immediately" would break continuous parity — dual-write-until-flip keeps the parity
  invariant true at every instant.
- [x] **Task 5 partial** (89dc253) — workboard contact/snooze attribution threaded
  (acted_by_user_id / created_by_user_id); manual-sync-trigger attribution VERIFIED ALREADY
  CLOSED by Stage 7 4b (admin.sync_trigger recordAudit carries actorUserId → operator
  observation). **content_manager TS removal DEFERRED to Task 6 ops**: it needs the prod row
  check first (`SELECT count(*) FROM users WHERE role='content_manager'`); removing the TS
  value with a live row would 500 response serialization. Steps in Task 6.
  **Model-grant dashboard list UI deferred** with it (routes + history endpoint exist; Stage 33
  owns the admin UI expansion — recorded, minimal-surface rule).
- [ ] **Task 6 (ops)** — deploy 0065 + dist → prod smokes: chatter password login on a test
  account; device token issue/revoke round-trip while the same user's key works;
  `grants:parity` = zero; the June-access history query run + recorded; content_manager row
  check → rows>0 ? migrate to chatter w/ owner confirm : remove from userRoles TS next release;
  read-path flip (ACCESS_GRANTS_READ_ENABLED=true) AFTER parity; assignment-table DROP ships a
  release later, owner-acknowledged.

New vocabulary: **kind:"any-session"** (any live cookie session, any role) — verdict via new
requireSessionUser; legend updated. New config: ACCESS_GRANTS_READ_ENABLED (NEVER/none, default
false). Gotchas: config-less test contexts (rotation/password-reset unit mocks) reach the toggle
→ reads are app.config?-defensive; pg returns bigint columns as strings (Number() in tests);
repo-level mock factories needed the new db exports added.
