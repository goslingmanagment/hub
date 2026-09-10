# Overview: metric audit and UI review, 2026-09-10

The first UI proposal preserved ambiguous audience KPIs and was rejected by the
owner. This revision changes the information model before the presentation.

## What the old numbers actually mean

| Old label | Actual source / calculation | What it does not prove | Treatment |
|---|---|---|---|
| Subscribers / Subs | `pages.subscriber_count`. Fansly account identity provides its headline; OnlyFans refreshes it from `page_subscriptions.is_current = true`. | Paying customers, unique agency fans, current-period acquisition. | Page-level **Access subscriptions**; no summed model/agency audience KPI. |
| Followers | Fansly's account `followCount`; OnlyFans has no equivalent supported headline here. Fansly says subscribers also count as followers. | A disjoint audience segment, customers, traffic or incremental reach. | Page-level Fansly count; OnlyFans shows unavailable. Never add to subscriptions. |
| New subscribers | `daily_subscribers.new_subscribers`: count subscription records by `source_created_at`, summed for the period. No payment predicate. | First-time paying buyers, paid acquisition, renewal count or net growth. The mutable projection and incomplete capture history cannot establish these. | Remove from the overview. |
| New followers | Count `page_follows` rows by `followed_at`, summed from `daily_followers`. No subtraction of unfollows in that metric. | Net audience growth, impressions, profile visits, unique agency acquisitions or conversion. | Remove from the overview's headline and financial table. |
| Net revenue | Sum reportable daily creator-net amounts, including pending/posted/unknown states; sales, adjustments and unclassified money. Payout reversals are excluded. | Payout balance, settled cash received, agency margin/profit or complete platform capture. | **Net earnings**, with explicit inclusion of pending transactions, sources and dates. |

Source code: `apps/runtime/src/modules/finance/index.ts`,
`apps/runtime/src/services/reporting.ts`,
`apps/runtime/src/services/sync/shared.ts`,
`apps/runtime/src/services/sync/ofapi-audience-sync.ts`,
`apps/runtime/src/services/ofapi-subscription-projection.ts`,
`packages/db/src/repositories/{sync,transactions,reporting}.ts`.

## Verified platform semantics and stored-data limits

- Fansly explicitly says subscribers are also counted as followers; it also
  supports free/discounted trial months. [Fansly: Your Audience](https://help.fansly.com/en/articles/12315291-your-audience).
- The OFAPI provider documents separate new/renewed and paid/free/unknown
  subscription metrics. The old Hub headline does not request or expose that
  segmentation. [OFAPI: Subscriber Metrics](https://docs.onlyfansapi.com/api-reference/statistics/get-subscriber-metrics).
- Read-only Hub samples contain active `lora-of` subscriptions with price 0, and
  `lora-vip-of` subscriptions with both 0 and 4,990 mills. These are bounded samples,
  **not** a census of free and paid access. Their subscription capture floor is
  unknown. More importantly, `parseOfapiActiveFan` falls back to zero when price
  fields are absent, and the live subscription projection can also use a zero
  fallback. Stored zero therefore does not distinguish known free from unknown.
- The displayed production subscriber total was 6,673 in the observed overview.
  It was a sum of page counters, not a count of paying or unique people.
- The permitted production `read_only` role could read page counters but was
  denied `page_subscriptions`; no higher-privilege database read was attempted.
  Subscription examples and transaction data came through the authorized Hub
  Agent Read Plane instead.

## What the new page answers

1. **How much was earned?** Creator-net earnings after platform fees, change in
   dollars and percent, daily chart, current/previous dates and today's incomplete
   day. Existing Fansly 7/30-day and OnlyFans 8/31-day windows are preserved.
2. **What produced the earnings?** Paid messages, subscription payments, tips,
   posts and any other reportable source; adjustments and unclassified amounts
   remain visible. Percentages use sales revenue, not the adjusted net total.
3. **Which pages changed?** Current and previous amounts by model/page, largest
   absolute decline, and sorting by earnings or decline. A zero baseline never
   produces infinity; absent comparisons remain unavailable. Retired pages are
   retained, including when their current earnings are zero but prior earnings
   were nonzero.
4. **What is the page audience?** Expandable current stored follower/access counts
   with links to each page's lists and explanations of overlap and identity limits.

The UI drops the redundant by-model chart request and the ambiguous growth
request. Existing catalog, revenue and daily-series queries remain independently
readable, retryable and protected against previous-period placeholder data.

## Real preview evidence

The initial preview used synthetic fixture data; that was insufficient to judge
business usefulness. The revised local preview uses a captured Hub transaction
slice (2026-07-10 through 2026-09-10 19:45 UTC), exhausted per-page traversals,
platform-specific report windows and the shared money/type helpers. Page audience
counters and attention states were read from the live overview. No synthetic
business amounts remain in the normal preview.

The captured 7-day selection reconciles to the observed production overview:

- Creator net: 4,203,808 mills; previous window: 5,441,424 mills.
- Paid messages: 2,757,584 mills (65.6% of sales).
- Subscription payments: 757,424 mills (18.0%).
- Tips: 652,000 mills; paid posts: 36,800 mills.
- Largest page decline: `lora-1`, -857,600 mills. `lora-3`: -735,192 mills.
  `lora-2`: +340,776 mills.

These are dated stored-Hub facts, not a fresh platform audit. Some traversals
report mutable-sort caveats; Ari's longer requested history precedes its capture
floor and contains gaps. The snapshot supports Today/7D/30D; all-time and page
drill-downs require the actual backend. The preview's fixed banner states it is
a local snapshot. Private capture files and fixture code remain ignored artifacts.

## Follow-up data work identified, outside this home-page revision

- Preserve unknown subscription prices separately from known zero through
  ingestion and provenance before offering a paid/free segmentation.
- Define buyer KPIs from transactions with explicit identity, revenue type,
  period and capture coverage; subscriptions cannot substitute for them.
- Acquisition, retention and conversion need a verified event/cohort definition,
  including repeats, expiration and capture floors. The existing daily audience
  rows cannot establish that funnel.

## Validation

- `pnpm check`: strictness ratchet passed without new debt, lint passed,
  291 unit-test files / 3,194 tests passed (9 skipped), dashboard build passed.
- Focused rerun: 29 tests covering report windows and page scope, retired
  attribution, old-server compatibility, free/paid audience ambiguity, source
  adjustments, errors and period placeholders.
- Chrome: the snapshot's 30-day amount ($22,701.17) also matches the live Hub
  overview. Switching 7D/30D, sorting declines and expanding audience work.
  A simulated daily-chart refresh failure retained earnings and all eight page
  rows with a stale-data warning; retry restored the chart.
- Responsive checks: 390px and 320px layouts, including expanded audience, retain
  the page width without horizontal overflow. Larger desktop layout keeps source
  amounts beside the earnings chart.
