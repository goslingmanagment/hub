// WP-F3 — the catalog projector.
//
// ONE projector, ONE watermark, a reducer per table, exactly as the statistics
// and engagement projectors are shaped. Two things are specific to this family
// and both are about ABSENCE.
//
// ── 1. `catalog.listing_observed` IS THE ONLY REASON `missing_since` WORKS ───
//
// Row events say what IS. Nothing in them says what ISN'T, so a projector that
// read only row events could never mark a retired tier, a revoked gift code or
// a deleted album — least of all in the case that matters most, where the
// listing comes back EMPTY and produces no row events at all.
//
// The roster event carries the complete set of refs one FULL listing served.
// This projector applies it in BOTH directions: mark every row of that kind NOT
// in the set (whose `missing_since` is still null) as missing at the roster's
// instant, and CLEAR the mark on every row the set still names. The mark is
// therefore derived from the ledger, in ledger order, which is what makes it
// survive truncate-and-replay identically. A sweep that computed the same thing
// at capture time would produce a projection a rebuild could not reproduce.
//
// The CLEAR half is not symmetry for its own sake. A row whose content changed
// clears its own mark through the ordinary upsert — but a gift code that is
// revoked and reinstated UNCHANGED emits no row event at all, because its
// content hash is the one it had before. Only the roster can un-mark it, which
// is also why the roster is keyed per LOOK rather than per ref-set.
//
// ORDER MATTERS, and it is guaranteed by the canonicalizer: the roster is the
// LAST draft of its observation, so every row it describes has already been
// upserted (clearing `missing_since` on anything that came back) by the time
// the complement is marked.
//
// ── 2. ALBUM MEMBERSHIP NEEDS A COMPLETE WALK ───────────────────────────────
//
// Individual membership pages advance sightings. Only the separate, journaled
// `vault.album_walk_completed` inventory can mark missing membership. Its
// projector preserves concurrent sightings and is reproducible from the ledger.
//
// ── THE THREE RULES IT SHARES WITH EVERY PROJECTOR IN THIS TREE ─────────────
//
// 1. Projectors read EVENTS only — never `observations.payload`, never
//    `sync_raw_payloads`.
// 2. Rows are dated from `data`, NEVER from `event.occurredAt`. The events are
//    receipt-time by construction (§3.2b); `occurredAt` is when we LOOKED.
// 3. `applied` counts real writes, so an idle tick logs nothing.
//
// WHAT IT DELIBERATELY DOES NOT DO: it writes NOTHING to `creator_media` or
// `creator_media_bundles`. `media.observed` events minted by this family — the
// vault walk's and the batch hydration's — are consumed by the MEDIA-PLANE
// projector, which is and stays the single writer of those two tables. A second
// writer with its own precedence rule is how two heads start disagreeing about
// one media row's price.

import {
  countCreatorVaultUniqueMembers,
  countPageUniqueCreatorMedia,
  getPageTransactionsWriterInfo,
  getProjectionWatermark,
  listDetachedPartitionsHoldingAccount,
  listEventAccounts,
  listEventsSince,
  reconcileCatalogAlbumPresence,
  reconcileCatalogAutomationsPresence,
  reconcileCatalogGiftCodePresence,
  reconcileCatalogTierPlansPresence,
  reconcileCatalogTiersPresence,
  reconcileCatalogWallsPresence,
  reconcileVaultAlbumScan,
  upsertVaultAlbumScan,
  setProjectionWatermark,
  sumCreatorVaultAlbumItemCounts,
  upsertCreatorVaultAlbum,
  upsertCreatorVaultAlbumMember,
  upsertPageAutomatedMessage,
  upsertPageGiftCode,
  upsertPageSubscriptionTier,
  upsertPageSubscriptionTierPlan,
  upsertPageWall,
  type CatalogVaultKind,
  type FanslyCatalogPlatform,
} from "@agency_hub_core/db";
import { millsFromInteger, type Mills } from "@agency_hub_core/shared";
import { sql } from "drizzle-orm";

import type { AppContext } from "../../bootstrap.ts";

export const FANSLY_CATALOG_PROJECTION = "fansly_catalog";

const EVENT_PAGE_SIZE = 500;

