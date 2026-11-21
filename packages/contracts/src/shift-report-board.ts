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
/**
 * How each site's own list words a sale, by the sale's kind — Fansly's Wallet activity («Media Sale to», approved
 * prototype `report-panel-mockups/columns.html`), OnlyFans' statement («Payment for message from»). The ONE dictionary:
 * the board's rows take their words from it (`saleSiteWords`). A row's kind is the rule's (`ppv`, `post`, `tip`,
 * `subscription`); a sale's stored kind (`message_purchase`, `post_purchase`, `stream_tip`) reads as the same.
 */
export const SALE_SITE_WORDS = {
  fansly: { ppv: "Media Sale to", post: "Media Sale to", subscription: "Subscription Sale to", tip: "Tip from" },
  onlyfans: { ppv: "Payment for message from", post: "Payment for post from", subscription: "Subscription from", tip: "Tip from" },
} as const satisfies Record<"fansly" | "onlyfans", Record<"ppv" | "post" | "subscription" | "tip", string>>;

const SALE_KIND_OF: Record<string, "ppv" | "post" | "subscription" | "tip"> = {
  ppv: "ppv", message_purchase: "ppv", post: "post", post_purchase: "post", subscription: "subscription", tip: "tip", stream_tip: "tip",
};

/** The site's words before the fan for a sale of a kind; a kind it does not know — the plain «Sale to» / «Payment from». Pure. */
export function saleSiteWords(platform: "fansly" | "onlyfans", kind: string): string {
  const one = SALE_KIND_OF[kind];
  if (one === undefined) return platform === "fansly" ? "Sale to" : "Payment from";
  return SALE_SITE_WORDS[platform][one];
}

export const SHIFT_REPORT_WORDS = ["mine", "not_mine", "share", "give", "pot"] as const;
export const shiftReportWordEnum = z.enum(SHIFT_REPORT_WORDS);

/** How long the check may hold the person: after this the server's timer moves `checking` to `confirm`. */
export const SHIFT_REPORT_CHECK_MINUTES = 10;
/**
 * A colleague's sale the person writes to themself («Моя», «Пополам с …») counts at once (owner, 2026-11-21): the
 * colleague is told, not asked. Their notice («Ждут вас», the amber strip on their board) stays this long unanswered;
 * «Не согласен» has no deadline.
 */
export const SALE_TAKE_NOTICE_DAYS = 3;
/** A row of the person's own from this sum without a comment is pointed at («Без комментария: N продаж от $30»). */
export const SHIFT_REPORT_BARE_NOTE_FROM_MILLS = 30_000;
/** The quick words of a sale's comment; each one appends to the text. */
export const SHIFT_REPORT_QUICK_WORDS = ["торг", "кастом", "голосовое", "допродажа"] as const;
/** The quick reasons of «Почему продажа ваша?»: one tap fills the line of why. */
export const SHIFT_REPORT_TAKE_REASONS = ["общался я", "мой кастом", "договорились"] as const;

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
   * asked — waits for the decider («ждём владельца»; a colleague is never asked now: their sale is written at once);
   * agreed — the colleague agreed («Олег согласился»); disputed — they did not, the decider decides; silence — written
   * to the person without the colleague's answer (`taken`: at once, by their word; before 2026-11-21 by a day of
   * silence); decided — the decider decided (`decision` says how); withdrawn — «Отменить».
   */
  state: z.enum(["asked", "agreed", "disputed", "silence", "decided", "withdrawn"]),
  answerNote: z.string().nullable(),
  /** Null: no deadline any more (the sale is written at once); kept for an older client. */
  answerBy: isoTimestamp.nullable(),
  /** The decider's decision in plain words («владелец отдал вам», «владелец оставил в общаке»); null — none. */
  decision: z.string().nullable(),
  /**
   * The other side hands shifts in the old way (no board): the question went to the decider at once, no day of silence
   * runs («Олег сдаёт смену по-старому, решит владелец»). Absent from an older server: false.
   */
  oldWay: z.boolean().optional(),
  /**
   * The colleague's sale written to the person at once by their word (a take): it counts for them now, the colleague is
   * told and may object. «Отменить» and the tick take it back until it is disputed or decided. Absent from an older
   * server: false.
   */
  taken: z.boolean().optional(),
});

/**
 * A colleague wrote a sale of the person to themself (or half): the amber strip under the row, «Понятно» / «Не
 * согласен». Before 2026-11-21 such a word was a question answered «Согласен» / «Не согласен».
 */
