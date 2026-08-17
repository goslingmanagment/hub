// G5 slice 2 — the payload read seam's mode machine, in isolation.
//
// No database: the seam's only database dependency is one `db.execute` inside
// readEnvelopeCapturePayload, so a stub handle that counts its calls and hands
// back catalog rows proves every branch — including the ones a real Postgres
// makes hard to produce on demand (a dead connection, a body row that is not
// there, an object stored under the wrong representation).
//
// The three properties every case here exists to defend:
//   1. `inline` touches NOTHING — zero queries, zero counters.
//   2. `shadow` NEVER changes what the caller receives, whatever it finds.
//   3. `serve` falls back to inline on every failure class, silently.

import { beforeEach, describe, expect, it } from "vitest";

import {
  getCaptureCasReadCounters,
  getCaptureCasReadMode,
  publishCaptureCasReadMode,
  resetCaptureCasReadForTests,
  resolveCapturePayload,
  resolveCapturePayloadRow,
  resolveRawCapturePayloadRow,
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

describe("capture CAS read seam — publishing the mode", () => {
  it("defaults to inline and accepts only the three known modes", () => {
    expect(getCaptureCasReadMode()).toBe("inline");
    publishCaptureCasReadMode("shadow");
    expect(getCaptureCasReadMode()).toBe("shadow");
    publishCaptureCasReadMode("serve");
    expect(getCaptureCasReadMode()).toBe("serve");
    // Anything unrecognised (a hand-edited row, an undefined config field, a
    // value from a newer binary) fails CLOSED to the mode that changes nothing.
    publishCaptureCasReadMode("nonsense");
    expect(getCaptureCasReadMode()).toBe("inline");
    publishCaptureCasReadMode(undefined);
    expect(getCaptureCasReadMode()).toBe("inline");
  });
});

describe("capture CAS read seam — inline mode", () => {
  it("returns the inline body and issues NO query, even with a reference", async () => {
    const stub = stubApp([catalogRow({ different: true })]);

    const result = await resolveCapturePayload(stub.app, {
      envelope: "observation",
      envelopeId: 11,
      inline: INLINE,
      ref: REF,
    });

    // Identity, not equality: nothing was re-parsed, re-encoded or copied.
    expect(result).toBe(INLINE);
    expect(stub.queries).toBe(0);
    expect(getCaptureCasReadCounters()).toEqual({
      shadowChecked: 0,
      shadowMatched: 0,
      shadowMismatched: 0,
      served: 0,
      serveFellBack: 0,
    });
  });

  it("returns the SAME row object from the row form", async () => {
    const stub = stubApp([]);
    const row = { payload: INLINE, payloadRef: REF, extra: "kept" };

    expect(await resolveCapturePayloadRow(stub.app, "observation", 11, row)).toBe(row);
    expect(stub.queries).toBe(0);
  });
});

describe("capture CAS read seam — no reference", () => {
  it("returns inline and issues no query in every mode", async () => {
    for (const mode of ["inline", "shadow", "serve"] as const) {
      resetCaptureCasReadForTests(mode);
      const stub = stubApp([catalogRow({ never: "read" })]);

      const result = await resolveCapturePayload(stub.app, {
        envelope: "observation",
        envelopeId: 11,
        inline: INLINE,
        ref: null,
      });

      expect(result, mode).toBe(INLINE);
      expect(stub.queries, mode).toBe(0);
      expect(getCaptureCasReadCounters(), mode).toMatchObject({
        shadowChecked: 0,
        served: 0,
        serveFellBack: 0,
      });
    }
  });
});

describe("capture CAS read seam — shadow mode", () => {
  beforeEach(() => {
    resetCaptureCasReadForTests("shadow");
  });

  it("compares a matching copy, counts it, logs nothing, and still returns inline", async () => {
    // Deliberately a DIFFERENT object with DIFFERENT key order: the codec
    // decides equality by canonical octets, never by key order or identity.
    const stub = stubApp([catalogRow({ total: 1, messages: [{ text: "hey", id: "m1" }] })]);

    const result = await resolveCapturePayload(stub.app, {
      envelope: "observation",
      envelopeId: 11,
      inline: INLINE,
      ref: REF,
    });

    expect(result).toBe(INLINE);
    expect(stub.queries).toBe(1);
    expect(stub.warnings).toHaveLength(0);
    expect(getCaptureCasReadCounters()).toMatchObject({
      shadowChecked: 1,
      shadowMatched: 1,
      shadowMismatched: 0,
    });
  });

  it("counts and logs a content mismatch — and STILL returns inline", async () => {
    const stub = stubApp([catalogRow({ messages: [{ id: "m1", text: "TAMPERED" }], total: 1 })]);

    const result = await resolveCapturePayload(stub.app, {
      envelope: "observation",
      envelopeId: 11,
      inline: INLINE,
      ref: REF,
    });

    expect(result).toBe(INLINE);
    expect(getCaptureCasReadCounters()).toMatchObject({
      shadowChecked: 1,
      shadowMatched: 0,
      shadowMismatched: 1,
    });
    expect(stub.warnings).toHaveLength(1);
    expect(stub.warnings[0]!.fields).toEqual({
      envelope: "observation",
      envelopeId: 11,
      bucketMonth: "2026-08-01",
      objectId: 7,
      reason: "content_mismatch",
    });
    // The line is BOUNDED: it names what disagreed and where, never a body.
    expect(JSON.stringify(stub.warnings[0])).not.toContain("TAMPERED");
    expect(JSON.stringify(stub.warnings[0])).not.toContain("hey");
  });

  it.each([
    ["object_missing", { rows: [] as unknown[] }],
    ["body_missing", catalogRow(null, { hasJson: false })],
    ["representation_mismatch", catalogRow(null, { representation: "exact_bytes", hasBytes: true })],
    ["read_error", new Error("connection terminated")],
  ])("counts %s as a mismatch and never changes the result", async (reason, response) => {
    const stub = stubApp([response as { rows: unknown[] } | Error]);

    const result = await resolveCapturePayload(stub.app, {
      envelope: "observation",
      envelopeId: 11,
      inline: INLINE,
      ref: REF,
    });

    expect(result).toBe(INLINE);
    expect(getCaptureCasReadCounters()).toMatchObject({
      shadowChecked: 1,
      shadowMatched: 0,
      shadowMismatched: 1,
    });
    expect(stub.warnings[0]!.fields.reason).toBe(reason);
  });

  it("reports an inline body the frozen codec cannot encode, without failing the read", async () => {
    // A Date is not plain wire JSON; the codec refuses it by design. Such a
    // value can never reach the catalog either, so this only ever describes an
    // inline body no comparison can be made against.
    const uncanonicalizable = { capturedAt: new Date("2026-08-01T00:00:00.000Z") };
    const stub = stubApp([catalogRow({ capturedAt: "2026-08-01T00:00:00.000Z" })]);

    const result = await resolveCapturePayload(stub.app, {
      envelope: "observation",
      envelopeId: 11,
      inline: uncanonicalizable,
      ref: REF,
    });

    expect(result).toBe(uncanonicalizable);
    expect(stub.warnings[0]!.fields.reason).toBe("inline_uncanonicalizable");
    expect(getCaptureCasReadCounters()).toMatchObject({ shadowMismatched: 1 });
  });
});

describe("capture CAS read seam — serve mode", () => {
  beforeEach(() => {
    resetCaptureCasReadForTests("serve");
  });

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
    // serve does not compare; the shadow window already did that.
    expect(getCaptureCasReadCounters()).toMatchObject({ shadowChecked: 0 });
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

  it("swaps the payload on the row forms and leaves every other field alone", async () => {
    const catalog = { total: 1, messages: [{ text: "hey", id: "m1" }] };
    const observationStub = stubApp([catalogRow(catalog)]);
    const rawStub = stubApp([catalogRow(catalog)]);

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

    const rawRow = { id: 42, responsePayload: INLINE, payloadRef: REF, endpoint: "dm_messages" };
    const resolvedRaw = await resolveRawCapturePayloadRow(rawStub.app, rawRow);
    expect(resolvedRaw.responsePayload).toBe(catalog);
    expect(resolvedRaw.endpoint).toBe("dm_messages");
    expect(resolvedRaw.id).toBe(42);
  });
});
