import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  pageConversationMessagesResponseSchema,
  pageConversationPreviewResponseSchema,
} from "@agency_hub_core/contracts";
import { readDmLiveUnion, type Database } from "@agency_hub_core/db";
import { getDescriptor, loadConfig, platformHasLiveOverlay, readsFanslyLiveOverlay } from "@agency_hub_core/shared";

import { PgDialect } from "../packages/db/node_modules/drizzle-orm/pg-core/index.js";
import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";

const DIALECT = new PgDialect();

// Fansly Sync Engine step 1 «показ читателям» (plan §7.11, §15 step 1): the
// per-page reader switch, the union merge and the additive contract.

const fansly = (label: string) => ({ label, platform: "fansly" as const });

describe("fanslyLiveOverlayReadPages", () => {
  it("is a live, editable key whose default reads no page", () => {
    expect(getDescriptor("fanslyLiveOverlayReadPages")).toMatchObject({
      envName: "FANSLY_LIVE_OVERLAY_READ_PAGES", kind: "string", default: "none",
      editability: "editable", runtimeApply: "live",
    });
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/hub",
      APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    }, { loadDotEnv: false });
    expect(config.fanslyLiveOverlayReadPages).toBe("none");
    expect(readsFanslyLiveOverlay(config, fansly("ari-1"))).toBe(false);
  });

  it("grants exact labels, all, and fails closed on unset, empty and none", () => {
    const reads = (value: string | undefined, label = "ari-1") =>
      readsFanslyLiveOverlay(value === undefined ? {} : { fanslyLiveOverlayReadPages: value }, fansly(label));
    expect(reads(undefined)).toBe(false);
    expect(reads("")).toBe(false);
    expect(reads(" , ")).toBe(false);
    expect(reads("none")).toBe(false);
    expect(reads("ari-1")).toBe(true);
    expect(reads(" lilly-1 , ari-1 ")).toBe(true);
    expect(reads("lilly-1")).toBe(false);
    expect(reads("ari")).toBe(false);
    expect(reads("ARI-1")).toBe(false);
    expect(reads("all")).toBe(true);
    expect(reads("all", "lora-3")).toBe(true);
    // The kill-switch wins wherever it is typed.
    expect(reads("ari-1,none")).toBe(false);
    expect(reads("none,all")).toBe(false);
  });

  it("never reads the overlay for a platform without one", () => {
    expect(platformHasLiveOverlay("fansly")).toBe(true);
    expect(platformHasLiveOverlay("onlyfans")).toBe(false);
    expect(readsFanslyLiveOverlay({ fanslyLiveOverlayReadPages: "all" }, { label: "of-1", platform: "onlyfans" }))
      .toBe(false);
    expect(readsFanslyLiveOverlay({ fanslyLiveOverlayReadPages: "of-1" }, { label: "of-1", platform: "onlyfans" }))
      .toBe(false);
  });
});

type StoreRow = { id: string; at: Date | null };
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, seconds));
function overlayRow(id: string, seconds: number, extra: Record<string, unknown> = {}) {
  return {
    platform_message_id: id, platform_conversation_id: "800", sender_platform_user_id: "700",
    sender_role: "fan", created_at: at(seconds), content: `live ${id}`, in_reply_to_message_id: null,
    api_unavailable: false, ...extra,
  };
}

async function union(input: { overlay: Record<string, unknown>[]; store: StoreRow[]; limit: number }) {
  const execute = vi.fn().mockResolvedValue({ rows: input.overlay });
  const filters: Array<{ sql: string; params: unknown[] }> = [];
  const items = await readDmLiveUnion({ execute } as unknown as Database, {
    pageId: 7,
    platformConversationId: "800",
    store: "page_dm_messages",
    limit: input.limit,
    readStore: async (notTombstoned) => {
      filters.push(DIALECT.sqlToQuery(notTombstoned(sql`held.platform_message_id`)));
      return input.store;
    },
    storeKey: (row) => ({ messageId: row.id, at: row.at }),
  });
  return { items, execute, filters };
}
const ids = (items: Awaited<ReturnType<typeof union>>["items"]) =>
  items.map((item) => item.source === "rest" ? `rest:${item.row.id}` : `live:${item.message.platformMessageId}`);

