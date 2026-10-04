import {
  createModel,
  createOnlyFansPage,
  rebuildRevenueRollups,
  rebuildSpenderProjections,
  upsertFanPages,
  upsertFans,
  upsertTransaction,
} from "@agency_hub_core/db";
import type { TransactionState, TransactionType } from "@agency_hub_core/shared";

import type { StartedTestDatabase } from "./db.ts";

// The seeded page of the Spenders statistics tests (H-8): the repository's
// (tests/client-spender-stats.integration.test.ts), the union's and the
// route's read the same fans, so a number proven in one file is the number
// the others expect.

/** The instant the fixture's numbers are of. */
export const SPENDER_STATS_FIXTURE_AS_OF = new Date("2026-10-03T12:00:00.000Z");
/** The OFAPI account `addDmMessage` files its rows under; a page that reads them is bound to it. */
export const SPENDER_STATS_FIXTURE_OFAPI_ACCOUNT = "acct_stats";

/** Seed helpers over the test database `db()` returns when a helper runs. */
export function spenderStatsFixture(db: () => StartedTestDatabase) {
  let transactionSeq = 0;
  let messageSeq = 0;

  async function seedPage(label: string) {
    const model = await createModel(db().db, { slug: `model-${label}`, name: `Model ${label}` });
    if (!model) throw new Error(`model for ${label} was not created`);
    const page = await createOnlyFansPage(db().db, { modelId: model.id, label });
    if (!page) throw new Error(`page ${label} was not created`);
    return page;
  }

  async function seedFan(pageId: number, ref: string, options: { deleted?: boolean } = {}) {
    const [fan] = await upsertFans(db().db, [{ platform: "onlyfans", platformUserId: ref, username: `fan${ref}` }]);
    await upsertFanPages(db().db, [{ fanId: fan!.id, platformAccountId: pageId }]);
    if (options.deleted) {
      await db().pool.query("update fans set deleted_detected_at = now() where id = $1", [fan!.id]);
    }
    return fan!.id;
  }

  async function addTransaction(pageId: number, input: {
    fanId: number | null;
    type: TransactionType;
    gross: bigint;
    at: string;
    state?: TransactionState;
  }) {
    transactionSeq += 1;
    await upsertTransaction(db().db, {
      platformAccountId: pageId,
      source: "ofapi:webhook",
      fanId: input.fanId,
      transactionId: `stats-${transactionSeq}`,
      rawType: input.type,
      canonicalType: input.type,
      transactionState: input.state ?? "posted",
      rawStatus: "ok",
      grossAmountMills: input.gross,
      sourceDestinationAmountMills: input.gross,
      creatorNetAmountMills: (input.gross * 8n) / 10n,
      occurredAt: new Date(input.at),
    });
  }

  async function addThread(pageId: number, input: {
    fanId: number | null;
    conversationRef: string;
    unreadCount?: number;
    headRole?: "fan" | "model" | "system" | "unknown";
    lastMessageAt?: string | null;
    lastFanMessageAt?: string | null;
    lastModelMessageAt?: string | null;
    visible?: boolean;
  }) {
    await db().pool.query(
      `insert into page_dm_threads (
         platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id,
         unread_count, last_message_sender_role, last_message_at,
         last_fan_message_at, last_model_message_at, is_visible
       ) values ($1, $2, $3, $3, $4, $5::dm_sender_role, $6, $7, $8, $9)`,
      [
        pageId,
        input.fanId,
        input.conversationRef,
        input.unreadCount ?? 0,
        input.headRole ?? "fan",
        input.lastMessageAt ?? input.lastFanMessageAt ?? input.lastModelMessageAt ?? null,
        input.lastFanMessageAt ?? null,
        input.lastModelMessageAt ?? null,
        input.visible ?? true,
      ],
    );
  }

  /** A message_archive row; answers its message id. */
  async function addMessage(pageId: number, input: {
    conversationRef: string;
    fromFan: boolean;
    at: string | null;
    text: string;
    deleted?: boolean;
    contentPending?: boolean;
    /** The platform message id; a fresh one unless given. */
    ref?: string;
    /** REST material clocks (the AI union's choice between two copies of one message). */
    materialObservedAt?: string;
    vendorChangedAt?: string;
  }): Promise<string> {
    messageSeq += 1;
    const ref = input.ref ?? String(900_000 + messageSeq);
    await db().pool.query(
      `insert into message_archive (
         account_id, platform, conversation_ref, message_ref, fan_native_id,
         sender_role, is_sent_by_me, occurred_at, text_plain, deleted_at, content_pending,
         material_observed_at, vendor_changed_at
       ) values ($1, 'onlyfans', $2, $3, $2, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        pageId,
        input.conversationRef,
        ref,
        input.fromFan ? "fan" : "model",
        !input.fromFan,
        input.at,
        input.text,
        input.deleted ? input.at ?? "2026-10-01T00:00:00Z" : null,
        input.contentPending ?? false,
        input.materialObservedAt ?? null,
        input.vendorChangedAt ?? null,
      ],
    );
    return ref;
  }

  /**
   * A dm_message_archive row, the webhook store the AI transcript union reads
   * beside the archive; answers its message id. `at: null` is a stub (a row
   * without a creation time); `conversationRef: null` with `deleted` is the
   * stub a `messages.deleted` webhook leaves, which names no chat.
   */
  async function addDmMessage(pageId: number, input: {
    conversationRef: string | null;
    fromFan: boolean;
    at: string | null;
    text: string;
    deleted?: boolean;
    ref?: string;
    ofapiAccountId?: string;
    restMaterialObservedAt?: string;
    restPlatformChangedAt?: string;
  }): Promise<string> {
    messageSeq += 1;
    const ref = input.ref ?? String(900_000 + messageSeq);
    await db().pool.query(
      `insert into dm_message_archive (
         platform, platform_account_id, ofapi_account_id, platform_conversation_id,
         fan_platform_user_id, platform_message_id, sender_role, is_sent_by_me,
         message_created_at, text_plain, deleted_at, source, source_event_type,
         source_idempotency_key, source_journal_id, source_received_at, retain_until,
         rest_material_observed_at, rest_platform_changed_at
       ) values (
         'onlyfans', $1, $2, $3, $3, $4, $5, $6, $7, $8, $9, 'webhook', $10, $11, 1, now(),
         now() + interval '100 years', $12, $13
       )`,
      [
        pageId,
        input.ofapiAccountId ?? SPENDER_STATS_FIXTURE_OFAPI_ACCOUNT,
        input.conversationRef,
        ref,
        input.fromFan ? "fan" : "model",
        !input.fromFan,
        input.at,
        input.text,
        input.deleted ? input.at ?? "2026-10-01T00:00:00Z" : null,
        input.deleted && input.at === null ? "messages.deleted" : input.fromFan ? "messages.received" : "messages.sent",
        `stats-dm-${messageSeq}`,
        input.restMaterialObservedAt ?? null,
        input.restPlatformChangedAt ?? null,
      ],
    );
    return ref;
  }

  /**
   * The main page, as of 2026-10-03 12:00Z, UTC window 2026-09-04..2026-10-03.
   * See each fan's comment for what it proves.
   */
  async function seedMainPage() {
    const page = await seedPage("stats-of");
    const other = await seedPage("stats-other-of");

    // A: tier 25-50 (37 000); paid before the window, so not new; one purchase
    // at 22:30Z on 09-03, outside the UTC window but 09-04 01:30 in Moscow;
    // last text 3 days ago (not silent); awaiting, 2 unread.
    const a = await seedFan(page.id, "1001");
    await addTransaction(page.id, { fanId: a, type: "tip", gross: 30_000n, at: "2026-08-01T10:00:00Z" });
    await addTransaction(page.id, { fanId: a, type: "tip", gross: 2_000n, at: "2026-09-03T22:30:00Z" });
    await addTransaction(page.id, { fanId: a, type: "tip", gross: 5_000n, at: "2026-10-03T09:00:00Z" });
    await addMessage(page.id, { conversationRef: "1001", fromFan: true, at: "2026-09-30T12:00:00Z", text: "hey" });
    await addMessage(page.id, { conversationRef: "1001", fromFan: false, at: "2026-10-02T08:00:00Z", text: "hi!" });
    await addThread(page.id, {
      fanId: a,
      conversationRef: "1001",
      unreadCount: 2,
      headRole: "fan",
      lastFanMessageAt: "2026-10-03T08:00:00Z",
      lastModelMessageAt: "2026-10-02T08:00:00Z",
    });

    // B: tier 0-25 (12 000); first purchase in the window (new); a pending tip;
    // last TEXT 10 days ago — a later deleted, blank or content-pending message
    // does not count; replied to, so not awaiting, and an older second chat
    // that is awaiting does not make B awaiting (primary chat rule).
    const b = await seedFan(page.id, "1002");
    await addTransaction(page.id, { fanId: b, type: "message_purchase", gross: 10_000n, at: "2026-09-25T10:00:00Z" });
    await addTransaction(page.id, { fanId: b, type: "tip", gross: 2_000n, at: "2026-09-30T10:00:00Z", state: "pending" });
    await addMessage(page.id, { conversationRef: "1002", fromFan: true, at: "2026-09-23T12:00:00Z", text: "remember me" });
    await addMessage(page.id, { conversationRef: "1002", fromFan: true, at: "2026-10-01T12:00:00Z", text: "deleted", deleted: true });
    await addMessage(page.id, { conversationRef: "1002", fromFan: true, at: "2026-10-02T12:00:00Z", text: " \n\t " });
    await addMessage(page.id, { conversationRef: "1002", fromFan: true, at: "2026-10-02T13:00:00Z", text: "stub", contentPending: true });
    await addMessage(page.id, { conversationRef: "1002", fromFan: false, at: "2026-10-03T11:00:00Z", text: "model text" });
    await addThread(page.id, {
      fanId: b,
      conversationRef: "1002",
      headRole: "model",
      lastMessageAt: "2026-09-24T12:00:00Z",
      lastFanMessageAt: "2026-09-23T12:00:00Z",
      lastModelMessageAt: "2026-09-24T12:00:00Z",
    });
    await addThread(page.id, {
      fanId: b,
      conversationRef: "b-old",
      unreadCount: 1,
      lastMessageAt: "2026-09-01T12:00:00Z",
      lastFanMessageAt: "2026-09-01T12:00:00Z",
      lastModelMessageAt: null,
    });

    // C: tier 150-350 (197 000); a refund in the window and no purchase;
    // silent since August (over 21 days); awaiting with no model message at
    // all and a chat row whose head is unknown → read state unknown.
    const c = await seedFan(page.id, "1003");
    await addTransaction(page.id, { fanId: c, type: "subscription", gross: 200_000n, at: "2026-07-01T10:00:00Z" });
    await addTransaction(page.id, { fanId: c, type: "refund", gross: -3_000n, at: "2026-09-30T11:00:00Z" });
    await addMessage(page.id, { conversationRef: "1003", fromFan: true, at: "2026-08-01T12:00:00Z", text: "bye" });
    await addThread(page.id, {
      fanId: c,
      conversationRef: "1003",
      headRole: "unknown",
      lastMessageAt: "2026-08-01T12:00:00Z",
      lastFanMessageAt: "2026-08-01T12:00:00Z",
      lastModelMessageAt: null,
    });

    // D: tier 0-25 (1 000); first purchase on the window's first UTC date, in
    // the unknown state; never wrote (silence unknown); no chat.
    const d = await seedFan(page.id, "1004");
    await addTransaction(page.id, { fanId: d, type: "stream_tip", gross: 1_000n, at: "2026-09-04T00:30:00Z", state: "unknown" });

    // E: bought and was refunded in the window: lifetime 0, so no tier — the
    // spend lands in "untiered"; awaiting but not a payer, so not queued.
    const e = await seedFan(page.id, "1005");
    await addTransaction(page.id, { fanId: e, type: "tip", gross: 500n, at: "2026-09-10T10:00:00Z" });
    await addTransaction(page.id, { fanId: e, type: "refund", gross: -500n, at: "2026-09-11T10:00:00Z" });
    await addThread(page.id, {
      fanId: e,
      conversationRef: "1005",
      unreadCount: 1,
      lastFanMessageAt: "2026-10-01T10:00:00Z",
    });

    // F: tier 600-plus (700 000); last text exactly 21 days ago (still 8–21);
    // awaiting, nothing unread and the chat's head is the fan → read.
    const f = await seedFan(page.id, "1006");
    await addTransaction(page.id, { fanId: f, type: "tip", gross: 690_000n, at: "2026-06-01T10:00:00Z" });
    await addTransaction(page.id, { fanId: f, type: "tip", gross: 10_000n, at: "2026-09-28T10:00:00Z" });
    await addMessage(page.id, { conversationRef: "1006", fromFan: true, at: "2026-09-12T12:00:00Z", text: "miss you" });
    await addThread(page.id, {
      fanId: f,
      conversationRef: "1006",
      headRole: "fan",
      lastFanMessageAt: "2026-09-30T10:00:00Z",
      lastModelMessageAt: "2026-09-29T10:00:00Z",
    });

    // G: a deleted account that paid in the window: never a tier member, its
    // spend is "untiered".
    const g = await seedFan(page.id, "1007", { deleted: true });
    await addTransaction(page.id, { fanId: g, type: "tip", gross: 3_000n, at: "2026-09-15T10:00:00Z" });

    // Unattributed purchase; a payout reversal and an inactive row that no
    // number may count; another page's spend in the same window.
    await addTransaction(page.id, { fanId: null, type: "tip", gross: 4_000n, at: "2026-09-20T10:00:00Z" });
    await addTransaction(page.id, { fanId: null, type: "payout_reversal", gross: -50_000n, at: "2026-09-21T10:00:00Z" });
    await addTransaction(page.id, { fanId: a, type: "tip", gross: 99_000n, at: "2026-09-22T10:00:00Z" });
    await db().pool.query(
      "update transactions set is_active = false, inactive_reason = 'missing_from_sync_window' where gross_amount_mills = 99000",
    );
    const stranger = await seedFan(other.id, "2001");
    await addTransaction(other.id, { fanId: stranger, type: "tip", gross: 77_000n, at: "2026-09-29T10:00:00Z" });

    return { page, other, fans: { a, b, c, d, e, f, g } };
  }

  async function rebuildAll(pageId: number, rebuiltAt = SPENDER_STATS_FIXTURE_AS_OF) {
    await rebuildSpenderProjections(db().db, pageId, null, rebuiltAt);
    await rebuildRevenueRollups(db().db, pageId);
  }

  return { seedPage, seedFan, addTransaction, addThread, addMessage, addDmMessage, seedMainPage, rebuildAll };
}
