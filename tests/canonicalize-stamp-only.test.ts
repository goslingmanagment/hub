// A row stamped at insert is never shown to its canonicalizer again: the
// stamp-only decision must equal "this family's canonicalizer returns nothing
// for every payload of the kind" — or a captured fact is silently consumed.

import { FANSLY_WS_CAPTURE_KIND } from "@agency_hub_core/shared";
import { describe, expect, it } from "vitest";

import {
  CANONICALIZER_FAMILIES,
  stampOnlyParseVersion,
} from "../apps/runtime/src/services/canonicalize/index.ts";
import type { CanonicalizableObservation } from "../apps/runtime/src/services/canonicalize/types.ts";

const RECEIVED_AT = new Date("2026-11-10T09:00:00.000Z");

const PRODUCERS = ["desktop@1.0.0", "desktop-harvest@1.0.0", "chat-extension@2.0.0", "fansly:browser", "fansly:b0"];
const FRAME = JSON.stringify({ t: 10000, d: { serviceId: 5, event: { type: 1, message: { id: "200", groupId: "100" } } } });
const PAYLOADS: unknown[] = [
  null,
  {},
  [],
  "text",
  7,
  // A harvest message row: the one shape the client-capture family mints from.
  { row: { message_id: "1000031", chat_id: "1000005", is_sent_by_me: 1, created_at: "2026-11-09T10:00:00Z", text_plain: "hey", deleted: 1 } },
  { row: { message_id: "1000032", chat_id: "1000005", is_sent_by_me: 0 } },
  // The captured-frame envelope, with hint-bearing frames.
  { codec: FANSLY_WS_CAPTURE_KIND, frame: FRAME, generation: "a".repeat(64) },
  { codec: FANSLY_WS_CAPTURE_KIND, frame: FRAME, generation: null },
  { pageLabel: "page", fanId: "1", messageId: "2", text: "x", amount: 100 },
];

function observations(source: string, kind: string): CanonicalizableObservation[] {
  const rows: CanonicalizableObservation[] = [];
  let id = 1;
  for (const producer of PRODUCERS) {
    for (const payload of PAYLOADS) {
      for (const accountId of [null, 11]) {
        rows.push({
          id: id++, source, producer, platform: accountId === null ? null : "fansly", accountId,
          nativeAccountRef: null, kind, payload, observedAt: null, receivedAt: RECEIVED_AT,
        } as CanonicalizableObservation);
      }
    }
  }
  return rows;
}

const context = { nativeAccountRefByAccountId: new Map<number, string | null>([[11, "own-1"]]), accountIdByNativeRef: new Map<string, number>() };

describe("stamp-only observations (stamped at insert, never swept)", () => {
  it("is decided by the registry flag alone, at the family's current version", () => {
    for (const family of CANONICALIZER_FAMILIES) {
      for (const kind of family.kinds ?? ["any.kind"]) {
        const expected = family.stampOnly !== undefined && !family.stampOnly.exceptKinds.includes(kind)
          ? family.version : undefined;
        expect(stampOnlyParseVersion(family.source, kind), `${family.source}:${family.lane} ${kind}`).toBe(expected);
      }
    }
  });

  it("only for kinds whose canonicalizer returns nothing for every payload, with no gate or quarantine to skip", () => {
    let stampOnlyKinds = 0;
    for (const family of CANONICALIZER_FAMILIES) {
      for (const kind of family.kinds ?? []) {
        if (stampOnlyParseVersion(family.source, kind) === undefined) continue;
        stampOnlyKinds += 1;
        expect(family.parse, kind).toBeUndefined();
        expect(family.quarantine, kind).toBeUndefined();
        for (const observation of observations(family.source, kind)) {
          expect(family.canonicalize(observation, context), `${kind} ${observation.producer}`).toEqual([]);
        }
      }
    }
    // fansly.ws.frame.v1 + every client-capture desktop kind but harvest.messages.
    expect(stampOnlyKinds).toBe(1 + [...CANONICALIZER_FAMILIES.find((family) => family.lane === "desktop")!.kinds!].length - 1);
  });

  it("the captured frame its writer builds passes the signals family's shape gate", () => {
    const signals = CANONICALIZER_FAMILIES.find((family) => family.source === "fansly_ws" && family.lane === "signals")!;
    // captureBrowserWsFrame: page id, platform fansly, the codec envelope with a string frame.
    const written = {
      id: 1, source: "fansly_ws", producer: "fansly:browser", platform: "fansly", accountId: 11,
      nativeAccountRef: null, kind: FANSLY_WS_CAPTURE_KIND, observedAt: null, receivedAt: RECEIVED_AT,
      payload: { codec: FANSLY_WS_CAPTURE_KIND, frame: FRAME, generation: "b".repeat(64) },
    } as CanonicalizableObservation;
    expect(signals.canParse?.(written)).toBe(true);
  });

  it("leaves the kinds that can mint, and kinds no family claims, to the sweep", () => {
    for (const kind of [`${FANSLY_WS_CAPTURE_KIND}:unattributed`, `${FANSLY_WS_CAPTURE_KIND}:unverified_session`, `${FANSLY_WS_CAPTURE_KIND}:refused`]) {
      expect(stampOnlyParseVersion("fansly_ws", kind), kind).toBeUndefined();
    }
    expect(stampOnlyParseVersion("client_capture", "harvest.messages")).toBeUndefined();
    expect(stampOnlyParseVersion("client_capture", "desktop.unknown:ai_acceptance")).toBeUndefined();
    expect(stampOnlyParseVersion("client_capture", "client.onlyfans_feed.v1")).toBeUndefined();
    // harvest.messages is excluded because it DOES mint.
    const desktop = CANONICALIZER_FAMILIES.find((family) => family.source === "client_capture" && family.lane === "desktop")!;
    const minted = observations("client_capture", "harvest.messages")
      .filter((observation) => desktop.canonicalize(observation, context).length > 0);
    expect(minted.length).toBeGreaterThan(0);
  });
});
