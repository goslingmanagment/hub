// The payload read seam, in isolation.
//
// No database: the seam's only database dependency is one `db.execute` inside
// readEnvelopeCapturePayload, so a stub handle that counts its calls and hands
// back catalog rows proves every branch — including the ones a real Postgres
// makes hard to produce on demand (a dead connection, a body row that is not
// there, an object stored under the wrong representation).
//
// The properties every case here exists to defend:
//   1. A row with no reference costs nothing — zero queries, zero counters.
//   2. A dual-copy row falls back to inline on every failure class, silently.
//   3. A pointer-only row raises, never answers null, when its one copy is gone.

import { beforeEach, describe, expect, it } from "vitest";

import {
  getCaptureCasReadCounters,
  type CapturePayloadUnavailableError,
  isCapturePayloadUnavailable,
  resetCaptureCasReadForTests,
  resolveCapturePayload,
  resolveCapturePayloadRow,
} from "../apps/runtime/src/services/payload-reader.ts";

const REF = { bucketMonth: "2026-08-01", objectId: 7 };

interface Warning {
  fields: Record<string, unknown>;
  message: string;
}

/** A stub app whose `db.execute` answers with a scripted catalog row (or
 *  throws), and whose logger records what the seam decided to say. */
function stubApp(
  responses: Array<{ rows: unknown[] } | Error>,
) {
  const warnings: Warning[] = [];
  let queries = 0;
  const app = {
    db: {
      execute: async () => {
        const next = responses[queries] ?? { rows: [] };
        queries += 1;
        if (next instanceof Error) {
          throw next;
        }
        return next;
      },
    },
    logger: {
      info: () => {},
      error: () => {},
      warn: (fields: Record<string, unknown>, message: string) => {
        warnings.push({ fields, message });
      },
    },
  };
  return {
    app: app as never,
    warnings,
    get queries() {
      return queries;
    },
  };
}

/** The shape readEnvelopeCapturePayload selects. */
function catalogRow(body: unknown, options?: {
  representation?: string;
  hasJson?: boolean;
  hasBytes?: boolean;
}) {
  return {
    rows: [{
      representation: options?.representation ?? "canonical_json",
      has_json: options?.hasJson ?? true,
      json_body: body,
      has_bytes: options?.hasBytes ?? false,
    }],
  };
}

const INLINE = { messages: [{ id: "m1", text: "hey" }], total: 1 };

beforeEach(() => {
  resetCaptureCasReadForTests();
});

describe("capture CAS read seam — row form", () => {
  it("returns the SAME row object when there is no reference", async () => {
    const stub = stubApp([]);
    const row = { payload: INLINE, payloadRef: null, extra: "kept" };

    expect(await resolveCapturePayloadRow(stub.app, "observation", 11, row)).toBe(row);
    expect(stub.queries).toBe(0);
  });
});

describe("capture CAS read seam — no reference", () => {
  it("returns inline and issues no query", async () => {
    const stub = stubApp([catalogRow({ never: "read" })]);

    const result = await resolveCapturePayload(stub.app, {
      envelope: "observation",
      envelopeId: 11,
      inline: INLINE,
      ref: null,
    });

    expect(result).toBe(INLINE);
    expect(stub.queries).toBe(0);
    expect(getCaptureCasReadCounters()).toEqual({
      served: 0,
      serveFellBack: 0,
      servedNullInline: 0,
      nullInlineUnresolved: 0,
    });
  });
});

describe("capture CAS read seam — a dual-copy row", () => {
  it("returns the CATALOG body", async () => {
    const catalog = { total: 1, messages: [{ text: "hey", id: "m1" }] };
    const stub = stubApp([catalogRow(catalog)]);

    const result = await resolveCapturePayload(stub.app, {
      envelope: "observation",
      envelopeId: 11,
      inline: INLINE,
      ref: REF,
    });

    expect(result).toBe(catalog);
    expect(result).not.toBe(INLINE);
    expect(getCaptureCasReadCounters()).toMatchObject({ served: 1, serveFellBack: 0 });
  });

  it("serves a stored JSON null as the value it is, not as a missing body", async () => {
    // The single-parse trap in the other direction (#80/decision #216): a body
    // that IS `null` is a stored fact, and treating it as absent would silently
    // swap it for whatever the inline column happens to hold.
    const stub = stubApp([catalogRow(null)]);

    const result = await resolveCapturePayload(stub.app, {
      envelope: "observation",
      envelopeId: 11,
      inline: INLINE,
      ref: REF,
    });

    expect(result).toBeNull();
    expect(getCaptureCasReadCounters()).toMatchObject({ served: 1, serveFellBack: 0 });
  });

  it.each([
    ["object_missing", { rows: [] as unknown[] }],
    ["body_missing", catalogRow(null, { hasJson: false })],
    ["representation_mismatch", catalogRow(null, { representation: "exact_bytes", hasBytes: true })],
    ["read_error", new Error("connection terminated")],
  ])("falls back to inline silently on %s", async (_reason, response) => {
    const stub = stubApp([response as { rows: unknown[] } | Error]);

    const result = await resolveCapturePayload(stub.app, {
      envelope: "observation",
      envelopeId: 11,
      inline: INLINE,
      ref: REF,
    });

    expect(result).toBe(INLINE);
    expect(getCaptureCasReadCounters()).toMatchObject({ served: 0, serveFellBack: 1 });
    // SILENT: a fallback is a safe, expected outcome, and a per-read error log
    // on a degraded catalog would drown the log before anyone read it.
    expect(stub.warnings).toHaveLength(0);
  });

  it("swaps the payload on the row form and leaves every other field alone", async () => {
    const catalog = { total: 1, messages: [{ text: "hey", id: "m1" }] };
    const observationStub = stubApp([catalogRow(catalog)]);

    const observationRow = { payload: INLINE, payloadRef: REF, kind: "dm_messages" };
    const resolved = await resolveCapturePayloadRow(
      observationStub.app,
      "observation",
      11,
      observationRow,
    );
    expect(resolved).not.toBe(observationRow);
    expect(resolved.payload).toBe(catalog);
    expect(resolved.kind).toBe("dm_messages");
  });
});

