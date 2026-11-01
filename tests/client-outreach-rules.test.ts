import { describe, expect, it } from "vitest";

import {
  OUTREACH_EVIDENCE_MINUTES,
  OUTREACH_RECORD_MAX_AGE_DAYS,
  OUTREACH_SEND_TICKET_SECONDS,
} from "@agency_hub_core/contracts";
import {
  decideOutreachSend,
  normalizeOutreachText,
  OUTREACH_EVIDENCE_AFTER_MS,
  OUTREACH_RECORD_MAX_AGE_MS,
  OUTREACH_SEND_TICKET_MS,
  outreachCreatedAt,
  outreachEvidenceDue,
  outreachRecordClickedAt,
  outreachSendViewState,
  outreachTextMatches,
  pickOutreachEvidence,
  type OutreachSendRequest,
  type OutreachSendRow,
  type OutreachSendSnapshot,
} from "@agency_hub_core/db";

// «Рассылки» kept by Hub (docs/plans/2026-11-01-outreach-store/spec.md §5): the
// rules of one fan's send, row by row of the spec's table, and the archive's
// proof of an uncertain send.

const NOW = new Date("2026-11-01T12:00:00.000Z");
const ME = 7;
const OTHER = 8;
const A = "0b7c2a3e-6a5d-4c2e-9f11-2b9d3c4e5f60";
const B = "1c8d3b4f-7b6e-4d3f-8a22-3c0e4d5f6a71";
const sec = (n: number) => new Date(NOW.getTime() + n * 1000);

function send(over: Partial<OutreachSendRow> = {}): OutreachSendRow {
  return { state: "sending", attemptId: A, senderUserId: ME, clickedAt: sec(-10), ticketUntil: sec(110), ...over };
}
const snapshot = (over: Partial<OutreachSendSnapshot> = {}): OutreachSendSnapshot => ({ now: NOW, send: null, othersSending: [], ...over });
const claim = (over: Partial<Extract<OutreachSendRequest, { action: "claim" }>> = {}): OutreachSendRequest => ({
  action: "claim", attemptId: A, userId: ME, text: "hey you", media: null, ...over,
});
const sent = (attemptId = A, userId = ME): OutreachSendRequest => ({ action: "sent", attemptId, userId, platformMessageId: "123" });
const failed = (attemptId = A, userId = ME): OutreachSendRequest => ({ action: "failed", attemptId, userId, code: "CG-SEND-REFUSED" });
const uncertain = (attemptId = A, userId = ME): OutreachSendRequest => ({ action: "uncertain", attemptId, userId });
const record = (over: Partial<Extract<OutreachSendRequest, { action: "record" }>> = {}): OutreachSendRequest => ({
  action: "record", attemptId: B, userId: ME, state: "sent", clickedAt: sec(-3600), sentAt: sec(-3599), text: "hey you",
  media: null, platformMessageId: "456", ...over,
});

