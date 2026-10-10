import { describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";

// Production 2026-09-30: a Fansly body with an unpaired UTF-16 surrogate failed
// the raw insert with 22P02 (json/jsonb refuse the `\udXXX` escape). The
// capture seam now journals such a body with U+FFFD in place of each one. The
// ordinary body — every other capture — must reach the inserts as the very
// object the lane served: no copy, no marker, no note.

const captured = vi.hoisted(() => ({
  raws: [] as Array<{ endpoint: string; responsePayload: unknown; mapperVersion: string }>,
  observations: [] as Array<{ kind: string; payload: unknown; payloadHash: Buffer }>,
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock("@agency_hub_core/db", async (importOriginal) => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    insertRawPayload: vi.fn(async (
      _db: unknown,
      input: { endpoint: string; responsePayload: unknown; mapperVersion: string },
    ) => {
      captured.raws.push(input);
      return { id: 11, capturedAt: new Date(0), payloadRefVanished: false };
    }),
    insertObservation: vi.fn(async (
      _db: unknown,
      input: { kind: string; payload: unknown; payloadHash: Buffer },
    ) => {
      captured.observations.push(input);
      return { inserted: true, observationId: 22, payloadRefVanished: false };
    }),
    insertSyncRunEvent: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
      captured.events.push(input);
      return input;
    }),
    recordSyncHttpAttemptResponseBodyBytes: vi.fn(async () => true),
  };
});

const { countLoneSurrogatesDeep, sanitizeLoneSurrogatesDeep } = await import("@agency_hub_core/shared");
const { runWithPageSyncExecutionContext } = await import("@agency_hub_core/db");
const { persistRawPayload, retentionDate } = await import("../apps/runtime/src/services/sync/shared.ts");
const {
  JOURNAL_LONE_SURROGATES_REPLACED_MAPPER_SUFFIX,
  JOURNAL_NUL_REPLACED_MAPPER_SUFFIX,
  replaceJournalLoneSurrogates,
  replaceJournalUnstorableText,
} = await import("../apps/runtime/src/sync/fansly/lib/journal-lone-surrogates.ts");

const LONE_HIGH = "\ud83d";
const LONE_LOW = "\udc4b";

function row(endpoint: string, responsePayload: unknown, syncRunId: number | null = null) {
  return {
    platformAccountId: 7,
    syncRunId,
    endpoint,
    requestParams: {},
    responsePayload,
    mapperVersion: "fansly-phase1-v5",
    payloadKind: "mapping_critical" as const,
    retainUntil: retentionDate(),
  };
}

function reset() {
  captured.raws.length = 0;
  captured.observations.length = 0;
  captured.events.length = 0;
}

function inRun<T>(run: () => Promise<T>) {
  return runWithPageSyncExecutionContext({ pageId: 7, stream: "dm_messages", requestSeq: 3, leaseToken: "t" }, run);
}

/** Well-formed text only: whole emoji (surrogate PAIRS), CJK, escapes. */
function cleanBody() {
  return {
    success: true,
    response: {
      messages: [
        { id: "1", content: "hey 😊👋🏽 你好 \\ud83d is just text", createdAt: 1790000000 },
        { id: "2", content: "", createdAt: 1790000001, attachments: [{ contentType: 1, contentId: "3" }] },
      ],
    },
  };
}

describe("countLoneSurrogatesDeep", () => {
  it("counts unpaired high and low surrogates in values and keys, never pairs", () => {
    expect(countLoneSurrogatesDeep(cleanBody())).toBe(0);
    expect(countLoneSurrogatesDeep("😊")).toBe(0);
    expect(countLoneSurrogatesDeep(`a${LONE_HIGH}`)).toBe(1);
    expect(countLoneSurrogatesDeep(`${LONE_LOW}b`)).toBe(1);
    // A reversed pair is two unpaired halves.
    expect(countLoneSurrogatesDeep(`${LONE_LOW}${LONE_HIGH}`)).toBe(2);
    expect(countLoneSurrogatesDeep({
      [`key${LONE_HIGH}`]: [1, null, true, { deep: [`x${LONE_LOW}y${LONE_HIGH}`] }],
    })).toBe(3);
    expect(countLoneSurrogatesDeep(null)).toBe(0);
    expect(countLoneSurrogatesDeep(undefined)).toBe(0);
    expect(countLoneSurrogatesDeep(42)).toBe(0);
  });

  it("agrees with sanitizeLoneSurrogatesDeep, which keeps a served __proto__ key as data", () => {
    const served = JSON.parse(`{"__proto__":{"about":"hi \\ud83d"},"ok":"😊"}`) as Record<string, unknown>;
    expect(countLoneSurrogatesDeep(served)).toBe(1);
    const clean = sanitizeLoneSurrogatesDeep(served);
    expect(Object.getPrototypeOf(clean)).toBe(Object.prototype);
    expect(JSON.stringify(clean)).toBe(`{"__proto__":{"about":"hi �"},"ok":"😊"}`);
    expect(countLoneSurrogatesDeep(clean)).toBe(0);
  });
});

