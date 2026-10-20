import { describe, expect, it } from "vitest";

import { resolveSpenderStatsWindows } from "@agency_hub_core/shared";

import {
  spenderStatsCacheKey,
} from "../apps/runtime/src/services/spender-stats.ts";

// chat-extension H-8b: the per-process cache in front of the Spenders
// statistics read. 60 seconds, one load per key at a time, a bounded number of
// keys. Who may ask is not its business: the route checks that first, on every
// request (tests/client-spender-stats-route.integration.test.ts).

const T0 = Date.parse("2026-10-03T12:00:00.000Z");

describe("spenderStatsCacheKey", () => {
  /** The window a caller of `timeZone` is answered for at `asOf`: what the route keys an answer by. */
  const windowsOf = (timeZone: string, asOf = new Date(T0)) => resolveSpenderStatsWindows({ asOf, timeZone });
  const base = {
    pageId: 7,
    windows: windowsOf("Europe/Moscow"),
    messageSource: "archive",
    projectionAsOf: new Date("2026-10-03T11:00:00.000Z"),
  } as const;

  it("changes with everything an answer depends on besides the clock", () => {
    const variants = [
      base,
      { ...base, pageId: 8 },
      // Another zone: other instants.
      { ...base, windows: windowsOf("UTC") },
      // The local date turned (midnight in Moscow is 21:00Z): the window moved a day.
      { ...base, windows: windowsOf("Europe/Moscow", new Date("2026-10-03T21:00:00.000Z")) },
      // A whole day apart: the dates start at the same instants and are not the same dates.
      { ...base, windows: windowsOf("Pacific/Kiritimati") },
      { ...base, windows: windowsOf("Pacific/Honolulu") },
      // The owner flips the AI transcript to the union: silence reads other messages.
      { ...base, messageSource: "union" as const },
      // A transaction was written and the projection rebuilt: the answer is new at once.
      { ...base, projectionAsOf: new Date("2026-10-03T11:00:00.001Z") },
      { ...base, projectionAsOf: null },
    ];
    const keys = variants.map((variant) => spenderStatsCacheKey(variant));
    expect(new Set(keys).size).toBe(variants.length);
    expect(spenderStatsCacheKey({ ...base })).toBe(keys[0]);
    // The clock itself is not in the key: later the same local date is the same answer.
    expect(spenderStatsCacheKey({ ...base, windows: windowsOf("Europe/Moscow", new Date(T0 + 59_000)) })).toBe(keys[0]);
    expect(spenderStatsCacheKey({ ...base, windows: windowsOf("Europe/Moscow", new Date("2026-10-03T20:59:59.999Z")) }))
      .toBe(keys[0]);

    // The premise of the Kiritimati and Honolulu pair: 24 hours apart, so only the dates tell them apart.
    const [kiritimati, honolulu] = [windowsOf("Pacific/Kiritimati"), windowsOf("Pacific/Honolulu")];
    expect(kiritimati.dateStarts).toEqual(honolulu.dateStarts);
    expect(kiritimati.end).toEqual(honolulu.end);
    expect(kiritimati.dates).not.toEqual(honolulu.dates);
  });
});
