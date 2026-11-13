import { describe, expect, it } from "vitest";

import type { ShiftReportNote } from "../packages/contracts/src/index.ts";
import { noteParts, noteSalesMore, placeNotes, type NoteRow } from "../apps/workboard/src/shared/reportNotes.ts";

// «Смены» count a shift's sales by the rule «чья продажа»; people are paid by the day's report. Hub says per person
// and report day what stands between the two (`shiftReportNotes`); here a day's note finds its row — the day's last
// shift — and its words: «не в отчёте: 2 продажи, $31.98 · в отчёте по словам: $12.00 · в посте иначе: +$15.00».
// Invented people and amounts.

const msk = (at: string) => new Date(`${at.replace(" ", "T")}:00+03:00`).toISOString();

function row(userId: number | null, from: string, to: string, ongoing = false): NoteRow {
  return { key: `${userId ?? "me"}:${msk(from)}`, userId, startedAt: msk(from), endedAt: msk(to), ongoing };
}

function note(userIds: number[], reportDate: string, extra: Partial<ShiftReportNote> = {}): ShiftReportNote {
  return { userIds, reportDate, unreported: { count: 0, mills: 0, sales: [] }, byWordsMills: 0, postApartMills: 0, sumOnlyMills: null, ...extra };
}

const unreported = (count: number, mills: number): ShiftReportNote["unreported"] => ({
  count,
  mills,
  sales: Array.from({ length: Math.min(count, 2) }, (_, index) => ({
    saleId: 900 + index, occurredAt: msk(`2026-11-10 01:0${index}`), pageLabel: "mia-1", kind: index === 0 ? "message_purchase" : "tip", netMills: 15_990,
  })),
});

describe("the row a day's note stands under", () => {
  it("the last shift of the person's report day, whichever of their logins worked it", () => {
    const morning = row(11, "2026-11-10 08:00", "2026-11-10 12:00");
    const evening = row(12, "2026-11-10 18:00", "2026-11-10 23:00");
    const other = row(21, "2026-11-10 09:00", "2026-11-10 17:00");
    const day = note([11, 12], "2026-11-10", { byWordsMills: 12_000 });
    expect([...placeNotes([evening, other, morning], [day])]).toEqual([[evening.key, { note: day, ofDay: true }]]);
    expect([...placeNotes([other, morning], [day])]).toEqual([[morning.key, { note: day, ofDay: false }]]);
    // None of the day's shifts is on the screen («Мои смены» of someone else, a page filter): no row, no note.
    expect(placeNotes([other], [day]).size).toBe(0);
  });

  it("a night is the day the ledger reports it on; a day with a shift still going says nothing yet", () => {
    const night = row(21, "2026-11-10 23:00", "2026-11-11 07:00");
    const wednesday = note([21], "2026-11-11", { postApartMills: 5_000 });
    expect([...placeNotes([night], [wednesday])]).toEqual([[night.key, { note: wednesday, ofDay: false }]]);
    expect(placeNotes([night], [note([21], "2026-11-10", { postApartMills: 5_000 })]).size).toBe(0);
    const going = row(21, "2026-11-11 08:00", "2026-11-11 12:00", true);
    expect(placeNotes([night, going], [wednesday]).size).toBe(0);
  });

  it("on a person's own screen every note is theirs: the rows name no login", () => {
    const first = row(null, "2026-11-10 10:00", "2026-11-10 13:00");
    const second = row(null, "2026-11-10 15:00", "2026-11-10 21:00");
    const day = note([11, 12], "2026-11-10", { byWordsMills: 12_000 });
    expect([...placeNotes([first, second], [day])]).toEqual([[second.key, { note: day, ofDay: true }]]);
  });

  it("the ledger not answering is no line at all", () => {
    expect(placeNotes([row(11, "2026-11-10 10:00", "2026-11-10 18:00")], null).size).toBe(0);
  });
});

describe("the note's words", () => {
  const texts = (value: ShiftReportNote, ofDay = false, sum?: boolean) => noteParts({ note: value, ofDay }, sum === undefined ? {} : { sum }).map((part) => part.text);

  it("names each thing in its order: sales in no report, sums by word, the post apart", () => {
    const all = note([11], "2026-11-10", { unreported: unreported(2, 31_980), byWordsMills: 12_000, postApartMills: 15_000 });
    expect(texts(all)).toEqual(["не в отчёте: 2 продажи, $31.98", "в отчёте по словам: $12.00", "в посте иначе: +$15.00"]);
    expect(noteParts({ note: all, ofDay: false }).map((part) => part.kind)).toEqual(["unreported", "byWords", "postApart"]);
    expect(texts(note([11], "2026-11-10", { postApartMills: -8_000 }))).toEqual(["в посте иначе: −$8.00"]);
  });

  it("counts sales the Russian way: 1 продажа, 2 продажи, 5 продаж, 11 продаж, 21 продажа", () => {
    const words = (count: number) => texts(note([11], "2026-11-10", { unreported: unreported(count, 10_000) }))[0];
    expect(words(1)).toBe("не в отчёте: 1 продажа, $10.00");
    expect(words(2)).toBe("не в отчёте: 2 продажи, $10.00");
    expect(words(5)).toBe("не в отчёте: 5 продаж, $10.00");
    expect(words(11)).toBe("не в отчёте: 11 продаж, $10.00");
    expect(words(21)).toBe("не в отчёте: 21 продажа, $10.00");
  });

  it("nothing for a day with nothing to say", () => {
    expect(texts(note([11], "2026-11-10"))).toEqual([]);
  });

  it("a report with no breakdown says its sum, as before: of the shift, or of the day's several shifts", () => {
    const hand = note([11], "2026-11-10", { sumOnlyMills: 446_400 });
    expect(texts(hand)).toEqual(["в отчёте $446.40"]);
    expect(texts(hand, true)).toEqual(["в отчёте за день $446.40"]);
    // Where the row's own number is the report's sum («Мои смены»), it is not said again.
    expect(texts(hand, false, false)).toEqual([]);
  });

  it("says how many sales Hub counted and did not list", () => {
    expect(noteSalesMore(note([11], "2026-11-10", { unreported: unreported(5, 80_000) }))).toBe("и ещё 3");
    expect(noteSalesMore(note([11], "2026-11-10", { unreported: unreported(2, 31_980) }))).toBeNull();
  });
});