describe("replaceJournalLoneSurrogates", () => {
  it("returns a clean value by identity and a dirty one as a sanitized copy", () => {
    const clean = cleanBody();
    expect(replaceJournalLoneSurrogates(clean)).toEqual({ value: clean, replaced: 0 });
    expect(replaceJournalLoneSurrogates(clean).value).toBe(clean);

    const dirty = { about: `bio ${LONE_HIGH}`, list: [`${LONE_LOW} x`] };
    const result = replaceJournalLoneSurrogates(dirty);
    expect(result).toEqual({ value: { about: "bio �", list: ["� x"] }, replaced: 2 });
    expect(dirty.about).toBe(`bio ${LONE_HIGH}`);
  });
});

describe("replaceJournalUnstorableText (bug hunt Д3: U+0000 too)", () => {
  it("returns a clean value by identity with both counts 0", () => {
    const clean = cleanBody();
    const result = replaceJournalUnstorableText(clean);
    expect(result).toEqual({ value: clean, loneSurrogates: 0, nul: 0 });
    expect(result.value).toBe(clean);
  });

  it("replaces a NUL in a value and in a key, and a surrogate beside a NUL, by U+FFFD with the right counts", () => {
    const dirty = { about: "nul\u0000here", "k\u0000ey": [`${LONE_HIGH} and \u0000\u0000`], plain: "fine" };
    const snapshot = JSON.stringify(dirty);
    const result = replaceJournalUnstorableText(dirty);
    expect(result).toEqual({
      value: { about: "nul�here", "k�ey": ["� and ��"], plain: "fine" },
      loneSurrogates: 1,
      nul: 4,
    });
    // What the driver sends jsonb no longer carries a refused escape.
    expect(JSON.stringify(result.value)).not.toContain("\\u0000");
    expect(JSON.stringify(result.value)).not.toMatch(/\\ud[89ab]/i);
    // The served object is left as it was.
    expect(JSON.stringify(dirty)).toBe(snapshot);
    expect(result.value).not.toBe(dirty);
  });

  it("keeps a parsed __proto__ key as data", () => {
    const dirty = JSON.parse('{"__proto__":{"about":"x\\u0000y"},"ok":"z"}') as Record<string, unknown>;
    const result = replaceJournalUnstorableText(dirty);
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    expect(JSON.stringify(result.value)).toBe('{"__proto__":{"about":"x�y"},"ok":"z"}');
    expect(result.nul).toBe(1);
  });

  it("names its suffix; the legacy replacement still leaves a NUL alone", () => {
    expect(JOURNAL_NUL_REPLACED_MAPPER_SUFFIX).toBe("+nul-replaced-v1");
    const body = { success: true, response: [{ id: "1", content: "hi\u0000there" }] };
    const legacy = replaceJournalLoneSurrogates(body);
    expect(legacy.replaced).toBe(0);
    expect(JSON.stringify(legacy.value)).toContain("\\u0000");
  });
});