const FANSLY_CATALOG_EVENT_TYPES = new Set([
  "vault.album_observed",
  "vault.album_membership_observed",
  "vault.album_walk_completed",
  "subscription.tier_observed",
  "subscription.tier_plan_observed",
  "promo.gift_code_observed",
  "automation.definition_observed",
  "page.wall_observed",
  "catalog.listing_observed",
]);

/** The gift-code half of WP-F1's two-kind table. See the note on
 *  `PROMO_LINKS_TABLE` in `fansly-stats.ts`: both rebuilds scope by kind. */
export const PROMO_LINKS_TABLE = "page_promo_links";
export const CATALOG_PROMO_LINK_KIND = "gift_code";

/**
 * The tables this projector truncates on rebuild.
 *
 * `page_promo_links` is HERE, and its delete is the one that is SCOPED: WP-F1
 * built the table for two `link_kind`s and this package supplies the second, so
 * the two writers truncate disjoint halves of one table. An unscoped delete on
 * either side would remove rows the other side's ledger owns and only the other
 * side's rebuild could restore.
 *
 * `creator_media` and `creator_media_bundles` are ABSENT: the media plane owns
 * them, truncates them on its own rebuild, and replays the same
 * `media.observed` events this family mints.
 */
export const FANSLY_CATALOG_PROJECTION_TABLES = [
  "creator_vault_album_scans",
  "creator_vault_album_members",
  "creator_vault_albums",
  "page_subscription_tier_plans",
  "page_subscription_tiers",
  "page_walls",
  "page_automated_messages",
  "page_promo_links",
] as const;

export interface FanslyCatalogProjectionResult extends Record<string, unknown> {
  accounts: number;
  eventsSeen: number;
  applied: number;
  albums: number;
  albumMembers: number;
  tiers: number;
  tierPlans: number;
  giftCodes: number;
  automations: number;
  walls: number;
  markedMissing: number;
  clearedMissing: number;
}