describe("readDmLiveUnion merge", () => {
  it("merges both newest-first lists by instant, then id, and keeps `limit`", async () => {
    const { items, execute } = await union({
      overlay: [overlayRow("106", 50), overlayRow("104", 30), overlayRow("102", 10)],
      store: [{ id: "105", at: at(40) }, { id: "103", at: at(30) }, { id: "101", at: at(0) }],
      limit: 4,
    });
    // Overlay first, then the store (a REST copy committing in between is in both).
    expect(execute).toHaveBeenCalledTimes(1);
    expect(ids(items)).toEqual(["live:106", "rest:105", "live:104", "rest:103"]);
    const live = items[0];
    expect(live).toEqual({ source: "live", message: {
      platformMessageId: "106", platformConversationId: "800", senderPlatformUserId: "700", senderRole: "fan",
      createdAt: at(50), content: "live 106", inReplyToMessageId: null, apiUnavailable: false,
    } });
  });

  it("prefers the REST row when both reads hold the message, and keeps each list's own order", async () => {
    const { items } = await union({
      overlay: [overlayRow("9", 20), overlayRow("10", 20)],
      store: [{ id: "9", at: at(20) }, { id: "x-late", at: null }],
      limit: 10,
    });
    // "10" > "9" numerically at the same instant; the store's null instant sorts last.
    expect(ids(items)).toEqual(["live:10", "rest:9", "rest:x-late"]);
  });

  it("returns the store alone when the overlay has nothing, and the overlay alone when the store is empty", async () => {
    expect(ids((await union({ overlay: [], store: [{ id: "1", at: at(1) }], limit: 5 })).items)).toEqual(["rest:1"]);
    expect(ids((await union({ overlay: [overlayRow("2", 2)], store: [], limit: 5 })).items)).toEqual(["live:2"]);
  });

  it("hands the store reader the socket tombstone predicate for its own column", async () => {
    const { filters, execute } = await union({ overlay: [], store: [], limit: 5 });
    expect(filters).toHaveLength(1);
    const predicate = filters[0]!.sql.replace(/\s+/g, " ");
    expect(predicate).toContain("not exists ( select 1 from dm_live_messages tombstone");
    expect(predicate).toContain("tombstone.platform_message_id = held.platform_message_id");
    expect(predicate).toContain("tombstone.deleted_at is not null");
    expect(filters[0]!.params).toEqual([7]);
    // The overlay arm: this page and chat only, hidden once the store holds the id.
    const overlay = DIALECT.sqlToQuery(execute.mock.calls[0]![0]);
    const text = overlay.sql.replace(/\s+/g, " ");
    expect(text).toContain("join page_dm_threads t");
    expect(text).toContain("m.deleted_at is null");
    expect(text).toContain("m.confirm_outcome is distinct from 'not_found'");
    expect(text).toContain("not exists ( select 1 from page_dm_messages held");
    expect(overlay.params).toEqual(expect.arrayContaining([7, "800", 5]));
  });
});

describe("conversation message contract (additive provenance)", () => {
  const page = {
    id: 1, label: "ari-1", platform: "fansly", username: null, displayName: null,
    followerCount: { value: null, available: false }, subscriberCount: { value: null, available: false },
    lastLightSyncAt: null, lastFollowerSyncAt: null, modelSlug: "ari", modelName: "Ari",
  };
  const conversation = {
    platformConversationId: "800", storedMessageCount: 1, messageCoverageStatus: "complete",
    messageBackfillComplete: true, messageSyncEligibility: "excluded", messageSyncExcludedReason: "x",
    lastMessageSyncAt: null, unreadCount: 0, lastMessageAt: null,
  };
  const item = { messageId: "1", senderRole: "fan", content: "hi", createdAt: "2026-10-01T12:00:00.000Z", tipAmountCents: 0 };

  it("accepts the old shape and both provenances; rejects an unknown source", () => {
    const parse = (messages: unknown[]) => pageConversationMessagesResponseSchema.safeParse({
      page, conversationId: "800", conversation, messages,
    });
    expect(parse([item]).success).toBe(true);
    expect(parse([{ ...item, source: "rest" }]).success).toBe(true);
    expect(parse([{ ...item, source: "live", apiUnavailable: true }]).success).toBe(true);
    expect(parse([{ ...item, source: "socket" }]).success).toBe(false);
    const preview = pageConversationPreviewResponseSchema.safeParse({
      page, fan: null, conversation, messages: [{
        platformMessageId: "1", senderPlatformUserId: "700", senderRole: "fan",
        createdAt: "2026-10-01T12:00:00.000Z", content: "hi", totalTipAmountCents: 0, source: "live", apiUnavailable: false,
      }],
      messageSyncUx: {
        state: "healthy", label: "Up to date", headline: "ready", detail: null, progressLabel: null,
        nextRetryAt: null, updatedAt: null, requiresAction: false,
      },
    });
    expect(preview.success, JSON.stringify(preview.error?.issues)).toBe(true);
  });

  it("is regenerated: the OpenAPI document carries both fields as optional on both routes", () => {
    const document = JSON.parse(readFileSync(new URL("../reference/agency-hub.openapi.json", import.meta.url), "utf8")) as {
      paths: Record<string, { get?: { responses: Record<string, { content: Record<string, { schema: unknown }> }> } }>;
    };
    for (const path of [
      "/api/v1/pages/{pageLabel}/conversations/{conversationId}/messages",
      "/api/v1/pages/{pageLabel}/conversations/{platformConversationId}/preview",
    ]) {
      const schema = document.paths[path]?.get?.responses["200"]?.content["application/json"]?.schema as {
        properties: { messages: { items: { properties: Record<string, unknown>; required: string[] } } };
      };
      const messageItem = schema.properties.messages.items;
      expect(messageItem.properties.source, path).toEqual({ type: "string", enum: ["rest", "live"] });
      expect(messageItem.properties.apiUnavailable, path).toEqual({ type: "boolean" });
      expect(messageItem.required, path).not.toContain("source");
      expect(messageItem.required, path).not.toContain("apiUnavailable");
    }
  });
});
