import { SHIFT_REPORT_PHASES, saleSiteWords } from "@agency_hub_core/contracts";
import type { HandinVersionLine } from "@agency_hub_core/db";
import { describe, expect, it } from "vitest";

import { reportSums } from "../apps/runtime/src/services/sale-claim-rules.ts";
import {
  checkLetsConfirm,
  cardSuperseded,
  confirmedLines,
  holdsSale,
  lineWithWord,
  mayAct,
  sameAsSigned,
  signedLines,
  takeNoticeOpen,
  takeSettles,
  withSettlementsNow,
  type BoardAction,
} from "../apps/runtime/src/services/shift-report-phases.ts";

// The «Отчёт» board (package R): who may do what in each phase, when the check lets the person confirm, what a
// version made at «Подтверждаю» counts with Gengar's proposals, and a take of a colleague's sale.

const ACTIONS: BoardAction[] = ["edit", "note", "ask", "handIn", "confirm", "reopen", "cancel", "resend", "answerProposal"];
const person = { access: "own" as const, kind: "person" as const, enabled: true };
const colleague = { access: "read" as const, kind: "person" as const, enabled: true };
const agent = { access: "own" as const, kind: "agent" as const, enabled: true };

function line(id: number, over: Partial<HandinVersionLine> & { shareMills?: number; home?: string; toUserId?: number | null } = {}): HandinVersionLine {
  const net = over.netMills ?? 10_000;
  const shareMills = over.shareMills ?? net;
  return {
    transactionId: id,
    offPlatformId: null,
    group: shareMills > 0 ? "mine" : "near",
    pageLabel: "mia-2",
    kind: "message_purchase",
    occurredAt: "2026-11-12T19:00:00.000Z",
    netMills: net,
    rule: { home: over.home ?? (shareMills > 0 ? "shift" : "nobody"), reason: "holder", shareMills, toUserId: over.toUserId ?? null, senderUserId: null },
    alreadyIn: null,
    statement: null,
    shareWithUserId: null,
    note: null,
    amountMills: shareMills,
    added: false,
    disputed: false,
    ...over,
  };
}

describe("who may do what on the board", () => {
  it("a colleague, a team lead or the owner reading someone's board never confirms, edits or hands it in", () => {
    for (const phase of SHIFT_REPORT_PHASES) {
      for (const action of ACTIONS) expect(mayAct(colleague, action, phase)).toBe(false);
    }
  });

  it("an agent never confirms, reopens, cancels, sends late sales or answers a card; it hands in «со слов» from the draft only", () => {
    for (const phase of SHIFT_REPORT_PHASES) {
      for (const action of ["confirm", "reopen", "cancel", "resend", "answerProposal", "ask"] as const) expect(mayAct(agent, action, phase)).toBe(false);
    }
    expect(mayAct(agent, "handIn", "draft")).toBe(true);
    expect(mayAct(agent, "handIn", "confirm")).toBe(false);
  });

  it("the person confirms only in «Подтвердите», edits only in the draft and «Правка», and does nothing while it is checked", () => {
    for (const phase of SHIFT_REPORT_PHASES) {
      expect(mayAct(person, "confirm", phase)).toBe(phase === "confirm");
      expect(mayAct(person, "edit", phase)).toBe(phase === "draft" || phase === "fixing");
      expect(mayAct(person, "resend", phase)).toBe(phase === "counted");
    }
    for (const action of ACTIONS) expect(mayAct(person, action, "checking")).toBe(false);
    expect(mayAct({ ...person, enabled: false }, "handIn", "draft")).toBe(false);
  });
});

describe("the check holds the person for 10 minutes at most", () => {
  const handedInAt = new Date("2026-11-12T23:04:00Z");
  const at = (minutes: number) => new Date(handedInAt.getTime() + minutes * 60_000);

  it("lets the person confirm at once when nothing checks it, or once both checks are in", () => {
    expect(checkLetsConfirm({ handedInAt, now: handedInAt, hubPending: false, gengarPending: false })).toBe(true);
  });

  it("waits while Gengar reads or Hub reads a page, until the server's timer says 10 minutes", () => {
    expect(checkLetsConfirm({ handedInAt, now: at(9.9), hubPending: false, gengarPending: true })).toBe(false);
    expect(checkLetsConfirm({ handedInAt, now: at(9.9), hubPending: true, gengarPending: false })).toBe(false);
    expect(checkLetsConfirm({ handedInAt, now: at(10), hubPending: true, gengarPending: true })).toBe(true);
  });
});