function eventData(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

/**
 * Event mills travel as decimal STRINGS (JSON cannot carry a bigint, and a
 * float would re-open the 1000x footgun). Constructed through the named
 * already-mills constructor `millsFromInteger` (Stage 27) — never a hand-rolled
 * `BigInt(...)`.
 *
 * The shape guards in FRONT of it are not decoration: the constructor THROWS on
 * a non-digit string and on a non-finite number, and a projector must skip a
 * malformed money field rather than crash the sweep. Digits only ⇒ no sign, no
 * fraction, no exponent.
 */
function millsOrNull(value: unknown): Mills | null {
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return millsFromInteger(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return millsFromInteger(value);
  }
  return null;
}

function isoDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function vaultKind(value: unknown): CatalogVaultKind {
  return value === "user" ? "user" : "creator";
}

/** The UTC business date of a capture instant — the daily-snapshot key the
 *  tracking half of `page_promo_links` already uses. */
function utcBusinessDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

export async function runFanslyCatalogProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
): Promise<FanslyCatalogProjectionResult> {
  const totals: FanslyCatalogProjectionResult = {
    accounts: 0,
    eventsSeen: 0,
    applied: 0,
    albums: 0,
    albumMembers: 0,
    tiers: 0,
    tierPlans: 0,
    giftCodes: 0,
    automations: 0,
    walls: 0,
    markedMissing: 0,
    clearedMissing: 0,
  };
  const accounts = input?.accountId != null
    ? [input.accountId]
    : await listEventAccounts(app.db);
  const platformCache = new Map<number, string | null>();

  for (const accountId of accounts) {
    totals.accounts += 1;
    if (!platformCache.has(accountId)) {
      const page = await getPageTransactionsWriterInfo(app.db, accountId);
      platformCache.set(accountId, page?.platform ?? null);
    }
    const platform = platformCache.get(accountId) ?? null;
    if (platform !== "fansly" && platform !== "onlyfans") {
      // No page, no platform: the rows would be unattributable. The events stay
      // in the ledger and project the moment the page mapping lands.
      continue;
    }
    const catalogPlatform: FanslyCatalogPlatform = platform;

    let watermark = await getProjectionWatermark(app.db, FANSLY_CATALOG_PROJECTION, accountId);
    for (;;) {
      const events = await listEventsSince(app.db, {
        accountId,
        afterSeq: watermark,
        limit: EVENT_PAGE_SIZE,
      });
      if (events.length === 0) {
        break;
      }
      totals.eventsSeen += events.length;

      for (const event of events) {
        if (!FANSLY_CATALOG_EVENT_TYPES.has(event.type)) {
          continue;
        }
        const data = eventData(event.data);
        const lineage = {
          sourceEventId: event.id,
          sourceObservationId: event.observationId,
          sourceAccountSeq: event.accountSeq,
          // Receipt-time events: occurredAt IS the observation instant, which
          // is exactly the freshness ordering these heads need.
          observedAt: event.occurredAt,
          contentHash: asText(data.contentHash) ?? "",
        };
        if (lineage.contentHash.length !== 64) {
          continue;
        }

        switch (event.type) {
          case "vault.album_observed": {
            const albumRef = asText(data.albumRef);
            if (albumRef === null) continue;
            const result = await upsertCreatorVaultAlbum(app.db, {
              pageId: accountId,
              platform: catalogPlatform,
              vaultKind: vaultKind(data.vaultKind),
              albumRef,
              ownerAccountRef: asText(data.ownerAccountRef),
              title: asText(data.title),
              description: typeof data.description === "string" ? data.description : null,
              albumType: asInt(data.albumType),
              status: asInt(data.status),
              pos: asInt(data.pos),
              itemCount: asInt(data.itemCount),
              lastItemRef: asText(data.lastItemRef),
              thumbnailRef: asText(data.thumbnailRef),
              public: asInt(data.public),
              version: asInt(data.version),
              createdAtPlatform: isoDate(data.createdAtPlatform),
              ...lineage,
            });
            if (result.applied) {
              totals.albums += 1;
              totals.applied += 1;
            }
            continue;
          }

          case "vault.album_membership_observed": {
            const albumRef = asText(data.albumRef);
            const mediaRef = asText(data.mediaRef);
            if (albumRef === null || mediaRef === null) continue;
            const result = await upsertCreatorVaultAlbumMember(app.db, {
              pageId: accountId,
              platform: catalogPlatform,
              albumRef,
              mediaOfferRef: asText(data.mediaOfferRef),
              memberRef: asText(data.memberRef),
              customFilename: typeof data.customFilename === "string" ? data.customFilename : null,
              mediaOfferType: asInt(data.mediaOfferType),
              bundleRef: asText(data.bundleRef),
              mediaRef,
              mediaType: asInt(data.mediaType),
              previewRef: asText(data.previewRef),
              vaultKind: vaultKind(data.vaultKind),
              createdAtPlatform: isoDate(data.createdAtPlatform),
              ...lineage,
            });
            if (result.applied) {
              totals.albumMembers += 1;
              totals.applied += 1;
            }
            if (data.vaultKind === "creator") await reconcileVaultAlbumScan(app.db, accountId, albumRef, mediaRef);
            continue;
          }

          case "vault.album_walk_completed": {
            const albumRef = asText(data.albumRef);
            const walkRef = asText(data.walkRef);
            const startedAt = isoDate(data.startedAt);
            const completedAt = isoDate(data.completedAt);
            const expectedCount = asInt(data.expectedCount);
            const pages = asInt(data.pages);
            if (!albumRef || !walkRef || !startedAt || !completedAt || expectedCount === null
              || !pages || data.vaultKind !== "creator" || !Array.isArray(data.seenMediaRefs)
              || !data.seenMediaRefs.every((ref): ref is string => typeof ref === "string" && ref.length > 0)
              || new Set(data.seenMediaRefs).size !== expectedCount) continue;
            await upsertVaultAlbumScan(app.db, { pageId: accountId, albumRef, walkRef,
              startedAt, completedAt, seenMediaRefs: data.seenMediaRefs, expectedCount, pages, ...lineage });
            totals.applied += 1;
            continue;
          }

          case "subscription.tier_observed": {
            const tierRef = asText(data.tierRef);
            if (tierRef === null) continue;
            const result = await upsertPageSubscriptionTier(app.db, {
              pageId: accountId,
              platform: catalogPlatform,
              tierRef,
              name: asText(data.name),
              color: asText(data.color),
              pos: asInt(data.pos),
              // `tier.price`. A BASE, not the price — the plans hold that.
              basePriceMills: millsOrNull(data.basePriceMills),
              maxSubscribers: asInt(data.maxSubscribers),
              subscriptionBenefits: asArray(data.subscriptionBenefits),
              includedTierRefs: asArray(data.includedTierRefs),
              plans: asArray(data.plans),
              ...lineage,
            });
            if (result.applied) {
              totals.tiers += 1;
              totals.applied += 1;
            }
            continue;
          }

          case "subscription.tier_plan_observed": {
            const tierRef = asText(data.tierRef);
            const planRef = asText(data.planRef);
            if (tierRef === null || planRef === null) continue;
            const result = await upsertPageSubscriptionTierPlan(app.db, {
              pageId: accountId,
              platform: catalogPlatform,
              tierRef,
              planRef,
              status: asInt(data.status),
              durationDays: asInt(data.durationDays),
              // THE PRICE TRUTH (FEAT-002).
              priceMills: millsOrNull(data.priceMills),
              useAmounts: asInt(data.useAmounts),
              promos: asArray(data.promos),
              ...lineage,
            });
            if (result.applied) {
              totals.tierPlans += 1;
              totals.applied += 1;
            }
            continue;
          }

          case "promo.gift_code_observed": {
            const codeRef = asText(data.codeRef);
            if (codeRef === null) continue;
            const result = await upsertPageGiftCode(app.db, {
              pageId: accountId,
              platform: catalogPlatform,
              codeRef,
              // The capture's UTC day — dated from the OBSERVATION instant,
              // which for a receipt-time event is `event.occurredAt`. This is
              // the one date in this file that is not "when the thing
              // happened", and it is right: the daily snapshot's key is when we
              // looked.
              businessDate: utcBusinessDate(event.occurredAt),
              code: asText(data.code),
              label: typeof data.label === "string" ? data.label : null,
              linkType: asInt(data.linkType),
              status: asInt(data.status),
              planRef: asText(data.planRef),
              priceMills: millsOrNull(data.priceMills),
              originalPriceMills: millsOrNull(data.originalPriceMills),
              uses: asInt(data.uses),
              maxUses: asInt(data.maxUses),
              createdAtPlatform: isoDate(data.createdAtPlatform),
              startsAtPlatform: isoDate(data.startsAtPlatform),
              endsAtPlatform: isoDate(data.endsAtPlatform),
              metadata: {
                durationDays: asInt(data.durationDays),
                paymentMethodRequired: asInt(data.paymentMethodRequired),
                newSubscribersOnly: asInt(data.newSubscribersOnly),
                version: asInt(data.version),
              },
              capturedAt: event.occurredAt,
              ...lineage,
            });
            if (result.applied) {
              totals.giftCodes += 1;
              totals.applied += 1;
            }
            continue;
          }

          case "automation.definition_observed": {
            const automationRef = asText(data.automationRef);
            if (automationRef === null) continue;
            const result = await upsertPageAutomatedMessage(app.db, {
              pageId: accountId,
              platform: catalogPlatform,
              automationRef,
              triggerType: asInt(data.triggerType),
              triggerMetadata: eventData(data.triggerMetadata),
              delaySeconds: asInt(data.delaySeconds),
              cooldownSeconds: asInt(data.cooldownSeconds),
              templateType: asInt(data.templateType),
              senderRef: asText(data.senderRef),
              // NULL, not "", when the template did not parse: an automation
              // with no text and one we could not read are different facts, and
              // `parseOk` is what tells them apart.
              messageText: typeof data.messageText === "string" ? data.messageText : null,
              attachmentRefs: asArray(data.attachmentRefs),
              parseOk: data.parseOk !== false,
              ...lineage,
            });
            if (result.applied) {
              totals.automations += 1;
              totals.applied += 1;
            }
            continue;
          }

          case "page.wall_observed": {
            const wallRef = asText(data.wallRef);
            if (wallRef === null) continue;
            const result = await upsertPageWall(app.db, {
              pageId: accountId,
              platform: catalogPlatform,
              wallRef,
              name: typeof data.name === "string" ? data.name : null,
              description: typeof data.description === "string" ? data.description : null,
              pos: asInt(data.pos),
              mainWall: asBool(data.mainWall),
              defaultWall: asBool(data.defaultWall),
              private: asInt(data.private),
              metadata: eventData(data.metadata),
              ...lineage,
            });
            if (result.applied) {
              totals.walls += 1;
              totals.applied += 1;
            }
            continue;
          }

          case "catalog.listing_observed": {
            // THE ROSTER. Everything this listing named has just been upserted
            // (clearing its `missing_since`); everything it did NOT name, and
            // is not already marked, is missing as of this instant.
            const listingKind = asText(data.listingKind);
            if (listingKind === null) continue;
            const presentRefs = stringArray(data.refs);
            const missingSince = event.occurredAt;
            const reconciled = await reconcileListingPresence(app.db, {
              pageId: accountId,
              listingKind,
              presentRefs,
              missingSince,
            });
            if (reconciled.marked > 0 || reconciled.cleared > 0) {
              totals.markedMissing += reconciled.marked;
              totals.clearedMissing += reconciled.cleared;
              totals.applied += reconciled.marked + reconciled.cleared;
            }
            continue;
          }

          default:
            continue;
        }
      }

      watermark = events[events.length - 1]!.accountSeq;
      await setProjectionWatermark(app.db, FANSLY_CATALOG_PROJECTION, accountId, watermark);
      if (events.length < EVENT_PAGE_SIZE) {
        break;
      }
    }
  }

  return totals;
}

