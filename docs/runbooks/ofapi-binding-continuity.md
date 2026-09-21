# OFAPI binding continuity (Decision 382)

What happens when an OnlyFans page's OFAPI account changes, and what to do so
it changes as rarely as possible.

## How the accounts actually rotate here

The owner registers a NEW OnlyFansAPI account (a new team) roughly monthly,
connects the models there and hands the new API key to an agent, who applies
it in the hub. Every `acct_…` changes at once with the team; the OnlyFans
creator ids behind them do not. (The vendor's "re-authenticate instead of
adding again" advice is about a different situation — one team, a session
that expired — and does not apply to this flow.)

## Key handover: what the agent does in the hub

1. On the VPS, in `/opt/agency-hub/.env.production`: set `OFAPI_API_KEY` to
   the new key and `OFAPI_EXPECTED_TEAM_SLUG` to the new team's slug (OFAPI
   console, or `GET https://app.onlyfansapi.com/api/whoami` with the new
   key → `team.slug`); keep `OFAPI_WEBHOOK_MANAGEMENT_SCOPE=team`. Both are
   env-only settings (`editability: never`), so recreate the services:
   `cd /opt/agency-hub && docker compose --env-file .env.production -f docker-compose.production.yml up -d`.
   Without the new slug the credential preflight reports `mismatch`, every
   stateful OFAPI call refuses, and the reconciler skips with
   `credential_mismatch` in the worker log.
2. Re-register the webhook under the new team: `POST /api/v1/admin/ofapi/webhook`
   (owner session) with `endpointUrl` = `https://gosling-agency.ru/api/v1/ofapi/webhook`.
3. Do NOT edit `pages.ofapi_account_id` by hand. Within five minutes the
   reconciler sees the new roster, rebinds both pages to the new accounts of
   the same creators and keeps the old accounts as history — or run it now:
   `ofapi:bindings:reconcile` (report), then `--execute`.
4. Check: `select id,label,ofapi_account_id,external_page_id from pages where platform='onlyfans'`
   shows the new `acct_…`; `ofapi_account_bindings` still lists the previous
   ones with `valid_to`; the worker log has `OFAPI binding reconcile complete`
   with two `rebind` actions.

## When the id changes anyway

The reconciler (`ofapi.binding.reconcile`, every five minutes, flag
`ofapiBindingReconcileEnabled`, roster read is free) matches accounts to pages
by the creator's OnlyFans id, which never changes:

| Situation | What it does |
|---|---|
| Page has no creator id recorded | Seeds it from the roster entry of the page's current account (page + custody row). Refuses if another page carries that creator. |
| Current account gone from the roster / not authenticated / auth action required, exactly one authenticated account of the same creator | Rebinds through the verified apply: new generation, old account retired with `valid_to`, `ofapi.binding.replaced` audit row, auth incident resolved. Journaled facts of both refs replay. |
| Same, but zero or several candidates | Waits (`waiting[].reason`). Candidates still join custody as history. |
| Bound account works and the creator is connected a second time | Keeps the binding, attaches the duplicate as history, reports it (`duplicates[]`). |
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
