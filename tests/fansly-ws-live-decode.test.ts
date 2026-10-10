import { describe, expect, it } from "vitest";
import {
  decodeFanslyWsLiveFrame, FANSLY_WS_LIVE_DECODER_VERSION, FANSLY_WS_LIVE_FIELD, FANSLY_WS_MAX_FRAME_BYTES,
} from "@agency_hub_core/shared";
import { judgeDmLiveParity, type DmLiveParityRow } from "@agency_hub_core/db";
import { serviceFrame, wrapped } from "./helpers/fansly-ws-fixtures.ts";

const created = (message: Record<string, unknown>) => serviceFrame({ type: 1, message });
const full = {
  id: "900000000000000001", groupId: "800000000000000001", senderId: "700000000000000001",
  createdAt: 1790599288.773, content: "hello", inReplyTo: "900000000000000000", inReplyToRoot: null,
  attachments: [{ contentType: 1, contentId: "600000000000000001", location: "https://cdn.example.test/x" },
    { contentType: 7, contentId: "600000000000000002", amount: 500 }],
  type: 1, correlationId: "500000000000000001", totalTipAmount: 500, embeds: [],
};

describe("Fansly live overlay decoder (plan §7.2–7.3)", () => {
  it("reads the socket-only fields of a message created frame, ids only, no money", () => {
    const decoded = decodeFanslyWsLiveFrame(created(full));
    expect(decoded.decoderVersion).toBe(FANSLY_WS_LIVE_DECODER_VERSION);
    expect(decoded.items).toEqual([{ kind: "message_created", path: [], message: {
      id: full.id, groupId: full.groupId, senderId: full.senderId, createdAtMs: 1790599288773,
      content: "hello", inReplyTo: full.inReplyTo, inReplyToRoot: null,
      attachments: [{ contentType: 1, contentId: "600000000000000001" }, { contentType: 7, contentId: "600000000000000002" }],
      type: 1, correlationId: full.correlationId,
      fieldMask: Object.values(FANSLY_WS_LIVE_FIELD).reduce((mask, bit) => mask | bit, 0),
    } }]);
    // No URL, amount or tip total escapes the decoder.
    const text = JSON.stringify(decoded);
    expect(text).not.toContain("cdn.example.test");
    expect(text).not.toContain("500,");
    expect(text).not.toMatch(/amount|totalTip/i);
  });

  it("records which optional fields were absent instead of inventing empties", () => {
    const decoded = decodeFanslyWsLiveFrame(created({
      id: full.id, groupId: full.groupId, senderId: full.senderId, createdAt: 1790599288,
    }));
    expect(decoded.items).toEqual([{ kind: "message_created", path: [], message: expect.objectContaining({
      content: null, inReplyTo: null, attachments: [], type: null, correlationId: null, fieldMask: 0,
      createdAtMs: 1790599288000,
    }) }]);
  });

  it.each([
    ["id", "message_id"], ["groupId", "group_id"], ["senderId", "sender_id"], ["createdAt", "created_at"],
  ])("a frame without %s is invalid (%s), never a partial row", (field, reason) => {
    const message: Record<string, unknown> = { ...full };
    delete message[field];
    expect(decodeFanslyWsLiveFrame(created(message)).items).toEqual([{ kind: "invalid", path: [], reason }]);
  });

  it.each([["a string time", { createdAt: "1790599288" }], ["a non-numeric sender", { senderId: 7 }],
    ["an id with letters", { id: "9x" }]])("rejects %s", (_label, patch) => {
    expect(decodeFanslyWsLiveFrame(created({ ...full, ...patch })).items[0]?.kind).toBe("invalid");
  });

  it("keeps socket text storable: an unpaired surrogate or a NUL becomes U+FFFD, a whole emoji stays", () => {
    // Fansly sends text as JSON, so a fan's broken emoji arrives as a lone
    // `\ud83d` escape that jsonb refuses, and a NUL as `\u0000` that text refuses.
    const content = (text: string) => {
      const [item] = decodeFanslyWsLiveFrame(created({ ...full, content: text })).items;
      return item?.kind === "message_created" ? item.message.content : undefined;
    };
    // The captured frame itself holds only the escape, so capture accepts it.
    expect(created({ ...full, content: "love you \ud83d" })).not.toMatch(/[\uD800-\uDFFF]/);
    expect(content("love you \ud83d")).toBe("love you �");
    expect(content("\udc00 low first")).toBe("� low first");
    expect(content("nul\u0000byte")).toBe("nul�byte");
    expect(content("whole 🥰 pair")).toBe("whole 🥰 pair");
  });

  it("keeps the message type within the overlay's integer column; past it the type is absent", () => {
    for (const type of [2 ** 31, -(2 ** 31) - 1, 1.5]) {
      expect(decodeFanslyWsLiveFrame(created({ ...full, type })).items).toEqual([{ kind: "message_created", path: [],
        message: expect.objectContaining({ type: null, fieldMask: expect.any(Number) }) }]);
    }
    const [edge] = decodeFanslyWsLiveFrame(created({ ...full, type: 2 ** 31 - 1 })).items;
    expect(edge).toMatchObject({ message: { type: 2 ** 31 - 1 } });
    const [absent] = decodeFanslyWsLiveFrame(created({ ...full, type: 2 ** 31 })).items;
    // The frame carried the field: the mask says so, the value is unknown.
    expect(absent?.kind === "message_created" && absent.message.fieldMask & FANSLY_WS_LIVE_FIELD.type)
      .toBe(FANSLY_WS_LIVE_FIELD.type);
  });

  it("reads deletions with or without a group, and other services as not-a-message", () => {
    const frame = wrapped(10001, [
      serviceFrame({ type: 10, message: { id: "11", groupId: "22", type: 3 } }),
      serviceFrame({ type: 10, message: { id: "12" } }),
      serviceFrame({ type: 10, message: { groupId: "22" } }),
      serviceFrame({ type: 8, id: "33" }, 4),
      serviceFrame({ type: 2, transaction: { amount: 900 } }, 6),
      { t: 1, excluded: true },
      "not json",
    ]);
    expect(decodeFanslyWsLiveFrame(frame).items).toEqual([
      { kind: "message_deleted", path: [0], messageId: "11", groupId: "22" },
      { kind: "message_deleted", path: [1], messageId: "12", groupId: null },
      { kind: "invalid", path: [2], reason: "message_id" },
      { kind: "other", path: [3] },
      { kind: "other", path: [4] },
      { kind: "other", path: [5] },
      { kind: "invalid", path: [6], reason: "envelope" },
    ]);
  });

  it("walks nested batches within the hint extractor's bounds", () => {
    const one = created(full);
    let nested = one;
    for (let depth = 0; depth < 10; depth++) nested = wrapped(10001, [nested]);
    const deep = decodeFanslyWsLiveFrame(nested).items;
    expect(deep).toHaveLength(1);
    expect(deep[0]).toMatchObject({ kind: "limit" });
    const wide = decodeFanslyWsLiveFrame(wrapped(10001, Array.from({ length: 400 }, () => one))).items;
    expect(wide.filter((item) => item.kind === "message_created")).toHaveLength(254);
    expect(wide.at(-1)).toMatchObject({ kind: "limit" });
    expect(decodeFanslyWsLiveFrame(" ".repeat(FANSLY_WS_MAX_FRAME_BYTES + 1)).items).toEqual([{ kind: "limit", path: [] }]);
  });
});

