import { describe, expect, it } from "vitest";

import { CLIENT_CHAT_LENGTH_CHATTERS_MAX } from "@agency_hub_core/contracts";
import type { ClientChatChatterRow, ClientChatLengthRow } from "@agency_hub_core/db";

import { chatAuthorsOf, chatLengthOf } from "../apps/runtime/src/services/client-deleted-messages.ts";

// The chat header's card: how many messages the chat ever had, since when, and
// who wrote them. The chatters always; the fan and the page's unattributed
// messages only beside a proven length, adding up to it.

const ME = 7;
const OLDEST = new Date(Date.UTC(2026, 9, 26, 12, 0));

const thread = (over: Partial<ClientChatLengthRow> = {}): ClientChatLengthRow => ({
  historyState: "complete",
  chainCount: 400,
  afterHead: 15,
  oldestAt: OLDEST,
  ...over,
});

const chatter = (userId: number, username: string, messages: number): ClientChatChatterRow => ({ userId, username, messages });

const total = (authors: ReturnType<typeof chatAuthorsOf>) =>
  authors.fan! + authors.unattributed! + authors.chatters.reduce((sum, row) => sum + row.messages, 0);

describe("chatLengthOf", () => {
  it("answers a proven chat's length, since when, and who wrote it: the fan, the chatters and the rest add up", () => {
    const chat = chatLengthOf("900", thread(), { chatters: [chatter(8, "olga", 80), chatter(ME, "anna", 120)], pageSide: 250 }, ME);
    expect(chat).toEqual({
      conversationRef: "900",
      messages: 415,
      firstMessageAt: OLDEST.toISOString(),
      authors: {
        chatters: [
          { userId: ME, name: "anna", isMe: true, messages: 120 },
          { userId: 8, name: "olga", isMe: false, messages: 80 },
        ],
        fan: 165,
        unattributed: 50,
      },
    });
    expect(total(chat.authors!)).toBe(415);
  });

  it("names the chatters of an unproven chat, but neither its length nor the fan's and the unattributed", () => {
    for (const historyState of ["none", "unverified", "partial"] as const) {
      expect(chatLengthOf("900", thread({ historyState }), { chatters: [chatter(8, "olga", 3)], pageSide: null }, ME)).toEqual({
        conversationRef: "900",
        messages: null,
        firstMessageAt: null,
        authors: { chatters: [{ userId: 8, name: "olga", isMe: false, messages: 3 }], fan: null, unattributed: null },
      });
    }
  });

  it("answers no authors at all in a proven chat nobody reported a send of: everything the page sent is unattributed", () => {
    expect(chatLengthOf("900", thread(), { chatters: [], pageSide: 300 }, ME).authors).toEqual({ chatters: [], fan: 115, unattributed: 300 });
  });
});

describe("chatAuthorsOf", () => {
  it("takes the page's side as at least the chatters' when a send is reported before the archive holds it", () => {
    const authors = chatAuthorsOf(415, { chatters: [chatter(ME, "anna", 120), chatter(8, "olga", 80)], pageSide: 190 }, ME);
    expect(authors).toMatchObject({ fan: 215, unattributed: 0 });
    expect(total(authors)).toBe(415);
  });

  it("never answers a negative count when the archive or the chatters are ahead of the length", () => {
    // The archive holds more of the page's messages than the proven length has in all.
    const archiveAhead = chatAuthorsOf(100, { chatters: [chatter(ME, "anna", 30)], pageSide: 105 }, ME);
    expect(archiveAhead).toMatchObject({ fan: 0, unattributed: 70 });
    expect(total(archiveAhead)).toBe(100);
    // The chatters alone are more than the length.
    expect(chatAuthorsOf(10, { chatters: [chatter(ME, "anna", 12)], pageSide: 4 }, ME)).toMatchObject({ fan: 0, unattributed: 0 });
  });

  it("lists at most the cap, the most messages first and a tie by name; the ones left out count as unattributed", () => {
    const many = Array.from({ length: CLIENT_CHAT_LENGTH_CHATTERS_MAX + 1 }, (_, index) => chatter(100 + index, `user${String(index).padStart(2, "0")}`, 2));
    many.push(chatter(99, "zed", 5), chatter(98, "bob", 5));
    const authors = chatAuthorsOf(1000, { chatters: many, pageSide: 400 }, ME);
    expect(authors.chatters).toHaveLength(CLIENT_CHAT_LENGTH_CHATTERS_MAX);
    expect(authors.chatters.slice(0, 3).map((row) => row.name)).toEqual(["bob", "zed", "user00"]);
    expect(authors.chatters.some((row) => row.name === "user49")).toBe(false);
    const listed = authors.chatters.reduce((sum, row) => sum + row.messages, 0);
    expect(listed).toBe(5 + 5 + 48 * 2);
    expect(authors).toMatchObject({ fan: 600, unattributed: 400 - listed });
    expect(total(authors)).toBe(1000);
  });
});
