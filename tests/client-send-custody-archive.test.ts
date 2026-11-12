import { describe, expect, it } from "vitest";

import {
  CLIENT_SEND_ARCHIVE_GRACE_MS,
  CLIENT_SEND_ARCHIVE_PROOF_WINDOW_MS,
  decideHeldSendArchiveProof,
  type HeldSendArchiveAttribution,
  type HeldSendArchiveCustody,
  type HeldSendArchiveEvidence,
} from "@agency_hub_core/db";

// The rule Hub closes a held Fansly greeting on (owner, 2026-11-07): the
// dispatcher's own report of a send whose message went out within ±30 s of the
// dispatch on Fansly's clock, the only one that could be this send, whose
// message the page's archive has as its own, in that chat, not deleted, and no
// other send carries. The reporting computer's clock plays no part
// (2026-11-12: one install ran ~41 s ahead). Anything else leaves the send as
// it is. tests/client-send-custody-archive.integration.test.ts covers the SQL,
// the lock and the close.

const DISPATCHED = new Date("2026-11-05T23:40:14.000Z");
const NOW = new Date("2026-11-07T06:00:00.000Z");
const at = (ms: number) => new Date(DISPATCHED.getTime() + ms);
const ME = 30;
const FAN = "800000000000001";
const CHAT = "900000000000001";

const custody = (over: Partial<HeldSendArchiveCustody> = {}): HeldSendArchiveCustody => ({
  attemptId: "20000000-0000-4000-8000-000000000001", pageId: 10, fanRef: FAN, userId: ME,
  instanceId: "00000000-0000-4000-8000-000000000001", platform: "fansly", origin: "preview-send", purpose: "greeting",
  partCount: 1, state: "dispatching", ticketExpiresAt: at(10_000), createdAt: DISPATCHED, ...over,
});
const attribution = (over: Partial<HeldSendArchiveAttribution> = {}): HeldSendArchiveAttribution => ({
  platformMessageId: "700000000000001", userId: ME, fanRef: FAN, conversationRef: CHAT, observedAt: at(-870),
  recordedAt: at(1_200), source: "fansly-extension", composedWith: "hi", observationId: 5, boundElsewhere: false,
  archive: { id: 1, sentByMe: true, deleted: false, conversationRef: CHAT, occurredAt: at(-200) },
  ...over,
});
const evidence = (over: Partial<HeldSendArchiveEvidence> = {}): HeldSendArchiveEvidence => ({
  now: NOW, custody: custody(), attributions: [attribution()], ...over,
});

