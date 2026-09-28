# Fansly WS + REST reliability repair

Decisions 383–387; plans and independent Fable review:
`docs/plans/2026-09-22-fansly-reliability/`.

## Deployment boundary

This branch changes code and adds migration 0206. It does not deploy, enable
flags, repin production policy, reset a watermark or recover historical rows.
Production rollout follows the ordinary owner-approved deploy procedure. Test
and observe one page before widening an operational intervention. Preserve the
existing B0/B1 gates, full cadence and 24-hour attempt budget.

0206 is additive and an older binary can keep writing the old columns. A code
rollback leaves new receipt evidence readable; old code can again repeat reads
for deleted targets. Disable B1 through the existing switch if containment is
needed. Keep raw observations and attempt accounting intact.

## Checked generation repair

Run against the intended environment. Status is read-only and makes no Fansly
HTTP request. Preview for a mismatched generation and apply each inspect account/me once through the exact
page proxy, without retries or redirects. They never send a fan message.

```sh
pnpm --silent cli fansly:ws-policy --page lora-2
pnpm --silent cli fansly:ws-policy --page lora-2 --preview > /tmp/lora-2-preview.json
```

Review page identity, old/new generation, binding result, blockers and proposal.
B0 verified_at is only socket authentication shape; the account/me result is the
independent account check. A ready proposal expires after 15 minutes. To apply
that concrete reviewed operation after authorization:

```sh
pnpm --silent cli fansly:ws-policy --page lora-2 --apply /tmp/lora-2-preview.json
```

Apply rechecks binding, generation, config version/fingerprint and permanent
policy under existing row locks and a serializable transaction. A conflict
requires a fresh preview; never work around it by resetting a budget or changing
activationAt. Reapplying an already-recorded proposal returns already_applied.
Canary, disabled and expired policies refuse. Verify all-role live config
convergence and new receipts in the new generation afterward; no process restart
is required for live overrides. Old disabled receipts remain retained and are
not automatically re-routed. A reverse repin to a stale generation is not a
repair; rollback to B1-off is the operational containment option.

Detailed sync-block responses expose messages_live.metrics.fanslyWsHints. A
mismatch is informational, not a deploy-health failure or an archive completeness
certificate. The command also exposes it when ordinary REST is healthy.

## Settlement and failure checks

```sql
select page_id, settlement_kind, count(*)
from fansly_ws_hint_status where received_at >= now() - interval '24 hours'
group by page_id, settlement_kind;

select page_id, subject_ref, last_refresh_outcome, consecutive_failures,
       next_due_at, retry_after_at, requested_revision, applied_revision
from subject_refresh_state where plane = 'fansly_ws_dm'
order by page_id, subject_ref;
```

A prior hot_applied_at remains materialization evidence even if the message is later deleted.
source_deleted means an exact retained delete settled the operational target
following a contiguous REST walk. It does not mean the message was stored in the
business archive; hot_applied_at stays null for a deleted-only target. Its
settlement_observation_id points to retained deletion evidence. Mutation receipts
stay mutation_debt; this is not a B2 tombstone projector.

A terminal transport/timeout event for the admitted B1 request records
`target_transport`/`target_timeout` and retries after 60 seconds, then 120, up to
one hour. A missing target without exact deletion evidence still uses the existing
one-minute target_unconfirmed retry, bounded by the unchanged 24-hour cap. Auth, 429/Retry-After, policy cancellation and storage/telemetry errors
retain shared executor behavior. New R+1 preserves retry_after_at. Hint-only
runs never certify ordinary freshness or resolve its incidents. Attempt counts
are not refunded or reset across policy generations.

A spent 24-hour cap is checked before any B1 request is prepared: the claimed
subject records `budget_exhausted` and retries when enough counted attempts age
out of the window, without a pacer slot or a consecutive_failures increment,
and the projector does not wake an event-only DM run until then. Subjects
deferred to the same reopening are claimed in the order they were refused
(`last_visited_at`), so a saturated page serves its backlog first in, first
out rather than by group id. Other refusals before dispatch (policy disabled or
expired, type disabled) also leave consecutive_failures unchanged.

A0 full scans after bounded scans must retain the prior certified completion in
diagnostics.boundaryMs. Inspect complete/incomplete status and below-stop
witnesses together; green deployment or a complete A0 report alone is not a
whole-archive preservation proof.

## Six retained-only Ari targets

The exact input is `docs/plans/2026-09-22-fansly-reliability/ari-recovery-targets.json`.
It identifies the six observations/messages independently checked in the
September 21 audit. Their live reader state can change; regenerate the manifest:

```sh
pnpm --silent cli fansly:ws-recovery-manifest \
  --input docs/plans/2026-09-22-fansly-reliability/ari-recovery-targets.json
```

The command uses a read-only transaction, at most 20 exact targets, the envelope
payload reader, canonical reader precedence and the existing owner-erasure
fence. Output contains text length and envelope hash and provenance, never text. Missing
receipts, unavailable bodies, uncertain binding and owner erasure are explicit.
Custody is the stored expected identity, not fabricated account verification.
Later source mutations remain distinct from materialization/tombstones in the
reader. A manifest is a current inspection, not reusable write authorization.

There is no supported WS-to-message_archive projector in this code. The six rows
are not claimed recovered. A separate B2 change must define native sender/fan
identity for groups absent from REST, source-event deduplication/provenance,
tombstone ordering, owner-erasure fencing and replay before applying a reviewed
production recovery. Do not create a fake visible REST thread to bypass it.
