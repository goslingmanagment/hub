// Arena plan §7 «Стирание» (R4, PR10): the page-less kinds the fan erasure
// reaches by kind are the kinds the observation registry knows, so the R5
// writer and the erasure cannot disagree about a literal. The erasure itself is
// proved against a real database in
// tests/erasure-pageless-observations.integration.test.ts.

import { describe, expect, it } from "vitest";

import {
  ACCOUNT_LOOKUP_PUBLIC_OBSERVATION_KIND,
  PAGELESS_FAN_OBSERVATION_KINDS,
} from "../apps/runtime/src/services/erasure/index.ts";
import {
  claimObservationKind,
  WRITTEN_OBSERVATION_KINDS,
} from "../apps/runtime/src/services/observation-kinds.ts";

describe("page-less observation kinds the fan erasure reaches", () => {
  it("lists the public reader's kind under Fansly, as a registered pull kind", () => {
    expect(ACCOUNT_LOOKUP_PUBLIC_OBSERVATION_KIND).toBe("account_lookup_public");
    expect(PAGELESS_FAN_OBSERVATION_KINDS.fansly.map((entry) => entry.kind))
      .toContain(ACCOUNT_LOOKUP_PUBLIC_OBSERVATION_KIND);
    expect(PAGELESS_FAN_OBSERVATION_KINDS.onlyfans).toEqual([]);
    const entry = WRITTEN_OBSERVATION_KINDS.find((item) => item.kind === ACCOUNT_LOOKUP_PUBLIC_OBSERVATION_KIND);
    expect(entry?.source).toBe("pull");
  });

  it("every listed kind is one the registry owns — statically, or as its writer's `:failed` body", () => {
    for (const [platform, listed] of Object.entries(PAGELESS_FAN_OBSERVATION_KINDS)) {
      for (const item of listed) {
        const label = `${platform}:${item.kind}`;
        const base = item.kind.endsWith(":failed") ? item.kind.slice(0, -":failed".length) : item.kind;
        const registered = WRITTEN_OBSERVATION_KINDS.find((row) => row.kind === base);
        expect(registered, `${label}: not in WRITTEN_OBSERVATION_KINDS`).toBeDefined();
        expect(
          claimObservationKind({ ...registered!, kind: item.kind }),
          `${label}: a written kind must be owned`,
        ).toMatchObject({ claimed: true });
        expect(item.writer.length, label).toBeGreaterThan(0);
      }
      expect(new Set(listed.map((item) => item.kind)).size, platform).toBe(listed.length);
    }
  });
});
