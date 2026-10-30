/**
 * Agent Read Plane — the dataset vocabulary.
 *
 * WHY THIS FILE EXISTS: the dataset name in `POST /agent/pages/:pageLabel/
 * datasets/:dataset/query` is the one open-looking segment of the whole plane, and
 * the registry is the ONLY bridge from that name to code. A string never becomes a
 * table or column name at runtime: the name resolves here, and a field outside the
 * dataset's allowlist is a static 400 BEFORE any SQL. Declaring the vocabulary once
 * (here) and deriving the enums, the catalog response and the filter allowlists from
 * it is the same anti-drift law the claim/plane registry states in its own header.
 *
 * SCOPE: names, field maps, scalar kinds, deterministic sort keys. The SQL mapping
 * (dataset -> table, field -> expression) lands in slice A together with the
 * operation, WITH a mandatory two-way test: every available dataset's declared
 * fields are exactly covered by the runtime mapping, and vice versa. `platforms`
 * and `captureState` — the two remaining catalog-response columns — are runtime
 * facts about a deployment rather than vocabulary, and join in the same slice.
 *
 * Source: the contract appendix §17 dataset catalog (names, fields, default sorts,
 * stable keys and the money-bearing set are copied from it verbatim; the scalar
 * kinds are the appendix's own closed union). Architecture reference:
 * `investigations/agent-read-api-design-2026-07-31.md` §10.
 */

import { type AgentCapability } from "./agent-read-capabilities.ts";

/**
 * The closed scalar union a dataset row may carry. There is no nested structure
 * and no free JSON: `components.schemas` is empty in the generated OpenAPI (every
 * schema inlines), so a recursive JSON value expands forever. A dataset that needs
 * structure needs a real operation instead.
 */
export const AGENT_DATASET_FIELD_KINDS = [
  "string",
  "int",
  /** Integer mills (1 mill = $0.001) — never a float, never dollars. */
  "mills",
  "bool",
  "timestamp",
  "date",
  "string_array",
] as const;

export type AgentDatasetFieldKind = (typeof AGENT_DATASET_FIELD_KINDS)[number];

/**
 * The closed filter-operator vocabulary. The route schema and the kind-aware
 * validator below both derive from this value so an operator cannot be accepted
 * on the wire but forgotten by the semantic boundary (or vice versa).
 */
export const AGENT_DATASET_FILTER_OPS = [
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "is_null",
  "is_not_null",
] as const;

export type AgentDatasetFilterOperator = (typeof AGENT_DATASET_FILTER_OPS)[number];

/** Shared by the window contract and timestamp filter validation. */
export const AGENT_RFC3339_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** Kinds that admit a deterministic ORDER BY. See `agentDatasetFieldSortable`. */
const ORDERED_FIELD_KINDS: ReadonlySet<AgentDatasetFieldKind> = new Set<AgentDatasetFieldKind>([
  "int",
  "mills",
  "timestamp",
  "date",
]);

export type AgentDatasetSort = {
  readonly field: string;
  readonly dir: "asc" | "desc";
  /** NULLS LAST on a nullable sort column, so a row with no value never leads. */
  readonly nullsLast: boolean;
};

export type AgentDatasetDefinition = {
  /**
   * Money-bearing datasets additionally require the `read:money` capability.
   *
   * A dataset carrying ANY field of kind `mills` is money-bearing by definition
   * — pinned by test, because the appendix declared one such dataset otherwise
   * and that quietly put a fan's lifetime spend behind a read:datasets-only key.
   */
  readonly moneyBearing: boolean;
  /**
   * Datasets carrying operator- or fan-written FREE TEXT additionally require
   * `read:messages`.
   *
   * `fan_notes` selects the note body verbatim, which is the same disclosure
   * class as a transcript — and the person operation puts exactly that material
   * behind `read:messages`. Without this flag a `read:datasets`-only key read the
   * notes through the dataset route instead, so the capability was a door with a
   * window next to it. Declared here rather than as a list at the handler, and
   * pinned by test against the field map, so a future dataset that adds a text
   * body cannot inherit the narrower requirement.
   */
  readonly verbatimText: boolean;
  /**
   * Datasets whose ROWS DISCLOSE A PURCHASE additionally require
   * `read:messages` — the endpoints-cover scope-pairing rule.
   *
   * The rule exists because a purchase is a fact about a CONVERSATION as much
   * as about money: a row saying "this fan bought offer 3 of message X" tells a
   * `read:money`-only key who was talking to whom and what they bought, which
   * is exactly the disclosure `read:messages` guards. A buyer identity or a
   * per-message sale count discloses a purchase on its own — there is no
   * threshold below which it does not.
   *
   * Declared rather than inferred: unlike `verbatimText`, no field NAME or
   * scalar KIND can tell `salesCount` on a message offer (a purchase) from
   * `salesCount` on a catalogue item (an inventory statistic). The flag is
   * REQUIRED on every dataset so the question has to be answered rather than
   * defaulted, and a test pins the derivation.
   */
  readonly disclosesPurchase: boolean;
  /**
   * The page's OWN published material or its statistics: no row names a fan,
   * a conversation, a purchase or an amount, and any free text is the page's
   * own (its post copy, file and album names). A key holding `read:content`
   * reads such a dataset with that capability alone, in place of
   * `agentDatasetRequiredCapabilities` (owner 2026-10-29: ContentOps reads
   * posts, files and vault without the conversations). Absent means no: a
   * dataset that grows a fan, money or a conversation must drop the flag, and
   * a test pins it against the other flags.
   */
  readonly ownContent?: true;
  /** Wire field -> scalar kind. This map IS the filter/sort allowlist. */
  readonly fields: Readonly<Record<string, AgentDatasetFieldKind>>;
  readonly defaultSort: AgentDatasetSort;
  /**
   * Physical row identifier(s) completing the keyset cursor `{sortValue,
   * stableKey}`. These are NOT wire fields and are never returned or filtered on;
   * they exist so pagination is total-ordered even when the sort column ties.
   * Resolved to real columns by the slice-A mapping.
   */
  readonly stableKey: readonly string[];
};

/**
 * Datasets addressable TODAY. The path enum is built from exactly these keys, so a
 * planned dataset is caught by Zod at the boundary as a static 400 — visible in the
 * catalog, not addressable in the query.
 */
