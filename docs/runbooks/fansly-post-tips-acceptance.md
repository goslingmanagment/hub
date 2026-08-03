# Fansly post tips — post-deploy acceptance

This is an owner-gated verification for decision #209. It establishes what the
undocumented `GET /tips?targetIds=...` call actually returns in production; it
does not turn a captured sample into a provider completeness guarantee.

All monetary values below are Fansly-native mills (`1000 = $1`). Run these
checks only after migration 0121, canonicalizer v4 and the creator-post
projection are deployed.

## 1. The one-time walk completed instead of restarting

```sql
select p.label,
       c.state ->> 'revision' as revision,
       c.state ->> 'before' as before_cursor,
       c.state ->> 'pageIndex' as page_index,
       c.state ->> 'fanslyPostTipsCaptureVersion' as capture_version,
       c.state ->> 'fanslyPostTipsBackfilledAt' as backfilled_at,
       c.state ->> 'fanslyRecentRefreshCutoffAt' as refresh_cutoff_at,
       c.state ->> 'fanslyRecentRefreshAnchorReached' as refresh_anchor_reached,
       c.state ->> 'completedAt' as completed_at,
       c.updated_at
from page_sync_cursors c
join pages p on p.id = c.page_id
where p.platform = 'fansly' and c.stream = 'posts'
order by p.label;
```

Acceptance: every enabled Fansly posts lane reaches `capture_version = 1` and
non-null `backfilled_at`/`completed_at`. While a long walk is in progress,
`before_cursor` and `page_index` must continue across a revision change rather
than reset to `0`.

The one-time historical walk has a null `refresh_cutoff_at` and completes only
at the terminal empty timeline page. On the next ordinary six-hour revision,
`refresh_cutoff_at` is frozen at that logical walk's start minus 14 elapsed days.
The walk must continue after `refresh_anchor_reached = true` and complete only
at an empty page or after capturing one wholly older boundary page. If it spans
chunks or a cadence revision, the same cutoff and non-zero `before_cursor` must
survive; a later wall clock must not move the cutoff mid-walk.

Confirm the request journal contains `scanMode = recent_refresh` and the same
`recentRefreshCutoffAt` for every page in one logical walk. Pick a post below
the former head page but still inside the cutoff and verify both its timeline
snapshot and companion `/tips` payload were observed again. This is the live
check that `/timelinenew` is still newest-first; an older-than-horizon post
remains a point-in-time snapshot and is not claimed continuously current.

## 2. Parser health is explicit

Top-level response drift remains below v4 and is replayable:

```sql
select p.label,
       count(*) as captured_tip_payloads,
       count(*) filter (where o.parse_version < 4) as top_level_parse_debt
from observations o
join pages p on p.id = o.account_id
where o.source = 'pull' and o.platform = 'fansly' and o.kind = 'post_tips'
group by p.label
order by p.label;
```

Malformed members of an otherwise valid array do not discard valid siblings.
They produce a bounded diagnostic. An old diagnostic is resolved when a newer
parser version successfully replays its observation, so inspect only rows whose
observation is still stamped at that diagnostic's parser version:

```sql
select p.label,
       count(*) as affected_payloads,
       sum((e.data ->> 'rejectedItemCount')::int) as rejected_items,
       min(e.occurred_at) as first_seen_at,
       max(e.occurred_at) as last_seen_at
from domain_events e
join observations o on o.id = e.observation_id
join pages p on p.id = e.account_id
where e.type = 'post.tip_parse_rejected'
  and o.parse_version = (e.data ->> 'parserVersion')::int
group by p.label
order by p.label;
```

Acceptance: zero top-level debt and zero rejected items is ideal. Any non-zero
row is an explicit gap to inspect from owner-only raw capture; it is not a
reason to infer or synthesize missing tips. Sync run anomalies with code
`fansly_post_tips_contract_drift` identify non-array responses without wedging
the posts lane. `fansly_post_tips_scope_drift` identifies an array that
explicitly named another receiver or a type-1000 post outside the request. The
raw table still holds the provider response verbatim; its `post_tips`
observation is a request-context quarantine envelope left as visible parse debt,
so none of its rows project under the requesting page.

Verify the undocumented target filter itself from each raw request/response
pair. This query must return zero rows:

