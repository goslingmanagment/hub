/**
 * The «Отчёт» board (products plan 2026-11-13, package R): what `shiftReport` answers in `board` so the screen draws a
 * whole shift — a column per page, rows as the sites' own lists, the phase — without a second request per row. The
 * approved prototype is `8-docs/2026-11-13-products/report-panel-mockups/columns.html`; its words are taken verbatim.
 *
 * Phases: draft («Черновик») → «Сдать смену» records a CANDIDATE, checking («Проверка»: Hub and Gengar check it, 10
 * minutes at most) → confirm («Подтвердите»: the person signs the candidate again, Gengar's proposals that are not
 * declined applied) → counted («Учтён»: a version exists, the ledger sees it) → fixing («Правка»: the counted version
 * stands until a new one is confirmed). Only the person confirms; no agent door has a confirm.
 *
 * Everything is behind the person's right `submits_shift` (off for everyone in production).
 */
import { z } from "zod";

import { intId, isoTimestamp, mills } from "./primitives.ts";

export const SHIFT_REPORT_PHASES = ["draft", "checking", "confirm", "counted", "fixing"] as const;
export const shiftReportPhaseEnum = z.enum(SHIFT_REPORT_PHASES);
export type ShiftReportPhase = z.infer<typeof shiftReportPhaseEnum>;

/** The chip of each phase, as the prototype writes it. */
export const SHIFT_REPORT_PHASE_CHIPS: Record<ShiftReportPhase, string> = {
  draft: "Черновик",
  checking: "Проверка",
  confirm: "Подтвердите",
  counted: "Учтён",
  fixing: "Правка",
};

/**
 * The person's words on a sale of the board (the marks): the ledger's three (`mine`, `not_mine`, `share`) and two of
 * one's own sale — `give` (to a colleague: settled at once in their favour) and `pot` (no longer mine; the owner
 * decides whether it joins a pot). A version's line in the ledger's feed keeps the three words: `give` and `pot` read
 * there as `not_mine` (the line counts nothing for the person), the feed's format does not change.
 */
export const SHIFT_REPORT_WORDS = ["mine", "not_mine", "share", "give", "pot"] as const;
export const shiftReportWordEnum = z.enum(SHIFT_REPORT_WORDS);
export type ShiftReportWord = z.infer<typeof shiftReportWordEnum>;

/** How long the check may hold the person: after this the server's timer moves `checking` to `confirm`. */
export const SHIFT_REPORT_CHECK_MINUTES = 10;
/** A question to a colleague unanswered this long settles for the one who asked (a pot question never does). */
export const SHIFT_REPORT_ASK_SILENCE_HOURS = 24;
/** A row of the person's own from this sum without a comment is pointed at («Без комментария: N продаж от $30»). */
export const SHIFT_REPORT_BARE_NOTE_FROM_MILLS = 30_000;
/** The quick words of a sale's comment; each one appends to the text. */
export const SHIFT_REPORT_QUICK_WORDS = ["торг", "кастом", "голосовое", "допродажа"] as const;
/** A sighting still not in Hub this long after it was seen goes to the decider. */
export const SALE_SIGHTING_UNMATCHED_HOURS = 48;

/**
 * A person's name in the cases the board's texts need: «Спросить Олега», «Пополам с Олегом», «Вопрос ушёл Олегу». A
 * plain rule for Russian first names (a name in Latin letters, or one the rule does not know, stays as it is).
 */
export const personNameFormsSchema = z.object({
  /** «Олег». */
  nom: z.string(),
  /** Whose: «Олега», «Севы». */
  gen: z.string(),
  /** Whom (ask): «Олега», «Севу». */
  acc: z.string(),
  /** With whom: «Олегом», «Севой». */
  ins: z.string(),
  /** To whom: «Олегу», «Севе». */
  dat: z.string(),
});
export type PersonNameForms = z.infer<typeof personNameFormsSchema>;