export const AGENT_DATASETS = {
  ofapi_financial_snapshots: {
    moneyBearing: true, verbatimText: false, disclosesPurchase: false,
    fields: { platform:"string", source:"string", operation:"string", metricPath:"string", unit:"string", rawValue:"string", valueMills:"mills", windowFrom:"timestamp", windowTo:"timestamp", granularity:"string", observedAt:"timestamp", coverageState:"string", coverageReason:"string", observationRef:"string" },
    defaultSort:{field:"observedAt",dir:"desc",nullsLast:false}, stableKey:["metricKey"],
  },
  // OnlyFans payout requests as OnlyFans lists them (`payouts/payout-requests`),
  // one row per invoice, latest observation wins. OnlyFans-only and separate
  // from `payouts`: Fansly's status codes, confidence and payout methods have no
  // OnlyFans counterpart, so sharing that dataset would advertise fields that
  // answer null forever.
  ofapi_payout_requests: {
    moneyBearing: true, verbatimText: false, disclosesPurchase: false,
    fields: { platform:"string", payoutRef:"string", amountMills:"mills", currency:"string", state:"string", rejectReason:"string", requestedAt:"timestamp", lastObservedAt:"timestamp", observationRef:"string" },
    defaultSort:{field:"requestedAt",dir:"desc",nullsLast:true}, stableKey:["payoutRequestKey"],
  },
  // ── OnlyFans traffic sources (plan 2026-10-08, PR 14) ─────────────────────
  // The link series: Hub reads OFAPI's stored tracking and trial link lists
  // four times a day (page_link_stat_runs / page_link_stat_snapshots). Every
  // counter and money figure is the vendor's CUMULATIVE value at the moment
  // of the read; deltas are the reader's arithmetic. OnlyFans only.
  //
  // `campaign_snapshots` — the series itself: one row per link in each run
  // that is a USABLE result of its window (coordinator's П9.1; the one shared
  // predicate `linkStatRunUsableResultSql`). Money-bearing: the vendor's
  // revenue is the creator's NET after the OnlyFans fee.
  campaign_snapshots: {
    moneyBearing: true,
    verbatimText: false,
    disclosesPurchase: false,
    fields: {
      linkKind: "string",
      linkRef: "string",
      name: "string",
      observedAt: "timestamp",
      /** The Europe/Moscow day of `observedAt` (the business day). */
      businessDate: "date",
      windowAt: "timestamp",
      runRef: "string",
      runStatus: "string",
      /** The first non-empty run under a new OFAPI account; null on rows an
       *  image that did not record the flag wrote (everything before 0255). */
      bindingChanged: "bool",
      clicks: "int",
      /** Trial links only; null on tracking links. */
      claims: "int",
      subscribers: "int",
      /** Null while the vendor has not computed it — never a fake zero. */
      spenders: "int",
      /** Creator NET after the OnlyFans fee, refunds and chargebacks; null =
       *  unknown. Never take the fee off again. */
      vendorRevenueNetMills: "mills",
      /** Already excluded from `vendorRevenueNetMills`; informational. */
      vendorChargebacksMills: "mills",
      vendorRevenueCalculatedAt: "timestamp",
      isFinished: "bool",
      linkEndsAt: "timestamp",
    },
    // Oldest first: a series is read forward from a watermark.
    defaultSort: { field: "observedAt", dir: "asc", nullsLast: false },
    stableKey: ["runId", "platformLinkId"],
  },
  // `campaign_runs` — every ATTEMPT to read a page's list, failed and skipped
  // ones included (a window that passed without any attempt is a `skipped` /
  // `window_missed` row): where the series has a hole, and why.
  // `usableResult` is the same shared predicate the snapshots are filtered by.
  campaign_runs: {
    moneyBearing: false,
    verbatimText: false,
    disclosesPurchase: false,
    fields: {
      linkKind: "string",
      windowAt: "timestamp",
      observedAt: "timestamp",
      businessDate: "date",
      runRef: "string",
      status: "string",
      /** Caveats of a `partial`, what stopped a `truncated`, the (redacted)
       *  error of a `failed`, why a `skipped` was not attempted. */
      reason: "string",
      attempt: "int",
      apiPages: "int",
      rawItems: "int",
      writtenRows: "int",
      bindingChanged: "bool",
      usableResult: "bool",
    },
    defaultSort: { field: "observedAt", dir: "asc", nullsLast: false },
    stableKey: ["runId"],
  },
  // `campaign_bindings` — who brings a link's traffic, with dates: link →
  // channel (traffic_link_bindings) and channel → contractor
  // (traffic_channel_contractors), each dated on its own. One row per STRETCH
  // over which both are constant, so a contractor change inside a binding
  // splits it, and a stretch no contractor covers says so with a null
  // contractor. The two facts' own intervals and start bases ride along
  // unchanged (П9.7: an assumed start is never served as an established one).
  campaign_bindings: {
    moneyBearing: false,
    verbatimText: false,
    disclosesPurchase: false,
    fields: {
      linkKind: "string",
      linkRef: "string",
      channelKey: "string",
      channelTitle: "string",
      contractorKey: "string",
      contractorTitle: "string",
      /** This stretch: [validFrom, validTo), validTo null = still in force. */
      validFrom: "timestamp",
      validTo: "timestamp",
      /** How the link → channel binding's start is known: `confirmed` or
       *  `assumed_link_created` (the link's creation date stands in). */
      validFromBasis: "string",
      bindingValidFrom: "timestamp",
      bindingValidTo: "timestamp",
      contractorValidFrom: "timestamp",
      contractorValidTo: "timestamp",
      contractorValidFromBasis: "string",
    },
    defaultSort: { field: "validFrom", dir: "asc", nullsLast: false },
    stableKey: ["bindingId", "stretchFrom"],
  },
  // ── OnlyFans traffic sources: Hub's own money per link (plan 2026-10-08,
  // PR 15) ────────────────────────────────────────────────────────────────
  // Hub's own figure, beside OFAPI's: posted transactions (П9.3) split equally
  // over the links whose link ↔ fan periods hold them, under
  // `ofapi_subscription_period_equal_split.v1` (each row names it). A link's
  // figure begins at its own floor (`hubMoneyFloorAt` / `floorAt`, the start of
  // its first finished fan walk): Hub says nothing of the time before it.
  // Computed when read — a period confirmed later changes past figures.
  //
  // `campaigns` — one row per link of the series, its latest state: the
  // latest snapshot's counters and OFAPI's money, the channel and contractor
  // bound to it now, and Hub's money since its floor. Windowed by
  // `lastObservedAt`.
  campaigns: {
    moneyBearing: true,
    verbatimText: false,
    disclosesPurchase: false,
    fields: {
      linkKind: "string",
      linkRef: "string",
      name: "string",
      url: "string",
      linkCreatedAt: "timestamp",
      linkEndsAt: "timestamp",
      isFinished: "bool",
      /** Vendor subscribeDays of a trial link; null on tracking links. */
      trialDays: "int",
      tags: "string_array",
      /** The channel and contractor bound now; null = none. */
      channelKey: "string",
      contractorKey: "string",
      lastObservedAt: "timestamp",
      clicks: "int",
      /** Claims on a trial link, subscribers on a tracking link (`fansMetric`). */
      fans: "int",
      fansMetric: "string",
      subscribers: "int",
      spenders: "int",
      /** OFAPI: creator NET after the OnlyFans fee, refunds and chargebacks;
       *  null = unknown. Never take the fee off again. */
      vendorRevenueNetMills: "mills",
      vendorRevenueCalculatedAt: "timestamp",
      /** Hub: posted transactions since `hubMoneyFloorAt`, net after the fee;
       *  null when the link has no finished fan walk (no floor). */
      hubRevenueNetMills: "mills",
      /** Hub: pending transactions since the floor — never in the figure. */
      hubPendingMills: "mills",
      hubMoneyFloorAt: "timestamp",
      attributionRule: "string",
      /** `creator_net_after_platform_fee` for both money figures. */
      revenueBasis: "string",
    },
    defaultSort: { field: "lastObservedAt", dir: "desc", nullsLast: true },
    stableKey: ["pageId", "linkKind", "linkRef"],
  },
  // `campaign_money_daily` — Hub's own money per link and Europe/Moscow
  // business day (00:00–24:00 Moscow): a row for a day with any posted or
  // pending share of the link. A day after the link's floor without a row had
  // none; a day before it is unknown to Hub. A chargeback or refund stands on
  // its own day with its original purchase's link shares (П2).
  campaign_money_daily: {
    moneyBearing: true,
    verbatimText: false,
    disclosesPurchase: false,
    fields: {
      businessDate: "date",
      /** 00:00 Moscow of the day, as a UTC instant (the window's column). */
      dayStartAt: "timestamp",
      linkKind: "string",
      linkRef: "string",
      hubRevenueNetMills: "mills",
      hubPendingMills: "mills",
      /** Posted transactions with a share of this link that day. */
      transactionCount: "int",
      fanCount: "int",
      attributionRule: "string",
      floorAt: "timestamp",
    },
    defaultSort: { field: "dayStartAt", dir: "asc", nullsLast: false },
    stableKey: ["pageId", "linkKind", "linkRef", "businessDate"],
  },
  fan_memberships: {
    // MONEY-BEARING because of `lifetimeSpendMills`. The appendix's prose names
    // only subscriptions/transactions/fan_spend_daily as money-bearing while its
    // own catalog puts a mills field on THIS dataset; the two statements
    // contradict each other, and following the narrower one would hand a
    // read:datasets-only key a fan's lifetime spend without read:money.
    moneyBearing: true,
    verbatimText: false,
    disclosesPurchase: false,
    fields: {
      platform: "string",
      platformUserId: "string",
      username: "string",
      displayName: "string",
      membershipState: "string",
      firstSeenAt: "timestamp",
      lastSeenAt: "timestamp",
      lifetimeSpendMills: "mills",
      // When the page's latest account answer did not return the fan
      // (deleted the account or blocked the page); null otherwise.
      accountLookupMissAt: "timestamp",
      // When the page last answered for the fan at all; null: never asked.
      accountCheckedAt: "timestamp",
      // OnlyFans only: whether the page can message the fan — contactable,
      // unavailable (chat closed), restricted, blocked, gone, unknown.
      accountContactability: "string",
    },
    defaultSort: { field: "lastSeenAt", dir: "desc", nullsLast: false },
    stableKey: ["fanId"],
  },
  dm_threads: {
    moneyBearing: false,
    verbatimText: false,
    disclosesPurchase: false,
    fields: {
      platform: "string",
      platformUserId: "string",
      conversationRef: "string",
      lastMessageAt: "timestamp",
      messageCount: "int",
      unreadCount: "int",
      coverageStatus: "string",
    },
    defaultSort: { field: "lastMessageAt", dir: "desc", nullsLast: true },
    stableKey: ["threadId"],
  },
  subscriptions: {
    moneyBearing: true,
    verbatimText: false,
    disclosesPurchase: false,
    fields: {
      platform: "string",
      platformUserId: "string",
      subscriptionRef: "string",
      subscriptionState: "string",
      startedAt: "timestamp",
      expiresAt: "timestamp",
      priceMills: "mills",
      currency: "string",
    },
    defaultSort: { field: "startedAt", dir: "desc", nullsLast: false },
    stableKey: ["subscriptionId"],
  },
  subscription_events: {
    moneyBearing: false,
    verbatimText: false,
    disclosesPurchase: false,
    fields: {
      occurredAt: "timestamp",
      fanId: "string",
      phase: "string",
      subType: "string",
    },
    defaultSort: { field: "occurredAt", dir: "desc", nullsLast: false },
    stableKey: ["domainEventId"],
  },
  transactions: {
    moneyBearing: true,
    verbatimText: false,
    disclosesPurchase: false,
    fields: {
      platform: "string",
      platformUserId: "string",
      transactionRef: "string",
      transactionType: "string",
      transactionState: "string",
      occurredAt: "timestamp",
      grossMills: "mills",
      netMills: "mills",
      feeMills: "mills",
      currency: "string",
      /** Backward-compatible legacy name. The provider value is a generic
       * correlation key and is not guaranteed to identify a message. */
      relatedMessageRef: "string",
      correlationRef: "string",
    },
    defaultSort: { field: "occurredAt", dir: "desc", nullsLast: false },
    stableKey: ["transactionId"],
  },
  tip_transactions: {
    moneyBearing: true,
    // Fan-written tip copy is transcript-grade verbatim material. One query
    // intentionally returns ledger money and captured context together, so all
    // three dataset/money/messages capabilities are mandatory.
    verbatimText: true,
    disclosesPurchase: false,
    fields: {
      platform: "string",
      platformUserId: "string",
      transactionRef: "string",
      transactionType: "string",
      transactionState: "string",
      occurredAt: "timestamp",
      grossMills: "mills",
      netMills: "mills",
      feeMills: "mills",
      currency: "string",
      correlationRef: "string",
      contextState: "string",
      capturedConversationRef: "string",
      tipMessageText: "string",
    },
    defaultSort: { field: "occurredAt", dir: "desc", nullsLast: false },
    stableKey: ["transactionId"],
  },
  fan_spend_daily: {
    moneyBearing: true,
    verbatimText: false,
    disclosesPurchase: false,
    fields: {
      platform: "string",
      platformUserId: "string",
      businessDate: "date",
      grossMills: "mills",
      netMills: "mills",
      transactionCount: "int",
      currency: "string",
    },
    defaultSort: { field: "businessDate", dir: "desc", nullsLast: false },
    stableKey: ["fanId", "canonicalType", "transactionState"],
  },
  follows: {
    moneyBearing: false,
    verbatimText: false,
    disclosesPurchase: false,
    fields: {
      platform: "string",
      platformUserId: "string",
      followed: "bool",
      followedAt: "timestamp",
      unfollowedAt: "timestamp",
    },
    defaultSort: { field: "followedAt", dir: "desc", nullsLast: true },
    stableKey: ["followId"],
  },
  followers_daily: {
    moneyBearing: false,
    verbatimText: false,
    disclosesPurchase: false,
    fields: {
      platform: "string",
      /** The UTC day the follows fell on (the rollup buckets `followed_at`
       *  by UTC date) — not a Europe/Moscow business day. */
      businessDate: "date",
      /** The page's total follower count Hub knew for that day; null = not
       *  known (only today's value comes from the live sync). */
      followersCount: "int",
      /** Follow relationships whose `followed_at` falls on that day, counted
       *  over what Hub stores (a later unfollow still counts). Derived: the
       *  rollup is rebuilt from `page_follows`, so a past day can still move.
       *  A day with no row has no stored follow. */
      newFollowers: "int",
    },
    defaultSort: { field: "businessDate", dir: "desc", nullsLast: false },
    stableKey: ["pageId"],
  },
  fan_aliases: {
    moneyBearing: false,
    verbatimText: false,
    disclosesPurchase: false,
    fields: {
      platform: "string",
      platformUserId: "string",
      aliasKind: "string",
      aliasValue: "string",
      firstSeenAt: "timestamp",
      lastSeenAt: "timestamp",
    },
    defaultSort: { field: "lastSeenAt", dir: "desc", nullsLast: true },
    stableKey: ["aliasId"],
  },
  fan_notes: {
    moneyBearing: false,
    verbatimText: true,
    disclosesPurchase: false,
    fields: {
      platform: "string",
      platformUserId: "string",
      noteRef: "string",
      noteText: "string",
      createdAt: "timestamp",
      updatedAt: "timestamp",
      // Who created the note / wrote it last, as the chat extension reported
      // (client_note_attributions); null for a note no report names.
      createdBy: "string",
      lastEditedBy: "string",
    },
    defaultSort: { field: "createdAt", dir: "desc", nullsLast: false },
    stableKey: ["noteId"],
  },
  // Who wrote each Fansly note (note-attribution-v1, 0324): one row per
  // confirmed write of the chat extension. Never a title or text of a note:
  // `noteRef` joins `fan_notes` (`external:<id>`) while the hub's sync holds the
  // note; `platformNoteRef` is Fansly's own id either way.
  note_attributions: {
    moneyBearing: false,
    verbatimText: false,
    disclosesPurchase: false,
    fields: {
      platform: "string",
      platformUserId: "string",
      noteRef: "string",
      platformNoteRef: "string",
      noteKind: "string",
      action: "string",
      origin: "string",
      fields: "string_array",
      authorLogin: "string",
      occurredAt: "timestamp",
      recordedAt: "timestamp",
    },
    defaultSort: { field: "occurredAt", dir: "desc", nullsLast: false },
    stableKey: ["eventId"],
  },
  posts: {
    ownContent: true,
    moneyBearing: false,
    // Creator-written post copy is verbatim material. This deliberately reuses
    // the transcript disclosure class: a read:datasets-only key must not gain a
    // side door to content text.
    verbatimText: true,
    disclosesPurchase: false,
    fields: {
      platform: "string",
      postRef: "string",
      postText: "string",
      publishedAt: "timestamp",
      firstObservedAt: "timestamp",
      lastObservedAt: "timestamp", rowUpdatedAt: "timestamp",
      attachmentCount: "int",
      fypFlags: "int",
      inReplyToRef: "string",
      wallRefs: "string_array",
    },
    defaultSort: { field: "publishedAt", dir: "desc", nullsLast: false },
    stableKey: ["postId"],
  },
  raw_media: {
    ownContent: true,
    moneyBearing: false, verbatimText: true, disclosesPurchase: false,
    fields: {
      platform: "string", mediaRef: "string", ownerAccountRef: "string",
      filename: "string", mimeType: "string", mediaType: "int", providerType: "string", durationMs: "int",
      width: "int", height: "int", originalWidth: "int", originalHeight: "int",
      frameRateMilli: "int", createdAtPlatform: "timestamp", updatedAtPlatform: "timestamp",
      firstOrigin: "string", sourceKind: "string", firstObservedAt: "timestamp", lastObservedAt: "timestamp", rowUpdatedAt: "timestamp",
    },
    defaultSort: { field: "firstObservedAt", dir: "asc", nullsLast: false },
    stableKey: ["mediaRef"],
  },
  post_attachments: {
    ownContent: true,
    moneyBearing: false, verbatimText: true, disclosesPurchase: false,
    fields: {
      platform: "string", postRef: "string", publishedAt: "timestamp", attachmentIndex: "int",
      pos: "int", contentType: "int", contentRef: "string", role: "string", memberIndex: "int",
      bundleRef: "string", mediaOfferRef: "string", previewRef: "string", mediaRef: "string",
      linkState: "string", filename: "string", mimeType: "string", durationMs: "int",
      originalWidth: "int", originalHeight: "int", lastObservedAt: "timestamp", rowUpdatedAt: "timestamp",
      postObservationRef: "int", offerObservationRef: "int", bundleObservationRef: "int", fileObservationRef: "int",
    },
    defaultSort: { field: "publishedAt", dir: "asc", nullsLast: false },
    stableKey: ["postAttachmentKey"],
  },
  post_monetization: {
    moneyBearing: true,
    // Fansly's tip-goal label is creator-written verbatim copy. Keep the whole
    // dataset behind the same read:messages disclosure gate as creator posts so
    // the label cannot become a side door around the text capability.
    verbatimText: true,
    disclosesPurchase: false,
    fields: {
      platform: "string",
      postRef: "string",
      publishedAt: "timestamp",
      lastObservedAt: "timestamp",
      postTargetTipAmountMills: "mills",
      attachmentTipAmountMills: "mills",
      postTipTotalMills: "mills",
      tipGoalLinked: "bool",
      tipGoalRef: "string",
      tipGoalLabelText: "string",
      tipGoalTargetMills: "mills",
      tipGoalCurrentMills: "mills",
      tipGoalAmountsHidden: "bool",
    },
    defaultSort: { field: "publishedAt", dir: "desc", nullsLast: false },
    stableKey: ["postId"],
  },
  post_tips: {
    moneyBearing: true,
    // Fansly permits the sender to attach a free-form note to a tip. The note
    // is fan-written transcript-grade material, so the whole dataset stays
    // behind read:messages in addition to its money gate.
    verbatimText: true,
    disclosesPurchase: false,
    fields: {
      platform: "string",
      postTipPostRef: "string",
      postTipRef: "string",
      tipSenderPlatformUserId: "string",
      postTipOccurredAt: "timestamp",
      postTipAmountMills: "mills",
      receiverTransactionRef: "string",
      postTipGoalRef: "string",
      postTipMessageText: "string",
    },
    defaultSort: { field: "postTipOccurredAt", dir: "desc", nullsLast: false },
    stableKey: ["postTipId"],
  },
  tip_goals: {
    moneyBearing: true,
    // The goal label is creator-written verbatim copy. This remains true even
    // though the dataset deduplicates shared goals to one latest snapshot.
    verbatimText: true,
    disclosesPurchase: false,
    fields: {
      platform: "string",
      tipGoalRef: "string",
      tipGoalLabelText: "string",
      tipGoalTargetMills: "mills",
      tipGoalCurrentMills: "mills",
      tipGoalAmountsHidden: "bool",
      lastObservedAt: "timestamp",
      linkedPostCount: "int",
    },
    defaultSort: { field: "lastObservedAt", dir: "desc", nullsLast: false },
    stableKey: ["tipGoalRef"],
  },
  // ── endpoints-cover (WP-S1): the thirteen datasets over what F1-F7 and F4
  // capture. FANSLY ONLY (A28-2) — the catalog's per-dataset `platforms` says
  // so, and no OnlyFans lane writes any of these tables.
  //
  // Every one of them declares a NON-EMPTY `readPlanes` in the SQL mapping,
  // minted by a claim field this initiative added to the matching class.
  // `readPlanes: []` is legal (`sync_streams` uses it honestly) and is
  // FORBIDDEN here: it silently disables the capture-floor epistemics the whole
  // coverage story rests on, and an empty-result answer would then carry no
  // evidence about whether anything was ever captured.
  traffic_daily: {
    moneyBearing: false,
    verbatimText: false,
    disclosesPurchase: false,
    fields: {
      platform: "string",
      subjectKind: "string",
      subjectRef: "string",
      periodMs: "int",
      bucketStart: "timestamp",
      /** RAW platform code as text (A22-2). Key on THIS. */
      sourceCode: "string",
      /** This build's reading of the code; `unknown:<code>` when it has none. */
      sourceLabel: "string",
      mappingVersion: "int",
      /** `type - (type % 10)` for a profile row; null for the 0/1 media codes,
       *  which are not a family/member structure at all. */
      family: "string",
      /** Member 1 is the creator widget's visit count; anything else is the
       *  dwell-bearing series, whose own view counts differ. */
      measure: "string",
      views: "int",
      previewViews: "int",
      uniqueViewers: "int",
      previewUniqueViewers: "int",
      interactionTimeMs: "int",
      previewInteractionTimeMs: "int",
    },
    defaultSort: { field: "bucketStart", dir: "desc", nullsLast: false },
    stableKey: ["bucketKey"],
  },
  media_stats: {
    // The catalogue head travels with the buckets, so the sale figures make it
    // money-bearing. `salesNetMills` is A12's NET verbatim; the gross beside it
    // is DERIVED and named accordingly, and the two are never summed.
    moneyBearing: true,
    verbatimText: false,
    // Catalogue sale COUNTS are inventory statistics about the creator's own
    // shelf, not a disclosure of who bought what — no fan appears on a row
    // here. The purchase-disclosing dataset is `message_media_sales`.
    disclosesPurchase: false,
    fields: {
      platform: "string",
      mediaOfferRef: "string",
      mediaType: "int",
      mimeType: "string",
      durationMs: "int",
      periodMs: "int",
      bucketStart: "timestamp",
      sourceCode: "string",
      sourceLabel: "string",
      mappingVersion: "int",
      views: "int",
      previewViews: "int",
      uniqueViewers: "int",
      previewUniqueViewers: "int",
      interactionTimeMs: "int",
      previewInteractionTimeMs: "int",
      priceMills: "mills",
      salesCount: "int",
      salesNetMills: "mills",
      /** DERIVED from net at read time (net / 0.8, A12). The name carries the
       *  warning because a wire field cannot carry a footnote. */
      salesGrossMillsDerived: "mills",
    },
    // NO VIDEO FIELDS, and their absence is deliberate: [E5] found all six live
    // per-media responses carrying seven stat keys and no video metrics at all,
    // for a video asset. Declaring always-null columns would promise a metric
    // the route does not serve.
    defaultSort: { field: "bucketStart", dir: "desc", nullsLast: false },
    stableKey: ["mediaBucketKey"],
  },
  top_media: {
    ownContent: true,
    moneyBearing: false,
    verbatimText: false,
    disclosesPurchase: false,
    fields: {
      platform: "string",
      plane: "string",
      rank: "int",
      mediaOfferRef: "string",
      bundleRef: "string",
      periodMs: "int",
      requestedStart: "timestamp",
      requestedEnd: "timestamp",
      views: "int",
      previewViews: "int",
      interactionTimeMs: "int",
      previewInteractionTimeMs: "int",
      observedAt: "timestamp",
    },
    // The WINDOW is part of a row's identity: rank 2 of one window is not the
    // same fact as rank 2 of the next, so the sort is by window, not by rank.
    defaultSort: { field: "requestedEnd", dir: "desc", nullsLast: false },
    stableKey: ["topMediaKey"],
  },
  top_tags: {
    moneyBearing: false,
    verbatimText: false,
    disclosesPurchase: false,
    fields: {
      platform: "string",
      plane: "string",
      rank: "int",
      tagRef: "string",
      /** NULL when the response's own `tags[]` join missed — never fabricated
       *  from the id, and never read as "the tag has no name". */
      tagName: "string",
      periodMs: "int",
      requestedStart: "timestamp",
      requestedEnd: "timestamp",
      views: "int",
      previewViews: "int",
      interactionTimeMs: "int",
      previewInteractionTimeMs: "int",
      observedAt: "timestamp",
    },
    defaultSort: { field: "requestedEnd", dir: "desc", nullsLast: false },
    stableKey: ["topTagKey"],
  },
  revenue_mix: {
    moneyBearing: true,
    verbatimText: false,
    disclosesPurchase: false,
    fields: {
      platform: "string",
      businessDate: "date",
      /** RAW. ONE visible label maps to TWO live codes, legacy and current
       *  (A22-2), and this ledger reaches back to 2025-03-06 — well into legacy
       *  territory. Group by `typeCode` for the truth, by `typeLabel` for the
       *  grouping the platform's own chart shows. */
      typeCode: "int",
      typeLabel: "string",
      typeEra: "string",
      mappingVersion: "int",
      /** Stored separately, NEVER derived across bases. */
      grossMills: "mills",
      netMills: "mills",
      lastObservedAt: "timestamp",
    },
    defaultSort: { field: "businessDate", dir: "desc", nullsLast: false },
    stableKey: ["revenueMixKey"],
  },
  message_media_sales: {
    // THE SCOPE-PAIRING RULE'S ONE DATASET. It supersedes the planned
    // `purchase_history` key (removed below): that name was a SYNC STREAM with
    // no serving table, while these rows are the real answer to "what was
    // offered and what was bought in DMs".
    moneyBearing: true,
    verbatimText: false,
    disclosesPurchase: true,
    fields: {
      platform: "string",
      messageRef: "string",
      conversationRef: "string",
      offerOrdinal: "int",
      mediaOfferRef: "string",
      bundleRef: "string",
      offerType: "int",
      mimeType: "string",
      durationMs: "int",
      priceMills: "mills",
      /** The archive joins THIS for purchase state (A17-4 variant B); it is not
       *  a column on the message row. `unknown` is a real value, not a null. */
      purchaseState: "string",
      orderRef: "string",
      salesCount: "int",
      salesNetMills: "mills",
      fanPlatformUserId: "string",
      messageCreatedAt: "timestamp",
      lastObservedAt: "timestamp",
    },
    defaultSort: { field: "messageCreatedAt", dir: "desc", nullsLast: true },
    stableKey: ["messageOfferKey"],
  },
  comments: {
    // Fan- and creator-written reply bodies: transcript-grade material, so the
    // whole dataset rides `read:messages` exactly as `posts` does.
    moneyBearing: true,
    verbatimText: true,
    disclosesPurchase: false,
    fields: {
      platform: "string",
      commentRef: "string",
      parentPostRef: "string",
      rootPostRef: "string",
      authorRef: "string",
      authorUsername: "string",
      /** `''` is a REPLY, not a missing one: a fan who replied with only an
       *  attachment still replied, and one of the four live captured replies
       *  had empty content. */
      commentText: "string",
      likeCount: "int",
      /** TWO BASES, never summed. */
      tipTotalMills: "mills",
      attachmentTipMills: "mills",
      attachmentCount: "int",
      occurredAt: "timestamp",
      changedAt: "timestamp",
      discoveredVia: "string",
      /** The walk route has no established pagination, so a suspiciously full
       *  page marks its rows. A true here means per-post completeness is
       *  UNKNOWN for that post — never that the comment is suspect. */
      possiblyTruncated: "bool",
      /** A later FULL walk stopped naming this comment. Never a delete (DP 7). */
      missingSince: "timestamp",
    },
    defaultSort: { field: "occurredAt", dir: "desc", nullsLast: false },
    stableKey: ["commentKey"],
  },
  likes: {
    // SHIPS EMPTY ON FANSLY, and the catalog says so rather than omitting the
    // dataset: no like code is live-confirmed ([E4]), so WP-F2's layer 2 writes
    // nothing here and `captureState` is `not_captured`. An omitted dataset and
    // an empty one are indistinguishable to a reader, which is the confusion
    // this plane exists to remove. The OnlyFans `posts.liked` webhook populates
    // the same table independently.
    moneyBearing: false,
    verbatimText: false,
    disclosesPurchase: false,
    fields: {
      platform: "string",
      subjectKind: "string",
      subjectRef: "string",
      likerPlatformUserId: "string",
      /** `active` | `undone`. An undo sets the state; it never deletes. */
      state: "string",
      occurredAt: "timestamp",
      discoveredVia: "string",
    },
    defaultSort: { field: "occurredAt", dir: "desc", nullsLast: false },
    stableKey: ["likeKey"],
  },
  vault_media: {
    ownContent: true,
    moneyBearing: false,
    verbatimText: true,
    disclosesPurchase: false,
    fields: {
      platform: "string",
      /** `creator` | `user`. The user vault is the account's OWN Likes and
       *  Purchases and holds OTHER creators' media, so merging the two would
       *  make purchases indistinguishable from inventory. */
      vaultKind: "string",
      albumRef: "string",
      albumTitle: "string",
      lastFullWalkAt: "timestamp",
      fullWalkRef: "string",
      fullWalkObservedCount: "int",
      customFilename: "string",
      filename: "string",
      mimeType: "string",
      durationMs: "int",
      originalWidth: "int",
      originalHeight: "int",
      /** Raw file identity. This is the membership key on the live creator
       *  vault and remains distinct from an optional offer id. */
      mediaRef: "string",
      mediaOfferRef: "string",
      /** The membership row's OWN id — the vault walk's cursor, and NOT the
       *  same value as `mediaOfferRef`. */
      memberRef: "string",
      mediaType: "int",
      bundleRef: "string",
      createdAtPlatform: "timestamp",
      missingSince: "timestamp",
      firstObservedAt: "timestamp",
      lastObservedAt: "timestamp", rowUpdatedAt: "timestamp",
    },
    defaultSort: { field: "firstObservedAt", dir: "desc", nullsLast: false },
    stableKey: ["vaultMemberKey"],
  },
  notifications: {
    moneyBearing: false,
    verbatimText: false,
    // Captured purchase codes 2007/2008 name the buyer through
    // `correlationGroupRef` even when `correlationRef` is null. A buyer plus a
    // purchase code discloses the purchase without needing a price or offer, so
    // this dataset obeys the same read:messages pairing rule as media sales.
    disclosesPurchase: true,
    fields: {
      platform: "string",
      notificationRef: "string",
      /** RAW. The shipped spec was wrong on EIGHT of sixteen codes, including
       *  both purchase events (A22-1) — which is why storage keys on this and
       *  the label below carries its own confidence. */
      typeCode: "int",
      typeLabel: "string",
      /** `confirmed` requires two independent live examples agreeing with a
       *  second source; everything client-derived is `inferred`. */
      typeConfidence: "string",
      mappingVersion: "int",
      correlationRef: "string",
      correlationGroupRef: "string",
      occurredAt: "timestamp",
      acknowledgedAt: "timestamp",
    },
    defaultSort: { field: "occurredAt", dir: "desc", nullsLast: false },
    stableKey: ["notificationKey"],
  },
  subscription_tiers: {
    // ONE ROW PER PLAN, not per tier: `tier.price` is a BASE, not a price (all
    // five observed tiers carried 5 000 while their plans ranged 10 000 …
    // 499 990), so a tier-grained dataset would serve a number no subscriber
    // ever paid as if it were the price.
    moneyBearing: true,
    verbatimText: false,
    disclosesPurchase: false,
    fields: {
      platform: "string",
      tierRef: "string",
      tierName: "string",
      tierPos: "int",
      /** The tier HEAD's `price`. A base, never what a subscriber pays. */
      basePriceMills: "mills",
      maxSubscribers: "int",
      planRef: "string",
      planStatus: "int",
      /** Reads `plans[].billingCycle` — verified live; `duration` exists one
       *  level down, on `promos[]`, and is a different thing. */
      durationDays: "int",
      /** THE PRICE TRUTH. */
      priceMills: "mills",
      promoCount: "int",
      missingSince: "timestamp",
      lastObservedAt: "timestamp",
    },
    defaultSort: { field: "lastObservedAt", dir: "desc", nullsLast: false },
    stableKey: ["tierPlanKey"],
  },
  payouts: {
    // RESTRICTED: money OUT. `read:money` comes from the mills fields; the
    // method identity comes back MASKED and the full processor payload stays
    // raw-journal-only under the restricted class — provider 2 (Paxum) returns
    // a plaintext email address and the only sanctioned reader of that field is
    // the WP-F7 canonicalizer that produced the mask.
    moneyBearing: true,
    verbatimText: false,
    // No fan appears on a payout row: this is the agency paying itself, not a
    // purchase, so the pairing rule does not reach it.
    disclosesPurchase: false,
    fields: {
      platform: "string",
      payoutRef: "string",
      /** MILLS with no scaling: the wire unit IS the kernel unit here. */
      amountMills: "mills",
      /** RAW. 8 is the ONLY code ever observed and is never treated as "the
       *  success code" — `statusConfidence` is how a reader learns that. */
      statusCode: "int",
      statusLabel: "string",
      statusConfidence: "string",
      methodRef: "string",
      methodProviderId: "int",
      methodProviderLabel: "string",
      /** OURS, never the provider's. */
      methodMaskedLabel: "string",
      requestedAt: "timestamp",
      updatedAtPlatform: "timestamp",
    },
    defaultSort: { field: "requestedAt", dir: "desc", nullsLast: true },
    stableKey: ["payoutKey"],
  },
  capture_coverage: {
    ownContent: true,
    // The honesty plane as a dataset: the `(status, acquisition_mode, proof)`
    // vocabulary an agent needs to tell "we hold nothing" from "we never
    // looked". It reads CAPTURE-PLANE OPERATIONAL STATE, which no
    // `projection:rebuild` truncates — so the answer survives a repair that
    // wipes and replays every projection beside it.
    moneyBearing: false,
    verbatimText: false,
    disclosesPurchase: false,
    fields: {
      platform: "string",
      plane: "string",
      scopeRef: "string",
      status: "string",
      acquisitionMode: "string",
      proof: "string",
      oldestCapturedAt: "timestamp",
      newestCapturedAt: "timestamp",
      expectedCount: "int",
      observedUniqueCount: "int",
      reasonCode: "string",
      nextProbeAt: "timestamp",
      updatedAt: "timestamp",
    },
    defaultSort: { field: "updatedAt", dir: "desc", nullsLast: false },
    stableKey: ["coverageKey"],
  },
  sync_streams: {
    ownContent: true,
    moneyBearing: false,
    verbatimText: false,
    disclosesPurchase: false,
    fields: {
      stream: "string",
      syncStatus: "string",
      cursorAt: "timestamp",
      succeededAt: "timestamp",
      failedAt: "timestamp",
      consecutiveFailures: "int",
    },
    defaultSort: { field: "stream", dir: "asc", nullsLast: false },
    stableKey: ["pageId", "stream"],
  },
  // ── Fansly creator statistics of 2026-10 (0292), account plane ─────────────
  // `/account/stats/series` and `/account/stats/summary`, typed as served by
  // `creator-stats.account` (hourly) and `creator-stats.history` (to the
  // account's creation). Fansly sends a row only for a bucket with activity:
  // no row inside a window the coverage (`capture_coverage`, plane
  // `creator_stats_account`) shows read is a zero. `source` is the surface
  // code as served (0 For You, 1 Timeline, 2 Suggestions, 3 Search, 4 Other);
  // `sourceLabel` names it.
  creator_stats_views: {
    moneyBearing: false, verbatimText: false, disclosesPurchase: false,
    fields: {
      platform: "string", granularity: "string", bucketStart: "timestamp", source: "int", sourceLabel: "string",
      views: "int", impressions: "int", uniqueViewers: "int", videoViews: "int", completedViews: "int", watchMs: "int",
      /** The sum of each view's watched share in hundredths of a percent:
       *  divided by `videoViews` and by 100 it is the average percent. */
      watchPctSum: "string",
      replays: "int", imageViews: "int", imageImpressions: "int", uniqueImageViewers: "int", imageWatchMs: "int",
      capturedAt: "timestamp",
    },
    defaultSort: { field: "bucketStart", dir: "desc", nullsLast: false },
    stableKey: ["creatorStatsViewsKey"],
  },
  creator_stats_profile: {
    moneyBearing: false, verbatimText: false, disclosesPurchase: false,
    fields: {
      platform: "string", granularity: "string", bucketStart: "timestamp", source: "int", sourceLabel: "string",
      profileVisits: "int", uniqueVisitors: "int", profileWatchMs: "int", capturedAt: "timestamp",
    },
    defaultSort: { field: "bucketStart", dir: "desc", nullsLast: false },
    stableKey: ["creatorStatsProfileKey"],
  },
  creator_stats_follows: {
    moneyBearing: false, verbatimText: false, disclosesPurchase: false,
    fields: { platform: "string", granularity: "string", bucketStart: "timestamp", follows: "int", unfollows: "int", capturedAt: "timestamp" },
    defaultSort: { field: "bucketStart", dir: "desc", nullsLast: false },
    stableKey: ["creatorStatsFollowsKey"],
  },
  creator_stats_subscriptions: {
    moneyBearing: false, verbatimText: false, disclosesPurchase: false,
    fields: {
      platform: "string", granularity: "string", bucketStart: "timestamp", tierId: "string", tierName: "string",
      subscriptionsNew: "int", subscriptionsRenewed: "int", subscriptionsExpired: "int", subscriptionsCancelled: "int",
      subscriptionsMovedIn: "int", subscriptionsMovedOut: "int", capturedAt: "timestamp",
    },
    defaultSort: { field: "bucketStart", dir: "desc", nullsLast: false },
    stableKey: ["creatorStatsSubscriptionsKey"],
  },
  /** Fansly's own revenue per hour, UTC day or month and product type (the
   *  2026-10 statistics). Not the ledger: `transactions` is what Hub recorded
   *  arriving. Refunds per bucket as Fansly counts them. */
  creator_stats_revenue: {
    moneyBearing: true, verbatimText: false, disclosesPurchase: false,
    fields: {
      platform: "string", granularity: "string", bucketStart: "timestamp", productType: "int", productLabel: "string",
      transactions: "int", grossMills: "mills", netMills: "mills", refunds: "int", refundedGrossMills: "mills",
      refundedNetMills: "mills", capturedAt: "timestamp",
    },
    defaultSort: { field: "bucketStart", dir: "desc", nullsLast: false },
    stableKey: ["creatorStatsRevenueKey"],
  },
  /** Follower and subscriber count at each UTC day; a tier's row carries its
   *  `tierId` and only `subscriberCount`, the account's row no tier. */
  creator_stats_levels: {
    moneyBearing: false, verbatimText: false, disclosesPurchase: false,
    fields: {
      platform: "string", day: "date", tierId: "string", tierName: "string", followerCount: "int", subscriberCount: "int",
      capturedAt: "timestamp",
    },
    defaultSort: { field: "day", dir: "desc", nullsLast: false },
    stableKey: ["creatorStatsLevelsKey"],
  },
  /** Comments and post likes a UTC day (`source` -1) and media likes per surface. */
  creator_stats_engagement: {
    moneyBearing: false, verbatimText: false, disclosesPurchase: false,
    fields: { platform: "string", day: "date", metric: "string", source: "int", value: "int", capturedAt: "timestamp" },
    defaultSort: { field: "day", dir: "desc", nullsLast: false },
    stableKey: ["creatorStatsEngagementKey"],
  },
  /** Every `{ value, previous }` of one summary window as served (uniques and
   *  paying fans are not additive over days). Money metrics (`*Mills`) are in
   *  `valueMills` / `previousMills`, everything else in `value` / `previous`
   *  as decimal text; a flag is 1 or 0. */
  creator_stats_windows: {
    moneyBearing: true, verbatimText: false, disclosesPurchase: false,
    fields: {
      platform: "string", afterDay: "date", beforeDay: "date", scope: "string", ref: "string", metric: "string",
      value: "string", previous: "string", valueMills: "mills", previousMills: "mills", capturedAt: "timestamp",
    },
    defaultSort: { field: "beforeDay", dir: "desc", nullsLast: false },
    stableKey: ["creatorStatsWindowKey"],
  },
  // ── Fansly creator statistics of 2026-10 (0294), audience plane ────────────
  // `/account/stats/geo`, `/tags`, `/media/benchmarks`, `/media/shown` and
  // `/activehours`, typed as served by `creator-stats.audience` (6-hourly),
  // `creator-stats.audience-daily`, `creator-stats.media-shown` (hourly) and
  // `creator-stats.audience-history`. A window route answers for its whole
  // window: `afterDay` … `beforeDay` (both included, `windowDays` long) is the
  // window Fansly served — one day for the steady geo, a calendar month for
  // the geo history, 30 days for steady tags, 400 for the tags history — and
  // windows of different lengths are not to be added up together. A window
  // that ends on the day it was read (`capturedAt`) is partial. The coverage
  // is `capture_coverage`, plane `creator_stats_audience`.
  /** Views and profile visits per viewer country, surface and window. A
   *  side the country is not among is null (zero, unless the answer was cut at
   *  its 200-row limit: coverage `reasonCode` `rows_at_limit`). `country` is
   *  the upper-case ISO code; '' is Fansly's "Unknown". */
  creator_stats_geo: {
    moneyBearing: false, verbatimText: false, disclosesPurchase: false,
    fields: {
      platform: "string", afterDay: "date", beforeDay: "date", windowDays: "int", source: "int", sourceLabel: "string",
      country: "string", views: "int", imageViews: "int", videoViews: "int", watchMs: "int",
      /** The per-view watched share summed, in hundredths of a percent. */
      watchPctSum: "string",
      /** As Fansly computed them: 0–100, and ms. */
      avgWatchPercent: "string", avgWatchMs: "string",
      profileVisits: "int", capturedAt: "timestamp",
    },
    defaultSort: { field: "beforeDay", dir: "desc", nullsLast: false },
    stableKey: ["creatorStatsGeoKey"],
  },
  /** A tag's totals over one window and surface. `kind` 1 = the tags viewers
   *  browsed by, 2 = the tags of posts. `liftPoints` (percentage points over
   *  the page's other viewers) is served only for windows up to 120 days
   *  (`liftAvailable`), and null inside one when there is no one to compare. */
  creator_stats_tags: {
    moneyBearing: false, verbatimText: false, disclosesPurchase: false,
    fields: {
      platform: "string", afterDay: "date", beforeDay: "date", windowDays: "int", source: "int", sourceLabel: "string",
      kind: "int", tagId: "string", tag: "string", views: "int", imageViews: "int", videoViews: "int", watchMs: "int",
      imageWatchMs: "int", completedViews: "int", watchPctSum: "string", liftPoints: "string", liftVideoViews: "int",
      liftAvailable: "bool", capturedAt: "timestamp",
    },
    defaultSort: { field: "beforeDay", dir: "desc", nullsLast: false },
    stableKey: ["creatorStatsTagsKey"],
  },
  /** A tag's views per UTC day and surface; no row inside a covered window is a zero. */
  creator_stats_tag_series: {
    moneyBearing: false, verbatimText: false, disclosesPurchase: false,
    fields: {
      platform: "string", day: "date", source: "int", sourceLabel: "string", kind: "int", tagId: "string", tag: "string",
      views: "int", imageViews: "int", capturedAt: "timestamp",
    },
    defaultSort: { field: "day", dir: "desc", nullsLast: false },
    stableKey: ["creatorStatsTagSeriesKey"],
  },
  /** The creator's own video averages per length bucket over the last 30
   *  settled days, per surface and day it was read (not a platform
   *  percentile). `maxMs` 0 is the open last bucket. */
  creator_stats_benchmarks: {
    moneyBearing: false, verbatimText: false, disclosesPurchase: false,
    fields: {
      platform: "string", afterDay: "date", beforeDay: "date", windowDays: "int", source: "int", sourceLabel: "string",
      lengthBucket: "int", minMs: "int", maxMs: "int", mediaCount: "int", views: "int", videoViews: "int", watchMs: "int",
      completedViews: "int", watchPctSum: "string", avgWatchPercent: "string",
      /** 0–1. */
      completionRate: "string",
      avgWatchMs: "string", capturedAt: "timestamp",
    },
    defaultSort: { field: "beforeDay", dir: "desc", nullsLast: false },
    stableKey: ["creatorStatsBenchmarksKey"],
  },
  /** The number of different videos a surface put in front of someone over
   *  `hours` hours whose last hour starts at `endHour` (one hour per row from
   *  the hourly poll), and over the equally long span before. Distinct counts:
   *  hours do not add up to a day. */
  creator_stats_media_shown: {
    moneyBearing: false, verbatimText: false, disclosesPurchase: false,
    fields: {
      platform: "string", endHour: "timestamp", hours: "int", source: "int", sourceLabel: "string",
      mediaShown: "int", previousMediaShown: "int", capturedAt: "timestamp",
    },
    defaultSort: { field: "endHour", dir: "desc", nullsLast: false },
    stableKey: ["creatorStatsMediaShownKey"],
  },
  /** Views per UTC weekday (0 = Sunday) and UTC hour over the last 90
   *  settled days, per surface and day it was read; shift to a time zone at
   *  read time. */
  creator_stats_active_hours: {
    moneyBearing: false, verbatimText: false, disclosesPurchase: false,
    fields: {
      platform: "string", afterDay: "date", beforeDay: "date", windowDays: "int", source: "int", sourceLabel: "string",
      weekday: "int", hour: "int", views: "int", imageViews: "int", capturedAt: "timestamp",
    },
    defaultSort: { field: "beforeDay", dir: "desc", nullsLast: false },
    stableKey: ["creatorStatsActiveHoursKey"],
  },
  // ── Fansly creator statistics of 2026-10 (0293), media plane ───────────────
  // `/account/stats/media` per media offer (`creator-stats.media`, a walk by
  // the post's age) and `/account/stats/media/top` (`creator-stats.media-top`,
  // every 3 h). A row exists only for a bucket with activity: no row inside a
  // window the walk read is a zero. `source` is the surface code as served
  // (0 For You, 1 Timeline, 2 Suggestions, 3 Search, 4 Other); `sourceLabel`
  // names it. `watchPctSum` is the sum of each view's watched share in
  // hundredths of a percent (÷ `videoViews` ÷ 100 = the average percent).
  /** Views and watch time of one media of an offer per surface and UTC day.
   *  `uniqueViewers` is per day: summing it over days double-counts. */
  creator_stats_media_daily: {
    ownContent: true,
    moneyBearing: false, verbatimText: false, disclosesPurchase: false,
    fields: {
      platform: "string", mediaOfferId: "string", mediaId: "string", mediaType: "int", source: "int", sourceLabel: "string",
      day: "date", views: "int", impressions: "int", uniqueViewers: "int", videoViews: "int", completedViews: "int",
      watchMs: "int", watchPctSum: "string", replays: "int", durationMs: "int", capturedAt: "timestamp",
    },
    defaultSort: { field: "day", dir: "desc", nullsLast: false },
    stableKey: ["creatorStatsMediaDailyKey"],
  },
  /** The same per hour (Fansly keeps about two days of a media's hours). */
  creator_stats_media_hourly: {
    moneyBearing: false, verbatimText: false, disclosesPurchase: false,
    fields: {
      platform: "string", mediaOfferId: "string", mediaId: "string", mediaType: "int", source: "int", sourceLabel: "string",
      hourStart: "timestamp", views: "int", impressions: "int", videoViews: "int", completedViews: "int", watchMs: "int",
      watchPctSum: "string", replays: "int", capturedAt: "timestamp",
    },
    defaultSort: { field: "hourStart", dir: "desc", nullsLast: false },
    stableKey: ["creatorStatsMediaHourlyKey"],
  },
  /** A media's all-time figures on one surface as Fansly served them on
   *  `capturedDay` (they move: one row per day read). `retention` is the
   *  retention curve, each point `"<percent of the video>:<share still
   *  watching, 0–1>"`; empty for an image. */
  creator_stats_media_totals: {
    moneyBearing: false, verbatimText: false, disclosesPurchase: false,
    fields: {
      platform: "string", mediaOfferId: "string", mediaId: "string", mediaType: "int", source: "int", sourceLabel: "string",
      capturedDay: "date", views: "int", impressions: "int", videoViews: "int", completedViews: "int", watchMs: "int",
      watchPctSum: "string", replays: "int", durationMs: "int", retention: "string_array", retentionSampleSize: "int",
      capturedAt: "timestamp",
    },
    defaultSort: { field: "capturedDay", dir: "desc", nullsLast: false },
    stableKey: ["creatorStatsMediaTotalsKey"],
  },
  /** The views a viewer tag (`tagKind` 1; 2 = a tag of the post) brought a
   *  media over one read window (`afterDay` … `beforeDay`, both included). */
  creator_stats_media_tags: {
    moneyBearing: false, verbatimText: false, disclosesPurchase: false,
    fields: {
      platform: "string", mediaOfferId: "string", mediaId: "string", mediaType: "int", source: "int", sourceLabel: "string",
      tagId: "string", tag: "string", tagKind: "int", afterDay: "date", beforeDay: "date", views: "int", videoViews: "int",
      completedViews: "int", watchMs: "int", watchPctSum: "string", capturedAt: "timestamp",
    },
    defaultSort: { field: "beforeDay", dir: "desc", nullsLast: false },
    stableKey: ["creatorStatsMediaTagKey"],
  },
  /** A tag's views of an offer a UTC day, per surface. */
  creator_stats_media_tag_series: {
    moneyBearing: false, verbatimText: false, disclosesPurchase: false,
    fields: {
      platform: "string", mediaOfferId: "string", source: "int", sourceLabel: "string", tagId: "string", tag: "string",
      tagKind: "int", day: "date", views: "int", capturedAt: "timestamp",
    },
    defaultSort: { field: "day", dir: "desc", nullsLast: false },
    stableKey: ["creatorStatsMediaTagSeriesKey"],
  },
  /** An offer's likes and unlikes per surface and UTC day. */
  creator_stats_media_likes: {
    ownContent: true,
    moneyBearing: false, verbatimText: false, disclosesPurchase: false,
    fields: {
      platform: "string", mediaOfferId: "string", source: "int", sourceLabel: "string", day: "date", likes: "int",
      unlikes: "int", capturedAt: "timestamp",
    },
    defaultSort: { field: "day", dir: "desc", nullsLast: false },
    stableKey: ["creatorStatsMediaLikesKey"],
  },
  /** Fansly's top offers by `orderBy` of one surface and window, as its
   *  newest answer ranked them (`mediaType` 0 = images and videos together;
   *  `itemMediaType` is the row's own). The figures are the window's. */
  creator_stats_media_top: {
    moneyBearing: false, verbatimText: false, disclosesPurchase: false,
    fields: {
      platform: "string", source: "int", sourceLabel: "string", mediaType: "int", orderBy: "string", afterDay: "date",
      beforeDay: "date", rank: "int", mediaOfferId: "string", mediaId: "string", bestMediaId: "string", offerLikes: "int",
      offerUnlikes: "int", itemMediaType: "int", views: "int", impressions: "int", uniqueViewers: "int", videoViews: "int",
      completedViews: "int", watchMs: "int", watchPctSum: "string", replays: "int", durationMs: "int",
      capturedAt: "timestamp",
    },
    defaultSort: { field: "beforeDay", dir: "desc", nullsLast: false },
    stableKey: ["creatorStatsMediaTopKey"],
  },
} as const satisfies Record<string, AgentDatasetDefinition>;

