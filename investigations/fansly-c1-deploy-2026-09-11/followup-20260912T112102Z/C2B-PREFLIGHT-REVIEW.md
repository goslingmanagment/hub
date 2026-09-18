# C2b preflight review — 12 September 2026

Next: read effective configuration and retain a one-page shadow report before
preparing the single-key activation packet. This review performed only local
reads and wrote this recommendation; it ran no tests or production operations.
The owner's resumed implementation/deployment authorization does not establish
existing flag state, shadow coverage or C2c acceptance.

## Source binding

The coordinator reports runtime label `02ff7e34239e` at 11:22:49 UTC. Its local
git object resolves to `02ff7e34239e4ca43339dfa9a11fe992155e2866`.
Sixteen inspected paths match both `424f2a4248b6` and C1 worktree HEAD `66d6ac1a`:
the earnings handler/capture/receipt, transaction writer, both allowlist and
scheduling helpers, effective/config-view services, three dirty/receipt DB
modules, migrations 0178/0180/0181, config registry and C2b runbook. This is
source compatibility evidence; the runtime label and actual DB grants still
need retained production receipts. These C2b sources do not require another
deployment merely to begin the preflight.

## Read effective flags through the existing owner session

Use **`GET /api/v1/admin/config`**, the Configuration UI's existing read route,
or the generated SDK operation `adminConfig`. It requires **owner-session**
authentication; the repository's agent CLI has no configuration command.
An Agent Read Plane credential is not a substitute for the owner session.
Do not fall back to app-user/superuser SQL or export process environments.

Retain `generatedAt`, `roleStatuses`, `instances`, and the following three
items from `subsystems[].items[]`:

| Key | Required interpretation |
|---|---|
| `fanslyFanEarningsShadowPageAllowlist` | Record each active role's exact `running[].value`. Default `none`; blank/unset matches no page. Existing entries must be preserved, not silently replaced. |
| `fanslyFanEarningsSyncEnabled` | Must effectively be boolean `true` for ordinary earnings calls to run. |
| `fanslyNewStreamPageAllowlist` | Candidate label must match, or the value must be empty: this legacy allowlist's empty value means **all** pages. |

For each item keep `source`, `desired`, `overrideVersion`, `pendingApply`,
`drift`, and `running[]` with role/value/state/lastSeenAt. Require fresh API,
worker and scheduler rows, not just the view's default expected API/worker pair.
Missing/stale values are unknown. For the two string keys, `runningState=unknown`
or `desiredEffective=null` is not an off verdict; inspect the exact CSV values.
The shadow descriptor has no automatic `requires` dependency enforcement.

Evidence: [owner route and contract](/Users/dmitriy/.codex/worktrees/hub-fansly-c1-followers/packages/contracts/src/routes.ts:8093),
[runtime view](/Users/dmitriy/.codex/worktrees/hub-fansly-c1-followers/apps/runtime/src/services/app-config-service.ts:123),
[descriptor](/Users/dmitriy/.codex/worktrees/hub-fansly-c1-followers/packages/shared/src/config-registry.ts:115),
[opposite CSV semantics](/Users/dmitriy/.codex/worktrees/hub-fansly-c1-followers/apps/runtime/src/services/sync/fansly-stream-gate.ts:18).

## Read existing shadow activity

Use the established `read_only` connection to `agency_hub_core`. First verify
the function exists and this role can execute it, inside a READ ONLY transaction
with the same limits below. Catalog reads need no base-table grants:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '1s';
SELECT current_user, current_setting('transaction_read_only');
SELECT to_regprocedure('public.fansly_earnings_shadow_report(text)') AS report_function,
       CASE WHEN to_regprocedure('public.fansly_earnings_shadow_report(text)') IS NOT NULL
         THEN has_function_privilege(current_user,
           'public.fansly_earnings_shadow_report(text)', 'EXECUTE')
       END AS can_execute;
