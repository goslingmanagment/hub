// WP-F3 catalog writers (migration 0136).
//
// The house shape, with one addition and one measurement.
//
// THE SHAPE (unchanged from `fansly-stats.ts`): guarded upsert returning
// `applied`; the newer OBSERVATION wins with `source_account_seq` as the
// same-instant tie-break, because ledger order is APPEND order and a replayed
// older capture must never overwrite a fresher head; `first_observed_at` only
// ever moves backwards; NULL is never coalesced to 0; raw platform integers are
// stored rather than labels.
//
// THE ADDITION — `reconcileCatalog*Presence`. DP 7 forbids deleting a row that
// captured a fact, so an entity a later FULL listing stops naming is MARKED,
// not removed. Every reconciler below is driven by the `catalog.listing_observed`
// roster event, so the mark is derived from the ledger and survives
// truncate-and-replay; none of them is a scheduled sweep and none issues a
// DELETE.
//
// EACH DOES BOTH HALVES, and the CLEAR is the half that is easy to forget. A
// row whose content CHANGED clears its own mark through the ordinary upsert —
// but a row that disappears and comes back UNCHANGED emits no event at all,
// because its content hash is the one it had before. Only the roster can
// un-mark it. Without that, "gone" would be a tombstone rather than a state.
//
// THE MEASUREMENT — `countPageUniqueCreatorMedia` is the offer census;
// `countCreatorVaultUniqueMembers` is the raw-file union observed in the vault;
// `sumCreatorVaultAlbumItemCounts` is the explicitly non-unique served sum.
// They are related diagnostics, not interchangeable denominators: one raw file
// can back several offers.

import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";

export type FanslyCatalogPlatform = "fansly" | "onlyfans";

export type CatalogVaultKind = "creator" | "user";

export interface CatalogLineage {
  observedAt: Date;
  contentHash: string;
  sourceEventId: number;
  sourceObservationId: number;
  sourceAccountSeq: number;
}

/** Excluded wins on a newer observation instant, or on the same instant with a
 *  higher account_seq. */
function newerWins(table: string) {
  const current = sql.identifier(table);
  return sql`
    excluded.last_observed_at > ${current}.last_observed_at
    or (
      excluded.last_observed_at = ${current}.last_observed_at
      and excluded.source_account_seq > ${current}.source_account_seq
    )
  `;
}

function pick(table: string, column: string): SQL {
  const current = sql.identifier(table);
  const name = sql.identifier(column);
  return sql`case when ${newerWins(table)} then excluded.${name} else ${current}.${name} end`;
}

function millsParam(value: bigint | null): SQL {
  return value === null ? sql`null` : sql`${value.toString()}::bigint`;
}

/**
 * ONE bound parameter carrying a Postgres array literal, then cast.
 *
 * Not `sql`${array}`` — drizzle expands an array chunk into a comma-separated
 * parameter LIST, so an EMPTY array expands to nothing and the statement
 * becomes a syntax error at runtime on exactly the common case. An empty roster
 * is not an edge case here: it is what a page with no gift codes left serves.
 */
function textArrayParam(values: readonly string[]): SQL {
  const literal = `{${values.map((value) => `"${value.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;
  return sql`${literal}::text[]`;
}

// ── creator_vault_albums ─────────────────────────────────────────────────────

export interface UpsertCreatorVaultAlbumInput extends CatalogLineage {
  pageId: number;
  platform: FanslyCatalogPlatform;
  vaultKind: CatalogVaultKind;
  albumRef: string;
  ownerAccountRef: string | null;
  title: string | null;
  description: string | null;
  albumType: number | null;
  status: number | null;
  pos: number | null;
  /** AS SERVED. Non-unique membership — never summed into M. */
  itemCount: number | null;
  lastItemRef: string | null;
  thumbnailRef: string | null;
  public: number | null;
  version: number | null;
  createdAtPlatform: Date | null;
}