export type AgentDataset = keyof typeof AGENT_DATASETS;

/**
 * Datasets the catalog must NAME rather than hide. The plane's whole premise is
 * that an absent answer is distinguishable from an absent capability, so a hole in
 * the data is declared, not omitted.
 *
 * `fan_earnings` stays planned and untouched: `fan_earnings_stats` exists in the
 * database (migration 0061) but not in the Drizzle schema and is read only by raw
 * SQL. The endpoints-cover initiative deliberately did not adopt it.
 *
 * WHAT LEFT THIS LIST, AND WHERE IT WENT (WP-S1):
 *   `vault_media`, `notifications`, `subscription_tiers`, `comments`, `likes`,
 *   `payouts` — PROMOTED to available above, each over the projection its
 *   capture package landed. Reusing the reserved key rather than minting a new
 *   name is deliberate: a caller that read the catalog a year ago and wrote
 *   `--dataset comments` now gets data instead of a 400.
 *
 *   `purchase_history` — SUPERSEDED by `message_media_sales`. It was never a
 *   dataset: it is a SYNC STREAM name whose canonicalization produces
 *   `message.ppv_unlocked` and which has no serving table at all. The question
 *   it stood for — what was offered and what was bought in DMs — is answered by
 *   `message_media_offers`, which `message_media_sales` serves under the
 *   `read:messages` + `read:money` pairing rule. Keeping the stale key beside
 *   its real answer would have advertised a second, better `purchase_history`
 *   that is never coming.
 */