describe("a version made at «Подтверждаю»", () => {
  // The prototype's Gengar: Viggo «моя» → «пополам с Севой» (−$24), quill «ничья» → «моя» (+$8: the person's word).
  const viggo = line(3, { netMills: 48_000 });
  const quill = line(20, { netMills: 8_000, shareMills: 0, home: "nobody" });
  const dario = line(7, { netMills: 40_000 });
  const share = { transactionId: 3, kind: "owner_change" as const, toWord: "share" as const, toUserId: 77, note: null };
  const mine = { transactionId: 20, kind: "owner_change" as const, toWord: "mine" as const, toUserId: null, note: null };

  it("counts the proposals the person did not decline", () => {
    const lines = confirmedLines([viggo, quill, dario], [{ ...share, state: "proposed" }, { ...mine, state: "proposed" }]);
    expect(lines.map((one) => one.amountMills)).toEqual([24_000, 8_000, 40_000]);
    expect(reportSums(lines, ["mia-2"]).totalMills).toBe(72_000);
    expect(lines[0]).toMatchObject({ statement: "share", shareWithUserId: 77 });
    expect(lines[1]).toMatchObject({ statement: "mine", disputed: false });
    expect(lines[1]!.claimedMills).toBeUndefined();
  });

  it("leaves a declined proposal's line as the person had it", () => {
    const lines = confirmedLines([viggo, quill, dario], [{ ...share, state: "declined" }, { ...mine, state: "proposed" }]);
    expect(lines.map((one) => one.amountMills)).toEqual([48_000, 8_000, 40_000]);
    expect(lines[0]!.statement).toBeNull();
    expect(reportSums(lines, ["mia-2"]).totalMills).toBe(96_000);
  });

  it("never applies a late proposal (it waits for «Принять»)", () => {
    const lines = confirmedLines([viggo], [{ ...share, state: "late" }]);
    expect(lines[0]!.amountMills).toBe(48_000);
  });

  it("counts nothing of a sale given to a colleague or to the pot", () => {
    expect(lineWithWord(dario, { statement: "give", toUserId: 77 })).toMatchObject({ amountMills: 0, toUserId: 77, disputed: false });
    expect(lineWithWord(dario, { statement: "pot" }).amountMills).toBe(0);
  });
});

describe("a take of a colleague's sale", () => {
  const takenAt = new Date("2026-11-12T20:00:00Z");
  const claim = { kind: "claim", state: "asked", sideUserId: 77 };
  const taken = { kind: "claim", state: "agreed", sideUserId: 77, silenceAt: takenAt, answer: null };
  const later = (hours: number) => new Date(takenAt.getTime() + hours * 3_600_000);

  it("settles a colleague's sale for the one who said it at once, with no day of silence", () => {
    expect(takeSettles(claim)).toBe(true);
  });

  it("never settles the pot's question, one with nobody to ask, or one already answered or settled", () => {
    expect(takeSettles({ ...claim, sideUserId: null })).toBe(false);
    expect(takeSettles({ ...claim, state: "owner" })).toBe(false);
    expect(takeSettles({ ...claim, state: "agreed" })).toBe(false);
    expect(takeSettles({ ...claim, kind: "double" })).toBe(false);
  });

  it("keeps the side's notice open a week while unanswered, and closes it on an answer", () => {
    expect(takeNoticeOpen(taken, later(167.9))).toBe(true);
    expect(takeNoticeOpen(taken, later(168))).toBe(false);
    expect(takeNoticeOpen({ ...taken, answer: "agree" }, later(1))).toBe(false);
    expect(takeNoticeOpen({ ...taken, state: "owner" }, later(1))).toBe(false);
    expect(takeNoticeOpen({ ...taken, silenceAt: null }, later(1))).toBe(false);
  });
});