/** One roster kind → one reconciler. An unrecognized listing kind touches
 *  NOTHING: a roster we cannot map is a roster whose complement we cannot
 *  compute, and guessing would mark live rows dead. */
async function reconcileListingPresence(
  db: AppContext["db"],
  input: {
    pageId: number;
    listingKind: string;
    presentRefs: readonly string[];
    missingSince: Date;
  },
): Promise<{ marked: number; cleared: number }> {
  const { pageId, presentRefs, missingSince } = input;
  switch (input.listingKind) {
    case "vault_albums:creator":
      return await reconcileCatalogAlbumPresence(db, {
        pageId,
        vaultKind: "creator",
        presentRefs,
        missingSince,
      });
    case "vault_albums:user":
      return await reconcileCatalogAlbumPresence(db, {
        pageId,
        vaultKind: "user",
        presentRefs,
        missingSince,
      });
    case "subscription_tiers":
      return await reconcileCatalogTiersPresence(db, { pageId, presentRefs, missingSince });
    case "subscription_tier_plans":
      return await reconcileCatalogTierPlansPresence(db, { pageId, presentRefs, missingSince });
    case "gift_codes":
      return await reconcileCatalogGiftCodePresence(db, { pageId, presentRefs, missingSince });
    case "automated_messages":
      return await reconcileCatalogAutomationsPresence(db, {
        pageId,
        presentRefs,
        missingSince,
      });
    case "page_walls":
      return await reconcileCatalogWallsPresence(db, { pageId, presentRefs, missingSince });
    default:
      return { marked: 0, cleared: 0 };
  }
}