describe("passive parity verdict", () => {
  const base: DmLiveParityRow = {
    page_id: "1", platform_message_id: "9", platform_conversation_id: "22", sender_platform_user_id: "7",
    is_sent_by_page: false, created_at: new Date("2026-10-01T10:00:00.400Z"), content: "hi <b>there</b>",
    in_reply_to_message_id: "8", field_mask: FANSLY_WS_LIVE_FIELD.content | FANSLY_WS_LIVE_FIELD.inReplyTo,
    age_ms: "60000",
    hot_found: false, hot_content: null, hot_sender: null, hot_created_at: null, hot_reply: null, hot_group: null,
    arc_found: false, arc_text: null, arc_sent_by_me: null, arc_occurred_at: null, arc_reply: null, arc_group: null,
    arc_content_pending: null, excluded: false,
  };
  const hot = { hot_found: true, hot_content: "hi <b>there</b>", hot_sender: "7",
    hot_created_at: new Date("2026-10-01T10:00:00.000Z"), hot_reply: "8", hot_group: "22" };

  it("matches the REST hot row field by field, within one second of time", () => {
    expect(judgeDmLiveParity({ ...base, ...hot }, 3_600_000))
      .toEqual({ outcome: "match", source: "page_dm_messages", fields: [], waitReason: null });
  });

  it("names every mismatched field", () => {
    expect(judgeDmLiveParity({ ...base, ...hot, hot_content: "other", hot_sender: "6",
      hot_created_at: new Date("2026-10-01T10:00:02.000Z"), hot_reply: null, hot_group: "23" }, 3_600_000))
      .toEqual({ outcome: "mismatch", source: "page_dm_messages", fields: ["text", "sender", "time", "group", "reply"], waitReason: null });
  });

  it("compares the archive through its own text normalization and skips what it never observed", () => {
    expect(judgeDmLiveParity({ ...base, arc_found: true, arc_text: "hi there", arc_sent_by_me: false,
      arc_occurred_at: new Date("2026-10-01T10:00:00.000Z"), arc_reply: null, arc_group: "22",
      arc_content_pending: false }, 3_600_000)).toEqual({ outcome: "match", source: "message_archive", fields: [], waitReason: null });
    expect(judgeDmLiveParity({ ...base, arc_found: true, arc_text: "", arc_sent_by_me: true,
      arc_occurred_at: null, arc_reply: null, arc_group: null, arc_content_pending: true }, 3_600_000))
      .toEqual({ outcome: "mismatch", source: "message_archive", fields: ["sender"], waitReason: null });
  });

  it("judges a deletion stub by the chat, side and send time it carries: the socket's own facts match; the old chatless stub of an own message did not", () => {
    const own = { ...base, is_sent_by_page: true, sender_platform_user_id: "3" };
    const stub = { arc_found: true, arc_text: "", arc_reply: null, arc_content_pending: true };
    expect(judgeDmLiveParity({ ...own, ...stub, arc_group: "22", arc_sent_by_me: true,
      arc_occurred_at: own.created_at }, 3_600_000))
      .toEqual({ outcome: "match", source: "message_archive", fields: [], waitReason: null });
    expect(judgeDmLiveParity({ ...own, ...stub, arc_group: null, arc_sent_by_me: false,
      arc_occurred_at: new Date("2026-10-01T10:00:05.400Z") }, 3_600_000))
      .toEqual({ outcome: "mismatch", source: "message_archive", fields: ["sender", "time"], waitReason: null });
  });

  it("never scores a field the socket did not carry", () => {
    expect(judgeDmLiveParity({ ...base, ...hot, field_mask: 0, hot_content: "other", hot_reply: "1" }, 3_600_000))
      .toEqual({ outcome: "match", source: "page_dm_messages", fields: [], waitReason: null });
  });

  it("waits inside the window, then defers the row without a verdict (never not_found), or reports excluded chats apart", () => {
    expect(judgeDmLiveParity(base, 3_600_000)).toEqual({ outcome: null, source: null, fields: [], waitReason: null });
    expect(judgeDmLiveParity({ ...base, age_ms: "3600000" }, 3_600_000))
      .toEqual({ outcome: null, source: null, fields: [], waitReason: "age_without_rest" });
    expect(judgeDmLiveParity({ ...base, age_ms: "3600000", excluded: true }, 3_600_000))
      .toEqual({ outcome: "excluded", source: null, fields: [], waitReason: null });
    // A copy that arrives after the window still settles the row.
    expect(judgeDmLiveParity({ ...base, ...hot, age_ms: "7200000" }, 3_600_000))
      .toEqual({ outcome: "match", source: "page_dm_messages", fields: [], waitReason: null });
  });
});