export async function upsertCreatorVaultAlbum(
  db: Database,
  input: UpsertCreatorVaultAlbumInput,
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into creator_vault_albums (
      page_id, platform, vault_kind, album_ref, owner_account_ref, title, description,
      album_type, status, pos, item_count, last_item_ref, thumbnail_ref, public, version,
      created_at_platform, missing_since, first_observed_at, last_observed_at, content_hash,
      source_event_id, source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.vaultKind}, ${input.albumRef},
      ${input.ownerAccountRef}, ${input.title}, ${input.description}, ${input.albumType},
      ${input.status}, ${input.pos}, ${input.itemCount}, ${input.lastItemRef},
      ${input.thumbnailRef}, ${input.public}, ${input.version}, ${input.createdAtPlatform},
      null, ${input.observedAt}, ${input.observedAt}, ${input.contentHash},
      ${input.sourceEventId}, ${input.sourceObservationId}, ${input.sourceAccountSeq}
    )
    on conflict (page_id, vault_kind, album_ref) do update set
      owner_account_ref = ${pick("creator_vault_albums", "owner_account_ref")},
      title = ${pick("creator_vault_albums", "title")},
      description = ${pick("creator_vault_albums", "description")},
      album_type = ${pick("creator_vault_albums", "album_type")},
      status = ${pick("creator_vault_albums", "status")},
      pos = ${pick("creator_vault_albums", "pos")},
      item_count = ${pick("creator_vault_albums", "item_count")},
      last_item_ref = ${pick("creator_vault_albums", "last_item_ref")},
      thumbnail_ref = ${pick("creator_vault_albums", "thumbnail_ref")},
      public = ${pick("creator_vault_albums", "public")},
      version = ${pick("creator_vault_albums", "version")},
      created_at_platform = ${pick("creator_vault_albums", "created_at_platform")},
      -- An album that comes BACK is not missing any more. "Gone" is a state,
      -- never a tombstone.
      missing_since = case
        when ${newerWins("creator_vault_albums")} then null
        else creator_vault_albums.missing_since
      end,
      content_hash = ${pick("creator_vault_albums", "content_hash")},
      source_event_id = ${pick("creator_vault_albums", "source_event_id")},
      source_observation_id = ${pick("creator_vault_albums", "source_observation_id")},
      source_account_seq = ${pick("creator_vault_albums", "source_account_seq")},
      first_observed_at =
        least(creator_vault_albums.first_observed_at, excluded.first_observed_at),
      last_observed_at =
        greatest(creator_vault_albums.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

/**
 * Reconcile one vault's presence against a roster: mark what it did NOT name,
 * clear the mark on what it did.
 *
 * BOTH HALVES, and the CLEAR is the one that is easy to leave out. An album's
 * own upsert clears `missing_since` when the album's content changed — but a
 * row that disappears and comes back UNCHANGED emits no row event at all (its
 * content hash is the one it had before), so only the roster can un-mark it.
 * Without the clear, "gone" would be a tombstone rather than a state.
 *
 * `missing_since is null` on the mark is what makes it STICKY: the instant an
 * album FIRST went missing is the interesting one, and a second roster that
 * also omits it must not move the timestamp forward.
 */
export async function reconcileCatalogAlbumPresence(
  db: Database,
  input: {
    pageId: number;
    vaultKind: CatalogVaultKind;
    presentRefs: readonly string[];
    missingSince: Date;
  },
): Promise<{ marked: number; cleared: number }> {
  const present = textArrayParam(input.presentRefs);
  const marked = await db.execute(sql`
    update creator_vault_albums
       set missing_since = ${input.missingSince}, updated_at = now()
     where page_id = ${input.pageId}
       and vault_kind = ${input.vaultKind}
       and missing_since is null
       and not (album_ref = any(${present}))
  `);
  const cleared = await db.execute(sql`
    update creator_vault_albums
       set missing_since = null, updated_at = now()
     where page_id = ${input.pageId}
       and vault_kind = ${input.vaultKind}
       and missing_since is not null
       and album_ref = any(${present})
  `);
  return { marked: marked.rowCount ?? 0, cleared: cleared.rowCount ?? 0 };
}

// ── creator_vault_album_members ──────────────────────────────────────────────

export interface UpsertCreatorVaultAlbumMemberInput extends CatalogLineage {
  pageId: number;
  platform: FanslyCatalogPlatform;
  albumRef: string;
  mediaOfferRef: string | null;
  /** The membership row's own id — the walk cursor, NOT the media offer id. */
  memberRef: string | null;
  mediaOfferType: number | null;
  bundleRef: string | null;
  mediaRef: string;
  mediaType: number | null;
  previewRef: string | null;
  vaultKind: CatalogVaultKind;
  createdAtPlatform: Date | null;
}

export async function upsertCreatorVaultAlbumMember(
  db: Database,
  input: UpsertCreatorVaultAlbumMemberInput,
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into creator_vault_album_members (
      page_id, platform, album_ref, media_offer_ref, member_ref, media_offer_type,
      bundle_ref, media_ref, media_type, preview_ref, vault_kind, created_at_platform,
      missing_since, first_observed_at, last_observed_at, content_hash, source_event_id,
      source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.albumRef}, ${input.mediaOfferRef},
      ${input.memberRef}, ${input.mediaOfferType}, ${input.bundleRef}, ${input.mediaRef},
      ${input.mediaType}, ${input.previewRef}, ${input.vaultKind}, ${input.createdAtPlatform},
      null, ${input.observedAt}, ${input.observedAt}, ${input.contentHash},
      ${input.sourceEventId}, ${input.sourceObservationId}, ${input.sourceAccountSeq}
    )
    on conflict (page_id, vault_kind, album_ref, media_ref) do update set
      media_offer_ref = ${pick("creator_vault_album_members", "media_offer_ref")},
      member_ref = ${pick("creator_vault_album_members", "member_ref")},
      media_offer_type = ${pick("creator_vault_album_members", "media_offer_type")},
      bundle_ref = ${pick("creator_vault_album_members", "bundle_ref")},
      media_type = ${pick("creator_vault_album_members", "media_type")},
      preview_ref = ${pick("creator_vault_album_members", "preview_ref")},
      created_at_platform = ${pick("creator_vault_album_members", "created_at_platform")},
      content_hash = ${pick("creator_vault_album_members", "content_hash")},
      source_event_id = ${pick("creator_vault_album_members", "source_event_id")},
      source_observation_id = ${pick("creator_vault_album_members", "source_observation_id")},
      source_account_seq = ${pick("creator_vault_album_members", "source_account_seq")},
      first_observed_at =
        least(creator_vault_album_members.first_observed_at, excluded.first_observed_at),
      last_observed_at =
        greatest(creator_vault_album_members.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

// ── page_subscription_tiers / _plans ─────────────────────────────────────────

export interface UpsertPageSubscriptionTierInput extends CatalogLineage {
  pageId: number;
  platform: FanslyCatalogPlatform;
  tierRef: string;
  name: string | null;
  color: string | null;
  pos: number | null;
  /** `tier.price` — a BASE, never the price. */
  basePriceMills: bigint | null;
  maxSubscribers: number | null;
  subscriptionBenefits: unknown[];
  includedTierRefs: unknown[];
  /** The served `plans[]` array, verbatim. */
  plans: unknown[];
}

export async function upsertPageSubscriptionTier(
  db: Database,
  input: UpsertPageSubscriptionTierInput,
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into page_subscription_tiers (
      page_id, platform, tier_ref, name, color, pos, base_price_mills, max_subscribers,
      subscription_benefits, included_tier_refs, plans, missing_since, first_observed_at,
      last_observed_at, content_hash, source_event_id, source_observation_id,
      source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.tierRef}, ${input.name}, ${input.color},
      ${input.pos}, ${millsParam(input.basePriceMills)}, ${input.maxSubscribers},
      ${JSON.stringify(input.subscriptionBenefits)}::jsonb,
      ${JSON.stringify(input.includedTierRefs)}::jsonb,
      ${JSON.stringify(input.plans)}::jsonb,
      null, ${input.observedAt}, ${input.observedAt}, ${input.contentHash},
      ${input.sourceEventId}, ${input.sourceObservationId}, ${input.sourceAccountSeq}
    )
    on conflict (page_id, tier_ref) do update set
      name = ${pick("page_subscription_tiers", "name")},
      color = ${pick("page_subscription_tiers", "color")},
      pos = ${pick("page_subscription_tiers", "pos")},
      base_price_mills = ${pick("page_subscription_tiers", "base_price_mills")},
      max_subscribers = ${pick("page_subscription_tiers", "max_subscribers")},
      subscription_benefits = ${pick("page_subscription_tiers", "subscription_benefits")},
      included_tier_refs = ${pick("page_subscription_tiers", "included_tier_refs")},
      plans = ${pick("page_subscription_tiers", "plans")},
      missing_since = case
        when ${newerWins("page_subscription_tiers")} then null
        else page_subscription_tiers.missing_since
      end,
      content_hash = ${pick("page_subscription_tiers", "content_hash")},
      source_event_id = ${pick("page_subscription_tiers", "source_event_id")},
      source_observation_id = ${pick("page_subscription_tiers", "source_observation_id")},
      source_account_seq = ${pick("page_subscription_tiers", "source_account_seq")},
      first_observed_at =
        least(page_subscription_tiers.first_observed_at, excluded.first_observed_at),
      last_observed_at =
        greatest(page_subscription_tiers.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

export async function reconcileCatalogTiersPresence(
  db: Database,
  input: { pageId: number; presentRefs: readonly string[]; missingSince: Date },
): Promise<{ marked: number; cleared: number }> {
  const present = textArrayParam(input.presentRefs);
  const marked = await db.execute(sql`
    update page_subscription_tiers
       set missing_since = ${input.missingSince}, updated_at = now()
     where page_id = ${input.pageId}
       and missing_since is null
       and not (tier_ref = any(${present}))
  `);
  const cleared = await db.execute(sql`
    update page_subscription_tiers
       set missing_since = null, updated_at = now()
     where page_id = ${input.pageId}
       and missing_since is not null
       and tier_ref = any(${present})
  `);
  return { marked: marked.rowCount ?? 0, cleared: cleared.rowCount ?? 0 };
}

export interface UpsertPageSubscriptionTierPlanInput extends CatalogLineage {
  pageId: number;
  platform: FanslyCatalogPlatform;
  tierRef: string;
  planRef: string;
  status: number | null;
  /** From `plans[].billingCycle` (the live key), `plans[].duration` as fallback. */
  durationDays: number | null;
  /** THE PRICE TRUTH. Max observed live: 499 990. */
  priceMills: bigint | null;
  useAmounts: number | null;
  promos: unknown[];
}

export async function upsertPageSubscriptionTierPlan(
  db: Database,
  input: UpsertPageSubscriptionTierPlanInput,
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into page_subscription_tier_plans (
      page_id, platform, tier_ref, plan_ref, status, duration_days, price_mills,
      use_amounts, promos, missing_since, first_observed_at, last_observed_at,
      content_hash, source_event_id, source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.tierRef}, ${input.planRef}, ${input.status},
      ${input.durationDays}, ${millsParam(input.priceMills)}, ${input.useAmounts},
      ${JSON.stringify(input.promos)}::jsonb, null, ${input.observedAt}, ${input.observedAt},
      ${input.contentHash}, ${input.sourceEventId}, ${input.sourceObservationId},
      ${input.sourceAccountSeq}
    )
    on conflict (page_id, tier_ref, plan_ref) do update set
      status = ${pick("page_subscription_tier_plans", "status")},
      duration_days = ${pick("page_subscription_tier_plans", "duration_days")},
      price_mills = ${pick("page_subscription_tier_plans", "price_mills")},
      use_amounts = ${pick("page_subscription_tier_plans", "use_amounts")},
      promos = ${pick("page_subscription_tier_plans", "promos")},
      missing_since = case
        when ${newerWins("page_subscription_tier_plans")} then null
        else page_subscription_tier_plans.missing_since
      end,
      content_hash = ${pick("page_subscription_tier_plans", "content_hash")},
      source_event_id = ${pick("page_subscription_tier_plans", "source_event_id")},
      source_observation_id = ${pick("page_subscription_tier_plans", "source_observation_id")},
      source_account_seq = ${pick("page_subscription_tier_plans", "source_account_seq")},
      first_observed_at =
        least(page_subscription_tier_plans.first_observed_at, excluded.first_observed_at),
      last_observed_at =
        greatest(page_subscription_tier_plans.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

/** Plan refs are snowflakes and globally unique, so the roster names them
 *  without their tier — a plan that MOVES between tiers is still one plan. */
export async function reconcileCatalogTierPlansPresence(
  db: Database,
  input: { pageId: number; presentRefs: readonly string[]; missingSince: Date },
): Promise<{ marked: number; cleared: number }> {
  const present = textArrayParam(input.presentRefs);
  const marked = await db.execute(sql`
    update page_subscription_tier_plans
       set missing_since = ${input.missingSince}, updated_at = now()
     where page_id = ${input.pageId}
       and missing_since is null
       and not (plan_ref = any(${present}))
  `);
  const cleared = await db.execute(sql`
    update page_subscription_tier_plans
       set missing_since = null, updated_at = now()
     where page_id = ${input.pageId}
       and missing_since is not null
       and plan_ref = any(${present})
  `);
  return { marked: marked.rowCount ?? 0, cleared: cleared.rowCount ?? 0 };
}

// ── page_walls ───────────────────────────────────────────────────────────────

export interface UpsertPageWallInput extends CatalogLineage {
  pageId: number;
  platform: FanslyCatalogPlatform;
  wallRef: string;
  name: string | null;
  description: string | null;
  pos: number | null;
  mainWall: boolean | null;
  defaultWall: boolean | null;
  private: number | null;
  metadata: Record<string, unknown>;
}

export async function upsertPageWall(
  db: Database,
  input: UpsertPageWallInput,
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into page_walls (
      page_id, platform, wall_ref, name, description, pos, main_wall, default_wall,
      private, metadata, missing_since, first_observed_at, last_observed_at, content_hash,
      source_event_id, source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.wallRef}, ${input.name},
      ${input.description}, ${input.pos}, ${input.mainWall}, ${input.defaultWall},
      ${input.private}, ${JSON.stringify(input.metadata)}::jsonb, null,
      ${input.observedAt}, ${input.observedAt}, ${input.contentHash},
      ${input.sourceEventId}, ${input.sourceObservationId}, ${input.sourceAccountSeq}
    )
    on conflict (page_id, wall_ref) do update set
      name = ${pick("page_walls", "name")},
      description = ${pick("page_walls", "description")},
      pos = ${pick("page_walls", "pos")},
      main_wall = ${pick("page_walls", "main_wall")},
      default_wall = ${pick("page_walls", "default_wall")},
      private = ${pick("page_walls", "private")},
      metadata = ${pick("page_walls", "metadata")},
      missing_since = case
        when ${newerWins("page_walls")} then null else page_walls.missing_since
      end,
      content_hash = ${pick("page_walls", "content_hash")},
      source_event_id = ${pick("page_walls", "source_event_id")},
      source_observation_id = ${pick("page_walls", "source_observation_id")},
      source_account_seq = ${pick("page_walls", "source_account_seq")},
      first_observed_at = least(page_walls.first_observed_at, excluded.first_observed_at),
      last_observed_at = greatest(page_walls.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

export async function reconcileCatalogWallsPresence(
  db: Database,
  input: { pageId: number; presentRefs: readonly string[]; missingSince: Date },
): Promise<{ marked: number; cleared: number }> {
  const present = textArrayParam(input.presentRefs);
  const marked = await db.execute(sql`
    update page_walls
       set missing_since = ${input.missingSince}, updated_at = now()
     where page_id = ${input.pageId}
       and missing_since is null
       and not (wall_ref = any(${present}))
  `);
  const cleared = await db.execute(sql`
    update page_walls
       set missing_since = null, updated_at = now()
     where page_id = ${input.pageId}
       and missing_since is not null
       and wall_ref = any(${present})
  `);
  return { marked: marked.rowCount ?? 0, cleared: cleared.rowCount ?? 0 };
}

// ── page_automated_messages ──────────────────────────────────────────────────

export interface UpsertPageAutomatedMessageInput extends CatalogLineage {
  pageId: number;
  platform: FanslyCatalogPlatform;
  automationRef: string;
  triggerType: number | null;
  triggerMetadata: Record<string, unknown>;
  delaySeconds: number | null;
  cooldownSeconds: number | null;
  templateType: number | null;
  senderRef: string | null;
  messageText: string | null;
  attachmentRefs: unknown[];
  /** FALSE when the template did not parse as an object. The row still lands. */
  parseOk: boolean;
}

export async function upsertPageAutomatedMessage(
  db: Database,
  input: UpsertPageAutomatedMessageInput,
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into page_automated_messages (
      page_id, platform, automation_ref, trigger_type, trigger_metadata, delay_seconds,
      cooldown_seconds, template_type, sender_ref, message_text, attachment_refs, parse_ok,
      missing_since, first_observed_at, last_observed_at, content_hash, source_event_id,
      source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.automationRef}, ${input.triggerType},
      ${JSON.stringify(input.triggerMetadata)}::jsonb, ${input.delaySeconds},
      ${input.cooldownSeconds}, ${input.templateType}, ${input.senderRef},
      ${input.messageText}, ${JSON.stringify(input.attachmentRefs)}::jsonb, ${input.parseOk},
      null, ${input.observedAt}, ${input.observedAt}, ${input.contentHash},
      ${input.sourceEventId}, ${input.sourceObservationId}, ${input.sourceAccountSeq}
    )
    on conflict (page_id, automation_ref) do update set
      trigger_type = ${pick("page_automated_messages", "trigger_type")},
      trigger_metadata = ${pick("page_automated_messages", "trigger_metadata")},
      delay_seconds = ${pick("page_automated_messages", "delay_seconds")},
      cooldown_seconds = ${pick("page_automated_messages", "cooldown_seconds")},
      template_type = ${pick("page_automated_messages", "template_type")},
      sender_ref = ${pick("page_automated_messages", "sender_ref")},
      message_text = ${pick("page_automated_messages", "message_text")},
      attachment_refs = ${pick("page_automated_messages", "attachment_refs")},
      parse_ok = ${pick("page_automated_messages", "parse_ok")},
      missing_since = case
        when ${newerWins("page_automated_messages")} then null
        else page_automated_messages.missing_since
      end,
      content_hash = ${pick("page_automated_messages", "content_hash")},
      source_event_id = ${pick("page_automated_messages", "source_event_id")},
      source_observation_id = ${pick("page_automated_messages", "source_observation_id")},
      source_account_seq = ${pick("page_automated_messages", "source_account_seq")},
      first_observed_at =
        least(page_automated_messages.first_observed_at, excluded.first_observed_at),
      last_observed_at =
        greatest(page_automated_messages.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

export async function reconcileCatalogAutomationsPresence(
  db: Database,
  input: { pageId: number; presentRefs: readonly string[]; missingSince: Date },
): Promise<{ marked: number; cleared: number }> {
  const present = textArrayParam(input.presentRefs);
  const marked = await db.execute(sql`
    update page_automated_messages
       set missing_since = ${input.missingSince}, updated_at = now()
     where page_id = ${input.pageId}
       and missing_since is null
       and not (automation_ref = any(${present}))
  `);
  const cleared = await db.execute(sql`
    update page_automated_messages
       set missing_since = null, updated_at = now()
     where page_id = ${input.pageId}
       and missing_since is not null
       and automation_ref = any(${present})
  `);
  return { marked: marked.rowCount ?? 0, cleared: cleared.rowCount ?? 0 };
}

// ── gift codes → page_promo_links (WP-F1's table, the second link kind) ──────

export interface UpsertPageGiftCodeInput extends CatalogLineage {
  pageId: number;
  platform: FanslyCatalogPlatform;
  codeRef: string;
  /** The capture's UTC date — the same daily-snapshot shape the tracking half
   *  uses, so one table has one key. */
  businessDate: string;
  code: string | null;
  label: string | null;
  linkType: number | null;
  status: number | null;
  planRef: string | null;
  priceMills: bigint | null;
  /** `original_price` — a LIST PRICE. Never summed with the revenue columns. */
  originalPriceMills: bigint | null;
  uses: number | null;
  maxUses: number | null;
  createdAtPlatform: Date | null;
  startsAtPlatform: Date | null;
  endsAtPlatform: Date | null;
  metadata: Record<string, unknown>;
  capturedAt: Date;
}

export async function upsertPageGiftCode(
  db: Database,
  input: UpsertPageGiftCodeInput,
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into page_promo_links (
      page_id, platform, link_kind, link_ref, business_date, internal_ref, link_type,
      status, label, description, metadata, created_at_platform, uses, max_uses,
      price_mills, original_price_mills, starts_at_platform, ends_at_platform,
      missing_since, captured_at, content_hash, first_observed_at, last_observed_at,
      source_event_id, source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, 'gift_code', ${input.codeRef},
      ${input.businessDate}::date, ${input.planRef}, ${input.linkType}, ${input.status},
      ${input.label}, ${input.code}, ${JSON.stringify(input.metadata)}::jsonb,
      ${input.createdAtPlatform}, ${input.uses}, ${input.maxUses},
      ${millsParam(input.priceMills)}, ${millsParam(input.originalPriceMills)},
      ${input.startsAtPlatform}, ${input.endsAtPlatform}, null, ${input.capturedAt},
      ${input.contentHash}, ${input.observedAt}, ${input.observedAt}, ${input.sourceEventId},
      ${input.sourceObservationId}, ${input.sourceAccountSeq}
    )
    on conflict (page_id, platform, link_kind, link_ref, business_date) do update set
      internal_ref = ${pick("page_promo_links", "internal_ref")},
      link_type = ${pick("page_promo_links", "link_type")},
      status = ${pick("page_promo_links", "status")},
      label = ${pick("page_promo_links", "label")},
      description = ${pick("page_promo_links", "description")},
      metadata = ${pick("page_promo_links", "metadata")},
      created_at_platform = ${pick("page_promo_links", "created_at_platform")},
      uses = ${pick("page_promo_links", "uses")},
      max_uses = ${pick("page_promo_links", "max_uses")},
      price_mills = ${pick("page_promo_links", "price_mills")},
      original_price_mills = ${pick("page_promo_links", "original_price_mills")},
      starts_at_platform = ${pick("page_promo_links", "starts_at_platform")},
      ends_at_platform = ${pick("page_promo_links", "ends_at_platform")},
      missing_since = case
        when ${newerWins("page_promo_links")} then null else page_promo_links.missing_since
      end,
      captured_at = ${pick("page_promo_links", "captured_at")},
      content_hash = ${pick("page_promo_links", "content_hash")},
      source_event_id = ${pick("page_promo_links", "source_event_id")},
      source_observation_id = ${pick("page_promo_links", "source_observation_id")},
      source_account_seq = ${pick("page_promo_links", "source_account_seq")},
      first_observed_at =
        least(page_promo_links.first_observed_at, excluded.first_observed_at),
      last_observed_at =
        greatest(page_promo_links.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

/**
 * Gift codes carry `business_date` in their key (the tracking half's daily
 * snapshot shape), so "the code" is its LATEST row. The mark therefore lands on
 * `max(business_date)` per code — marking every historical row would rewrite
 * days on which the code demonstrably existed.
 */
export async function reconcileCatalogGiftCodePresence(
  db: Database,
  input: { pageId: number; presentRefs: readonly string[]; missingSince: Date },
): Promise<{ marked: number; cleared: number }> {
  const present = textArrayParam(input.presentRefs);
  const marked = await db.execute(sql`
    with heads as (
      select link_ref, max(business_date) as business_date
        from page_promo_links
       where page_id = ${input.pageId}
         and link_kind = 'gift_code'
       group by link_ref
    )
    update page_promo_links as p
       set missing_since = ${input.missingSince}, updated_at = now()
      from heads as h
     where p.page_id = ${input.pageId}
       and p.link_kind = 'gift_code'
       and p.link_ref = h.link_ref
       and p.business_date = h.business_date
       and p.missing_since is null
       and not (p.link_ref = any(${present}))
  `);
  const cleared = await db.execute(sql`
    update page_promo_links as p
       set missing_since = null, updated_at = now()
     where p.page_id = ${input.pageId}
       and p.link_kind = 'gift_code'
       and p.missing_since is not null
       and p.link_ref = any(${present})
  `);
  return { marked: marked.rowCount ?? 0, cleared: cleared.rowCount ?? 0 };
}

// ── M, and the number M is NOT ───────────────────────────────────────────────

/**
 * **M** — the media denominator WP-F4's whole lane is sized against.
 *
 * `count(distinct media_offer_ref)` over `creator_media`. The DISTINCT is
 * redundant against the table's own unique key and is written anyway, because
 * this number leaves the system as a named output and the query that produces
 * it should say what it means without the reader having to go and check a
 * constraint.
 */
export async function countPageUniqueCreatorMedia(
  db: Database,
  pageId: number,
): Promise<number> {
  const result = await db.execute(sql`
    select count(distinct media_offer_ref)::bigint as "count"
      from creator_media
     where page_id = ${pageId}
  `);
  const row = (result.rows?.[0] ?? {}) as { count?: unknown };
  return Number(row.count ?? 0);
}

/**
 * The count of DISTINCT raw media files the creator vault's membership names.
 * It is overlap-aware across albums, but it is not the offer census: one raw
 * file can back several rows in `creator_media`.
 *
 * The user vault is excluded by `vault_kind`: it holds the account's PURCHASES
 * from other creators, and counting them would inflate the page's own
 * inventory by the size of its shopping history.
 */
export async function countCreatorVaultUniqueMembers(
  db: Database,
  pageId: number,
): Promise<number> {
  const result = await db.execute(sql`
    select count(distinct media_ref)::bigint as "count"
      from creator_vault_album_members
     where page_id = ${pageId}
       and vault_kind = 'creator'
  `);
  const row = (result.rows?.[0] ?? {}) as { count?: unknown };
  return Number(row.count ?? 0);
}

/**
 * Σ `item_count` over the creator vault — reported ONLY as explicitly
 * NON-UNIQUE membership.
 *
 * It double-counts by construction: the system albums (type 38000 / 5000 /
 * 1000) are views over the same media, and the live capture proves it — Σ was
 * 16 939 over 27 albums while 38000 (7 574 items) and 5000 (3 154 items) shared
 * one `last_item_ref`. This function exists so the two numbers can be reported
 * SIDE BY SIDE with their difference visible, which is the only honest way to
 * publish either.
 */
export async function sumCreatorVaultAlbumItemCounts(
  db: Database,
  pageId: number,
): Promise<number> {
  const result = await db.execute(sql`
    select coalesce(sum(item_count), 0)::bigint as "total"
      from creator_vault_albums
     where page_id = ${pageId}
       and vault_kind = 'creator'
  `);
  const row = (result.rows?.[0] ?? {}) as { total?: unknown };
  return Number(row.total ?? 0);
}

/**
 * The hydration queue for the optional media-offer ids some membership shapes
 * carry. Live creator-vault rows currently carry only raw `mediaId`; those rows
 * are deliberately excluded rather than sending a raw file id to an offer-id
 * endpoint.
 */
export async function listUnhydratedVaultMediaRefs(
  db: Database,
  input: { pageId: number; limit: number },
): Promise<string[]> {
  const result = await db.execute(sql`
    select distinct m.media_offer_ref as "mediaOfferRef"
      from creator_vault_album_members m
     where m.page_id = ${input.pageId}
       and m.vault_kind = 'creator'
       and m.media_offer_ref is not null
       and not exists (
         select 1
           from creator_media c
          where c.page_id = m.page_id
            and c.media_offer_ref = m.media_offer_ref
       )
     order by m.media_offer_ref
     limit ${input.limit}
  `);
  return (result.rows ?? []).flatMap((row) => {
    const ref = (row as { mediaOfferRef?: unknown }).mediaOfferRef;
    return typeof ref === "string" && ref.length > 0 ? [ref] : [];
  });
}

/**
 * The bundle half of the same queue: bundle refs named by creator-vault
 * membership with no `creator_media_bundles` row yet.
 */
export async function listUnhydratedVaultBundleRefs(
  db: Database,
  input: { pageId: number; limit: number },
): Promise<string[]> {
  const result = await db.execute(sql`
    select distinct m.bundle_ref as "bundleRef"
      from creator_vault_album_members m
     where m.page_id = ${input.pageId}
       and m.vault_kind = 'creator'
       and m.bundle_ref is not null
       and not exists (
         select 1
           from creator_media_bundles b
          where b.page_id = m.page_id
            and b.bundle_ref = m.bundle_ref
       )
     order by m.bundle_ref
     limit ${input.limit}
  `);
  return (result.rows ?? []).flatMap((row) => {
    const ref = (row as { bundleRef?: unknown }).bundleRef;
    return typeof ref === "string" && ref.length > 0 ? [ref] : [];
  });
}

/**
 * The creator vault's albums as the walk sees them: which album, how many items
 * the platform CLAIMS it holds, and the newest member id it names.
 *
 * `last_item_ref` is the incremental trigger — when it changes, that album's
 * head is re-walked. `item_count = 0` is the one case where an empty first page
 * is honest rather than an unhonoured request, so it is carried out of the
 * database rather than re-derived at the call site.
 */
export async function listCreatorVaultAlbumsForWalk(
  db: Database,
  pageId: number,
): Promise<{ albumRef: string; itemCount: number | null; lastItemRef: string | null }[]> {
  const result = await db.execute(sql`
    select a.album_ref as "albumRef",
           a.item_count as "itemCount",
           a.last_item_ref as "lastItemRef"
      from creator_vault_albums a
     where a.page_id = ${pageId}
       and a.vault_kind = 'creator'
       and a.missing_since is null
     order by a.pos nulls last, a.album_ref
  `);
  return (result.rows ?? []).flatMap((row) => {
    const record = row as { albumRef?: unknown; itemCount?: unknown; lastItemRef?: unknown };
    if (typeof record.albumRef !== "string" || record.albumRef.length === 0) {
      return [];
    }
    return [{
      albumRef: record.albumRef,
      itemCount: record.itemCount === null || record.itemCount === undefined
        ? null
        : Number(record.itemCount),
      lastItemRef: typeof record.lastItemRef === "string" && record.lastItemRef.length > 0
        ? record.lastItemRef
        : null,
    }];
  });
}