describe("outreach send rules", () => {
  it("keeps Hub's numbers equal to the contract's", () => {
    expect(OUTREACH_SEND_TICKET_MS).toBe(OUTREACH_SEND_TICKET_SECONDS * 1000);
    expect(OUTREACH_RECORD_MAX_AGE_MS).toBe(OUTREACH_RECORD_MAX_AGE_DAYS * 24 * 60 * 60_000);
    expect(OUTREACH_EVIDENCE_AFTER_MS).toBe(OUTREACH_EVIDENCE_MINUTES * 60_000);
  });

  it("reads a claim past its ticket as uncertain", () => {
    expect(outreachSendViewState(send(), NOW)).toBe("sending");
    expect(outreachSendViewState(send({ ticketUntil: NOW }), NOW)).toBe("uncertain");
    expect(outreachSendViewState(send({ ticketUntil: sec(-1) }), NOW)).toBe("uncertain");
    expect(outreachSendViewState(send({ state: "sent", ticketUntil: null }), NOW)).toBe("sent");
  });

  describe("claim", () => {
    it("takes a fan with no send: sending, a 120-second ticket, who, when, the text", () => {
      const decision = decideOutreachSend(snapshot(), claim({ media: { vault: ["1"] } }));
      expect(decision).toEqual({
        outcome: "ok",
        writes: [{
          kind: "claim", attemptId: A, userId: ME, clickedAt: NOW, ticketUntil: new Date(NOW.getTime() + 120_000),
          text: "hey you", media: { vault: ["1"] },
        }],
      });
    });

    it("takes a fan whose send failed (proven) again", () => {
      const decision = decideOutreachSend(snapshot({ send: send({ state: "failed", ticketUntil: null }) }), claim({ attemptId: B }));
      expect(decision.outcome).toBe("ok");
      expect(decision.writes).toHaveLength(1);
    });

    it("answers taken for a send that went, may have, or is on its way", () => {
      for (const one of [
        send({ attemptId: B, senderUserId: OTHER }),
        send({ state: "sent", ticketUntil: null }),
        send({ state: "uncertain", ticketUntil: null }),
        // A claim past its ticket reads uncertain: never claimed again, not even by its own attempt.
        send({ ticketUntil: sec(-1) }),
      ]) {
        expect(decideOutreachSend(snapshot({ send: one }), claim()), one.state).toEqual({ outcome: "taken", writes: [] });
      }
    });

    it("answers a repeat of the same live claim ok and changes nothing", () => {
      expect(decideOutreachSend(snapshot({ send: send() }), claim())).toEqual({ outcome: "ok", writes: [] });
      // The attempt id is compared without its case.
      expect(decideOutreachSend(snapshot({ send: send() }), claim({ attemptId: A.toUpperCase() }))).toEqual({ outcome: "ok", writes: [] });
      // The same attempt id from another person is no repeat.
      expect(decideOutreachSend(snapshot({ send: send() }), claim({ userId: OTHER })).outcome).toBe("taken");
    });

    it("answers busy while another outreach's claim on the fan is live", () => {
      const decision = decideOutreachSend(snapshot({ othersSending: [{ outreachId: "other", ticketUntil: sec(30) }] }), claim());
      expect(decision).toEqual({ outcome: "busy", writes: [] });
    });

    it("stores another outreach's claim past its ticket uncertain first, then claims", () => {
      const decision = decideOutreachSend(snapshot({ othersSending: [{ outreachId: "other", ticketUntil: sec(-5) }] }), claim());
      expect(decision.outcome).toBe("ok");
      expect(decision.writes.map((write) => write.kind)).toEqual(["settle_other", "claim"]);
      expect(decision.writes[0]).toEqual({ kind: "settle_other", outreachId: "other" });
    });

    it("prefers taken to busy: this outreach's own send decides first", () => {
      const decision = decideOutreachSend(snapshot({
        send: send({ state: "sent", ticketUntil: null }), othersSending: [{ outreachId: "other", ticketUntil: sec(30) }],
      }), claim());
      expect(decision.outcome).toBe("taken");
    });
  });

  describe("sent", () => {
    it("ends the claim's own attempt from sending, at the report's moment", () => {
      expect(decideOutreachSend(snapshot({ send: send() }), sent())).toEqual({
        outcome: "ok", writes: [{ kind: "sent", sentAt: NOW, platformMessageId: "123" }],
      });
    });

    it("lands late on a claim past its ticket or an uncertain send, dated near its click", () => {
      const late = send({ clickedAt: sec(-600), ticketUntil: sec(-480) });
      for (const one of [late, { ...late, state: "uncertain" as const, ticketUntil: null }]) {
        const decision = decideOutreachSend(snapshot({ send: one }), sent());
        expect(decision.outcome).toBe("ok");
        expect(decision.writes).toEqual([{ kind: "sent", sentAt: sec(-480), platformMessageId: "123" }]);
      }
    });

    it("answers a repeat ok, another attempt's or a failed one not_yours", () => {
      expect(decideOutreachSend(snapshot({ send: send({ state: "sent", ticketUntil: null }) }), sent())).toEqual({ outcome: "ok", writes: [] });
      expect(decideOutreachSend(snapshot({ send: send() }), sent(B)).outcome).toBe("not_yours");
      expect(decideOutreachSend(snapshot({ send: send() }), sent(A, OTHER)).outcome).toBe("not_yours");
      expect(decideOutreachSend(snapshot(), sent()).outcome).toBe("not_yours");
      expect(decideOutreachSend(snapshot({ send: send({ state: "failed", ticketUntil: null }) }), sent()).outcome).toBe("not_yours");
    });
  });

  describe("failed", () => {
    it("ends the claim's own attempt from sending, past its ticket or uncertain: the fan may be claimed again", () => {
      for (const one of [send(), send({ ticketUntil: sec(-1) }), send({ state: "uncertain", ticketUntil: null })]) {
        expect(decideOutreachSend(snapshot({ send: one }), failed())).toEqual({
          outcome: "ok", writes: [{ kind: "failed", code: "CG-SEND-REFUSED" }],
        });
      }
    });

    it("answers a repeat ok; a sent one, another attempt's or none not_yours", () => {
      expect(decideOutreachSend(snapshot({ send: send({ state: "failed", ticketUntil: null }) }), failed())).toEqual({ outcome: "ok", writes: [] });
      expect(decideOutreachSend(snapshot({ send: send({ state: "sent", ticketUntil: null }) }), failed()).outcome).toBe("not_yours");
      expect(decideOutreachSend(snapshot({ send: send() }), failed(B)).outcome).toBe("not_yours");
      expect(decideOutreachSend(snapshot(), failed()).outcome).toBe("not_yours");
    });
  });

  describe("uncertain", () => {
    it("ends the claim's own attempt from sending, live or past its ticket", () => {
      for (const one of [send(), send({ ticketUntil: sec(-1) })]) {
        expect(decideOutreachSend(snapshot({ send: one }), uncertain())).toEqual({ outcome: "ok", writes: [{ kind: "uncertain" }] });
      }
    });

    it("answers a repeat ok; sent, failed, another attempt's or none not_yours", () => {
      expect(decideOutreachSend(snapshot({ send: send({ state: "uncertain", ticketUntil: null }) }), uncertain())).toEqual({ outcome: "ok", writes: [] });
      expect(decideOutreachSend(snapshot({ send: send({ state: "sent", ticketUntil: null }) }), uncertain()).outcome).toBe("not_yours");
      expect(decideOutreachSend(snapshot({ send: send({ state: "failed", ticketUntil: null }) }), uncertain()).outcome).toBe("not_yours");
      expect(decideOutreachSend(snapshot({ send: send() }), uncertain(B)).outcome).toBe("not_yours");
      expect(decideOutreachSend(snapshot(), uncertain()).outcome).toBe("not_yours");
    });
  });

  describe("record", () => {
    it("takes a send made before Hub for a fan with no send, as the client knew it", () => {
      expect(decideOutreachSend(snapshot(), record())).toEqual({
        outcome: "ok",
        writes: [{
          kind: "record", attemptId: B, userId: ME, state: "sent", clickedAt: sec(-3600), sentAt: sec(-3599), text: "hey you",
          media: null, platformMessageId: "456",
        }],
      });
      const unsure = decideOutreachSend(snapshot(), record({ state: "uncertain", sentAt: null }));
      expect(unsure.writes).toEqual([expect.objectContaining({ kind: "record", state: "uncertain", sentAt: null, platformMessageId: null })]);
    });

    it("dates a sent record at its click when it names no moment, never before the click or after now", () => {
      expect(decideOutreachSend(snapshot(), record({ sentAt: null })).writes[0]).toMatchObject({ sentAt: sec(-3600) });
      expect(decideOutreachSend(snapshot(), record({ sentAt: sec(-7200) })).writes[0]).toMatchObject({ sentAt: sec(-3600) });
      expect(decideOutreachSend(snapshot(), record({ sentAt: sec(60) })).writes[0]).toMatchObject({ sentAt: NOW });
    });

    it("takes a fan whose send failed; answers taken for one with a send, ok for the same record again", () => {
      expect(decideOutreachSend(snapshot({ send: send({ state: "failed", ticketUntil: null }) }), record()).outcome).toBe("ok");
      for (const one of [send(), send({ state: "sent", ticketUntil: null }), send({ state: "uncertain", ticketUntil: null })]) {
        expect(decideOutreachSend(snapshot({ send: one }), record()), one.state).toEqual({ outcome: "taken", writes: [] });
      }
      expect(decideOutreachSend(snapshot({ send: send({ attemptId: B, state: "sent", ticketUntil: null }) }), record())).toEqual({ outcome: "ok", writes: [] });
    });

    it("moves its own «may have gone» to «went» when the same attempt is recorded as sent; else changes nothing", () => {
      const own = snapshot({ send: send({ attemptId: B, state: "uncertain", ticketUntil: null }) });
      expect(decideOutreachSend(own, record())).toEqual({ outcome: "ok", writes: [{ kind: "sent", sentAt: sec(-3599), platformMessageId: "456" }] });
      expect(decideOutreachSend(own, record({ state: "uncertain", sentAt: null }))).toEqual({ outcome: "ok", writes: [] });
      // Another person's attempt with the same id is not theirs to settle.
      expect(decideOutreachSend(own, record({ userId: OTHER })).outcome).toBe("taken");
    });

    it("is never busy: another outreach's live claim does not stop a send that already happened", () => {
      expect(decideOutreachSend(snapshot({ othersSending: [{ outreachId: "other", ticketUntil: sec(30) }] }), record()).outcome).toBe("ok");
    });

    it("takes a click at most 30 days old and not in the future (a clock up to 5 minutes ahead reads now)", () => {
      expect(outreachRecordClickedAt(sec(-3600), NOW)).toEqual(sec(-3600));
      expect(outreachRecordClickedAt(sec(120), NOW)).toEqual(NOW);
      expect(outreachRecordClickedAt(sec(600), NOW)).toBeNull();
      expect(outreachRecordClickedAt(new Date(NOW.getTime() - 31 * 24 * 3600_000), NOW)).toBeNull();
      expect(outreachRecordClickedAt(new Date(Number.NaN), NOW)).toBeNull();
    });
  });

  it("takes a first save's own moment within the last 30 days", () => {
    expect(outreachCreatedAt(null, NOW)).toEqual(NOW);
    expect(outreachCreatedAt(sec(-3600), NOW)).toEqual(sec(-3600));
    expect(outreachCreatedAt(sec(3600), NOW)).toEqual(NOW);
    expect(outreachCreatedAt(new Date(NOW.getTime() - 40 * 24 * 3600_000), NOW)).toEqual(new Date(NOW.getTime() - 30 * 24 * 3600_000));
  });
});