/**
 * The catalog lane's three media censuses (A16 item 1).
 *
 * `uniqueMediaCount` is M: `count(distinct media_offer_ref)` over
 * `creator_media`. `vaultMemberUniqueCount` is the distinct raw-file union the
 * creator-vault walk measures. These are separate identities: one raw file can
 * back several offers. `albumMembershipSum` is Σ `item_count`, which
 * DOUBLE-COUNTS and is labelled non-unique everywhere it appears.
 *
 * All three are reported together on purpose, but no equality between the raw
 * file and offer counts is claimed.
 */
export interface FanslyCatalogMediaCensus {
  uniqueMediaCount: number;
  vaultMemberUniqueCount: number;
  /** Σ `item_count`. NON-UNIQUE by construction — never M. */
  albumMembershipSum: number;
}

export async function measureFanslyCatalogMedia(
  db: AppContext["db"],
  pageId: number,
): Promise<FanslyCatalogMediaCensus> {
  return {
    uniqueMediaCount: await countPageUniqueCreatorMedia(db, pageId),
    vaultMemberUniqueCount: await countCreatorVaultUniqueMembers(db, pageId),
    albumMembershipSum: await sumCreatorVaultAlbumItemCounts(db, pageId),
  };
}

/**
 * §3.2c(i) READ-SIDE PREFLIGHT — the rebuild refuses when any DETACHED
 * partition holds events for the account.
 *
 * Tiering exports and detaches `domain_events` monthlies older than ~6 months,
 * and `listEventsSince` sees only ATTACHED partitions. A rebuild that ran
 * anyway would truncate the projection, replay a truncated ledger, and call the
 * result authoritative — silently. It is worse than usual in THIS family: the
 * roster events are what write `missing_since`, so a truncated replay would not
 * merely lose rows, it would resurrect entities the platform retired.
 */
