# OFAPI binding continuity (Decision 382)

What happens when an OnlyFans page's OFAPI account changes, and what to do so
it changes as rarely as possible.

## The rule that avoids the problem

An `acct_…` is one OFAPI connection. OFAPI keeps it alive through session
expiry (automatic re-login, then "Re-authenticate Account" in the console or
`POST /api/authenticate/{account_id}/reauthenticate`). A NEW `acct_…`
appears only when the creator is **added again** ("Start Authentication" /
"Add account"). The vendor FAQ names that as the mistake behind duplicate
accounts. So, when the hub raises `ofapi_auth` (session expired, 2FA, face
check, disconnected): **re-authenticate the bound account; do not add the
creator again.** Then nothing below is needed.

## When the id changes anyway

The reconciler (`ofapi.binding.reconcile`, every five minutes, flag
`ofapiBindingReconcileEnabled`, roster read is free) matches accounts to pages
by the creator's OnlyFans id, which never changes:

| Situation | What it does |
|---|---|
| Page has no creator id recorded | Seeds it from the roster entry of the page's current account (page + custody row). Refuses if another page carries that creator. |
| Current account gone from the roster / not authenticated / auth action required, exactly one authenticated account of the same creator | Rebinds through the verified apply: new generation, old account retired with `valid_to`, `ofapi.binding.replaced` audit row, auth incident resolved. Journaled facts of both refs replay. |
| Same, but zero or several candidates | Waits (`waiting[].reason`). Candidates still join custody as history. |
| Bound account works and the creator is connected a second time | Keeps the binding, attaches the duplicate as history, logs the re-authenticate advice (`duplicates[]`). |
| Recorded creator ≠ roster creator for the page's account | Touches nothing, reports `identityMismatches[]` (log level error). |
| Roster account no page owns and no creator matched | Reports `unownedRosterAccounts[]`. |

Custody never moves between pages; that stays an operator action
(`docs/runbooks/ofapi-refresh-release1.md`).

## Rollout

1. Deploy; the job is registered but off.
2. Report first, from the api container:

```bash
docker exec agency-hub-api-1 node /app/apps/runtime/dist/cli.js ofapi:bindings:reconcile
```

   Expect on the two Lora pages: `seed_identity` for 518588958 (page 8) and
   514788334 (page 9), no `rebind`, no mismatch.
3. Apply once by hand: the same command with `--execute`; check
   `select id,label,ofapi_account_id,external_page_id from pages where platform='onlyfans'`.
4. Flip `ofapiBindingReconcileEnabled` in the panel (staged group #382),
   restart the worker. Silent runs log nothing; any action, wait, mismatch or
   duplicate logs `OFAPI binding reconcile complete` with the full result.

## Reading a rotation afterwards

- `observations` kind `ofapi.binding.replaced`, payload `source:
  "roster_reconcile"`: what was replaced, when, on which roster capture
  (`rosterEvidence.observationId` → the `ofapi_admin_accounts` row).
- `ofapi_account_bindings`: the retired account keeps its row (`valid_to`
  set), the new one carries the generation; attached history rows have
  `generation null` and `evidence.action = "attach_historical"`.
- Sweep log: `unmappedRefs` names any ref still without custody; after a
  rebind it empties within the next sweep pass.

## Pre-custody history

Accounts that were retired before the custody table existed are not in the
roster and cannot be repaired here: see
`docs/runbooks/ofapi-historical-binding-import.md` (Decision 381).