export const shiftReportIncomingSchema = z.object({
  claimId: intId,
  from: personSchema,
  /** mine — «записал эту продажу себе»; share — «записал эту продажу пополам с вами». */
  statement: z.enum(["mine", "share"]),
  note: z.string().nullable(),
  /** asked — waits for the reader; disputed — the reader said «Не согласен», the decider decides; settled — counted as the colleague wrote it (`taken`), or over. */
  state: z.enum(["asked", "disputed", "settled"]),
  /** The reader may answer it now: «Понятно» or «Не согласен» (no deadline). */
  canAnswer: z.boolean(),
  answer: z.enum(["agree", "disagree"]).nullable(),
  /** Null: no deadline any more; kept for an older client. */
  answerBy: isoTimestamp.nullable(),
  /**
   * Written by the colleague's word alone (a take): it counts for them now; the reader is told and may say «Понятно» or
   * «Не согласен». Absent from an older server: false.
   */
  taken: z.boolean().optional(),
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
  /**
   * A decision or an agreement on the sale was made after the card: it outranks the card, which changes nothing
   * («решено иначе»); absent — not so.
   */
  superseded: z.boolean().optional(),
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

/**
 * One item of a row's «чья» menu, as the server decides it: on someone else's sale only «Моя» and «Пополам с <держатель>»;
 * on one's own «Моя», «Пополам с <каждый коллега>», «<коллега>» (отдать), «Общак», «Ничья».
 */
export const shiftReportChoiceSchema = z.object({
  owner: shiftReportOwnerSchema,
  /**
   * What choosing it does: null — applied at once; else it takes a line of why — a colleague with the board: written at
   * once, they are told (`colleague`); anyone else, or a sale already settled or disputed by someone else: the decider.
   */
  asks: z.object({
    to: z.enum(["colleague", "decider"]),
    user: personSchema.nullable(),
    /** «сообщим Олегу», «решит владелец», «Олег сдаёт смену по-старому, решит владелец». */
    words: z.string(),
  }).nullable(),
  /** The menu's grey text: «по правилу», «сообщим Олегу», «решит владелец»; empty — none. */
  hint: z.string(),
  /** The current word (absent from a reader that marks it itself). */
  current: z.boolean().optional(),
});

/** Who decides a dispute, and how the texts name them: «Спор решит владелец», «Спор решит Марта». */
export const shiftReportDeciderSchema = z.object({
  kind: z.enum(["owner", "team_lead"]),
  user: personSchema.nullable(),
  /** The decider in the texts: «владелец», «Марта». */
  words: z.string(),
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
  /** What its «чья» menu offers (only while `editable`); absent or empty — no menu. */
  choices: z.array(shiftReportChoiceSchema).optional(),
  /** Hub's re-read after the hand-in found it («Hub дочитал кошельки: ещё 2 продажи … Показать» lights it). */
  foundByHub: z.boolean().optional(),
  /**
   * Who decides THIS sale's dispute (`deciderOf` of its page's model; the pot's and «стык смен» — the owner); absent —
   * the board's `decider`.
   */
  decider: shiftReportDeciderSchema.optional(),
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
  /**
   * The person signed it at «Сдать смену» (what they saw equals it): a check that changes nothing counts it by itself.
   * Absent — false (an older server).
   */
  signed: z.boolean().optional(),
  /**
   * The hand-in was signed and the check changed the report (Gengar's card, a sale Hub found, a colleague's answer): the
   * signature is not applied, «Проверка нашла изменения: проверьте и подтвердите». Absent — false.
   */
  signatureDeclined: z.boolean().optional(),
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
  /** Who decides a dispute of the shift's first model: a text that names no sale. A row names its own (`row.decider`). */
  decider: shiftReportDeciderSchema,
  /** The reader may press «Подтверждаю» now (own, phase confirm, the candidate not superseded). */
  canConfirm: z.boolean(),
  /** The dot on «Отчёт»: confirm, a question to the person, a row «после сдачи», a late card of Gengar. */
  needsMe: z.boolean(),
  /** When the newest candidate was handed in; null — not yet. */
  handedInAt: isoTimestamp.nullable(),
  /** When the newest version was made; null — not counted. */
  countedAt: isoTimestamp.nullable(),
  /**
   * The person's own shift seen without the board (their right is off, or came after the shift began): read only, rows
   * by the rule, no ticks, no «Сдать смену»; the screen shows the old notice («Сдача смены здесь ещё не включена…»).
   */
  preview: z.boolean().optional(),
  /**
   * The person's other shifts of the week that wait for them, oldest first (their own board only): one closed whose
   * report is not handed in (`draft`), waits for «Подтверждаю» (`confirm`) or a fix (`fixing`) — its sales count only in
   * its own report — and the one going now (`ongoing`, the way back to it). `count` and `mills` — the person's sales
   * and share there by the rule (a closed one's; 0 for the going one).
   */
  otherShifts: z.array(z.object({
    shiftId: intId,
    startedAt: isoTimestamp,
    endedAt: isoTimestamp,
    ongoing: z.boolean(),
    phase: shiftReportPhaseEnum,
    count: z.number().int().nonnegative(),
    mills,
  })).optional(),
  /** The comment of the latest shift before this one on any of its pages, as soon as it is written (a draft's too); null — none. */
  previous: z.object({ user: personSchema, comment: z.string(), at: isoTimestamp }).nullable().optional(),
  /**
   * The post for «Отчётность»: when the person last copied it, whether the ledger has seen the post of this report's
   * day (null — not known), whether a version made since the copy changed a page sum («Пост изменился. Исправьте прежний
   * пост в „Отчётности“, новый не пишите»), and whether the report's day is more than a day behind (the ledger's post
   * reader refuses such a post: warn before copying). Null — nothing counted yet.
   */
  post: z.object({
    copiedAt: isoTimestamp.nullable(),
    seen: z.boolean().nullable(),
    changedSinceCopy: z.boolean(),
    late: z.boolean(),
    /**
     * Each model's post (a shift on pages of two models has two): whether it was copied and changed since. The board
     * copies each by its own button («Скопировать пост: Лора») and marks each «скопирован».
     */
    models: z.array(z.object({
      modelSlug: z.string(),
      modelName: z.string(),
      copiedAt: isoTimestamp.nullable(),
      changedSinceCopy: z.boolean(),
    })).default([]),
  }).nullable().optional(),
});
export type ShiftReportBoard = z.infer<typeof shiftReportBoardSchema>;

/** The pulse's `report` field (`clientActivity`): the fifth button and its dot. Null — a person without the board. */
export const shiftReportPulseSchema = z.object({
  shiftId: intId,
  phase: shiftReportPhaseEnum,
  needsMe: z.boolean(),
});