describe("closing a held Fansly greeting on the archive's copy", () => {
  it("closes it with the message of the dispatcher's report, dated by the archive's copy", () => {
    expect(decideHeldSendArchiveProof(evidence())).toEqual({
      close: true, attribution: attribution(), platformMessageId: "700000000000001", sentAt: at(-200),
    });
  });

  it("settles a send whose computer's clock is off, on Fansly's time of the message", () => {
    // The install of 2026-11-09: every report ~38-41 s ahead of the dispatch, the message itself within a second of it.
    for (const skew of [38_000, 41_000, 49_000, -41_000, -10 * 60_000]) {
      expect(decideHeldSendArchiveProof(evidence({ attributions: [attribution({ observedAt: at(skew) })] })), String(skew))
        .toMatchObject({ close: true, platformMessageId: "700000000000001", sentAt: at(-200) });
    }
  });

  it("does not close a send that never went out on another message of the same person, whatever the clock says", () => {
    // The greeting failed (no report of it). The chatter's message to the fan 50 s before, on a computer 41 s ahead:
    // its report reads 9 s before the dispatch, Fansly dates it 50 s before. It is not this send.
    const earlier = attribution({
      platformMessageId: "700000000000009", observedAt: at(-9_000), recordedAt: at(-49_000), composedWith: "hand",
      archive: { id: 9, sentByMe: true, deleted: false, conversationRef: CHAT, occurredAt: at(-50_000) },
    });
    expect(decideHeldSendArchiveProof(evidence({ attributions: [earlier] }))).toEqual({ close: false, reason: "no_attribution" });
    // Reported late, while Hub's archive still dates it a minute before: still not this send.
    const reportedLate = attribution({ ...earlier, recordedAt: at(2_000) });
    expect(decideHeldSendArchiveProof(evidence({ attributions: [reportedLate] }))).toEqual({ close: false, reason: "no_attribution" });
    // Nothing reported at all.
    expect(decideHeldSendArchiveProof(evidence({ attributions: [] }))).toEqual({ close: false, reason: "no_attribution" });
  });

  it("looks only at a dispatch past its ticket and the grace", () => {
    const expired = DISPATCHED.getTime() + 10_000;
    const graceEnds = new Date(expired + CLIENT_SEND_ARCHIVE_GRACE_MS);
    expect(decideHeldSendArchiveProof(evidence({ now: new Date(graceEnds.getTime() - 1) }))).toEqual({ close: false, reason: "not_held" });
    expect(decideHeldSendArchiveProof(evidence({ now: graceEnds })).close).toBe(true);
    for (const state of ["sent", "failed", "resolved_sent", "resolved_not_sent", "unconfirmed"] as const) {
      expect(decideHeldSendArchiveProof(evidence({ custody: custody({ state }) }))).toEqual({ close: false, reason: "not_held" });
    }
    expect(decideHeldSendArchiveProof(evidence({ custody: custody({ ticketExpiresAt: null }) }))).toEqual({ close: false, reason: "not_held" });
  });

  it("takes only a one-part greeting sent from the preview on Fansly", () => {
    for (const over of [
      { platform: "onlyfans" }, { purpose: "preview-reply" as const }, { origin: "native-register" as const }, { partCount: 2 },
    ]) {
      expect(decideHeldSendArchiveProof(evidence({ custody: custody(over) }))).toEqual({ close: false, reason: "not_fansly_greeting" });
    }
  });

  it("needs the dispatcher's own report to this fan of a message Fansly dates within ±30 s", () => {
    const edge = CLIENT_SEND_ARCHIVE_PROOF_WINDOW_MS;
    const dated = (occurredAt: Date) => attribution({ archive: { id: 1, sentByMe: true, deleted: false, conversationRef: CHAT, occurredAt } });
    for (const occurredAt of [at(-edge), at(edge)]) {
      expect(decideHeldSendArchiveProof(evidence({ attributions: [dated(occurredAt)] }))).toMatchObject({ close: true, sentAt: occurredAt });
    }
    for (const other of [
      dated(at(edge + 1)), dated(at(-edge - 1)),
      attribution({ userId: ME + 1 }), attribution({ fanRef: "800000000000002" }),
    ]) {
      expect(decideHeldSendArchiveProof(evidence({ attributions: [other] }))).toEqual({ close: false, reason: "no_attribution" });
    }
  });

  it("never picks between two reports, and skips the one another send already carries", () => {
    // A greeting and a hand message within the window: which one is this send is unknown, a person decides.
    const hand = attribution({
      platformMessageId: "700000000000002", observedAt: at(9_000), recordedAt: at(9_500), composedWith: "hand",
      archive: { id: 2, sentByMe: true, deleted: false, conversationRef: CHAT, occurredAt: at(9_000) },
    });
    expect(decideHeldSendArchiveProof(evidence({ attributions: [attribution(), hand] }))).toEqual({ close: false, reason: "ambiguous" });
    // The hand message's copy is not in the archive yet: Hub's receipt of its report makes it a candidate all the same.
    const handUnarchived = attribution({ ...hand, archive: null });
    expect(decideHeldSendArchiveProof(evidence({ attributions: [attribution(), handUnarchived] })))
      .toEqual({ close: false, reason: "ambiguous" });
    // One Hub received long before or after the dispatch is not.
    for (const recordedAt of [at(-60_000), at(60_000)]) {
      expect(decideHeldSendArchiveProof(evidence({ attributions: [attribution(), attribution({ ...handUnarchived, recordedAt })] })))
        .toMatchObject({ close: true, platformMessageId: "700000000000001" });
    }
    // Another person's send to the fan is theirs, not a second candidate.
    const colleague = attribution({ platformMessageId: "700000000000003", userId: ME + 1 });
    expect(decideHeldSendArchiveProof(evidence({ attributions: [attribution(), colleague] }))).toMatchObject({
      close: true, platformMessageId: "700000000000001",
    });
    // The report another send carries is that send's: the other one is this send's.
    const taken = attribution({ platformMessageId: "700000000000004", boundElsewhere: true });
    expect(decideHeldSendArchiveProof(evidence({ attributions: [taken, attribution()] }))).toMatchObject({
      close: true, platformMessageId: "700000000000001",
    });
    expect(decideHeldSendArchiveProof(evidence({ attributions: [taken] }))).toEqual({ close: false, reason: "taken" });
  });

  it("needs the page's own archive copy, in that chat, not deleted, dated", () => {
    const copy = attribution().archive!;
    for (const archive of [
      // No copy yet, or one Fansly gave no time: Hub's receipt of the report times it, it does not prove it.
      null,
      { ...copy, occurredAt: null },
      { ...copy, sentByMe: false },
      { ...copy, deleted: true },
      { ...copy, conversationRef: "900000000000002" },
      { ...copy, conversationRef: null },
    ]) {
      expect(decideHeldSendArchiveProof(evidence({ attributions: [attribution({ archive })] })))
        .toEqual({ close: false, reason: "not_in_archive" });
    }
    expect(decideHeldSendArchiveProof(evidence({ attributions: [attribution({ conversationRef: null })] })))
      .toEqual({ close: false, reason: "not_in_archive" });
  });
});
