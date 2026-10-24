import { describe, expect, it } from "vitest";

import { inConversationOf } from "../apps/runtime/src/services/client-in-conversation.ts";

// «В разговоре» (Chat Memory week 1, plan §3): the mark of a person drops once
// their extension closed after their message; an extension that never beat
// since (an older build) keeps it for the whole 15 minutes.

const at = (minute: number) => new Date(Date.UTC(2026, 9, 26, 18, minute));
const row = (over: Partial<Parameters<typeof inConversationOf>[0][number]>) => ({
  fanRef: "438766025723355136",
  conversationRef: "810272281019305984",
  userId: 27,
  username: "Nikitatest",
  lastSentAt: at(0),
  heardSince: true,
  openNow: true,
  ...over,
});

describe("inConversationOf", () => {
  it("lists every person still talking to a fan, newest first, and marks the caller", () => {
    const fans = inConversationOf([row({}), row({ userId: 30, username: "Ivan-Ari", lastSentAt: at(5) })], 30);
    expect(fans).toEqual([{
      fanRef: "438766025723355136",
      conversationRef: "810272281019305984",
      chatters: [
        { userId: 30, name: "Ivan-Ari", isMe: true, lastSentAt: at(5).toISOString(), until: at(20).toISOString() },
        { userId: 27, name: "Nikitatest", isMe: false, lastSentAt: at(0).toISOString(), until: at(15).toISOString() },
      ],
    }]);
  });

  it("drops a person whose extension closed after their message, and keeps one whose extension never said", () => {
    expect(inConversationOf([row({ heardSince: true, openNow: false })], 30)).toEqual([]);
    expect(inConversationOf([row({ heardSince: false, openNow: false })], 30)).toHaveLength(1);
  });
});