export const AGENT_PLANNED_DATASETS = {
  fan_earnings: {},
  stories: {},
  fan_lists: {},
  livestreams: {},
  polls: {},
  chargebacks: {},
  blocks: {},
} as const;

export type AgentPlannedDataset = keyof typeof AGENT_PLANNED_DATASETS;

/** Derived. Anything that needs "which datasets are addressable" reads THIS. */
export const AGENT_DATASET_NAMES = Object.keys(AGENT_DATASETS) as readonly AgentDataset[];

/** Derived. The catalog lists these with `availability: "planned"`. */
export const AGENT_PLANNED_DATASET_NAMES = Object.keys(
  AGENT_PLANNED_DATASETS,
) as readonly AgentPlannedDataset[];

/**
 * Boundary lookup for an UNVALIDATED dataset name (it arrives in a path).
 *
 * Backed by a Map, not by object indexing: a plain object would answer
 * `"constructor"` or `"toString"` with an inherited function, and a truthy answer
 * to a prototype key is exactly how an allowlist stops being one.
 */
const DEFINITION_BY_NAME: ReadonlyMap<string, AgentDatasetDefinition> = new Map(
  Object.entries(AGENT_DATASETS as Record<string, AgentDatasetDefinition>),
);

export function agentDatasetDefinition(dataset: string): AgentDatasetDefinition | undefined {
  return DEFINITION_BY_NAME.get(dataset);
}

