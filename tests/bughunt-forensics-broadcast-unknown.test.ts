import { describe, expect, it } from "vitest";

import { decodeFanslyWsFrame } from "../apps/runtime/src/sync/fansly/ws/decode.ts";
import { routeWsItems, unknownRouteThread, type RouteContext, type RouteThread } from "../apps/runtime/src/sync/fansly/ws/router.ts";
import { serviceFrame } from "./helpers/fansly-ws-fixtures.ts";

// Bug hunt 2026-10-09 (forensics, FOR-3): an own mass broadcast (type 2, the
// [A6] marker) makes no work in a chat Hub knows (decision №9, design §6.2
// "a misclassified broadcast costs at most ≈ 20 urgent reads"), but in a chat
// Hub has no thread for every recipient's frame becomes a
// `dm-conversations.find` — the unknown-chat branch runs before the
// broadcast check (router.ts routeItem).

const OWN = "100000000000000001";
const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const BOUND: RouteThread = { known: true, bound: true, excluded: false, headConfirmedId: null };

function broadcastFrame(groupId: string, id: bigint): string {
  return serviceFrame({
    type: 1,
    message: {
      id: String(id), groupId, senderId: OWN, createdAt: NOW / 1000 - 1, content: "new set!",
      attachments: [], type: 2, correlationId: "900000000000000001",
    },
  });
}

function context(known: boolean): RouteContext {
  return {
    pageId: 7,
    nowMs: NOW,
    thread: () => (known ? BOUND : unknownRouteThread()),
    knownPendingTransaction: () => false,
    ownBroadcastActive: (item) => item.message.type === 2,
  };
}

describe("FOR-3: an own broadcast to chats Hub does not know", () => {
  it("makes no work in known chats but one find per unknown recipient", () => {
    const recipients = Array.from({ length: 500 }, (_, i) => String(300000000000000000n + BigInt(i)));
    let known = 0;
    let unknown = 0;
    recipients.forEach((groupId, i) => {
      const items = decodeFanslyWsFrame(broadcastFrame(groupId, 400000000000000000n + BigInt(i)), OWN).items;
      known += routeWsItems(items, context(true)).length;
      unknown += routeWsItems(items, context(false)).filter((s) => s.resource === "dm-conversations.find").length;
    });
    expect(known).toBe(0);
    // The design bound is ≈ 20 urgent reads for a misclassified broadcast; a
    // marked one to 500 unknown chats asks for 500 finds (each then a group
    // detail and a head read when the list does not show the chat).
    expect(unknown).toBe(500);
  });
});
