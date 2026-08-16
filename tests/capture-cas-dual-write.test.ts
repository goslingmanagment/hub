import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@agency_hub_core/db";

import {
  captureCasDualWriteAllowed,
  getCaptureCasDualWriteCounters,
  getCaptureCasDualWritePages,
  publishCaptureCasDualWritePages,
  putCaptureCasPayloads,
  resetCaptureCasDualWriteForTests,
} from "../apps/runtime/src/services/capture-cas-dual-write.ts";

// G5 slice 1, write side. The two properties under test are the two that make a
// default-off canary safe to deploy: the gate fails CLOSED, and nothing the
// content-addressed write can do is allowed to reach the capture.

beforeEach(() => {
  resetCaptureCasDualWriteForTests();
});

afterEach(() => {
  resetCaptureCasDualWriteForTests();
});

/** A handle that fails the test if anything touches the database. */
function forbiddenDb(): Database {
  return {
    execute: () => {
      throw new Error("the capture seam queried the database with the canary off");
    },
  } as unknown as Database;
}

/** A handle with no `.transaction` — the shape putPayloadObject treats as
 *  "compose inline" — whose every query fails. */
function brokenDb(): Database {
  return {
    execute: () => Promise.reject(new Error("connection lost")),
  } as unknown as Database;
}

const CAPTURE_INSTANT = new Date("2026-08-15T12:00:00.000Z");

describe("capture CAS dual-write gate parsing", () => {
  it("treats an empty or blank setting as fully OFF", () => {
    // FAILS CLOSED, the opposite of the Fansly new-stream allowlist. An unset
    // setting must never read as "dual-write the whole fleet".
    for (const csv of [undefined, "", "   ", ",", " , , "]) {
      expect(captureCasDualWriteAllowed(csv, 7), JSON.stringify(csv)).toBe(false);
    }
  });

  it("treats '*' as every page", () => {
    expect(captureCasDualWriteAllowed("*", 7)).toBe(true);
    expect(captureCasDualWriteAllowed("*", 999_999)).toBe(true);
    expect(captureCasDualWriteAllowed(" * ", 7)).toBe(true);
    // A wildcard anywhere in the list still means every page.
    expect(captureCasDualWriteAllowed("12,*", 7)).toBe(true);
  });

  it("matches page ids from a list, tolerating whitespace", () => {
    expect(captureCasDualWriteAllowed("12", 12)).toBe(true);
    expect(captureCasDualWriteAllowed("12", 13)).toBe(false);
    expect(captureCasDualWriteAllowed(" 12 , 34 ", 34)).toBe(true);
    expect(captureCasDualWriteAllowed("12,,34,", 12)).toBe(true);
    expect(captureCasDualWriteAllowed("\n12,\t34\n", 34)).toBe(true);
    expect(captureCasDualWriteAllowed("12,34", 1)).toBe(false);
  });

  it("never matches a page id by prefix, substring or label", () => {
    // "1" must not enable page 12, and a page LABEL is not an id — the entries
    // are compared as whole strings against the numeric id.
    expect(captureCasDualWriteAllowed("1", 12)).toBe(false);
    expect(captureCasDualWriteAllowed("123", 12)).toBe(false);
    expect(captureCasDualWriteAllowed("lora-main", 12)).toBe(false);
  });
});

describe("capture CAS dual-write publication", () => {
  it("starts off and takes the value the heartbeat publishes", () => {
    expect(getCaptureCasDualWritePages()).toBe("");
    publishCaptureCasDualWritePages("12,34");
    expect(getCaptureCasDualWritePages()).toBe("12,34");
    // An unset effective value returns the process to fully-off.
    publishCaptureCasDualWritePages(undefined);
    expect(getCaptureCasDualWritePages()).toBe("");
  });
});

describe("capture CAS dual-write never costs the capture", () => {
  it("does no work at all — not even a query — for a page outside the canary", async () => {
    publishCaptureCasDualWritePages("34");
    const refs = await putCaptureCasPayloads(forbiddenDb(), {
      pageId: 12,
      captureInstant: CAPTURE_INSTANT,
      responsePayload: { a: 1 },
      observationPayload: { a: 1 },
    });

    expect(refs).toEqual({ raw: null, observation: null });
    expect(getCaptureCasDualWriteCounters().attempted).toBe(0);
  });

  it("does no work at all when the canary is off entirely", async () => {
    const refs = await putCaptureCasPayloads(forbiddenDb(), {
      pageId: 12,
      captureInstant: CAPTURE_INSTANT,
      responsePayload: { a: 1 },
      observationPayload: { a: 1 },
    });

    expect(refs).toEqual({ raw: null, observation: null });
    expect(getCaptureCasDualWriteCounters().attempted).toBe(0);
  });

  it("swallows a codec refusal and hands back null references", async () => {
    publishCaptureCasDualWritePages("*");
    // A Date is not plain wire JSON: the frozen codec refuses it rather than
    // guessing at a toJSON hook. The capture that follows must be unaffected.
    const refs = await putCaptureCasPayloads(forbiddenDb(), {
      pageId: 12,
      captureInstant: CAPTURE_INSTANT,
      responsePayload: { capturedAt: new Date() },
      observationPayload: { capturedAt: new Date() },
    });

    expect(refs).toEqual({ raw: null, observation: null });
    const counters = getCaptureCasDualWriteCounters();
    expect(counters.attempted).toBe(1);
    expect(counters.codecRefused).toBe(1);
    expect(counters.failed).toBe(0);
    expect(counters.stored).toBe(0);
  });

  it("counts a non-codec failure separately and still hands back null references", async () => {
    publishCaptureCasDualWritePages("*");
    const refs = await putCaptureCasPayloads(brokenDb(), {
      pageId: 12,
      captureInstant: CAPTURE_INSTANT,
      responsePayload: { a: 1 },
      observationPayload: { a: 1 },
    });

    expect(refs).toEqual({ raw: null, observation: null });
    const counters = getCaptureCasDualWriteCounters();
    expect(counters.attempted).toBe(1);
    expect(counters.failed).toBe(1);
    expect(counters.codecRefused).toBe(0);
  });

  it("refuses a payload the codec cannot encode without touching the counters of the good path", async () => {
    publishCaptureCasDualWritePages("*");
    // Cyclic structure: another loud codec refusal, never a silent coercion.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const refs = await putCaptureCasPayloads(forbiddenDb(), {
      pageId: 12,
      captureInstant: CAPTURE_INSTANT,
      responsePayload: cyclic,
      observationPayload: cyclic,
    });

    expect(refs).toEqual({ raw: null, observation: null });
    expect(getCaptureCasDualWriteCounters()).toMatchObject({
      attempted: 1,
      codecRefused: 1,
      stored: 0,
      deduped: 0,
      failed: 0,
    });
  });
});