const VOWELS = "аеёиоуыэюя";
export function personNameForms(name: string): PersonNameForms {
  const nom = name.trim();
  const same = { nom, gen: nom, acc: nom, ins: nom, dat: nom };
  if (!/^[А-ЯЁ][а-яё]+$/u.test(nom)) return same;
  const stem = nom.slice(0, -1);
  const last = nom.slice(-1);
  const before = stem.slice(-1);
  if (last === "а") {
    const soft = "гкхжчшщ".includes(before);
    const hiss = "жчшщц".includes(before);
    return { nom, gen: stem + (soft ? "и" : "ы"), acc: stem + "у", ins: stem + (hiss ? "ей" : "ой"), dat: stem + "е" };
  }
  if (last === "я") {
    return before === "и"
      ? { nom, gen: stem + "и", acc: stem + "ю", ins: stem + "ей", dat: stem + "и" }
      : { nom, gen: stem + "и", acc: stem + "ю", ins: stem + "ей", dat: stem + "е" };
  }
  if (last === "й") return { nom, gen: stem + "я", acc: stem + "я", ins: stem + "ем", dat: stem + "ю" };
  if (last === "ь") return { nom, gen: stem + "я", acc: stem + "я", ins: stem + "ем", dat: stem + "ю" };
  if (VOWELS.includes(last)) return same;
  const hiss = "жчшщц".includes(last);
  return { nom, gen: nom + "а", acc: nom + "а", ins: nom + (hiss ? "ем" : "ом"), dat: nom + "у" };
}

const personSchema = z.object({ userId: intId, name: z.string(), forms: personNameFormsSchema });

/**
 * Whose a sale is, as the board says it: `me` — the shift's person («моя»); `share` — half with `userId`
 * («пополам с Севой»); `user` — a colleague's («Олега»); `pot` («общак»); `nobody` («ничья»); `waiting` — a PPV that
 * waits for its sender's shift; `decide` — the owner decides by the rule (the shift's boundary, nobody wrote).
 */
export const shiftReportOwnerSchema = z.object({
  kind: z.enum(["me", "share", "user", "pot", "nobody", "waiting", "decide"]),
  userId: intId.nullable(),
  name: z.string().nullable(),
  /** The word itself in the board's case: «моя», «пополам с Севой», «Олега», «общак», «ничья». */
  words: z.string(),
});
export type ShiftReportOwner = z.infer<typeof shiftReportOwnerSchema>;

/** A question asked from the draft («Почему продажа ваша?» → «Спросить Олега» / «Спросить владельца»). */
export const shiftReportAskSchema = z.object({
  claimId: intId,
  /** colleague — the rule gives it to a colleague, they answer; owner — the pot's (always the owner's). */
  to: z.enum(["colleague", "owner"]),
  toUser: personSchema.nullable(),
  /** What the person asked for. */
  want: shiftReportOwnerSchema,
  /** The one line of why. */
  note: z.string(),
  /**
   * asked — waits («ждём ответа Олега» / «ждём владельца»); agreed — the colleague agreed («Олег согласился»);
   * disputed — they did not, the decider decides; silence — a day of silence left it with the one who asked («Олег не
   * ответил за сутки»); decided — the decider decided (`decision` says how); withdrawn — «Отменить».
   */
  state: z.enum(["asked", "agreed", "disputed", "silence", "decided", "withdrawn"]),
  answerNote: z.string().nullable(),
  /** Until when the colleague may answer before the silence settles it; null — never (a pot question). */
  answerBy: isoTimestamp.nullable(),
  /** The decider's decision in plain words («владелец отдал вам», «владелец оставил в общаке»); null — none. */
  decision: z.string().nullable(),
});

/** Someone claims a sale of the person: the amber strip under the row, answered «Согласен» / «Не согласен». */
export const shiftReportIncomingSchema = z.object({
  claimId: intId,
  from: personSchema,
  /** mine — «считает эту продажу своей»; share — «предлагает делить пополам». */
  statement: z.enum(["mine", "share"]),
  note: z.string().nullable(),
  /** asked — waits for the reader; disputed — the reader said «Не согласен», the decider decides; settled — over. */
  state: z.enum(["asked", "disputed", "settled"]),
  /** The reader may answer it now. */
  canAnswer: z.boolean(),
  answer: z.enum(["agree", "disagree"]).nullable(),
  answerBy: isoTimestamp.nullable(),
});

