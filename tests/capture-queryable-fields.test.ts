// G5 slice 3a — the pure half: what the typed columns get filled with.
//
// These derivations replace SQL the database used to run over the inline body
// (`payload->>'machineId'`, `payload->'row'->>'tx_id'`,
// `jsonb_build_object('tips', response_payload -> 'tips')`). The whole point of
// the slice is that the column and the extraction it replaces agree, so the
// cases below are written against POSTGRES' semantics, not against a convenient
// TypeScript reading of them: a missing key and a JSON null are the same answer,
// a scalar renders as its text, and the harvest gate is the producer+kind pair
// the queries filter on.

import { describe, expect, it } from "vitest";

import {
  deriveObservationQueryableFields,
  deriveRawPayloadTipsSlice,
  jsonMemberText,
} from "@agency_hub_core/db";

const HARVEST = { producer: "desktop-harvest@0.1.29", kind: "harvest.messages" };
const HARVEST_TX = { producer: "desktop-harvest@0.1.29", kind: "harvest.fan_transactions" };

describe("jsonMemberText mirrors the ->> operator", () => {
  it("returns a string member unquoted", () => {
    expect(jsonMemberText("machine-1")).toBe("machine-1");
    expect(jsonMemberText("")).toBe("");
  });

  it("collapses a missing key and a JSON null onto the same NULL", () => {
    // `->>` cannot tell them apart either, which is why every column this
    // module feeds is nullable.
    expect(jsonMemberText(undefined)).toBeNull();
    expect(jsonMemberText(null)).toBeNull();
  });

  it("renders scalars as their text", () => {
    expect(jsonMemberText(5)).toBe("5");
    expect(jsonMemberText(4.25)).toBe("4.25");
    expect(jsonMemberText(0)).toBe("0");
    expect(jsonMemberText(true)).toBe("true");
    expect(jsonMemberText(false)).toBe("false");
  });

  it("refuses to guess at a non-scalar rather than emit a near-miss", () => {
    // PostgreSQL would render these as ITS jsonb text (`{"a": 1}`, with the
    // space) and no JSON.stringify reproduces that. A rendered document can
    // never be the machine uuid or transaction id these columns are compared
    // against, so an honest null beats a value that only ALMOST matches.
    expect(jsonMemberText({ a: 1 })).toBeNull();
    expect(jsonMemberText([1, 2])).toBeNull();
  });
});

describe("deriveObservationQueryableFields", () => {
  it("leaves every column null for an ordinary capture", () => {
    expect(deriveObservationQueryableFields({
      producer: "sync:fansly:transactions",
      kind: "earnings_transactions",
      payload: { machineId: "machine-1", row: { tx_id: "tx-1" } },
    })).toEqual({
      harvestMachineId: null,
      harvestTxId: null,
      harvestTxAmount: null,
      harvestTxCreatedAt: null,
    });
  });

  it("takes the machine id for any harvest kind", () => {
    expect(deriveObservationQueryableFields({
      ...HARVEST,
      payload: { table: "messages", machineId: "machine-1", row: { message_id: "9001" } },
    })).toEqual({
      harvestMachineId: "machine-1",
      harvestTxId: null,
      harvestTxAmount: null,
      harvestTxCreatedAt: null,
    });
  });

  it("takes the row members only for the transactions kind", () => {
    expect(deriveObservationQueryableFields({
      ...HARVEST_TX,
      payload: {
        table: "fan_transactions",
        machineId: "machine-1",
        row: { tx_id: "tx-7", amount: 5, created_at: "2025-10-01T00:00:00+00:00" },
      },
    })).toEqual({
      harvestMachineId: "machine-1",
      harvestTxId: "tx-7",
      harvestTxAmount: "5",
      harvestTxCreatedAt: "2025-10-01T00:00:00+00:00",
    });
  });

  it("requires BOTH the harvest producer and a harvest kind", () => {
    // The queries gate on the pair; a column filled on a looser rule would make
    // a row findable through the fallback and invisible without it.
    expect(deriveObservationQueryableFields({
      producer: "desktop@0.1.29",
      kind: "harvest.messages",
      payload: { machineId: "machine-1" },
    }).harvestMachineId).toBeNull();
    expect(deriveObservationQueryableFields({
      producer: "desktop-harvest@0.1.29",
      kind: "desktop.unknown:harvest.messages",
      payload: { machineId: "machine-1" },
    }).harvestMachineId).toBeNull();
  });

  it("never throws on a payload that is not the shape the lane promises", () => {
    // Capture-first (DP 7): a malformed harvested fact still journals, it just
    // journals with null locators.
    for (const payload of [null, undefined, 7, "text", [], { row: 3 }]) {
      expect(deriveObservationQueryableFields({ ...HARVEST_TX, payload })).toEqual({
        harvestMachineId: null,
        harvestTxId: null,
        harvestTxAmount: null,
        harvestTxCreatedAt: null,
      });
    }
  });
});

describe("deriveRawPayloadTipsSlice", () => {
  it("slices tips out of a DM message page", () => {
    expect(deriveRawPayloadTipsSlice({
      endpoint: "dm_messages",
      payloadKind: "dm_messages",
      responsePayload: {
        messages: [{ id: "heavy", media: "x".repeat(1000) }],
        tips: [{ id: "tip-1", message: "note" }],
      },
    })).toEqual({ tips: [{ id: "tip-1", message: "note" }] });
  });

  it("keeps the envelope with a null member when tips are absent", () => {
    // `jsonb_build_object('tips', payload -> 'tips')` yields `{"tips": null}`
    // for a missing key AND for an explicit null; the sidecar parser reads both
    // as an ABSENT sidecar, and that must not change.
    expect(deriveRawPayloadTipsSlice({
      endpoint: "dm_messages",
      payloadKind: "dm_messages",
      responsePayload: { messages: [] },
    })).toEqual({ tips: null });
    expect(deriveRawPayloadTipsSlice({
      endpoint: "dm_messages",
      payloadKind: "dm_messages",
      responsePayload: { tips: null },
    })).toEqual({ tips: null });
  });

  it("writes nothing for any other capture", () => {
    // The column exists for ONE reader's keyset walk. Filling it everywhere
    // would copy a `{tips: null}` onto every posts/fans/transactions capture in
    // the system — duplication, which is what this project exists to remove.
    expect(deriveRawPayloadTipsSlice({
      endpoint: "earnings_transactions",
      payloadKind: "mapping_critical",
      responsePayload: { tips: [{ id: "tip-1" }] },
    })).toBeUndefined();
    expect(deriveRawPayloadTipsSlice({
      endpoint: "dm_messages",
      payloadKind: "failed",
      responsePayload: { tips: [] },
    })).toBeUndefined();
  });

  it("writes nothing for a non-object body", () => {
    // Today's CASE hands such a payload back whole. Copying it would duplicate
    // a body to preserve a value the only consumer rejects either way — a
    // non-record response and SQL NULL are both `envelopeStatus: "invalid"`.
    for (const payload of [null, undefined, 7, "text", [1, 2]]) {
      expect(deriveRawPayloadTipsSlice({
        endpoint: "dm_messages",
        payloadKind: "dm_messages",
        responsePayload: payload,
      })).toBeUndefined();
    }
  });
});
