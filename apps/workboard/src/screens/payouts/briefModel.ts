import type {
  TeamLedgerPayoutPrepareResponse,
  TeamLedgerPayoutSaleBlocker,
  TeamLedgerPayoutSaleBlockersCoverage,
} from "@agency_hub_core/contracts";
import { millsToDollarsNumber } from "@agency_hub_core/shared";

/**
 * Pure presentation model for `PayoutBrief.tsx` («Выплата» + «Открытые вопросы по его продажам»).
 * Crucially, ledger flags (blockers and quiet notes) AND Hub's open sale questions are kept visible
 * even when `nothing !== null || amountMills <= 0`.
 */

type Flag = TeamLedgerPayoutPrepareResponse["flags"][number];

const MATCH_HINT: Partial<Record<TeamLedgerPayoutSaleBlocker["match"], string>> = {
  page: "на его странице — проверьте",
  unlinked: "не привязан — проверьте",
};

const COVERAGE_NOTE: Record<TeamLedgerPayoutSaleBlockersCoverage["reasons"][number], string> = {
  person_not_in_hub: "человека нет в реестре Hub — проверены совпадения по имени и несвязанные вопросы",
  pages_outside_key: "не все рабочие страницы человека попали в проверку",
  unlinked_questions_omitted: "есть несвязанные вопросы без страницы",
  truncated: "показана часть списка (сработал лимит)",
};

/** «1824» or «1823.67», as the message writes a transfer. */
export function transferWords(mills: number): string {
  const dollars = millsToDollarsNumber(mills);
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

export function messageOf(brief: TeamLedgerPayoutPrepareResponse): string | null {
  if (brief.message === null) return null;
  if (brief.placeholder === null || brief.suggestion === null) return brief.message;
  return brief.message.split(brief.placeholder).join(transferWords(brief.suggestion.transferMills));
}

export function workboardPath(link: string): string {
  if (link.startsWith("/workboard/")) return link.slice("/workboard".length);
  return link === "/workboard" ? "/" : link;
}

export function saleQuestionMatchHint(match: TeamLedgerPayoutSaleBlocker["match"]): string | undefined {
  return MATCH_HINT[match];
}

export function saleQuestionsCoverageNote(coverage?: TeamLedgerPayoutSaleBlockersCoverage): string | null {
  if (coverage?.state !== "partial" || coverage.reasons.length === 0) return null;
  return `Покрытие неполное: ${coverage.reasons.map((reason) => COVERAGE_NOTE[reason]).join("; ")}.`;
}

export interface PayoutBriefModel {
  isZero: boolean;
  nothingText: string | null;
  blockers: Flag[];
  notes: Flag[];
  saleQuestions: TeamLedgerPayoutSaleBlocker[];
  coverageNote: string | null;
  showSaleQuestionsBlock: boolean;
  hasBlockers: boolean;
  message: string | null;
}

export function buildPayoutBriefModel(brief: TeamLedgerPayoutPrepareResponse): PayoutBriefModel {
  const isZero = brief.nothing !== null || brief.amountMills <= 0;
  const blockers = brief.flags.filter((flag) => flag.blocker);
  const notes = brief.flags.filter((flag) => !flag.blocker);
  const saleQuestions = brief.saleQuestions ?? [];
  const coverageNote = saleQuestionsCoverageNote(brief.saleQuestionsCoverage);
  return {
    isZero,
    nothingText: isZero ? (brief.nothing ?? "Платить нечего.") : null,
    blockers,
    notes,
    saleQuestions,
    coverageNote,
    showSaleQuestionsBlock: saleQuestions.length > 0 || coverageNote !== null,
    hasBlockers: blockers.length > 0 || saleQuestions.length > 0,
    message: isZero ? null : messageOf(brief),
  };
}