type AgentDatasetFilterKindRule = {
  /** Value-bearing operators; the two null predicates are valid for every kind. */
  readonly operators: readonly AgentDatasetFilterOperator[];
  readonly acceptsValue: (operator: AgentDatasetFilterOperator, value: unknown) => boolean;
};

const EQUALITY_AND_ORDER_OPERATORS = [
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
] as const satisfies readonly AgentDatasetFilterOperator[];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const instant = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
}

function isRfc3339Timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !AGENT_RFC3339_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  // Date.parse catches impossible dates/times that the deliberately readable
  // wire regex cannot (for example 2026-02-30 or an hour of 29).
  return isCalendarDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}

/**
 * The semantic filter boundary, keyed by the registry's declared field kind.
 *
 * This is intentionally a small matrix, not a generic query language. Numeric
 * kinds require safe integers (money remains mills); booleans admit equality
 * only; timestamps/dates must be real wire values; and `in` stays limited to
 * textual values because the public scalar union has only `string[]` arrays.
 */
const FILTER_RULE_BY_KIND = {
  string: {
    operators: [...EQUALITY_AND_ORDER_OPERATORS, "in"],
    acceptsValue: (operator, value) => operator === "in"
      ? isStringArray(value)
      : typeof value === "string",
  },
  int: {
    operators: EQUALITY_AND_ORDER_OPERATORS,
    acceptsValue: (_operator, value) => typeof value === "number" && Number.isSafeInteger(value),
  },
  mills: {
    operators: EQUALITY_AND_ORDER_OPERATORS,
    acceptsValue: (_operator, value) => typeof value === "number" && Number.isSafeInteger(value),
  },
  bool: {
    operators: ["eq", "neq"],
    acceptsValue: (_operator, value) => typeof value === "boolean",
  },
  timestamp: {
    operators: EQUALITY_AND_ORDER_OPERATORS,
    acceptsValue: (_operator, value) => isRfc3339Timestamp(value),
  },
  date: {
    operators: [...EQUALITY_AND_ORDER_OPERATORS, "in"],
    acceptsValue: (operator, value) => operator === "in"
      ? isStringArray(value) && value.every(isCalendarDate)
      : isCalendarDate(value),
  },
  // There is no string-array field today and no array operator with honest SQL
  // semantics in v1. Null checks remain available without guessing one.
  string_array: {
    operators: [],
    acceptsValue: () => false,
  },
} as const satisfies Record<AgentDatasetFieldKind, AgentDatasetFilterKindRule>;

