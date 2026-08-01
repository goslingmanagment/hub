import { describe, expect, it } from "vitest";

import {
  createPageBodySchema,
  updateCredentialsBodySchema,
  verifyCredentialsBodySchema,
} from "@agency_hub_core/contracts";

const session = { authorization: "fansly-token" };
const proxy = { url: "socks5://proxy.example:1080" };

describe("Fansly proxy request contracts", () => {
  it.each([
    ["missing", undefined],
    ["null", null],
  ])("rejects a %s proxy for standalone credentials verification", (_label, candidate) => {
    const body = {
      platform: "fansly",
      session,
      ...(candidate === undefined ? {} : { proxy: candidate }),
    };

    expect(verifyCredentialsBodySchema.safeParse(body).success).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
  ])("rejects a %s proxy when creating a Fansly page", (_label, candidate) => {
    const body = {
      platform: "fansly",
      modelSlug: "lora",
      label: "lora-fansly",
      session,
      ...(candidate === undefined ? {} : { proxy: candidate }),
    };

    expect(createPageBodySchema.safeParse(body).success).toBe(false);
  });

  it("accepts a non-null proxy for standalone Fansly requests", () => {
    expect(verifyCredentialsBodySchema.safeParse({
      platform: "fansly",
      session,
      proxy,
    }).success).toBe(true);
    expect(createPageBodySchema.safeParse({
      platform: "fansly",
      modelSlug: "lora",
      label: "lora-fansly",
      session,
      proxy,
    }).success).toBe(true);
  });

  it("allows proxy omission for session-only PATCH but rejects null removal", () => {
    expect(updateCredentialsBodySchema.safeParse({
      platform: "fansly",
      session,
    }).success).toBe(true);
    expect(updateCredentialsBodySchema.safeParse({
      platform: "fansly",
      session,
      proxy: null,
    }).success).toBe(false);
  });
});