describe("persistRawPayload and unpaired surrogates", () => {
  it("passes a clean body through by identity, with no suffix and no note", async () => {
    for (const endpoint of ["dm_messages", "discovery_feed"]) {
      reset();
      const input = cleanBody();
      const snapshot = JSON.stringify(input);
      const result = await inRun(() => persistRawPayload({} as never, row(endpoint, input, 5), { platform: "fansly" }));
      // discovery_feed is a CDN-stripped kind, and a body with no signed URL
      // comes back from the strip as the same object too.
      expect(captured.raws[0]!.responsePayload, endpoint).toBe(input);
      expect(captured.observations[0]!.payload, endpoint).toBe(input);
      expect(result.observationPayload, endpoint).toBe(input);
      expect(captured.raws[0]!.mapperVersion, endpoint)
        .not.toContain(JOURNAL_LONE_SURROGATES_REPLACED_MAPPER_SUFFIX);
      expect(JSON.stringify(input), endpoint).toBe(snapshot);
      expect(captured.events, endpoint).toEqual([]);
    }
  });

  it("journals one sanitized copy for both envelopes and leaves the served object alone", async () => {
    reset();
    const input = cleanBody();
    input.response.messages[0]!.content = `so cute ${LONE_HIGH}`;
    input.response.messages[1]!.content = `${LONE_LOW} 😊`;
    const snapshot = JSON.stringify(input);
    const { observationId, observationPayload } = await inRun(() => persistRawPayload(
      {} as never,
      row("dm_messages", input, 5),
      { platform: "fansly" },
    ));

    const [raw] = captured.raws;
    const [observation] = captured.observations;
    expect(raw!.mapperVersion).toBe(`fansly-phase1-v5${JOURNAL_LONE_SURROGATES_REPLACED_MAPPER_SUFFIX}`);
    expect(JOURNAL_LONE_SURROGATES_REPLACED_MAPPER_SUFFIX).toBe("+lone-surrogates-replaced-v1");
    expect(raw!.responsePayload).not.toBe(input);
    expect(raw!.responsePayload).toEqual(sanitizeLoneSurrogatesDeep(input));
    expect(countLoneSurrogatesDeep(raw!.responsePayload)).toBe(0);
    // One object for both envelopes, so the catalog still does a single put,
    // and the hash is over the body actually stored.
    expect(observation!.payload).toBe(raw!.responsePayload);
    // The caller gets the journaled body back, so a hash it takes over it
    // (the DM shadow witness) matches what the observation holds.
    expect(observationPayload).toBe(observation!.payload);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(input.response.messages[0]!.content).toBe(`so cute ${LONE_HIGH}`);

    expect(captured.events).toEqual([expect.objectContaining({
      syncRunId: 5,
      platformAccountId: 7,
      provider: "fansly",
      stream: "dm_messages",
      eventType: "note",
      severity: "info",
      details: {
        code: "journal_lone_surrogates_replaced",
        endpoint: "dm_messages",
        rawPayloadId: 11,
        observationId,
        rawPayloadReplacements: 2,
        observationReplacements: 2,
      },
    })]);
  });

  it("composes with the CDN strip suffix and sanitizes a separate observation envelope", async () => {
    reset();
    const response = { posts: [{ id: "1", content: `great pic ${LONE_HIGH}` }], accounts: [] };
    const envelope = { walk: { postId: "9", before: null }, response };
    await persistRawPayload({} as never, row("post_replies", response), {
      platform: "fansly",
      observationPayload: envelope,
    });
    expect(captured.raws[0]!.mapperVersion)
      .toBe("fansly-phase1-v5+cdn-tokens-stripped-v1+lone-surrogates-replaced-v1");
    expect(captured.raws[0]!.responsePayload).toEqual({ posts: [{ id: "1", content: "great pic �" }], accounts: [] });
    expect(captured.observations[0]!.payload).toEqual({
      walk: { postId: "9", before: null },
      response: { posts: [{ id: "1", content: "great pic �" }], accounts: [] },
    });
    expect(response.posts[0]!.content).toBe(`great pic ${LONE_HIGH}`);
    // No run (and no execution context): the mapper suffix is the only marker.
    expect(captured.events).toEqual([]);
  });

  it("never fails a capture over the note", async () => {
    reset();
    const { insertSyncRunEvent } = await import("@agency_hub_core/db");
    vi.mocked(insertSyncRunEvent).mockRejectedValueOnce(new Error("telemetry down"));
    await expect(inRun(() => persistRawPayload(
      {} as never,
      row("dm_messages", { content: LONE_HIGH }, 5),
      { platform: "fansly" },
    ))).resolves.toMatchObject({ id: 11, observationId: 22 });
    expect(captured.raws[0]!.responsePayload).toEqual({ content: "�" });
  });
});
