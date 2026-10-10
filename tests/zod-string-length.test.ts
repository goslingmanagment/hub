import { describe, expect, it } from "vitest";
import { z } from "zod";

import { authRedeemAccountLinkBodySchema, routeSchemas } from "../packages/contracts/src/index.ts";
import { checkNewPassword } from "../packages/shared/src/password-policy.ts";

// zod 4.5 began measuring strings in Unicode code points. This API has always
// measured UTF-16 code units: zod 4.3, String.prototype.length and the shared
// password policy the dashboard checks against. patches/zod@4.6.5.patch keeps
// the units; this file fails if a zod upgrade drops or outgrows the patch.

/** One code point, two UTF-16 units. */
const EMOJI = "😀";

describe("zod string lengths", () => {
  it("count UTF-16 code units in min, max and length", () => {
    expect(EMOJI.length).toBe(2);
    expect(z.string().min(2).safeParse(EMOJI).success).toBe(true);
    expect(z.string().max(1).safeParse(EMOJI).success).toBe(false);
    expect(z.string().length(2).safeParse(EMOJI).success).toBe(true);
    expect(z.string().length(1).safeParse(EMOJI).success).toBe(false);
  });

  it("count them the same in an object's compiled parser", () => {
    const schema = z.object({ q: z.string().min(2).max(3) });
    expect(schema.safeParse({ q: EMOJI }).success).toBe(true);
    expect(schema.safeParse({ q: EMOJI + EMOJI }).success).toBe(false);
  });

  it("report an overlong string with zod's own issue", () => {
    const result = z.string().max(1).safeParse(EMOJI);
    expect(result.error?.issues[0]).toMatchObject({ code: "too_big", origin: "string", maximum: 1 });
  });

  it("keep the API's bounds where astral input meets them", () => {
    // A one-emoji archive search passes, as before zod 4.5.
    expect(routeSchemas.archiveSearch.querystring.safeParse({ q: EMOJI }).success).toBe(true);
    // Six emoji are 12 units: the shared policy and the schema both accept them.
    const password = EMOJI.repeat(6);
    expect(checkNewPassword(password)).toBe("ok");
    expect(authRedeemAccountLinkBodySchema.safeParse({ token: "t", password }).success).toBe(true);
    // 129 emoji are 258 units, over the 256 maximum of both.
    const overlong = EMOJI.repeat(129);
    expect(checkNewPassword(overlong)).toBe("too_long");
    expect(authRedeemAccountLinkBodySchema.safeParse({ token: "t", password: overlong }).success).toBe(false);
  });
});
