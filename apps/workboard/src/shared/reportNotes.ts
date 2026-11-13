/**
 * What stands between a day's shifts and the report it is paid by, on «Смены» and «Мои смены» — pure, no React
 * (tests/workboard-shifts-reports.test.ts). A shift's money on the screens is the rule's («чья продажа»); people are
 * paid by the day's report. Hub says, per person and report day, only the named things somebody can act on
 * (`shiftReportNotes`: Hub pairs the reports' lines with the sales, so a sale paid in a later report — «долёт» — is no
 * difference at all), and nothing for a day that has none. Here a day's note finds its row — the day's last shift —
 * and its words:
 *
 *   «не в отчёте: 2 продажи, $31.98 · в отчёте по словам: $12.00 · в посте иначе: +$15.00»
 *
 * and, for a day paid by a report with no breakdown to read, the report's sum as before: «в отчёте $446.40».
 * Nothing while a shift of the day goes on, before the rule, without a report, or when the ledger did not answer.
 */
import type { ShiftReportNote, ShiftReportNoteSale } from "@agency_hub_core/contracts";
import { formatDateTime, formatMills, formatSignedMills } from "@agency_hub_core/ui/format";
import { shiftReportDay } from "@agency_hub_core/ui/moscow";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { kindWord } from "@agency_hub_core/ui/shiftReports";

/** What a journal row brings: a shift. `userId` null — the viewer's own («Мои смены»: every note there is theirs). */
export interface NoteRow {
  key: string;
  userId: number | null;
  startedAt: string;
  endedAt: string;
  ongoing: boolean;
}

/** A day's note on its row. */
export interface PlacedNote {
  note: ShiftReportNote;
  /** The person has several shifts that day on the screen: the note is the whole day's. */
  ofDay: boolean;
}

/**
 * The notes by the key of the row each stands under: the last shift of the person's report day (a person — every login
 * of theirs, as Hub lists them; a day — the day the ledger reports a shift on, `shiftReportDay`). A day none of whose
 * shifts is on the screen has no row; a day with a shift going on says nothing yet.
 */
export function placeNotes(rows: readonly NoteRow[], notes: readonly ShiftReportNote[] | null): Map<string, PlacedNote> {
  const out = new Map<string, PlacedNote>();
  if (notes === null) return out;
  for (const note of notes) {
    const day = rows.filter((row) => (row.userId === null || note.userIds.includes(row.userId)) && shiftReportDay(row.startedAt, row.endedAt) === note.reportDate);
    if (day.length === 0 || day.some((row) => row.ongoing)) continue;
    const last = day.reduce((latest, row) => (row.startedAt > latest.startedAt ? row : latest));
    out.set(last.key, { note, ofDay: day.length > 1 });
  }
  return out;
}

export type NotePartKind = "unreported" | "byWords" | "postApart" | "sumOnly";

export interface NotePart {
  kind: NotePartKind;
  text: string;
}

/**
 * The line's parts, in their order. `sum` false — a screen whose row already shows the report's own sum («Мои смены»):
 * the report's sum is not said again.
 */
export function noteParts(placed: PlacedNote, options: { sum?: boolean } = {}): NotePart[] {
  const { note } = placed;
  const parts: NotePart[] = [];
  if (note.unreported.count > 0) {
    const sales = ruPlural(note.unreported.count, "продажа", "продажи", "продаж");
    parts.push({ kind: "unreported", text: `не в отчёте: ${note.unreported.count} ${sales}, ${formatMills(note.unreported.mills)}` });
  }
  if (note.byWordsMills !== 0) parts.push({ kind: "byWords", text: `в отчёте по словам: ${formatMills(note.byWordsMills)}` });
  if (note.postApartMills !== 0) parts.push({ kind: "postApart", text: `в посте иначе: ${formatSignedMills(note.postApartMills)}` });
  if (note.sumOnlyMills !== null && options.sum !== false) {
    parts.push({ kind: "sumOnly", text: `${placed.ofDay ? "в отчёте за день" : "в отчёте"} ${formatMills(note.sumOnlyMills)}` });
  }
  return parts;
}

/** Why a part is there and what to do, said in full on hover. `own` — on the person's own screen. */
export function noteHint(kind: NotePartKind, options: { own?: boolean; ofDay?: boolean } = {}): string {
  switch (kind) {
    case "unreported":
      return options.own
        ? "По правилу эти продажи ваши, но ни в одном вашем отчёте их нет. Они попадут в следующий отчёт долётом; если нет — скажите Генгару."
        : "По правилу эти продажи его, но ни в одном его отчёте их нет. Они попадут в следующий отчёт долётом; если нет — скажите Генгару.";
    case "byWords":
      return options.own
        ? "В отчёт добавлено с ваших слов: продажа другой смены или деньги мимо площадки. Начисляют по отчёту."
        : "В отчёт добавлено по словам чаттера: продажа другой смены или деньги мимо площадки. Начисляют по отчёту.";
    case "postApart":
      return "Пост в «Отчётности» отличается от расклада, который сохранил Генгар: его правили руками.";
    case "sumOnly":
      return options.ofDay
        ? "Отчёт дня (пост или сданный отчёт) даёт за все смены этого дня другую сумму: начисляют по нему. Продажи смен здесь — по правилу «чья продажа»."
        : "Отчёт дня (пост или сданный отчёт) даёт другую сумму: начисляют по нему. Продажи смены здесь — по правилу «чья продажа».";
  }
}

/** A sale no report pays, in one line: «12 нояб., 01:05 · mia-1 · ппв · $15.99». */
export function noteSaleLine(sale: ShiftReportNoteSale): string {
  return [formatDateTime(sale.occurredAt), sale.pageLabel, kindWord(sale.kind), formatMills(sale.netMills)].join(" · ");
}

/** «и ещё 3»: the sales Hub counted and did not list; null — every one is listed. */
export function noteSalesMore(note: ShiftReportNote): string | null {
  const more = note.unreported.count - note.unreported.sales.length;
  return more > 0 ? `и ещё ${more}` : null;
}
