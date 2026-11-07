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
// dispatcher's own report of the send within ±30 s, the only one that could be
// this send, whose message the page's archive has as its own, in that chat, not
// deleted, and no other send carries. Anything else leaves the send as it is.
// tests/client-send-custody-archive.integration.test.ts covers the SQL, the
// lock and the close.

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
  source: "fansly-extension", composedWith: "hi", observationId: 5, boundElsewhere: false,
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
    // A copy with no time is dated by the dispatch; a copy dated in the future, by now.
    const undated = attribution({ archive: { id: 1, sentByMe: true, deleted: false, conversationRef: CHAT, occurredAt: null } });
    expect(decideHeldSendArchiveProof(evidence({ attributions: [undated] }))).toMatchObject({ close: true, sentAt: DISPATCHED });
    const ahead = attribution({ archive: { id: 1, sentByMe: true, deleted: false, conversationRef: CHAT, occurredAt: new Date(NOW.getTime() + 5_000) } });
    expect(decideHeldSendArchiveProof(evidence({ attributions: [ahead] }))).toMatchObject({ close: true, sentAt: NOW });
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

  it("needs the dispatcher's own report to this fan within ±30 s", () => {
    const edge = CLIENT_SEND_ARCHIVE_PROOF_WINDOW_MS;
    for (const observedAt of [at(-edge), at(edge)]) {
      expect(decideHeldSendArchiveProof(evidence({ attributions: [attribution({ observedAt })] })).close).toBe(true);
    }
    for (const other of [
      attribution({ observedAt: at(edge + 1) }), attribution({ observedAt: at(-edge - 1) }),
      attribution({ userId: ME + 1 }), attribution({ fanRef: "800000000000002" }),
    ]) {
      expect(decideHeldSendArchiveProof(evidence({ attributions: [other] }))).toEqual({ close: false, reason: "no_attribution" });
    }
    expect(decideHeldSendArchiveProof(evidence({ attributions: [] }))).toEqual({ close: false, reason: "no_attribution" });
  });

  it("never picks between two reports, and skips the one another send already carries", () => {
    // A greeting and a hand message within the window: which one is this send is unknown, a person decides.
    const hand = attribution({ platformMessageId: "700000000000002", observedAt: at(9_000), composedWith: "hand" });
    expect(decideHeldSendArchiveProof(evidence({ attributions: [attribution(), hand] }))).toEqual({ close: false, reason: "ambiguous" });
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

  it("needs the page's own archive copy, in that chat, not deleted", () => {
    const copy = attribution().archive!;
    for (const archive of [
      null,
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
