import type { ShiftReportBoard } from "@agency_hub_core/contracts";
import { formatMills } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";

type Candidate = NonNullable<ShiftReportBoard["candidate"]>;

/** Hub's check of a hand-in and Gengar's, as the board's candidate states them (`shiftReport`, `teamShiftReports`). */
export interface ReportCheck {
  hub: Candidate["hub"]["state"];
  foundCount: number;
  foundMills: number;
  gengar: Candidate["gengar"]["state"];
  proposals: number;
}

function hubWords(check: ReportCheck): string {
  return {
    running: "Hub сверяет суммы с кошельками",
    matched: "Hub: суммы сошлись с кошельками",
    found: `Hub дочитал кошельки: ещё ${check.foundCount} ${ruPlural(check.foundCount, "продажа", "продажи", "продаж")}, ${formatMills(check.foundMills)}`,
    unchecked: "Hub сверит позже",
    statement: "Hub ждёт выписку OnlyFans",
  }[check.hub];
}

function gengarWords(check: ReportCheck): string | null {
  return {
    idle: null,
    reading: "Генгар читает переписки",
    found: `Генгар: ${check.proposals} ${ruPlural(check.proposals, "правка", "правки", "правок")}`,
    clean: "Генгар: замечаний нет",
    silent: "Генгар дочитает позже",
  }[check.gengar];
}

const said = (words: ReadonlyArray<string | null>) => words.filter((one): one is string => one !== null);

/**
 * The check in the board's words: the shift's page (review/ReportBlock.tsx) and «Смены → Отчёты» say them alike. Each
 * one a short phrase; Gengar not asked (no key reviews the pages) says nothing. Pure.
 */
export function checkWords(check: ReportCheck): string[] {
  return said([hubWords(check), gengarWords(check)]);
}

/** Of a counted report, only what is worth a look: Hub found more, could not check or waits; Gengar proposed or is late. Pure. */
export function noteworthyCheckWords(check: ReportCheck): string[] {
  return said([check.hub === "matched" ? null : hubWords(check), check.gengar === "clean" ? null : gengarWords(check)]);
}