```sql
select p.label, r.id as raw_payload_id, tip.ordinality as tip_index,
       target.value ->> 'id' as returned_post_ref,
       r.request_params -> 'targetIds' as requested_post_refs
from sync_raw_payloads r
join pages p on p.id = r.page_id
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(r.response_payload) = 'array'
    then r.response_payload else '[]'::jsonb end
) with ordinality as tip(value, ordinality)
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(tip.value -> 'targets') = 'array'
    then tip.value -> 'targets' else '[]'::jsonb end
) as target(value)
where r.endpoint = 'post_tips'
  and target.value ->> 'type' = '1000'
  and not exists (
    select 1
    from jsonb_array_elements_text(r.request_params -> 'targetIds') requested(id)
    where requested.id = target.value ->> 'id'
  );
```

Also compare every returned `receiverId` with the page's native Fansly account
id. The canonicalizer independently rejects receiver mismatches as item parse
debt. Zero scope anomalies plus zero query rows is evidence for this run, not a
permanent provider guarantee.

## 3. Reconcile captured rows to the post snapshot without forcing equality

```sql
select p.label,
       cp.platform_post_id,
       cp.published_at,
       cp.tip_goal_ref,
       cp.tip_amount_mills,
       cp.attachment_tip_amount_mills,
       cp.post_tip_total_mills,
       count(cpt.id) as captured_tip_rows,
       coalesce(sum(cpt.post_tip_amount_mills), 0) as captured_tip_mills,
       coalesce(sum(cpt.post_tip_amount_mills)
         filter (where cpt.tip_goal_ref is not null), 0) as captured_goal_mills,
       coalesce(sum(cpt.post_tip_amount_mills)
         filter (where cpt.tip_goal_ref is null), 0) as captured_direct_mills,
       cp.post_tip_total_mills
         - coalesce(sum(cpt.post_tip_amount_mills), 0) as snapshot_minus_rows_mills
from creator_posts cp
join pages p on p.id = cp.account_id
left join creator_post_tips cpt
  on cpt.account_id = cp.account_id
 and cpt.platform_post_id = cp.platform_post_id
where p.platform = 'fansly'
  and cp.published_at >= '2026-07-27T00:00:00Z'
  and cp.published_at <  '2026-08-02T00:00:00Z'
group by p.label, cp.id
order by p.label, cp.published_at;
```

Interpretation:

- `captured_tip_mills = post_tip_total_mills` is evidence of reconciliation for
  that captured post at that observation, not a universal API guarantee.
- A positive difference can be legitimate: the snapshot includes
  `attachmentTipAmountMills`, while a tip targeting a reply/attachment may not
  be returned by `/tips?targetIds=<post>`. Keep and report the difference.
- Goal/direct classification comes only from the captured type-7100 target:
  non-null `creator_post_tips.tip_goal_ref` is goal-qualified; null is direct.

## 4. Birthday ground truth

Match the rows to their native post refs using goal labels and the known UI/raw
observations, then record actual results next to this table:

| Page | Known live fact to reproduce |
|---|---|
| `lora-1`, laptop goal | `$1,000` goal-qualified total, `14` individual tips |
| `lora-1`, party post | `$500` goal-qualified + `$20` direct under the post |
| `lora-2`, birthday posts | known components `$455` and `$10.95` |
| `lora-3`, birthday posts | known components `$205` and `$200` |

The laptop post is the strongest acceptance for target-filter completeness:
`captured_tip_rows = 14`, `captured_goal_mills = 1000000`, and every captured
row points to the expected goal. The party post is the discriminator for exact
goal attribution: `500000` with a goal ref plus `20000` with a null goal ref.

## 5. Agent read smoke

Use `hub capabilities` first and read blockers/floors on every result.

- Known-post current snapshot: `post_monetization`, broad publication window,
  `--filter postRef:eq:<ref>`. Its window remains `publishedAt`; verify filters
  on both `publishedAt` and `lastObservedAt` without treating the latter as tip
  time.
- Money movements in a period: `post_tips`, whose window is
  `postTipOccurredAt`. Verify `postTipGoalRef` and gated verbatim
  `postTipMessageText`.
- Cross-post goal totals: `tip_goals`; verify exactly one row per
  `tipGoalRef` and the expected `linkedPostCount`.
- Person/timeline: verify post attribution appears in the separate `post_tips`
  lane/card and is not added a second time to the ordinary money total. A
  `postTipMessageText` claim on person/timeline must fail closed and direct the
  caller to the gated `post_tips` dataset.

Do not mark acceptance complete until `delivery.nextCursor` is exhausted and
the `creator_post_tips` capture floor, gaps and parse debt have been recorded.
`post_monetization` and `tip_goals` must likewise have no `creator_posts`
`parse_debt` gap from a fail-closed timeline page.