export type AgentDatasetFilterIssue =
  | { readonly code: "unknown_field" }
  | {
    readonly code: "operator_not_supported" | "value_type_mismatch";
    readonly kind: AgentDatasetFieldKind;
  };

/**
 * Validates a dataset filter after the path/body schemas but before SQL mapping.
 * The issue contains no caller value, so a 400 can be logged or returned without
 * echoing potentially sensitive filter material.
 */
export function agentDatasetFilterIssue(
  dataset: string,
  input: {
    readonly field: string;
    readonly op: AgentDatasetFilterOperator;
    readonly value?: unknown;
  },
): AgentDatasetFilterIssue | null {
  const definition = agentDatasetDefinition(dataset);
  const fields = definition?.fields as Record<string, AgentDatasetFieldKind> | undefined;
  const kind = fields !== undefined && Object.hasOwn(fields, input.field)
    ? fields[input.field]
    : undefined;
  if (kind === undefined) {
    return { code: "unknown_field" };
  }

  const carriesNoValue = input.op === "is_null" || input.op === "is_not_null";
  if (carriesNoValue) {
    return input.value === undefined ? null : { code: "value_type_mismatch", kind };
  }

  const rule: AgentDatasetFilterKindRule = FILTER_RULE_BY_KIND[kind];
  if (!rule.operators.includes(input.op)) {
    return { code: "operator_not_supported", kind };
  }
  return rule.acceptsValue(input.op, input.value)
    ? null
    : { code: "value_type_mismatch", kind };
}