export async function assertFanslyCatalogRebuildable(
  app: Pick<AppContext, "db">,
  accountIds: readonly number[],
): Promise<void> {
  for (const accountId of accountIds) {
    const holding = await listDetachedPartitionsHoldingAccount(app.db, accountId);
    if (holding.length > 0) {
      throw new Error(
        `fansly_catalog rebuild REFUSED for account ${accountId}: `
          + `${holding.map((row) => `${row.schema}.${row.name} (${row.rows} rows)`).join(", ")} `
          + "is detached and holds this account's events, so a replay would produce a "
          + "TRUNCATED projection and call it authoritative — including resurrecting "
          + "entities a roster event had marked missing. Recovery: re-attach the month "
          + "(the 0077 ritual — DETACH/ATTACH only, never DROP) or replay hot + lake for "
          + "the range, then re-run. See docs/runbooks/domain-event-partitions.md",
      );
    }
  }
}

/**
 * One-command rebuild: preflight, then truncate scope + reset watermark
 * ATOMICALLY, then replay. The deletes run in ONE transaction (the decision
 * #134 rule): a crash between them would leave an empty projection behind a
 * stale high watermark — permanently and silently empty.
 *
 * These deletes are a PROJECTION RESET — rebuildable state only, never
 * scheduled, which is the justification `tests/retention-deleters.test.ts`
 * carries for this file. The stream CHECKPOINT is not touched: the vault walk's
 * per-album cursors live there, they are capture-plane operational state, and a
 * rebuild that reset them would re-run a first-enable exhaustion crawl of every
 * album on every page.
 */
export async function rebuildFanslyCatalogProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
): Promise<FanslyCatalogProjectionResult> {
  const accountIds = input?.accountId != null
    ? [input.accountId]
    : await listEventAccounts(app.db);
  await assertFanslyCatalogRebuildable(app, accountIds);

  await app.db.transaction(async (tx) => {
    if (input?.accountId != null) {
      const pageId = input.accountId;
      for (const table of FANSLY_CATALOG_PROJECTION_TABLES) {
        await tx.execute(
          table === PROMO_LINKS_TABLE
            // Scoped by kind: the TRACKING half of this table belongs to the
            // statistics projector's ledger, and truncating it here would
            // delete rows this replay cannot re-derive.
            ? sql`
              delete from page_promo_links
               where page_id = ${pageId} and link_kind = ${CATALOG_PROMO_LINK_KIND}
            `
            : sql`delete from ${sql.identifier(table)} where page_id = ${pageId}`,
        );
      }
      await tx.execute(sql`
        delete from projection_seq_watermarks
        where projection = ${FANSLY_CATALOG_PROJECTION} and account_id = ${pageId}
      `);
    } else {
      for (const table of FANSLY_CATALOG_PROJECTION_TABLES) {
        await tx.execute(
          table === PROMO_LINKS_TABLE
            ? sql`delete from page_promo_links where link_kind = ${CATALOG_PROMO_LINK_KIND}`
            : sql`delete from ${sql.identifier(table)}`,
        );
      }
      await tx.execute(sql`
        delete from projection_seq_watermarks where projection = ${FANSLY_CATALOG_PROJECTION}
      `);
    }
  });
  return runFanslyCatalogProjection(app, input);
}