/** Gengar's proposal for a sale of the candidate: a card under the row. */
export const shiftReportProposalSchema = z.object({
  id: intId,
  /** owner_change — whose the sale is; note — a comment Gengar wrote («написал Генгар»). */
  kind: z.enum(["owner_change", "note"]),
  from: shiftReportOwnerSchema.nullable(),
  to: shiftReportOwnerSchema.nullable(),
  note: z.string().nullable(),
  /** What it changes in the person's sum (−$24.00, +$8.00). */
  deltaMills: mills,
  /** One or two sentences of why. */
  why: z.string(),
  /**
   * proposed — applied unless declined («Если согласны, ничего не нажимайте»); declined — «Вы не согласны: осталось
   * …, решит владелец» («Вернуть правку» brings it back); accepted — taken into a version; late — came after the report
   * was counted: «Принять» / «Не согласен», nothing changes by itself.
   */
  state: z.enum(["proposed", "declined", "accepted", "late"]),
  afterCounted: z.boolean(),
  /** The agent's name as people know it: «Генгар». */
  by: z.string(),
});

/** «Нет в Hub»: a sale the site showed that Hub does not hold. */
export const shiftReportSightingSchema = z.object({
  id: intId,
  seenAt: isoTimestamp,
  /** The person added it («добавили вы, Hub сверит»): it counts on the board, a version takes it once Hub holds it. */
  added: z.boolean(),
});

export const shiftReportRowNoteSchema = z.object({
  text: z.string(),
  /** person — the shift's person; agent — Gengar («написал Генгар»); other — someone else, named. */
  by: z.enum(["person", "agent", "other"]),
  byName: z.string(),
});

/** One row of a column: two lines, never more; the question, the claim, the card and the comment go under it. */
export const shiftReportRowSchema = z.object({
  /** Stable within the board: `t<transactionId>`, or `s<sightingId>` for a row Hub does not hold. */
  key: z.string(),
  /** Hub's `transactions.id`; null — a «нет в Hub» row (a sighting). */
  transactionId: intId.nullable(),
  pageLabel: z.string(),
  platform: z.enum(["fansly", "onlyfans"]),
  /**
   * What the sale is found by on the site: the platform's whole transaction id on Fansly («981337562090745305»); on
   * OnlyFans the statement's id when known, else null (the row is found by time, amount and fan).
   */
  platformRef: z.string().nullable(),
  /** Fansly's short number «#…5305» (the last four digits); null on OnlyFans, where the time stands instead. */
  refLabel: z.string().nullable(),
  /** Hub's canonical type: message_purchase, post_purchase, tip, stream_tip, subscription. */
  kind: z.string(),
  /** The site's own words before the fan: «Media Sale to», «Tip from», «Payment for message from», «Subscription from». */
  siteWords: z.string(),
  fan: z.object({ fanRef: z.string().nullable(), name: z.string().nullable(), username: z.string().nullable() }),
  occurredAt: isoTimestamp,
  netMills: mills,
  /** What the fan paid (OnlyFans shows both); null — the site shows only the net (Fansly). */
  grossMills: mills.nullable(),
  /** The rule's word and its reason in plain words («шёл его слот до 20:00», «тип под постом»). */
  rule: z.object({ owner: shiftReportOwnerSchema, reason: z.string(), words: z.string() }),
  /** The word the board shows now: the rule's, or the person's mark over it, or an answer. */
  owner: shiftReportOwnerSchema,
  /** The person's mark; null — the rule stands. */
  statement: shiftReportWordEnum.nullable(),
  /** The grey words after the owner on line 2, as the prototype composes them («по правилу ваша», «ждём ответа Олега», «поменял Генгар», «вам $15»). */
  reasonWords: z.string(),
  /** The tick: in the person's report. */
  ticked: z.boolean(),
  /** What the row counts in the person's sum now (0 while a question on it is open). */
  amountMills: mills,
  /** Before the shift began (folded into «До 18:00: 3 продажи Олега»): whose shift it was; null — not before. */
  before: z.object({ user: personSchema.nullable() }).nullable(),
  /** Came after the hand-in and is the person's by the rule: «после сдачи», «Досдать». */
  late: z.boolean(),
  ask: shiftReportAskSchema.nullable(),
  incoming: shiftReportIncomingSchema.nullable(),
  proposal: shiftReportProposalSchema.nullable(),
  note: shiftReportRowNoteSchema.nullable(),
  sighting: shiftReportSightingSchema.nullable(),
  /** The reader may tick it and change «чья» now. */
  editable: z.boolean(),
  /** The reader may write its comment now. */
  canNote: z.boolean(),
  /** Wants a look: a «нет в Hub», a late row, a claim to answer, a proposal, Gengar's comment. */
  attention: z.boolean(),
  /**
   * The menu «Чья продажа» of the row, as the server allows it (absent — the board's own rule, until every reader
   * sends it): each word, whether choosing it asks someone (a colleague, or the decider when there is nobody to ask —
   * then `words` says why: «Олег сдаёт смену по-старому, решит владелец»), and the grey hint («по правилу», «спросим
   * Олега», «решит владелец»).
   */
  choices: z.array(z.object({
    owner: shiftReportOwnerSchema,
    asks: z.object({ to: z.enum(["colleague", "decider"]), user: personSchema.nullable(), words: z.string() }).nullable(),
    hint: z.string(),
  })).optional(),
  /** Hub's re-read of the wallet after the hand-in found this sale («Hub дочитал кошельки: … · Показать»). */
  foundByHub: z.boolean().optional(),
});
export type ShiftReportRow = z.infer<typeof shiftReportRowSchema>;

