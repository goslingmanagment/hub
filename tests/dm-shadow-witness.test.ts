import { describe, expect, it } from "vitest";
import { createDmShadowWitnessPointers, resolveDmShadowWitness, type DmShadowWitness }
  from "../apps/runtime/src/services/sync/dm-shadow-witness.ts";
import { createDmShadowState, parseDmShadowState, type DmShadowState }
  from "../apps/runtime/src/services/sync/dm-shadow-state.ts";
import { advanceDmShadow, type DmShadowConversation }
  from "../apps/runtime/src/services/sync/dm-shadow.ts";
import { trimFanslyMessagingGroupsPayload } from "../apps/runtime/src/sync/fansly/lib/capture-trims.ts";

const payload = { data: [{ groupId: "g", lastMessageId: "m" }] };
const pointers = (body: { data: Array<{ groupId: string; lastMessageId: string | null }> } = payload) => createDmShadowWitnessPointers({ observationId: 123,
  payload: body, readStartedAtMs: 1000, readFinishedAtMs: 1100 });
const witness = (): DmShadowWitness => ({ ...pointers()("g", "m")!, pageNumber: 4,
  state: "missing", source: null, liveHotCopy: false });
const envelope = (body: unknown = payload) => ({ id: 123, accountId: 5,
  platform: "fansly", kind: "dm_conversations", payload: body });
const initial = () => ({ ...createDmShadowState({ startedAtMs: 1,
  boundaryMs: 10, completeCoverage: true }), pageCount: 3, stopPage: 3 });
const head = (): DmShadowConversation => ({ reasons: [], listMessageId: "m",
  embeddedMessageId: null, previousMessageId: "m", timestampMs: null,
  previousTimestampMs: null, materialConfirmed: false, discoveryToCaptureMs: null,
  historyPending: false, lastHistorySyncAtMs: null,
  readerHead: { state: "missing", source: null, liveHotCopy: false },
  readerWitnessPointer: pointers()("g", "m"),
});
const advance = (state: DmShadowState = initial(), conversations = [head()]) => advanceDmShadow(state, {
  observedAtMs: 1200, responseBytes: 100, conversations,
});

describe("A0 bounded pre-apply reader witnesses", () => {
  it("binds to trimmed raw positions even when mapped order differs", () => {
    const captured = trimFanslyMessagingGroupsPayload({ data: [null, {},
      { groupId: "other", lastMessageId: "other-head" }, payload.data[0]] });
    expect(pointers(captured)("g", "m")?.itemIndex).toBe(1);
    expect(pointers(captured)("other", "other-head")?.itemIndex).toBe(0);
    expect(pointers(captured)("g", "wrong")).toBeNull();
    expect(pointers({ data: [payload.data[0]!, payload.data[0]!] })("g", "m")).toBeNull();
  });

  it("resolves JSONB key ordering but rejects changed, erased and shifted bodies", () => {
    expect(resolveDmShadowWitness(witness(), 5, envelope({ data: [{ lastMessageId: "m", groupId: "g" }] })))
      .toEqual({ conversationRef: "g", messageId: "m" });
    for (const body of [null, { data: [] }, { data: [{ groupId: "other", lastMessageId: "m" }] },
      { data: [payload.data[0], payload.data[0]] }]) {
      expect(resolveDmShadowWitness(witness(), 5, envelope(body))).toBeNull();
    }
    // Existing fan erasure law may retain shared raw unchanged: no anonymization claim.
    expect(resolveDmShadowWitness(witness(), 5, envelope())).not.toBeNull();
  });

  it("rejects wrong observation identity, scope, kind and out-of-range index", () => {
    for (const change of [{ id: 124 }, { accountId: 6 }, { platform: "onlyfans" }, { kind: "dm_messages" }]) {
      expect(resolveDmShadowWitness(witness(), 5, { ...envelope(), ...change })).toBeNull();
    }
    expect(resolveDmShadowWitness({ ...witness(), itemIndex: 1 }, 5, envelope())).toBeNull();
  });

  it("caps at twenty across resumes without losing counters or mutating prior state", () => {
    const source = initial();
    const first = advance(source, Array.from({ length: 15 }, head));
    const resumed = parseDmShadowState(JSON.parse(JSON.stringify(first)))!;
    const second = advance(resumed, Array.from({ length: 15 }, head));
    expect(source.readerWitnesses).toEqual([]);
    expect(first.readerWitnesses).toHaveLength(15);
    expect(resumed.readerWitnesses).toHaveLength(15);
    expect(second.readerWitnesses).toHaveLength(20);
    expect(second.readerWitnessesOmitted).toBe(10);
    expect(second.readerMissingHeadsBelowStop).toBe(30);
    expect(second.readerWitnesses?.[15]?.pageNumber).toBe(5);
    expect(JSON.stringify(second.readerWitnesses)).not.toContain('"groupId"');
    expect(JSON.stringify(second.readerWitnesses)).not.toContain('"messageId"');
  });

  it("samples only after the stop, and includes unavailable reader checks honestly", () => {
    expect(advance({ ...initial(), stopPage: null }).readerWitnesses).toEqual([]);
    expect(advance(initial(), [{ ...head(), readerHead: { state: "materialized", source: "hot", liveHotCopy: true } }])
      .readerWitnesses).toEqual([]);
    const unavailable = advance(initial(), [{ ...head(), readerHead: null }]);
    expect(unavailable.readerWitnesses?.[0]).toMatchObject({ state: "unknown", source: null, liveHotCopy: null });
    expect(unavailable.unknownReaderHeadChecks).toBe(1);
    expect(unavailable.readerMissingHeadsBelowStop).toBe(0);
  });

  it("counts absent pointers explicitly and preserves legacy or mid-sweep unknowns", () => {
    expect(advance(initial(), [{ ...head(), readerWitnessPointer: null }])).toMatchObject({
      readerWitnesses: [], readerWitnessesOmitted: 1, readerMissingHeadsBelowStop: 1,
    });
    const { readerWitnesses: _witnesses, readerWitnessesOmitted: _omitted, ...legacy } = initial();
    expect(advance(parseDmShadowState(legacy)!)).toMatchObject({ readerWitnesses: null, readerWitnessesOmitted: null });
    expect(createDmShadowState({ startedAtMs: 1, boundaryMs: null, completeCoverage: false }))
      .toMatchObject({ readerWitnesses: null, readerWitnessesOmitted: null });
    expect(parseDmShadowState({ ...initial(), readerWitnesses: Array.from({ length: 21 }, witness) })).toBeUndefined();
  });

  it("leaves missing captures, clock rollback and non-JSON diagnostic input unlinked", () => {
    for (const change of [{ observationId: null }, { readFinishedAtMs: 0 }, { payload: { data: [], bad: 1n } }]) {
      expect(createDmShadowWitnessPointers({ observationId: 1, payload,
        readStartedAtMs: 100, readFinishedAtMs: 200, ...change })("g", "m")).toBeNull();
    }
  });
});
