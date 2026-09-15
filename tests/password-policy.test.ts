import { describe, expect, it } from "vitest";

import {
  COMMON_PASSWORDS,
  LONG_COMMON_PASSWORDS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  checkNewPassword,
  isCommonPassword,
  passwordStem,
} from "../packages/shared/src/password-policy.ts";
import { authRedeemAccountLinkBodySchema } from "../packages/contracts/src/routes.ts";

// Decision 347 §4.2. The floor and the blacklist have to agree: a 12-character
// minimum makes a plain top-1000 almost unreachable, so the rule also matches
// the STEM of a padded word. These cases are the ones a person actually types.

describe("the length rule", () => {
  it("refuses below the floor and above the ceiling, and accepts in between", () => {
    expect(checkNewPassword("short-1")).toBe("too_short");
    expect(checkNewPassword("a".repeat(PASSWORD_MIN_LENGTH - 1))).toBe("too_short");
    expect(checkNewPassword("x".repeat(PASSWORD_MAX_LENGTH + 1))).toBe("too_long");
    expect(checkNewPassword("correct-horse-battery-1")).toBe("ok");
  });

  it("is the same rule the redeem route publishes", () => {
    // If the schema and the policy drift apart, one of them starts lying to the
    // /join page about which passwords are acceptable.
    const password = authRedeemAccountLinkBodySchema.shape.password;
    expect(password.safeParse("a".repeat(PASSWORD_MIN_LENGTH - 1)).success).toBe(false);
    expect(password.safeParse("a".repeat(PASSWORD_MIN_LENGTH)).success).toBe(true);
    expect(password.safeParse("a".repeat(PASSWORD_MAX_LENGTH)).success).toBe(true);
    expect(password.safeParse("a".repeat(PASSWORD_MAX_LENGTH + 1)).success).toBe(false);
  });
});

describe("the blacklist", () => {
  it("refuses a long password that is itself a known one", () => {
    for (const password of [
      "administrator",
      "1qaz2wsx3edc",
      "q1w2e3r4t5y6",
      "123qweasdzxc",
    ]) {
      expect(checkNewPassword(password), password).toBe("common");
    }
  });

  it("refuses a familiar word wearing a numeric tail", () => {
    for (const password of [
      "password1234",
      "iloveyou1234",
      "qwertyuiop12",
      "iloveyou2026!",
      "sunshine1234",
    ]) {
      expect(checkNewPassword(password), password).toBe("common");
    }
  });

  it("normalizes before it looks", () => {
    expect(isCommonPassword("  1QAZ2WSX3EDC  ")).toBe(true);
    expect(isCommonPassword("Password1234")).toBe(true);
  });

  it("lets an ordinary long passphrase through", () => {
    for (const password of [
      "correct-horse-battery-1",
      "lora-vip-shift-2026",
      "grisha-loves-fansly",
      "rhubarb-tangent-99",
    ]) {
      expect(checkNewPassword(password), password).toBe("ok");
    }
  });

  it("does not judge a stem that is only padding", () => {
    // Stripping digits off these leaves nothing worth matching, so the stem
    // path must stay quiet and let the whole-string lists decide.
    expect(passwordStem("123456789012")).toBeNull();
    expect(passwordStem("a1234567890")).toBeNull();
    expect(passwordStem("iloveyou2026!")).toBe("iloveyou");
    expect(passwordStem("password")).toBe("password");
  });
});

describe("the lists themselves", () => {
  it("carries both sources at the size the comment claims", () => {
    expect(COMMON_PASSWORDS.size).toBe(994);
    expect(LONG_COMMON_PASSWORDS.size).toBe(1000);
  });

  it("keeps every long entry actually reachable through this form", () => {
    // The whole point of the second list: an entry shorter than the floor can
    // never be submitted, so a list of those would be decoration.
    for (const entry of LONG_COMMON_PASSWORDS) {
      expect(entry.length, entry).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH);
      expect(entry, entry).toBe(entry.trim().toLowerCase());
    }
  });

  it("keeps the short list complete — it is the stem catalogue, not a password list", () => {
    expect(COMMON_PASSWORDS.has("password")).toBe(true);
    expect(COMMON_PASSWORDS.has("iloveyou")).toBe(true);
    expect(COMMON_PASSWORDS.has("qwertyuiop")).toBe(true);
    const long = [...COMMON_PASSWORDS].filter((entry) => entry.length >= PASSWORD_MIN_LENGTH);
    expect(long.length).toBeLessThan(COMMON_PASSWORDS.size / 10);
  });
});