export const shiftReportColumnSchema = z.object({
  pageLabel: z.string(),
  platform: z.enum(["fansly", "onlyfans"]),
  /** The page's handle on the site («mia.two»); null — not known. */
  pageHandle: z.string().nullable(),
  modelName: z.string().nullable(),
  /** The shift's rows, newest first (a «нет в Hub» and a late row among them by time). */
  rows: z.array(shiftReportRowSchema),
  /** Sales of the same page and day before the shift began, folded into one row. */
  before: z.object({
    count: z.number().int().nonnegative(),
    /** When the shift began: «До 18:00». */
    until: isoTimestamp,
    /** Whose shifts they were («Олега»); empty — nobody's. */
    people: z.array(personSchema),
    rows: z.array(shiftReportRowSchema),
  }),
  /** «отмечено 7 из 9»: rows of the shift ticked, rows of the shift. */
  marked: z.number().int().nonnegative(),
  of: z.number().int().nonnegative(),
  sumMills: mills,
  /** The orange dot «Есть что посмотреть». */
  attention: z.boolean(),
});

/** Hub's own check of one page after the hand-in. */
export const shiftReportHubPageCheckSchema = z.object({
  pageLabel: z.string(),
  /**
   * running — reading now; matched — the sums met the wallet; found — the re-read found sales the candidate did not
   * hold (the candidate is re-made with them); unchecked — Hub could not check it («Hub не сверил Mia Free»);
   * statement — an OnlyFans page waits for ChatSpace's statement («Ждём выписку Mia Free»).
   */
  state: z.enum(["running", "matched", "found", "unchecked", "statement"]),
  foundCount: z.number().int().nonnegative(),
  foundMills: mills,
  at: isoTimestamp.nullable(),
});

export const shiftReportCandidateSchema = z.object({
  id: intId,
  number: z.number().int().positive(),
  madeAt: isoTimestamp,
  /** The person, or «со слов, через Генгара». */
  by: z.string(),
  door: z.enum(["extension", "workboard", "telegram"]),
  /** The draft was taken as it was at this moment. */
  cutoffAt: isoTimestamp,
  count: z.number().int().nonnegative(),
  totalMills: mills,
  hub: z.object({
    /** running while any page runs; matched — every page met; found — a page found more; unchecked — a page could not be checked. */
    state: z.enum(["running", "matched", "found", "unchecked", "statement"]),
    pages: z.array(shiftReportHubPageCheckSchema),
    foundCount: z.number().int().nonnegative(),
    foundMills: mills,
  }),
  gengar: z.object({
    /**
     * reading — «Генгар читает переписки смены, обычно пара минут»; found — proposals; clean — «замечаний нет»;
     * silent — 10 minutes without an answer («Генгар молчит 10 минут…»); idle — not asked (no key reviews the pages).
     */
    state: z.enum(["idle", "reading", "found", "clean", "silent"]),
    /** Since when it reads (the hand-in). */
    since: isoTimestamp,
    answeredAt: isoTimestamp.nullable(),
    proposals: z.number().int().nonnegative(),
    notes: z.number().int().nonnegative(),
  }),
  /** A correction or a re-check made a newer one: «Подтверждаю» on this one is refused. */
  superseded: z.boolean(),
});

