// Arena plan §7 «Стирание» (R4, PR10): the page-less kinds the fan erasure
// reaches by kind. The erasure itself is proved against a real database in
// tests/erasure-pageless-observations.integration.test.ts.

import { describe, expect, it } from "vitest";

import {
  ACCOUNT_LOOKUP_PUBLIC_OBSERVATION_KIND,
  PAGELESS_FAN_OBSERVATION_KINDS,
} from "../apps/runtime/src/services/erasure/index.ts";

describe("page-less observation kinds the fan erasure reaches", () => {
  it("lists the public reader's kind under Fansly", () => {
    expect(ACCOUNT_LOOKUP_PUBLIC_OBSERVATION_KIND).toBe("account_lookup_public");
    expect(PAGELESS_FAN_OBSERVATION_KINDS.fansly.map((entry) => entry.kind))
      .toContain(ACCOUNT_LOOKUP_PUBLIC_OBSERVATION_KIND);
    expect(PAGELESS_FAN_OBSERVATION_KINDS.onlyfans).toEqual([]);
  });

  it("every listed kind names its writer and appears once", () => {
    for (const [platform, listed] of Object.entries(PAGELESS_FAN_OBSERVATION_KINDS)) {
      for (const item of listed) {
        const label = `${platform}:${item.kind}`;
        expect(item.writer.length, label).toBeGreaterThan(0);
      }
      expect(new Set(listed.map((item) => item.kind)).size, platform).toBe(listed.length);
    }
  });
});