describe("what changed since the hand-in, read at «Подтверждаю»", () => {
  it("drops a «долёт» another report of the person took meanwhile: a sale counts in one report only", () => {
    const late = line(30, { netMills: 100_000, added: true });
    const own = line(31, { netMills: 20_000 });
    // The draft now: the other report holds the «долёт», so it is no line here any more.
    const lines = withSettlementsNow([late, own], [own]);
    expect(lines.map((one) => one.transactionId)).toEqual([31]);
  });

  it("counts 0 a sale another report of the person holds now", () => {
    const sold = line(32, { netMills: 50_000 });
    const [held] = withSettlementsNow([sold], [{ ...sold, alreadyIn: { shiftId: 9, reportDate: "2026-11-12" }, amountMills: 0 }]);
    expect(held).toMatchObject({ amountMills: 0, alreadyIn: { shiftId: 9 } });
  });

  it("takes a decision made since the hand-in, and drops one cancelled since", () => {
    const disputed = line(33, { netMills: 16_000, shareMills: 0, home: "shift", toUserId: 5, statement: "mine", amountMills: 0, disputed: true, claimedMills: 16_000 });
    const { claimedMills: _claimed, ...plain } = disputed;
    const [decided] = withSettlementsNow([disputed], [{ ...plain, amountMills: 8_000, disputed: false, settled: "owner" }]);
    expect(decided).toMatchObject({ amountMills: 8_000, disputed: false, settled: "owner" });
    expect(decided).not.toHaveProperty("claimedMills");
    const [cancelled] = withSettlementsNow([decided!], [disputed]);
    expect(cancelled).toMatchObject({ amountMills: 0, disputed: true, claimedMills: 16_000 });
    expect(cancelled).not.toHaveProperty("settled");
  });
});

describe("what «Подтверждаю» signs is what «Подтвердите» shows (`signedLines`)", () => {
  const none = new Map<number, number>();
  const noteCard = (transactionId: number, note: string) => ({ transactionId, kind: "note" as const, toWord: null, toUserId: null, note, state: "proposed" as const });

  it("signs the comment the person wrote in «Подтвердите», keeps the candidate's where they wrote none", () => {
    const written = line(40, { note: "старый" });
    const untouched = line(41, { note: "как сдал" });
    const lines = signedLines({ candidate: [written, untouched], draft: [written, untouched], proposals: [], notes: new Map([[40, "фан сам написал в чат"]]), oldWay: none });
    expect(lines.map((one) => one.note)).toEqual(["фан сам написал в чат", "как сдал"]);
  });

  it("a person's comment wins over Gengar's card of a comment; with none, the card's is signed", () => {
    const sale = line(42);
    const [mine] = signedLines({ candidate: [sale], draft: [sale], proposals: [noteCard(42, "Генгар: PPV из рассылки")], notes: new Map([[42, "мой PPV"]]), oldWay: none });
    expect(mine).toMatchObject({ note: "мой PPV" });
    expect(mine).not.toHaveProperty("noteByAgent");
    const [gengar] = signedLines({ candidate: [sale], draft: [sale], proposals: [noteCard(42, "Генгар: PPV из рассылки")], notes: new Map(), oldWay: none });
    expect(gengar).toMatchObject({ note: "Генгар: PPV из рассылки", noteByAgent: true });
  });

  it("signs a colleague's agreement given in «Подтвердите»: taken at 0, agreed — 10", () => {
    const taken = line(43, { netMills: 10_000, shareMills: 0, home: "shift", toUserId: 5, statement: "mine", amountMills: 0, disputed: true, claimedMills: 10_000 });
    const { claimedMills: _claimed, ...plain } = taken;
    const [signed] = signedLines({ candidate: [taken], draft: [{ ...plain, amountMills: 10_000, disputed: false, settled: "agreed" }], proposals: [], notes: new Map(), oldWay: none });
    expect(signed).toMatchObject({ amountMills: 10_000, disputed: false });
    expect(reportSums([signed!], ["mia-2"]).totalMills).toBe(10_000);
  });

  it("the total signed counts «мимо площадки» the owner confirmed, on its page", () => {
    const sale = line(44, { netMills: 20_000 });
    const lines = signedLines({ candidate: [sale], draft: [sale], proposals: [], notes: new Map(), oldWay: none });
    const sums = reportSums(lines, ["mia-2"], [{ amountMills: 5_000, state: "confirmed", pageLabel: "mia-2" }, { amountMills: 7_000, state: "pending", pageLabel: null }]);
    expect(sums.totalMills).toBe(25_000);
  });

  it("«отдать» a colleague without the board is signed as the person's «не моё»", () => {
    const sale = line(45, { netMills: 10_000 });
    const [given] = signedLines({
      candidate: [sale], draft: [sale], notes: new Map(), oldWay: new Map([[45, 7]]),
      proposals: [{ transactionId: 45, kind: "owner_change", toWord: "give", toUserId: 7, note: null, state: "proposed" }],
    });
    expect(given).toMatchObject({ statement: "not_mine" });
  });
});

