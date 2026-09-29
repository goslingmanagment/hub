import { describe, expect, it } from "vitest";
import { extractFanslyWsFanMediaMessages } from "../packages/shared/src/fansly-ws-media.ts";
import { serviceFrame, syntheticMessage, wrapped } from "./helpers/fansly-ws-fixtures.ts";

const OWN = "737077689877278720";
const FAN = "700700700";

const created = (message: Record<string, unknown>) => serviceFrame({ type: 1, message });

describe("AI media fast lane signal from durable WS envelopes", () => {
  it("returns a fan's media offers and bundles with ids and the message instant only", () => {
    const frame = created({
      id: "34", groupId: "12", senderId: FAN, createdAt: 1_759_000_000, content: syntheticMessage,
      attachments: [
        { contentType: 1, contentId: "8001", pos: 0 },
        { contentType: 2, contentId: "9001", pos: 1 },
        { contentType: 7, contentId: "tip-1", pos: 2 },
      ],
    });
    const found = extractFanslyWsFanMediaMessages(frame, OWN);
    expect(found).toEqual([{
      groupRef: "12", messageRef: "34", senderRef: FAN, createdAtMs: 1_759_000_000_000,
      attachments: [{ contentType: 1, contentRef: "8001" }, { contentType: 2, contentRef: "9001" }],
    }]);
    expect(JSON.stringify(found)).not.toContain(syntheticMessage);
  });

  it("ignores the page's own messages, tips alone, text and other services", () => {
    for (const frame of [
      created({ id: "34", groupId: "12", senderId: OWN, attachments: [{ contentType: 1, contentId: "8001" }] }),
      created({ id: "34", groupId: "12", senderId: FAN, attachments: [{ contentType: 7, contentId: "1" }] }),
      created({ id: "34", groupId: "12", senderId: FAN, content: "hi" }),
      serviceFrame({ type: 1, message: { id: "34", groupId: "12", senderId: FAN, attachments: [{ contentType: 1, contentId: "8001" }] } }, 6),
    ]) {
      expect(extractFanslyWsFanMediaMessages(frame, OWN)).toEqual([]);
    }
  });

  it("walks batches and keeps millisecond instants as they are", () => {
    const one = created({ id: "1", groupId: "12", senderId: FAN, createdAt: 1_759_000_000_123, attachments: [{ contentType: 1, contentId: "8001" }] });
    const two = created({ id: "2", groupId: "13", senderId: FAN, attachments: [{ contentType: 2, contentId: "9001" }] });
    const batch = wrapped(10001, [JSON.parse(one), JSON.parse(two)]);
    const found = extractFanslyWsFanMediaMessages(batch, OWN);
    expect(found.map((row) => [row.messageRef, row.createdAtMs])).toEqual([["1", 1_759_000_000_123], ["2", null]]);
  });
});