describe("the archive's proof of an uncertain send", () => {
  it("normalizes a text: tags away, entities decoded, white space one space, lower case", () => {
    expect(normalizeOutreachText("<p>Hey&nbsp;<b>YOU</b> &amp; me</p>\n\n<p>  soon?</p>")).toBe("hey you & me soon?");
    expect(normalizeOutreachText("Hi&#33; &#x1F600;")).toBe("hi! 😀");
    expect(normalizeOutreachText("  ")).toBe("");
  });

  it("matches on the first 60 normalized characters, or all of a shorter text", () => {
    const long = `${"a".repeat(59)}b and then whatever the platform kept`;
    expect(outreachTextMatches(long, `<p>${"A".repeat(59)}B</p> and something else entirely`)).toBe(true);
    expect(outreachTextMatches(long, `${"a".repeat(59)}c`)).toBe(false);
    expect(outreachTextMatches("hey", "hey there")).toBe(false);
    expect(outreachTextMatches("Hey  there", "hey there")).toBe(true);
    // Characters, not UTF-16 units: an emoji at the cut counts once.
    expect(outreachTextMatches(`${"😀".repeat(60)}x`, `${"😀".repeat(60)}y`)).toBe(true);
    // An empty text proves nothing.
    expect(outreachTextMatches("<p></p>", "")).toBe(false);
  });

  it("asks the archive about a send that reads uncertain, within 30 days of its click", () => {
    expect(outreachEvidenceDue(send({ state: "uncertain", ticketUntil: null }), NOW)).toBe(true);
    expect(outreachEvidenceDue(send({ ticketUntil: sec(-1) }), NOW)).toBe(true);
    expect(outreachEvidenceDue(send(), NOW)).toBe(false);
    expect(outreachEvidenceDue(send({ state: "sent", ticketUntil: null }), NOW)).toBe(false);
    expect(outreachEvidenceDue(send({ state: "failed", ticketUntil: null }), NOW)).toBe(false);
    expect(outreachEvidenceDue(send({ state: "uncertain", ticketUntil: null, clickedAt: new Date(NOW.getTime() - 31 * 24 * 3600_000) }), NOW)).toBe(false);
  });

  it("takes the earliest of the page's messages with the text from a minute before the click to 30 minutes after", () => {
    const click = NOW;
    const at = (minutes: number) => new Date(click.getTime() + minutes * 60_000);
    const messages = [
      { id: "early", at: at(-2), text: "hey you" },
      { id: "other", at: at(1), text: "something else" },
      { id: "first", at: at(-0.5), text: "<p>Hey you</p>" },
      { id: "second", at: at(5), text: "hey you" },
      { id: "late", at: at(31), text: "hey you" },
    ];
    expect(pickOutreachEvidence({ clickedAt: click, text: "Hey you" }, messages)?.id).toBe("first");
    expect(pickOutreachEvidence({ clickedAt: click, text: "Hey you" }, messages.filter((one) => one.id !== "first"))?.id).toBe("second");
    expect(pickOutreachEvidence({ clickedAt: click, text: "Hey you" }, [messages[0]!, messages[4]!])).toBeNull();
    expect(pickOutreachEvidence({ clickedAt: click, text: "Hey you" }, [])).toBeNull();
  });
});
