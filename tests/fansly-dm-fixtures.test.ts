import { describe, expect, it } from "vitest";

import { normalizeDmTipAmountCents } from "../apps/runtime/src/sync/fansly/lib/dm-normalize.ts";
import { normalizeFanslyTimestamp } from "../apps/runtime/src/sync/fansly/lib/timestamp.ts";

describe("Fansly DM fixtures", () => {
  it("normalizes Fansly timestamps from seconds and milliseconds at the anomaly boundary", () => {
    expect(normalizeFanslyTimestamp(1_772_616_871).toISOString()).toBe("2026-03-04T09:34:31.000Z");
    expect(normalizeFanslyTimestamp(1_772_616_871_000).toISOString()).toBe("2026-03-04T09:34:31.000Z");
    expect(normalizeFanslyTimestamp(1_000_000_000_000).toISOString()).toBe("2001-09-09T01:46:40.000Z");
  });

  it("normalizes provider DM tip units into stored cents", () => {
    expect(normalizeDmTipAmountCents("fansly", 20000)).toBe(2000);
    expect(normalizeDmTipAmountCents("fansly", 0)).toBe(0);
    expect(normalizeDmTipAmountCents("onlyfans", 125)).toBe(125);
  });
});