/**
 * The capabilities a key must hold to query this dataset: `read:datasets` always,
 * plus `read:money` for a money-bearing one and `read:messages` for one that
 * serves free text. Derived from the declaration, so a dataset that gains a money
 * field or a text body cannot keep the narrower requirement.
 */
export function agentDatasetRequiredCapabilities(
  dataset: AgentDataset,
): readonly AgentCapability[] {
  const definition = AGENT_DATASETS[dataset];
  const capabilities: AgentCapability[] = ["read:datasets"];
  if (definition.moneyBearing) {
    capabilities.push("read:money");
  }
  if (definition.verbatimText || definition.disclosesPurchase) {
    // The pairing rule and the free-text rule land on the SAME capability, and
    // deliberately so: both disclose the content of a conversation, one as
    // prose and one as the fact that a purchase happened inside it.
    capabilities.push("read:messages");
  }
  return capabilities;
}

/** The datasets a `read:content` key reads (see `ownContent`). */
export const AGENT_OWN_CONTENT_DATASETS = AGENT_DATASET_NAMES.filter(
  (dataset) => (AGENT_DATASETS[dataset] as AgentDatasetDefinition).ownContent === true,
);

/**
 * What THIS key needs to query the dataset: `read:content` alone for an
 * `ownContent` dataset when the key holds it, otherwise the declared
 * requirement. A key without `read:content` is answered exactly as before.
 */