// A row written pointer-only has ONE copy of its body: the catalog's.
describe("capture CAS read seam — a row with no inline body", () => {
  const CATALOG = { total: 1, messages: [{ text: "hey", id: "m1" }] };

  it("resolves from the catalog", async () => {
    const stub = stubApp([catalogRow(CATALOG)]);

    const result = await resolveCapturePayload(stub.app, {
      envelope: "observation",
      envelopeId: 11,
      inline: null,
      ref: REF,
    });

    expect(result).toBe(CATALOG);
    expect(stub.queries).toBe(1);
    expect(stub.warnings).toHaveLength(0);
    expect(getCaptureCasReadCounters()).toMatchObject({
      servedNullInline: 1,
      served: 0,
      nullInlineUnresolved: 0,
    });
  });

  it.each([
    ["object_missing", { rows: [] as unknown[] }],
    ["body_missing", catalogRow(null, { hasJson: false })],
    ["read_error", new Error("connection terminated")],
  ])("RAISES and logs when the only copy cannot be read (%s)", async (reason, response) => {
    const stub = stubApp([response as { rows: unknown[] } | Error]);

    // #223: the seam's oldest promise — "never throws" — held only while every
    // row had an inline body to fall open to. For a pointer-only row the
    // fall-open value IS null, and null is the seam's word for "this envelope
    // captured no body". Answering an unreadable body with it is how a dropped
    // connection became a permanently-empty observation, so this one outcome
    // is raised. It is still never silent, and still owns no latch (#217).
    const error = await resolveCapturePayload(stub.app, {
      envelope: "observation",
      envelopeId: 11,
      inline: null,
      ref: REF,
    }).then(() => null, (thrown: unknown) => thrown);

    expect(isCapturePayloadUnavailable(error)).toBe(true);
    expect((error as CapturePayloadUnavailableError).detail).toMatchObject({
      envelope: "observation",
      envelopeId: 11,
      bucketMonth: "2026-08-01",
      objectId: 7,
      reason,
    });
    expect(getCaptureCasReadCounters()).toMatchObject({
      nullInlineUnresolved: 1,
      servedNullInline: 0,
      serveFellBack: 0,
    });
    expect(stub.warnings).toHaveLength(1);
    expect(stub.warnings[0]!.fields).toMatchObject({
      envelope: "observation",
      envelopeId: 11,
      bucketMonth: "2026-08-01",
      objectId: 7,
      reason,
    });
  });

  it("a row that has an inline body NEVER raises, however broken the catalog", async () => {
    // The other half of the #223 contract: a degraded catalog must never turn
    // into an exception on a row that has an inline body to fall open to.
    const stub = stubApp([new Error("connection terminated")]);
    const result = await resolveCapturePayload(stub.app, {
      envelope: "observation",
      envelopeId: 11,
      inline: { kept: true },
      ref: REF,
    });
    expect(result).toEqual({ kept: true });
    expect(getCaptureCasReadCounters().nullInlineUnresolved).toBe(0);
  });

  it("returns null without a query when there is no reference either", async () => {
    // The legacy shape: no body and no pointer. Nothing to resolve — and
    // migration 0128's CHECK makes it unwritable from here on.
    const stub = stubApp([catalogRow(CATALOG)]);

    const result = await resolveCapturePayload(stub.app, {
      envelope: "observation",
      envelopeId: 11,
      inline: null,
      ref: null,
    });

    expect(result).toBeNull();
    expect(stub.queries).toBe(0);
    expect(getCaptureCasReadCounters()).toMatchObject({
      servedNullInline: 0,
      nullInlineUnresolved: 0,
    });
  });
});
