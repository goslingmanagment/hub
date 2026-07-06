import { describe, expect, it } from "vitest";

import {
  normalizeOnlyFansAvatarUrl,
  resolveOnlyFansDisplayName,
} from "../apps/runtime/src/services/onlyfans.ts";

const PUBLIC_ONLYFANS_AVATAR_URL = "https://public.onlyfans.com/files/lora/avatar.jpg";
const SIGNED_ONLYFANS_AVATAR_URL =
  "https://public.onlyfans.com/files/lora/avatar.jpg?Policy=ip-locked&Signature=sig&Key-Pair-Id=key";

describe("OnlyFans metadata helpers", () => {
  it("keeps only portable OnlyFans avatar URLs", () => {
    expect(normalizeOnlyFansAvatarUrl(PUBLIC_ONLYFANS_AVATAR_URL))
      .toBe(PUBLIC_ONLYFANS_AVATAR_URL);

    // Non-OnlyFans hosts, signed (expiring) URLs, and non-https schemes are
    // all unportable — they must never land in page metadata.
    expect(normalizeOnlyFansAvatarUrl("https://images.example/lora.png")).toBe(null);
    expect(normalizeOnlyFansAvatarUrl(SIGNED_ONLYFANS_AVATAR_URL)).toBe(null);
    expect(normalizeOnlyFansAvatarUrl("http://public.onlyfans.com/files/lora/avatar.jpg")).toBe(null);
    expect(normalizeOnlyFansAvatarUrl("not a url")).toBe(null);
    expect(normalizeOnlyFansAvatarUrl("")).toBe(null);
    expect(normalizeOnlyFansAvatarUrl(null)).toBe(null);
  });

  it("preserves existing rich display names when the source falls back to username", () => {
    expect(resolveOnlyFansDisplayName(
      { name: "loravie", username: "loravie" },
      { displayName: "Lora Free", username: "loravie" },
    )).toBe("Lora Free");

    expect(resolveOnlyFansDisplayName(
      { name: "Lora VIP", username: "loravievip" },
      { displayName: "Lora Free", username: "loravie" },
    )).toBe("Lora VIP");
  });

  it("falls back to the incoming name, then username, when nothing richer exists", () => {
    expect(resolveOnlyFansDisplayName(
      { name: "lora_of", username: "lora_of" },
      { displayName: null, username: "lora_of" },
    )).toBe("lora_of");

    expect(resolveOnlyFansDisplayName(
      { name: null, username: "lora_of" },
    )).toBe("lora_of");
  });
});