export const shiftReportBoardSchema = z.object({
  phase: shiftReportPhaseEnum,
  /** «Черновик», «Проверка», «Подтвердите», «Учтён», «Правка». */
  chip: z.string(),
  /** Pages of the shift's model(s) the shift did not work: «Mia-1 не в смене». */
  offShift: z.array(z.object({ pageLabel: z.string(), platform: z.enum(["fansly", "onlyfans"]) })),
  /** Every page of the shift, Fansly and OnlyFans together; a page with no sales too («За смену продаж нет»). */
  columns: z.array(shiftReportColumnSchema),
  /** The candidate the board is about (checking, confirm; fixing and counted: the newest one); null — none. */
  candidate: shiftReportCandidateSchema.nullable(),
  totals: z.object({
    /** «Ваши продажи: 17». */
    count: z.number().int().nonnegative(),
    /** «Итого», «стало». */
    nowMills: mills,
    /** «Было»: in confirm the candidate's total before the proposals, in fixing the counted version's; null — nothing to compare. */
    wasMills: mills.nullable(),
  }),
  /** What waits and is outside the sum: «Ждут ответа, в сумму не входят: …». */
  waiting: z.array(z.object({
    key: z.string(),
    transactionId: intId.nullable(),
    pageLabel: z.string(),
    fanName: z.string().nullable(),
    netMills: mills,
    why: z.enum(["ask", "incoming", "sighting", "late"]),
  })),
  /** The people a word may name: «пополам с …», «Олега», «Спросить …». */
  colleagues: z.array(personSchema),
  /** Who decides a dispute of this shift's model, and how the texts name them: «Спор решит владелец». */
  decider: z.object({
    kind: z.enum(["owner", "team_lead"]),
    user: personSchema.nullable(),
    /** The decider in the texts: «владелец», «Марта». */
    words: z.string(),
  }),
  /** The reader may press «Подтверждаю» now (own, phase confirm, the candidate not superseded). */
  canConfirm: z.boolean(),
  /** The dot on «Отчёт»: confirm, a question to the person, a row «после сдачи», a late card of Gengar. */
  needsMe: z.boolean(),
  /** When the newest candidate was handed in; null — not yet. */
  handedInAt: isoTimestamp.nullable(),
  /** When the newest version was made; null — not counted. */
  countedAt: isoTimestamp.nullable(),
  /**
   * Read only, the rule's board of a person without the board yet (`submits_shift` off): no ticks, no «чья», no
   * «Сдать смену»; the old notice in the bar's place. Absent — read `enabled` of the response.
   */
  preview: z.boolean().optional(),
  /** The comment the previous shift on these pages left («От прошлой смены (Олег): „…“»); null — none. */
  previous: z.object({ user: personSchema.nullable(), comment: z.string(), at: isoTimestamp }).nullable().optional(),
  /**
   * The counted version's post in «Отчётность»: when the person copied it, whether the post arrived in «Отчётность»
   * (`seen`), whether the report changed since it was copied, and whether it is a day late (the ledger will not take
   * it by itself). Null — nothing counted.
   */
  post: z.object({
    copiedAt: isoTimestamp.nullable(),
    seen: z.boolean(),
    changedSinceCopy: z.boolean(),
    late: z.boolean(),
  }).nullable().optional(),
});
export type ShiftReportBoard = z.infer<typeof shiftReportBoardSchema>;

/** The pulse's `report` field (`clientActivity`): the fifth button and its dot. Null — a person without the board. */
export const shiftReportPulseSchema = z.object({
  shiftId: intId,
  phase: shiftReportPhaseEnum,
  needsMe: z.boolean(),
});