ROLLBACK;
```

Proceed only with `current_user=read_only`, read-only `on`, and executable
function. Bind one verified Fansly page label as the psql `page_label` variable;
the label is a report target, not an enablement decision. Do not batch all pages
into one long function call. If other labels need baselines, read them serially.

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '1s';
SELECT public.fansly_earnings_shadow_report(:'page_label');
ROLLBACK;
```

Retain JSON, SHA-256, label, export interval, role, source/image and config
version. Missing function/access or timeout is an unavailable preflight, not an
empty successful report. Migration 0181 revokes PUBLIC execution and grants
`read_only` access without exposing fan IDs, amounts, payloads or base tables.
The query is page-scoped but aggregates its tracked operational state; the
deadline remains necessary at production cardinality.

## Activation packet and acceptance limits

Before a flip, select one eligible active Fansly page with ordinary transaction
activity and an understood daily spender walk. Record both endpoint baselines,
`last_completed_daily_spender_sweep`, stream/cadence health, request budget and
A0/T0 physical attempts over a dated interval. If shadow is already enabled,
inspect that activity first instead of resetting it. The reviewed packet should
name the page, current and proposed CSV, version for the audited one-key change,
verification window and rollback value. No cursor reset, forced sync, replay,
additional flag or cadence change is part of that activation.

The handler still selects positive-net daily spenders and performs the same
lifetime/monthly calls; the dirty state does not select extra HTTP targets.
Claims and semantic dirty revisions are independent for both endpoints, old/new
fan bindings survive, and R+1 remains pending after R. Empty/invalid responses,
first baselines and unchanged responses after signals do not prove recalculation.
Zero/negative and missing-roster targets remain explicit debt; a deterministic
fan rejection can still block the ordinary walk.

Retain reports across complete independent daily walks. For each endpoint
compare tracked/pending/never-checked/stale/outside-spender counts, visits versus
receipts, failures/expired claims, valid checks, changes and unsignaled changes.
`tracked_scope_complete=false` and an empty endpoint list must remain explicit.
Aggregates do not provide historical per-fan correction latency or distinguish
multiple corrections hidden behind one pending signal. Precise fan/window
attribution requires a separately scoped approved read surface over retained
receipts; do not bypass the metadata reader's privacy boundary with base-table
SQL. One fan's recent check, zero unsignaled changes or fewer hypothetical calls
cannot pass C2c. Daily rotation remains until quiet-correction detection/max-age
and physical cost are actually established.

Evidence: [report fields and grants](/Users/dmitriy/.codex/worktrees/hub-fansly-c1-followers/packages/db/migrations/0181_fansly_earnings_shadow_read.sql:13),
[selection and two calls](/Users/dmitriy/.codex/worktrees/hub-fansly-c1-followers/apps/runtime/src/services/sync/fan-earnings.ts:45),
[atomic semantic writer](/Users/dmitriy/.codex/worktrees/hub-fansly-c1-followers/apps/runtime/src/services/sync/transactions.ts:400),
[receipt CAS](/Users/dmitriy/.codex/worktrees/hub-fansly-c1-followers/packages/db/src/repositories/fan-earnings-receipts.ts:28),
[plan requirements](/Users/dmitriy/.codex/worktrees/hub-fansly-c1-followers/investigations/fansly-events-migration-plan-2026-09-07.md:164).

## Documentation finding

The [runbook's reservation paragraph](/Users/dmitriy/.codex/worktrees/hub-fansly-c1-followers/docs/runbooks/fansly-earnings-shadow.md:22)
and [stage STATUS](/Users/dmitriy/.codex/worktrees/hub-fansly-c1-followers/investigations/fansly-c2b-earnings-shadow-2026-09-10/STATUS.md:3)
still describe pre-merge CI/migration reservations; STATUS line 62 also says
A0's clock has not started. Label that text historical or refresh the operational
packet before relying on it. Do not renumber or edit applied SQL. No additional
code blocker was identified in this bounded review; production acceptance and
the C2a retained replay/repair evidence remain separate, unverified claims here.
