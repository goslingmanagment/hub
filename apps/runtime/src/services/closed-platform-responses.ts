import type { Platform } from "@agency_hub_core/shared";

import type { HumanAuthPrincipal } from "./auth.ts";

/**
 * Telegram pages stay out of the responses whose `platform` is a closed enum
 * (chat-extension Telegram spec §5.4).
 *
 * Every released client (the chat extension before Telegram, fansly-chat, the
 * onlyfans-chat desktop) validates `me`, `GET /pages` and the password login
 * with the zod schemas it shipped with, where `platform` is
 * `"fansly" | "onlyfans"`: one Telegram page in such a list fails the whole
 * answer, and the client stops signing in. So these lists leave Telegram pages
 * out:
 * - `me` and `GET /pages`, for every device token (the dashboard's cookie
 *   session sees every page);
 * - the password login's `user` and the account link's `platforms`, for
 *   everyone: neither is a cookie session's read yet (the dashboard reads its
 *   pages through its cookie `me` right after the login).
 *
 * The filter sits at the response's serialization, never in the principal:
 * `canAccessPage` keeps answering for the Telegram page, so the extension's AI
 * reaches it. The extension takes its pages from the bootstrap, whose
 * `platform` is an open token (older extensions skip a platform they do not
 * know).
 */
const CLOSED_ENUM_PLATFORMS: ReadonlySet<Platform> = new Set(["fansly", "onlyfans"]);

/** Whether a released client's closed platform enum knows this platform. */
export function closedEnumKnowsPlatform(platform: Platform): boolean {
  return CLOSED_ENUM_PLATFORMS.has(platform);
}

/** The items a closed-enum response may carry: only the platforms a released client knows. */
export function withClosedEnumPlatforms<T extends { platform: Platform }>(items: readonly T[]): T[] {
  return items.filter((item) => closedEnumKnowsPlatform(item.platform));
}

/** A device token's view of a page list; a cookie session sees every page. */
export function pagesForPrincipalResponse<T extends { platform: Platform }>(
  principal: Pick<HumanAuthPrincipal, "authMethod">,
  pages: readonly T[],
): T[] {
  return principal.authMethod === "device_token" ? withClosedEnumPlatforms(pages) : [...pages];
}

/** A user record with its page list as a released client can read it. */
export function userForClosedEnum<T extends { assignedPages: readonly { platform: Platform }[] }>(user: T): T {
  return { ...user, assignedPages: withClosedEnumPlatforms(user.assignedPages) };
}
