import { describe, expect, it } from "vitest";

import {
  buildMessagesUrl,
  buildProfileUrl,
  resolveExternalLink,
} from "../apps/dashboard/src/lib/platformUrls.ts";

// Pre-deploy audit B6 regression: copy-link buttons built fansly.com URLs for
// every page, so an OnlyFans page copied a fansly.com link to an OnlyFans
// conversation id.
describe("platform-aware external URLs", () => {
  it("builds Fansly URLs for Fansly pages", () => {
    expect(buildProfileUrl("fansly", "nymanoreus69")).toBe("https://fansly.com/nymanoreus69");
    expect(buildMessagesUrl("fansly", "797139409953628160"))
      .toBe("https://fansly.com/messages/797139409953628160");
  });

  it("builds OnlyFans URLs for OnlyFans pages", () => {
    expect(buildProfileUrl("onlyfans", "lora_of")).toBe("https://onlyfans.com/lora_of");
    expect(buildMessagesUrl("onlyfans", "123456789"))
      .toBe("https://onlyfans.com/my/chats/chat/123456789/");
  });

  it("prefers the chat link and falls back to the profile per platform", () => {
    expect(resolveExternalLink("onlyfans", {
      platformConversationId: "42",
      username: "lora_of",
    })).toEqual({ url: "https://onlyfans.com/my/chats/chat/42/", kind: "chat" });

    expect(resolveExternalLink("onlyfans", {
      platformConversationId: null,
      username: "lora_of",
    })).toEqual({ url: "https://onlyfans.com/lora_of", kind: "profile" });

    expect(resolveExternalLink("fansly", {
      platformConversationId: null,
      username: "  ",
    })).toBeNull();
  });

  it("URL-encodes identifiers", () => {
    expect(buildProfileUrl("onlyfans", "fan name")).toBe("https://onlyfans.com/fan%20name");
    expect(buildMessagesUrl("fansly", "id/../x")).toBe("https://fansly.com/messages/id%2F..%2Fx");
  });
});
