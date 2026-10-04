import { describe, expect, it } from "vitest";

import {
  KeyedLoadCache,
  SPENDER_STATS_CACHE_MAX_ENTRIES,
  SPENDER_STATS_CACHE_TTL_MS,
  spenderStatsCacheKey,
} from "../apps/runtime/src/services/spender-stats.ts";

// chat-extension H-8b: the per-process cache in front of the Spenders
// statistics read. 60 seconds, one load per key at a time, a bounded number of
// keys. Who may ask is not its business: the route checks that first, on every
// request (tests/client-spender-stats-route.integration.test.ts).

const T0 = Date.parse("2026-10-03T12:00:00.000Z");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function counting() {
  let loads = 0;
  return {
    get loads() {
      return loads;
    },
    load: (value: string) => () => {
      loads += 1;
      return Promise.resolve(value);
    },
  };
}

describe("KeyedLoadCache", () => {
  it("serves an answer again until it is 60 seconds old, then loads a new one", async () => {
    expect(SPENDER_STATS_CACHE_TTL_MS).toBe(60_000);
    const cache = new KeyedLoadCache<string>({ ttlMs: 60_000, maxEntries: 10 });
    const counter = counting();

    expect(await cache.get("page", T0, counter.load("first"))).toBe("first");
    expect(await cache.get("page", T0 + 1, counter.load("second"))).toBe("first");
    expect(await cache.get("page", T0 + 59_999, counter.load("second"))).toBe("first");
    expect(counter.loads).toBe(1);

    expect(await cache.get("page", T0 + 60_000, counter.load("second"))).toBe("second");
    expect(counter.loads).toBe(2);
    // The age is counted from when the load began, which is the instant the answer is of.
    expect(await cache.get("page", T0 + 119_999, counter.load("third"))).toBe("second");
    expect(await cache.get("page", T0 + 120_000, counter.load("third"))).toBe("third");
    expect(counter.loads).toBe(3);
  });

  it("keeps keys apart", async () => {
    const cache = new KeyedLoadCache<string>({ ttlMs: 60_000, maxEntries: 10 });
    const counter = counting();

    expect(await cache.get("a", T0, counter.load("for a"))).toBe("for a");
    expect(await cache.get("b", T0, counter.load("for b"))).toBe("for b");
    expect(await cache.get("a", T0 + 1, counter.load("again"))).toBe("for a");
    expect(counter.loads).toBe(2);
  });

  it("joins callers that ask while a key is being loaded: one load, one answer", async () => {
    const cache = new KeyedLoadCache<string>({ ttlMs: 60_000, maxEntries: 10 });
    const pending = deferred<string>();
    let loads = 0;
    const load = () => {
      loads += 1;
      return pending.promise;
    };

    const first = cache.get("page", T0, load);
    const second = cache.get("page", T0 + 5, load);
    // A load that runs past the 60 seconds is still joined, not started again.
    const late = cache.get("page", T0 + 90_000, load);
    expect(loads).toBe(1);

    pending.resolve("answer");
    expect(await Promise.all([first, second, late])).toEqual(["answer", "answer", "answer"]);
    expect(loads).toBe(1);
  });

  it("does not keep a failed load: everyone waiting gets the error, the next caller loads again", async () => {
    const cache = new KeyedLoadCache<string>({ ttlMs: 60_000, maxEntries: 10 });
    const pending = deferred<string>();
    const failing = () => pending.promise;

    const first = cache.get("page", T0, failing);
    const second = cache.get("page", T0, failing);
    pending.reject(new Error("the database is away"));
    await expect(first).rejects.toThrow("the database is away");
    await expect(second).rejects.toThrow("the database is away");
    expect(cache.size).toBe(0);

    expect(await cache.get("page", T0 + 1, () => Promise.resolve("recovered"))).toBe("recovered");
    expect(cache.size).toBe(1);
  });

  it("takes a load that throws before its first await as a failed load, not as a throw of its own", async () => {
    const cache = new KeyedLoadCache<string>({ ttlMs: 60_000, maxEntries: 10 });
    const answer = cache.get("page", T0, () => {
      throw new RangeError("not a zone");
    });
    await expect(answer).rejects.toThrow("not a zone");
    expect(cache.size).toBe(0);
    expect(await cache.get("page", T0, () => Promise.resolve("recovered"))).toBe("recovered");
  });

  it("holds a bounded number of keys: expired answers go first, then the oldest", async () => {
    expect(SPENDER_STATS_CACHE_MAX_ENTRIES).toBe(500);
    const cache = new KeyedLoadCache<string>({ ttlMs: 60_000, maxEntries: 3 });
    const counter = counting();

    await cache.get("a", T0, counter.load("a"));
    await cache.get("b", T0 + 10, counter.load("b"));
    await cache.get("c", T0 + 20, counter.load("c"));
    expect(cache.size).toBe(3);

    // A fourth key within the 60 seconds: the oldest key goes.
    await cache.get("d", T0 + 30, counter.load("d"));
    expect(cache.size).toBe(3);
    expect(await cache.get("b", T0 + 40, counter.load("b again"))).toBe("b");
    expect(await cache.get("a", T0 + 40, counter.load("a again"))).toBe("a again");
    expect(cache.size).toBe(3);

    // A miss sweeps every expired answer, whatever the size: here all but the new key.
    await cache.get("e", T0 + 200_000, counter.load("e"));
    expect(cache.size).toBe(1);
    expect(await cache.get("e", T0 + 200_001, counter.load("e again"))).toBe("e");
  });

  it("never grows past the bound under a stream of new keys", async () => {
    const cache = new KeyedLoadCache<number>({ ttlMs: 60_000, maxEntries: 50 });
    for (let index = 0; index < 500; index += 1) {
      await cache.get(`key-${index}`, T0 + index, () => Promise.resolve(index));
      expect(cache.size).toBeLessThanOrEqual(50);
    }
    // The newest keys are the ones kept.
    expect(await cache.get("key-499", T0 + 500, () => Promise.resolve(-1))).toBe(499);
    expect(await cache.get("key-0", T0 + 500, () => Promise.resolve(-1))).toBe(-1);
  });
});

describe("spenderStatsCacheKey", () => {
  const base = {
    pageId: 7,
    windowDays: 30,
    timeZone: "Europe/Moscow",
    messageSource: "archive",
    projectionAsOf: new Date("2026-10-03T11:00:00.000Z"),
  } as const;

  it("changes with everything an answer depends on besides the clock", () => {
    const variants = [
      base,
      { ...base, pageId: 8 },
      { ...base, timeZone: "UTC" },
      // The owner flips the AI transcript to the union: silence reads other messages.
      { ...base, messageSource: "union" as const },
      // A transaction was written and the projection rebuilt: the answer is new at once.
      { ...base, projectionAsOf: new Date("2026-10-03T11:00:00.001Z") },
      { ...base, projectionAsOf: null },
    ];
    const keys = variants.map((variant) => spenderStatsCacheKey(variant));
    expect(new Set(keys).size).toBe(variants.length);
    expect(spenderStatsCacheKey({ ...base })).toBe(keys[0]);
  });
});