export function agentDatasetCapabilitiesFor(
  dataset: AgentDataset,
  granted: ReadonlySet<string>,
): readonly AgentCapability[] {
  const definition: AgentDatasetDefinition = AGENT_DATASETS[dataset];
  return definition.ownContent === true && granted.has("read:content")
    ? ["read:content"]
    : agentDatasetRequiredCapabilities(dataset);
}

/**
 * Free-form content includes `*Text` fields and user-written file/album names.
 *
 * A convention rather than a per-field flag because the scalar KIND cannot tell
 * `noteText` from `username` — both are `string` — and the thing that must not
 * drift is "does this dataset hand over prose", which the field name already says.
 */
export function agentDatasetFieldIsVerbatimText(field: string): boolean {
  return /Text$/.test(field) || ["filename", "customFilename", "albumTitle"].includes(field);
}

/** Every declared field of a dataset is filterable — the map IS the allowlist. */
export function agentDatasetFieldFilterable(): boolean {
  return true;
}

/**
 * Sortable = the kind admits a deterministic order (numbers, money, instants,
 * dates), OR the field is this dataset's default sort. Free text and booleans are
 * deliberately excluded: sorting a page of transcripts by note text buys nothing
 * and costs an unindexable ORDER BY.
 */
export function agentDatasetFieldSortable(dataset: AgentDataset, field: string): boolean {
  const definition: AgentDatasetDefinition = AGENT_DATASETS[dataset];
  const fields = definition.fields as Record<string, AgentDatasetFieldKind>;
  // `Object.hasOwn` for the same reason the lookup above uses a Map: a prototype
  // key must not resolve to a real field.
  if (!Object.hasOwn(fields, field)) {
    return false;
  }
  const kind = fields[field];
  if (kind === undefined) {
    return false;
  }
  return ORDERED_FIELD_KINDS.has(kind) || definition.defaultSort.field === field;
}

export type AgentDatasetFieldView = {
  readonly field: string;
  readonly kind: AgentDatasetFieldKind;
  readonly filterable: boolean;
  readonly sortable: boolean;
};

/** The catalog view of a dataset's fields, in declaration order. */
export function agentDatasetFields(dataset: AgentDataset): readonly AgentDatasetFieldView[] {
  const definition = AGENT_DATASETS[dataset];
  return Object.entries(definition.fields as Record<string, AgentDatasetFieldKind>).map(
    ([field, kind]) => ({
      field,
      kind,
      filterable: agentDatasetFieldFilterable(),
      sortable: agentDatasetFieldSortable(dataset, field),
    }),
  );
}