describe("which line of a counted version holds its sale (`holdsSale`)", () => {
  it("holds what it counts or says something of; a $0 line with nothing on it holds nothing", () => {
    expect(holdsSale(line(50))).toBe(true);
    expect(holdsSale(line(51, { shareMills: 0 }))).toBe(false);
    expect(holdsSale(line(52, { shareMills: 0, statement: "not_mine" }))).toBe(true);
    expect(holdsSale(line(53, { shareMills: 0, statement: "mine", disputed: true }))).toBe(true);
    expect(holdsSale(line(54, { shareMills: 0, settled: "owner" }))).toBe(true);
  });
});

describe("a line that waits for the decider since the hand-in (third reader, 6)", () => {
  it("signs it at 0, claiming what it counted: «Не согласен» with a card waits as any disputed row", () => {
    const own = line(60, { netMills: 12_000 });
    const [signed] = withSettlementsNow([own], [{ ...own, amountMills: 0, disputed: true, claimedMills: 12_000 }]);
    expect(signed).toMatchObject({ amountMills: 0, disputed: true, claimedMills: 12_000 });
  });
});

describe("the sites' words of a row (third reader, 8)", () => {
  it("reads the rule's kinds and the stored ones alike, as Wallet activity and the statement do", () => {
    expect(saleSiteWords("fansly", "ppv")).toBe("Media Sale to");
    expect(saleSiteWords("fansly", "message_purchase")).toBe("Media Sale to");
    expect(saleSiteWords("fansly", "post")).toBe("Media Sale to");
    expect(saleSiteWords("onlyfans", "ppv")).toBe("Payment for message from");
    expect(saleSiteWords("onlyfans", "stream_tip")).toBe("Tip from");
    expect(saleSiteWords("fansly", "something")).toBe("Sale to");
  });
});

describe("a settlement outranks Gengar's card (round 2, N3)", () => {
  const share = { transactionId: 70, kind: "owner_change" as const, toWord: "share" as const, toUserId: 9, note: null, state: "proposed" as const };

  it("signs the decision made after the card: «пополам» on a sale decided away changes nothing", () => {
    const own = line(70, { netMills: 10_000 });
    const decided = { ...own, amountMills: 0, settled: "owner" as const };
    const [signed] = signedLines({ candidate: [own], draft: [decided], proposals: [share], notes: new Map(), oldWay: new Map() });
    expect(signed).toMatchObject({ amountMills: 0, settled: "owner" });
    expect(cardSuperseded(share, decided)).toBe(true);
    // Without a settlement the card applies, as before.
    const [carded] = signedLines({ candidate: [own], draft: [own], proposals: [share], notes: new Map(), oldWay: new Map() });
    expect(carded).toMatchObject({ amountMills: 5_000, statement: "share" });
  });

  it("never supersedes a comment card", () => {
    expect(cardSuperseded({ kind: "note" }, { settled: "owner" })).toBe(false);
  });
});

describe("the signature at «Сдать смену» signs the candidate as handed in", () => {
  const signed = {
    lines: [{ transactionId: 1, amountMills: 100_000 }, { transactionId: 2, amountMills: 0 }],
    pages: [{ pageLabel: "mia-2", amountMills: 100_000 }, { pageLabel: "mia-3", amountMills: 0 }],
    offPlatform: [{ id: 7, amountMills: 20_000, state: "pending", pageLabel: null }],
  };

  it("holds when nothing changed", () => {
    expect(sameAsSigned(signed, structuredClone(signed))).toBe(true);
  });

  it("refuses a decision that moved the money to another sale of the same total and count", () => {
    const swapped = { ...signed, lines: [{ transactionId: 1, amountMills: 0 }, { transactionId: 2, amountMills: 100_000 }] };
    expect(sameAsSigned(signed, swapped)).toBe(false);
  });

  it("refuses the same sales split between pages otherwise", () => {
    expect(sameAsSigned(signed, { ...signed, pages: [{ pageLabel: "mia-2", amountMills: 0 }, { pageLabel: "mia-3", amountMills: 100_000 }] })).toBe(false);
  });

  it("refuses a «мимо площадки» the owner decided since", () => {
    expect(sameAsSigned(signed, { ...signed, offPlatform: [{ id: 7, amountMills: 20_000, state: "confirmed", pageLabel: "mia-2" }] })).toBe(false);
  });
});
