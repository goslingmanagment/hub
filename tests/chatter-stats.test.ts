import { describe, expect, it } from "vitest";

import { settleSale, streaksOf } from "../apps/runtime/src/services/chatter-stats.ts";

// Whose a sale is when two shifts hold it: who last wrote to the fan; neither — both.
describe("settleSale", () => {
  const ME = 1;
  const COLLEAGUE = 2;

  it("is mine when no other shift holds it, whoever wrote", () => {
    expect(settleSale(ME, [], null)).toBe("mine");
    expect(settleSale(ME, [], COLLEAGUE)).toBe("mine");
  });

  it("is mine when two shifts hold it and I wrote last", () => {
    expect(settleSale(ME, [COLLEAGUE], ME)).toBe("mine");
  });

  it("is the colleague's when two shifts hold it and they wrote last", () => {
    expect(settleSale(ME, [COLLEAGUE], COLLEAGUE)).toBe("theirs");
  });

  it("is both of ours when neither of us wrote", () => {
    expect(settleSale(ME, [COLLEAGUE], null)).toBe("both");
    expect(settleSale(ME, [COLLEAGUE], 3)).toBe("both");
  });

  // The owner, 2026-11-08: from 02.11 a PPV is its sender's whoever's shift it came in, a post tip or a Campaign
  // contribution the общак.
  it("gives a PPV to its sender, whoever's shift holds it and whoever wrote last", () => {
    const mineSent = { ppvSender: { userId: ME, username: "me" }, common: null };
    const theirsSent = { ppvSender: { userId: COLLEAGUE, username: "colleague" }, common: null };
    expect(settleSale(ME, [], ME, theirsSent)).toBe("theirs");
    expect(settleSale(ME, [COLLEAGUE], COLLEAGUE, mineSent)).toBe("mine");
    expect(settleSale(ME, [COLLEAGUE], null, mineSent)).toBe("mine");
  });

  it("gives the общак to no shift", () => {
    expect(settleSale(ME, [], ME, { ppvSender: null, common: "post_tip" })).toBe("common");
    expect(settleSale(ME, [COLLEAGUE], ME, { ppvSender: null, common: "campaign" })).toBe("common");
  });

  it("settles by the old rule what the team's rule says nothing of", () => {
    expect(settleSale(ME, [COLLEAGUE], COLLEAGUE, { ppvSender: null, common: null })).toBe("theirs");
  });
});

describe("streaksOf", () => {
  const days = new Set(["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);

  it("counts the days in a row up to today", () => {
    expect(streaksOf(days, "2026-11-02")).toEqual({ current: 4, longest: 4 });
  });

  it("keeps the run while today has no shift yet", () => {
    expect(streaksOf(days, "2026-11-03")).toEqual({ current: 4, longest: 4 });
  });

  it("is broken by a whole day without a shift", () => {
    expect(streaksOf(days, "2026-11-04")).toEqual({ current: 0, longest: 4 });
    expect(streaksOf(new Set(), "2026-11-04")).toEqual({ current: 0, longest: 0 });
  });
});
