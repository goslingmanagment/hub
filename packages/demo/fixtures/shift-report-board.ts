import {
  SHIFT_REPORT_PHASE_CHIPS, personNameForms,
  type KernelOperationResponse, type ShiftReportBody, type ShiftReportBoard, type ShiftReportOwner, type ShiftReportPhase, type ShiftReportRow,
} from "@agency_hub_core/contracts";
import { millsFromDollars, millsPercentOf, millsToNumber } from "@agency_hub_core/shared";

import { demoError, queryString, type DemoHandlers, type DemoReply, type DemoRequest } from "../core.ts";

/**
 * The «Отчёт» board (package R) in the demo: one board per scenario of the approved prototype
 * (`8-docs/2026-11-13-products/report-panel-mockups/columns.html`), with the prototype's own invented data — model
 * Mia, pages Mia-2, Mia-3, Mia-4, Mia Free, Mia VIP, Mia Promo; the chatter Lev, his shift of 12 Nov 18:00–02:00;
 * colleagues Oleg (the shift before) and Seva; the same sales, times, sums and reasons as its `baseRows()`. One scenario
 * more than the prototype (`twoModels`): the shift holds two OnlyFans pages of a second model, Nova — two posts, a
 * comment for each.
 *
 * Each scenario has a stable shift id (`DEMO_BOARD_SHIFTS`): `/workboard/report/<id>`. The board is clickable through
 * the whole flow like the prototype: every write changes the scenario's board in memory (a tick, a word, a comment, a
 * question, «Сдать смену», «Подтверждаю», «Исправить», «Досдать»…), and Hub's and Gengar's answers to a hand-in play
 * after a pause, as in the prototype (Hub a second, Gengar four). The cookie `hub-demo-board` names a fresh copy of
 * every scenario (the demo's index page `/workboard/__report` sets a new one on each link; a screenshot tool passes
 * its own). Invented data only.
 */

type Report = KernelOperationResponse<"shiftReport">;

export const DEMO_BOARD_SHIFTS = {
  draft: 9_120_001,
  note: 9_120_002,
  askColleague: 9_120_003,
  askOwner: 9_120_004,
  notInHub: 9_120_005,
  checking: 9_120_006,
  gengarFound: 9_120_007,
  gengarClean: 9_120_008,
  gengarSilent: 9_120_009,
  dispute: 9_120_010,
  late: 9_120_011,
  counted: 9_120_012,
  fixing: 9_120_013,
  fivePages: 9_120_014,
  emptyPage: 9_120_015,
  /** A person without the board yet (`submits_shift` off): the read-only preview (the response's `enabled: false`). */
  preview: 9_120_016,
  /** A shift on two models' pages (Mia on Fansly, Nova on OnlyFans): a comment field and a post for each model. */
  twoModels: 9_120_017,
  /**
   * A day split by a long break: Lev's morning shift (10:00–13:05) closed without a report holds his $40 PPV; the board
   * of his evening names it above the columns, and the fold «До 18:00» says the sale is his.
   */
  splitDay: 9_120_018,
} as const;
export type DemoBoardScenario = keyof typeof DEMO_BOARD_SHIFTS;
type Scenario = DemoBoardScenario;
const SCENARIO_OF = new Map<number, Scenario>(Object.entries(DEMO_BOARD_SHIFTS).map(([key, id]) => [id, key as Scenario]));

/** The board's own claim ids (an incoming claim, the questions asked from the draft): `saleClaimAnswer` comes here. */
const INCOMING_CLAIM_ID = 8_002;
const ASK_CLAIM_BASE = 8_100;

/** Pauses of the played check, as the prototype's: Hub's answer, Gengar's answer, Gengar's late reading after «по проверке Hub». */
const HUB_PAUSE_MS = 1_000;
const GENGAR_PAUSE_MS = 4_000;
const GENGAR_LATE_MS = 9_000;
/** After «Скопировать пост», the post «arrives» in «Отчётность». */
const POST_SEEN_MS = 8_000;

const LEV = { userId: 7_101, name: "Лев" };
const OLEG = { userId: 7_102, name: "Олег" };
const SEVA = { userId: 7_103, name: "Сева" };
const WHO = { oleg: OLEG, seva: SEVA } as const;
type Who = keyof typeof WHO;
const whoOf = (userId: number | null | undefined): Who | null => (userId === OLEG.userId ? "oleg" : userId === SEVA.userId ? "seva" : null);
const person = (one: { userId: number; name: string }) => ({ ...one, forms: personNameForms(one.name) });

const MODELS = { mia: "Mia", nova: "Nova" } as const;
type ModelId = keyof typeof MODELS;
const PAGES = [
  { id: "m2", label: "Mia-2", platform: "fansly", handle: "mia.two", model: "mia" },
  { id: "m3", label: "Mia-3", platform: "fansly", handle: "mia.three", model: "mia" },
  { id: "m4", label: "Mia-4", platform: "fansly", handle: "mia.four", model: "mia", extra: "more" },
  { id: "fr", label: "Mia Free", platform: "onlyfans", handle: null, model: "mia" },
  { id: "vip", label: "Mia VIP", platform: "onlyfans", handle: null, model: "mia" },
  { id: "pr", label: "Mia Promo", platform: "onlyfans", handle: null, model: "mia", extra: "empty" },
  // The second model of `twoModels`: its OnlyFans pages carry the sales of Mia's (the same fans, ids + 40).
  { id: "nf", label: "Nova Free", platform: "onlyfans", handle: null, model: "nova" },
  { id: "nv", label: "Nova VIP", platform: "onlyfans", handle: null, model: "nova" },
] as const;
type PageId = (typeof PAGES)[number]["id"];

/** `wait:oleg` — Oleg's PPV that goes to his next shift (he is not on one now). */
type Own = "me" | "pot" | "oleg" | "seva" | "none" | "half:seva" | "half:oleg" | "wait:oleg" | "";
interface Base {
  id: number; page: PageId; day: 11 | 12 | 13; t: string; kind: "media" | "sub" | "tip"; name: string; handle: string;
  net: number; gross: number; tx: string; rule: Own; why: string; late?: boolean; lost?: boolean; before?: boolean;
  /** Hub's re-read of the wallet after the hand-in found it (shown only once found). */
  found?: boolean;
  /** Lev's own sale of his morning shift, not handed in (`splitDay` only): folded before the evening, «моя». */
  split?: boolean;
}
const mk = (id: number, page: PageId, day: 11 | 12 | 13, t: string, kind: Base["kind"], name: string, handle: string, net: number, gross: number, tx: string, rule: Own, why: string, extra: Partial<Base> = {}): Base =>
  ({ id, page, day, t, kind, name, handle, net, gross, tx, rule, why, ...extra });

/** The prototype's `baseRows()`, one to one. */
const BASE: Base[] = [
  mk(12, "m2", 13, "02:38", "media", "Harlan/Texas", "harlan_tx", 36, 0, "981341022871530944", "me", "ваш ппв из 01:55", { late: true }),
  mk(1, "m2", 13, "02:12", "media", "Harlan/Texas", "harlan_tx", 24, 0, "981340275518826113", "me", "ваш ппв из 01:40, куплен после смены"),
  mk(2, "m2", 12, "23:48", "tip", "mossrain", "mossrain", 8, 0, "981338810264419842", "pot", "тип под постом"),
  mk(3, "m2", 12, "22:30", "media", "Viggo", "viggo_nord", 48, 0, "981337562090745305", "me", "ваш ппв, отправлен в 22:17"),
  mk(4, "m2", 12, "21:30", "tip", "Wren", "wren_o", 12, 0, "981336977431290668", "me", "", { lost: true }),
  mk(62, "m2", 12, "21:55", "tip", "Rowan/Canada", "rowan_k", 15, 0, "981337101552918406", "me", "тип в чате после вашего сообщения", { found: true }),
  mk(13, "m2", 12, "21:12", "media", "Juno/Oslo", "juno_oslo", 30, 0, "981336851204477390", "half:seva", "ппв Севы из 17:20, дожали вы"),
  mk(5, "m2", 12, "20:41", "sub", "Rowan/Canada", "rowan_k", 8, 0, "981336420187553920", "me", "подписался после вашего сообщения"),
  mk(15, "m2", 12, "20:58", "media", "Kai/Berlin", "kai_b", 26, 0, "981336530221904118", "wait:oleg", "PPV отправил Олег, уйдёт в его следующую смену"),
  mk(6, "m2", 12, "19:40", "tip", "Felix B.", "felix_b", 16, 0, "981335801669112477", "oleg", "шёл его слот до 20:00"),
  mk(7, "m2", 12, "19:31", "tip", "Dario/Milan", "dario_mi", 40, 0, "981335714022638196", "me", "тип в чате после вашего сообщения"),
  mk(8, "m2", 12, "19:05", "media", "Dario/Milan", "dario_mi", 32, 0, "981335468395021753", "me", "ваш ппв, отправлен в 18:51"),
  mk(9, "m2", 12, "18:22", "media", "Dario/Milan", "dario_mi", 17.6, 0, "981335052716884031", "me", "ваш ппв, отправлен в 18:10"),
  mk(10, "m2", 12, "17:48", "media", "Vee/Spain", "vee_s", 24, 0, "981334726150397284", "", "", { before: true }),
  mk(11, "m2", 12, "16:10", "sub", "Hollis", "hollis_88", 8, 0, "981333801945562019", "", "", { before: true }),
  mk(14, "m2", 12, "15:02", "tip", "Brodie", "brodie_w", 10, 0, "981333205518640227", "", "", { before: true }),
  mk(20, "m3", 13, "01:47", "sub", "quill", "quill_q", 8, 0, "981340021773350496", "none", "фану никто не писал"),
  mk(21, "m3", 13, "00:58", "sub", "Teo", "teo_r", 4, 0, "981339520048117350", "me", "подписался после вашего сообщения"),
  mk(22, "m3", 12, "22:48", "sub", "kitecat", "kitecat", 120, 0, "981337743906228871", "me", "тир Gold после вашей переписки"),
  mk(23, "m3", 12, "21:03", "media", "Ash/UK", "ash_w", 28, 0, "981336712558004629", "me", "ваш ппв от 10 нояб., куплен сегодня"),
  mk(24, "m3", 12, "15:30", "media", "Corin", "corin_v", 20, 0, "981333415280779164", "", "", { before: true }),
  mk(50, "m4", 13, "01:20", "tip", "Rook", "rook_77", 10, 0, "981339844120556017", "me", "тип в чате после вашего сообщения"),
  mk(51, "m4", 12, "23:02", "media", "Lyle/Dublin", "lyle_d", 22, 0, "981338412093377150", "me", "ваш ппв, отправлен в 22:50"),
  mk(52, "m4", 12, "19:15", "sub", "pepper", "pepper_v", 8, 0, "981335590412270833", "none", "фану никто не писал"),
  mk(53, "m4", 12, "17:30", "media", "Ines", "ines_c", 18, 0, "981334620044817292", "", "", { before: true }),
  mk(30, "fr", 13, "01:52", "media", "nightowl", "nightowl_7", 20, 25, "", "seva", "ппв Севы от 11 нояб."),
  mk(31, "fr", 13, "01:30", "media", "Oskar", "oskar_n", 14.4, 18, "", "me", "ваш ппв, отправлен в 01:12"),
  mk(32, "fr", 13, "00:55", "media", "Oskar", "oskar_n", 14.4, 18, "", "me", "ваш ппв, отправлен в 00:41"),
  mk(33, "fr", 13, "00:20", "media", "Juniper", "juniper_j", 12, 15, "", "me", "ваш ппв, отправлен в 00:02"),
  mk(34, "fr", 12, "23:50", "tip", "marlowe", "marlowe_m", 24, 30, "", "me", "тип в чате после вашего сообщения"),
  mk(35, "fr", 12, "23:05", "media", "marlowe", "marlowe_m", 36, 45, "", "me", "ваш ппв, отправлен в 22:58"),
  mk(36, "fr", 12, "22:15", "media", "marlowe", "marlowe_m", 24, 30, "", "me", "ваш ппв, отправлен в 22:02"),
  mk(37, "fr", 12, "17:02", "media", "Benno", "benno_k", 16, 20, "", "", "", { before: true }),
  mk(40, "vip", 12, "20:20", "sub", "Bram", "bram_h", 16, 20, "", "me", "подписался после вашего сообщения"),
  mk(41, "vip", 12, "14:45", "tip", "Soren", "soren_w", 8, 10, "", "", "", { before: true }),
  mk(64, "m2", 12, "12:40", "media", "Dario/Milan", "dario_mi", 40, 0, "981332750118326211", "me", "", { before: true, split: true }),
];
/** Nova's pages in `twoModels`: the sales of Mia's OnlyFans pages, on Nova's. */
BASE.push(...BASE.filter((row) => row.page === "fr" || row.page === "vip").map((row) => ({ ...row, id: row.id + 40, page: row.page === "fr" ? "nf" as const : "nv" as const })));
/** «Найти продажу»: sales of the days before on the shift's pages that no report of Lev's holds. */
const CLAIMABLE: Base[] = [
  mk(60, "m2", 11, "23:14", "tip", "Rowan/Canada", "rowan_k", 15, 0, "981329101442210831", "none", "фану никто не писал"),
  mk(61, "m3", 11, "21:40", "media", "Teo", "teo_r", 22, 0, "981328815503317702", "oleg", "ппв Олега"),
];
const MY_NOTES: Record<number, string> = { 7: "голосовое, просил ещё", 22: "тир Gold, обещан кастом 5 минут, сдать до пятницы" };
const G_EDITS = [
  { id: 3, from: "me" as Own, to: "half:seva" as Own, why: "О покупке договорился Сева 11 нояб.: фан написал «возьму завтра вечером». Вы отправили ппв и закрыли продажу." },
  { id: 20, from: "none" as Own, to: "me" as Own, why: "Владелец в чате смены в 23:52: «quill считай Льву, он его вернул»." },
];
const G_NOTES: Record<number, string> = { 8: "офис, часть 2" };
/** What the previous shift (Oleg's) left: the board's quiet line, and a comment on one of his sales before 18:00. */
const PREVIOUS = { comment: "Dario просил кастом к пятнице, ответьте ему первым", at: "17:58" };
const BEFORE_NOTES: Record<number, string> = { 10: "ждёт кастом, обещал купить завтра" };

const FANSLY_WORDS = { media: "Media Sale to", sub: "Subscription Sale to", tip: "Tip from" } as const;
const OF_WORDS = { media: "Payment for message from", sub: "Subscription from", tip: "Tip from" } as const;
const KIND = { media: "message_purchase", sub: "subscription", tip: "tip" } as const;
const pageOf = (id: PageId) => PAGES.find((page) => page.id === id)!;
const modelOfLabel = (label: string): ModelId => PAGES.find((page) => page.label === label)?.model ?? "mia";
/** The models of the board's pages, each once, in the pages' order: one post and one comment each. */
const modelsOf = (state: State): ModelId[] => [...new Set(state.pages.map((id) => pageOf(id).model))];
/** A model's comment, as Hub's rule says it: its own when written (an empty one too), else the general one. */
const commentOf = (state: State, model: ModelId) => (Object.hasOwn(state.modelComments, model) ? state.modelComments[model]! : state.comment);

/** 12 Nov 2026, Moscow (UTC+3). */
const at = (day: number, time: string) => new Date(Date.UTC(2026, 10, day, Number(time.slice(0, 2)) - 3, Number(time.slice(3)))).toISOString();
const SHIFT_START = at(12, "18:00");
/** Lev's morning shift of `splitDay`, closed without a report. The demo holds one shift's sales: its link opens the draft. */
const MORNING = { shiftId: 9_120_001, from: at(12, "10:00"), to: at(12, "13:05") };
const SHIFT_END = at(13, "02:00");
/** The prototype's clocks: handed in 02:04 (again 02:21), counted 02:09 (by Hub's check alone 02:16). */
const HANDED_IN = [at(13, "02:04"), at(13, "02:21")] as const;
const COUNTED = { found: at(13, "02:09"), silent: at(13, "02:16") } as const;
const m = (usd: number) => millsToNumber(millsFromDollars(usd));

const half = (own: Own): Who | null => (own.startsWith("half:") ? own.slice(5) as Who : null);
const cut = (own: Own, net: number) => (own === "me" ? net : half(own) ? net / 2 : 0);
function ownerOf(own: Own): ShiftReportOwner {
  if (own === "me") return { kind: "me", userId: LEV.userId, name: LEV.name, words: "моя" };
  const h = half(own);
  if (h) return { kind: "share", userId: WHO[h].userId, name: WHO[h].name, words: `пополам с ${personNameForms(WHO[h].name).ins}` };
  if (own === "oleg" || own === "seva") return { kind: "user", userId: WHO[own].userId, name: WHO[own].name, words: personNameForms(WHO[own].name).gen };
  if (own === "wait:oleg") return { kind: "waiting", userId: OLEG.userId, name: OLEG.name, words: personNameForms(OLEG.name).gen };
  if (own === "pot") return { kind: "pot", userId: null, name: null, words: "общак" };
  return { kind: "nobody", userId: null, name: null, words: "ничья" };
}
const ruleWord = (own: Own) => (own === "me" ? "ваша" : ownerOf(own).words);
/** Who answers a question about a sale the rule gives `rule`: the colleague (a waiting PPV's sender), or the owner for the pot. */
const askedOf = (rule: Own): Who | "owner" | null =>
  (rule === "oleg" || rule === "seva" ? rule : rule === "wait:oleg" ? "oleg" : half(rule) ?? (rule === "pot" ? "owner" : null));
/** A waiting PPV's last moment for its sender's shift, as Hub's rule gives it (sale-rule.ts `ppvWaitMs`: a week). */
const waitsUntilOf = (row: Base) => at(row.day + 7, row.t);

/**
 * The row's «чья» menu as Hub offers it (shift-report-board-view.ts `choicesOf`). Oleg and Seva both hand in by the
 * board: a word on a colleague is written at once, they are told; the pot's is the owner's.
 */
function choicesOf(row: Base, current: ShiftReportOwner): NonNullable<ShiftReportRow["choices"]> {
  const is = (one: ShiftReportOwner) => one.kind === current.kind && (one.userId ?? 0) === (current.userId ?? 0);
  type Asks = NonNullable<ShiftReportRow["choices"]>[number]["asks"];
  const item = (own: Own, asks: Asks, hint?: string) => {
    const owner = ownerOf(own);
    return { owner, asks, hint: own === row.rule ? "по правилу" : hint ?? asks?.words ?? "", current: is(owner) };
  };
  if (row.rule !== "me" && half(row.rule) === null) {
    const holder = askedOf(row.rule);
    const asks: Asks = holder === null ? null : holder === "owner"
      ? { to: "decider", user: null, words: "решит владелец" }
      : { to: "colleague", user: person(WHO[holder]), words: `сообщим ${personNameForms(WHO[holder].name).dat}` };
    return [item(row.rule, null), item("me", asks), ...(holder === "oleg" || holder === "seva" ? [item(`half:${holder}`, asks)] : [])];
  }
  return [item("me", null), item("half:oleg", null), item("half:seva", null), item("oleg", null), item("seva", null), item("pot", null, "решит владелец"), item("none", null)];
}

/** A word on someone else's sale: `taken` — a colleague's, written to Lev at once (Hub since 2026-11-21); `asked` — the decider's. */
interface Ask { to: Who | "owner"; want: Own; note: string; state: "asked" | "disputed" | "taken" }
/** A colleague wrote Lev's sale to themself: `taken` — unanswered, `agreed` — «Понятно», `disputed` — «Не согласен». */
interface Incoming { id: number; from: Who; note: string; state: "taken" | "agreed" | "disputed" }
interface Proposal { id: number; from: Own; to: Own; why: string; state: "proposed" | "declined" | "accepted" }
interface OffPlatform { id: number; amountMills: number; fromWhom: string; whatFor: string; state: "pending" | "confirmed" | "rejected"; pageLabel: string | null }

interface State {
  phase: ShiftReportPhase;
  own: Map<number, Own>;
  ok: Map<number, string>;
  notes: Map<number, { text: string; by: "person" | "agent" }>;
  asks: Map<number, Ask>;
  incoming: Incoming | null;
  proposals: Map<number, Proposal>;
  gNote: { id: number; text: string; state: "proposed" | "accepted" } | null;
  lost: boolean;
  lostAdded: boolean;
  late: boolean;
  lateAdded: boolean;
  /** Sales added by hand («Найти продажу»). */
  extra: Base[];
  pages: PageId[];
  /** How Gengar answers the next check: found (proposals), clean, silent. */
  mode: "found" | "clean" | "silent";
  gengar: "reading" | "found" | "clean" | "silent" | null;
  /** When the check began and what it was handed in with: the played answers count from here. */
  submittedAtMs: number | null;
  submittedMills: number;
  submittedCount: number;
  candidates: number;
  /** «Сдать смену» carried what the bar showed and it was the report: a check that finds nothing counts it by itself. */
  signed: boolean;
  /** Signed, and the check found something: «Подтвердите» with «Проверка нашла изменения». */
  signatureDeclined: boolean;
  wasMills: number | null;
  counted: boolean;
  countedAt: string | null;
  countedMills: number;
  /** Counted by Hub's check while Gengar was silent: his reading comes later. */
  countedAtMs: number | null;
  gWait: boolean;
  /** «Исправить»: the counted board as it was, for «Отмена». */
  snapshot: State | null;
  /** Hub's re-read finds a sale at the first «Подтверждаю» (the board changed under the person's eyes). */
  hubFinds: boolean;
  found: boolean;
  /** The post in «Отчётность», as Hub would watch it (`post-copied` is not a demo operation yet: set by the scenario). */
  post: { copiedAt: string | null; seen: boolean; changedSinceCopy: boolean; late: boolean };
  /** Of two models: each model's «Скопировать пост», by model. */
  postCopies: Partial<Record<ModelId, string>>;
  /** «Скопировать пост» pressed (real time): the post «arrives» in «Отчётность» a little later. */
  copiedAtMs: number | null;
  /** A person without the board: read only. */
  preview: boolean;
  /** Lev's morning shift waits for its report (`splitDay`). */
  split: boolean;
  /** The general comment; each model's own (Hub 0432) in `modelComments`. */
  comment: string;
  modelComments: Partial<Record<ModelId, string>>;
  offPlatform: OffPlatform[];
}

function fresh(): State {
  return {
    phase: "draft", own: new Map(), ok: new Map(), notes: new Map(Object.entries(MY_NOTES).map(([id, text]) => [Number(id), { text, by: "person" as const }])),
    asks: new Map(), incoming: null, proposals: new Map(), gNote: null, lost: false, lostAdded: false, late: false, lateAdded: false, extra: [],
    pages: ["m2", "m3", "fr", "vip"], mode: "found", gengar: null, submittedAtMs: null, submittedMills: 0, submittedCount: 0, candidates: 0, signed: false, signatureDeclined: false,
    wasMills: null, counted: false, countedAt: null, countedMills: 0, countedAtMs: null, gWait: false, snapshot: null, comment: "", modelComments: {}, offPlatform: [],
    hubFinds: false, found: false, post: { copiedAt: null, seen: false, changedSinceCopy: false, late: false }, postCopies: {}, preview: false, copiedAtMs: null, split: false,
  };
}

function clone(state: State): State {
  return {
    ...state,
    own: new Map(state.own), ok: new Map(state.ok), notes: new Map(state.notes), asks: new Map(state.asks),
    incoming: state.incoming && { ...state.incoming }, proposals: new Map([...state.proposals].map(([id, one]) => [id, { ...one }])),
    gNote: state.gNote && { ...state.gNote }, extra: [...state.extra], pages: [...state.pages], offPlatform: state.offPlatform.map((one) => ({ ...one })),
    post: { ...state.post }, postCopies: { ...state.postCopies }, modelComments: { ...state.modelComments },
    snapshot: null,
  };
}

function rowsOf(state: State) {
  return [...BASE, ...state.extra].filter((row) => state.pages.includes(row.page) && (!row.lost || state.lost) && (!row.late || state.late) && (!row.found || state.found)
    && (!row.split || state.split));
}
const lostOpen = (state: State, row: Base) => !!row.lost && !state.lostAdded;
const lateOpen = (state: State, row: Base) => !!row.late && !state.lateAdded;
const ownNow = (state: State, row: Base): Own => state.own.get(row.id) ?? (row.lost ? "me" : row.rule);
function shareOf(state: State, row: Base): number {
  if (row.before || lostOpen(state, row) || lateOpen(state, row)) return 0;
  // A take counts at once (all, or the half); a question to the decider counts nothing until the decision.
  const ask = state.asks.get(row.id);
  if (ask !== undefined) return ask.state === "taken" ? cut(ask.want, row.net) : 0;
  // Taken by a colleague: nothing of it is Lev's while it stands; disputed, it is the rule's (his) until the decision.
  if (state.incoming?.id === row.id && state.incoming.state !== "disputed") return 0;
  return cut(ownNow(state, row), row.net);
}
function setOwn(state: State, row: Base, own: Own) {
  if (own === (row.lost ? "me" : row.rule)) state.own.delete(row.id);
  else state.own.set(row.id, own);
}
const totalOf = (state: State) => rowsOf(state).reduce((sum, row) => sum + m(shareOf(state, row)), 0);
const countOf = (state: State) => rowsOf(state).filter((row) => shareOf(state, row) > 0).length;

function rowOf(state: State, row: Base, own: boolean): ShiftReportRow {
  const page = pageOf(row.page);
  const fansly = page.platform === "fansly";
  const word = ownNow(state, row);
  const share = shareOf(state, row);
  const editing = state.phase === "draft" || state.phase === "fixing";
  const sighting = !!row.lost;
  const plain = !row.before && !lostOpen(state, row) && !lateOpen(state, row) && !sighting;
  const proposal = state.proposals.get(row.id) ?? null;
  const ask = state.asks.get(row.id) ?? null;
  const incoming = state.incoming?.id === row.id ? state.incoming : null;
  const note: { text: string; by: "person" | "agent" | "other" } | null = row.before && BEFORE_NOTES[row.id]
    ? { text: BEFORE_NOTES[row.id]!, by: "other" }
    : state.notes.get(row.id) ?? (state.gNote?.id === row.id ? { text: state.gNote.text, by: "agent" as const } : null);
  const taken = ask?.state === "taken";
  const takenFromMe = incoming !== null && incoming.state !== "disputed";
  let owner = ownerOf(taken ? ask!.want : takenFromMe ? incoming!.from : word);
  let reasonWords = "";
  if (lostOpen(state, row)) {
    owner = { kind: "me", userId: LEV.userId, name: LEV.name, words: "нет в Hub" };
    reasonWords = "Hub не поймал";
  } else if (lateOpen(state, row)) {
    owner = { kind: "me", userId: LEV.userId, name: LEV.name, words: "после сдачи" };
    reasonWords = row.why;
  } else if (ask?.state === "asked") {
    reasonWords = ask.to === "owner" ? "ждём владельца" : `ждём ответа ${personNameForms(WHO[ask.to].name).gen}`;
  } else if (taken && ask.to !== "owner") {
    reasonWords = `по правилу ${personNameForms(WHO[ask.to].name).gen}, записали вы`;
  } else if (ask?.state === "disputed" && ask.to !== "owner") {
    reasonWords = `${WHO[ask.to].name} не согласен, решит владелец`;
  } else if (takenFromMe) {
    reasonWords = "по правилу ваша";
  } else if (incoming) {
    reasonWords = `${WHO[incoming.from].name} оспаривает`;
  } else if (proposal && (proposal.state === "proposed" || proposal.state === "accepted")) {
    reasonWords = "поменял Генгар";
  } else if (state.ok.has(row.id)) {
    reasonWords = state.ok.get(row.id)!;
  } else if (word !== row.rule && !row.lost) {
    reasonWords = `по правилу ${ruleWord(row.rule)}`;
  } else if (share <= 0) {
    reasonWords = row.why;
  }
  const attention = lostOpen(state, row) || lateOpen(state, row) || incoming?.state === "taken"
    || (state.phase === "confirm" && (proposal?.state === "proposed" || (state.gNote?.id === row.id && note?.by === "agent")));
  const askTo = ask === null ? null : ask.to;
  // Ticks and «чья» only in the draft; a comment in every phase (the next shift reads it); nothing in a preview.
  // A sale a colleague wrote to themself: Lev's words on it change nothing while the take stands (Hub's rule).
  const editable = own && !state.preview && editing && plain && !takenFromMe;
  return {
    key: sighting ? `s${row.id}` : `t${row.id}`,
    transactionId: sighting ? null : row.id,
    pageLabel: page.label,
    platform: page.platform,
    platformRef: fansly ? row.tx : null,
    refLabel: fansly ? `#…${row.tx.slice(-4)}` : null,
    kind: KIND[row.kind],
    siteWords: (fansly ? FANSLY_WORDS : OF_WORDS)[row.kind],
    fan: { fanRef: row.handle, name: row.name, username: row.handle },
    occurredAt: at(row.day, row.t),
    netMills: m(row.net),
    grossMills: fansly ? null : m(row.gross),
    rule: {
      owner: row.split ? ownerOf("me") : row.before ? ownerOf("oleg") : ownerOf(row.lost ? "me" : row.rule), reason: row.before ? "holder" : "demo", words: row.why,
      ...(row.rule === "wait:oleg" ? { waitsUntil: waitsUntilOf(row) } : {}),
    },
    owner: row.split ? ownerOf("me") : row.before ? ownerOf("oleg") : owner,
    statement: taken ? (ask!.want === "me" ? "mine" : "share")
      : word === row.rule || row.before || row.lost ? null : word === "none" ? "not_mine" : word === "me" ? "mine" : half(word) ? "share" : word === "pot" ? "pot" : "give",
    reasonWords: row.split ? "смена 12 нояб., 10:00–13:05, не сдана" : row.before ? "смена Олега" : reasonWords,
    ticked: share > 0,
    amountMills: m(share),
    before: row.before ? { user: person(row.split ? LEV : OLEG) } : null,
    late: !!row.late,
    ask: ask === null || askTo === null ? null : {
      claimId: ASK_CLAIM_BASE + row.id,
      to: askTo === "owner" ? "owner" : "colleague",
      toUser: askTo === "owner" ? null : person(WHO[askTo]),
      want: ownerOf(ask.want),
      note: ask.note,
      // Hub's words of a take: written without the colleague's answer («silence»), `taken`.
      state: ask.state === "taken" ? "silence" : ask.state,
      answerNote: null,
      answerBy: null,
      decision: null,
      ...(ask.state === "taken" ? { taken: true } : {}),
    },
    incoming: incoming ? {
      claimId: INCOMING_CLAIM_ID, from: person(WHO[incoming.from]), statement: "mine", note: incoming.note,
      state: incoming.state === "disputed" ? "disputed" : "settled",
      canAnswer: own && incoming.state === "taken", answer: incoming.state === "disputed" ? "disagree" : incoming.state === "agreed" ? "agree" : null, answerBy: null,
      ...(incoming.state === "disputed" ? {} : { taken: true }),
    } : null,
    proposal: proposal ? {
      id: proposal.id, kind: "owner_change", from: ownerOf(proposal.from), to: ownerOf(proposal.to),
      note: null, deltaMills: m(cut(proposal.to, row.net) - cut(proposal.from, row.net)), why: proposal.why, state: proposal.state, afterCounted: false, by: "Генгар",
    } : state.gNote?.id === row.id ? {
      id: 5_103, kind: "note", from: null, to: null, note: state.gNote.text, deltaMills: 0, why: "Из переписки: фан просил вторую часть офиса.", state: state.gNote.state, afterCounted: false, by: "Генгар",
    } : null,
    note: note ? { text: note.text, by: note.by, byName: note.by === "agent" ? "Генгар" : note.by === "other" ? OLEG.name : LEV.name } : null,
    sighting: sighting ? { id: row.id, seenAt: at(12, "21:31"), added: state.lostAdded } : null,
    editable,
    canNote: own && !state.preview && plain,
    attention,
    // A sale Lev wrote to himself has no menu of «чья» (Hub's rule): the tick or «Отменить» takes it back.
    ...(editable ? { choices: taken ? [] : choicesOf(row, owner) } : {}),
    foundByHub: row.found === true,
  };
}

const minuteOf = (row: Base) => row.day * 1440 + Number(row.t.slice(0, 2)) * 60 + Number(row.t.slice(3));

function boardOf(state: State, own: boolean, nowMs: number): ShiftReportBoard {
  const rows = rowsOf(state);
  const columns = state.pages.map((id) => {
    const page = pageOf(id);
    const all = rows.filter((row) => row.page === id).sort((a, b) => minuteOf(b) - minuteOf(a));
    const shift = all.filter((row) => !row.before).map((row) => rowOf(state, row, own));
    const before = all.filter((row) => row.before).map((row) => rowOf(state, row, own));
    return {
      pageLabel: page.label, platform: page.platform, pageHandle: page.handle, modelName: MODELS[page.model],
      rows: shift,
      before: { count: before.length, until: SHIFT_START, people: before.some((row) => row.owner.kind !== "me") ? [person(OLEG)] : [], rows: before },
      marked: shift.filter((row) => row.ticked).length,
      of: shift.length,
      sumMills: shift.reduce((sum, row) => sum + row.amountMills, 0),
      attention: shift.some((row) => row.attention),
    };
  });
  const flat = columns.flatMap((column) => column.rows);
  const nowMills = flat.reduce((sum, row) => sum + row.amountMills, 0);
  const count = flat.filter((row) => row.ticked).length;
  const handed = state.candidates > 0;
  const hubDone = state.submittedAtMs === null || nowMs - state.submittedAtMs >= HUB_PAUSE_MS || state.phase !== "checking";
  const proposals = [...state.proposals.values()].length;
  const gengarState = state.gengar ?? "idle";
  const waiting = flat.filter((row) => row.ask?.state === "asked" || row.ask?.state === "disputed" || (row.incoming && row.incoming.state !== "settled")
    || (row.sighting && !row.sighting.added) || (row.late && !row.ticked)).map((row) => ({
    key: row.key, transactionId: row.transactionId, pageLabel: row.pageLabel, fanName: row.fan.name, netMills: row.netMills,
    why: row.ask ? "ask" as const : row.incoming ? "incoming" as const : row.sighting ? "sighting" as const : "late" as const,
  }));
  const again = state.candidates > 1;
  return {
    phase: state.phase,
    chip: SHIFT_REPORT_PHASE_CHIPS[state.phase],
    offShift: [{ pageLabel: "Mia-1", platform: "fansly" }],
    columns,
    candidate: handed ? {
      id: 6_000 + state.candidates, number: state.candidates, madeAt: HANDED_IN[again ? 1 : 0], by: LEV.name, door: "workboard", cutoffAt: HANDED_IN[again ? 1 : 0],
      count: state.submittedCount, totalMills: state.submittedMills,
      hub: {
        state: !hubDone ? "running" : state.found ? "found" : "matched",
        pages: columns.map((column) => {
          const found = state.found && column.pageLabel === "Mia-2";
          return { pageLabel: column.pageLabel, state: !hubDone ? "running" as const : found ? "found" as const : "matched" as const, foundCount: found ? 1 : 0, foundMills: found ? m(15) : 0, at: hubDone ? at(13, "02:05") : null };
        }),
        foundCount: state.found ? 1 : 0, foundMills: state.found ? m(15) : 0,
      },
      gengar: {
        state: gengarState, since: HANDED_IN[again ? 1 : 0],
        answeredAt: gengarState === "found" || gengarState === "clean" ? at(13, "02:07") : null,
        proposals, notes: state.gNote ? 1 : 0,
      },
      superseded: false,
      signed: state.signed,
      signatureDeclined: state.phase === "confirm" && state.signatureDeclined,
    } : null,
    totals: { count, nowMills, wasMills: state.wasMills },
    waiting,
    colleagues: [person(OLEG), person(SEVA)],
    decider: { kind: "owner", user: null, words: "владелец" },
    canConfirm: own && state.phase === "confirm",
    needsMe: own && (state.phase === "confirm" || waiting.some((one) => one.why === "incoming" || one.why === "late") || flat.some((row) => row.incoming?.canAnswer === true) || state.split),
    handedInAt: handed ? HANDED_IN[again ? 1 : 0] : null,
    countedAt: state.counted ? state.countedAt : null,
    preview: state.preview ? true : undefined,
    otherShifts: own && state.split
      ? [{ shiftId: MORNING.shiftId, startedAt: MORNING.from, endedAt: MORNING.to, ongoing: false, phase: "draft", count: 1, mills: m(40) }]
      : undefined,
    previous: own ? { user: person(OLEG), comment: PREVIOUS.comment, at: at(12, PREVIOUS.at) } : null,
    post: own && state.counted
      ? {
        ...state.post,
        models: modelsOf(state).map((model, _, all) => ({
          modelSlug: model, modelName: MODELS[model], copiedAt: all.length === 1 ? state.post.copiedAt : state.postCopies[model] ?? null, changedSinceCopy: state.post.changedSinceCopy,
        })),
      }
      : null,
  };
}

/** The prototype's `postText()`: the counted report as today's post in «Отчётность», one per model with its own comment. */
function postOf(state: State, board: ShiftReportBoard, model: ModelId): string {
  const money = (mills: number) => `$${(mills / 1000).toFixed(2).replace(".", ",")}`;
  const word = (row: ShiftReportRow) => (row.kind === "message_purchase" ? "ппв" : row.kind === "tip" ? "тип" : row.netMills >= 20_000 ? "тир" : "саб");
  const columns = board.columns.filter((column) => modelOfLabel(column.pageLabel) === model);
  const fans = new Map<string, ShiftReportRow[]>();
  columns.flatMap((column) => column.rows).filter((row) => row.ticked).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    .forEach((row) => fans.set(row.pageLabel + row.fan.username, [...(fans.get(row.pageLabel + row.fan.username) ?? []), row]));
  const lines = [...fans.values()].map((rows) => `${rows[0]!.platform === "fansly" ? "https://fansly.com/" : "https://onlyfans.com/"}${rows[0]!.fan.username} - ${rows[0]!.fan.name}, `
    + rows.map((row) => `${word(row)} ${money(row.amountMills)}${row.owner.kind === "share" ? ` (${row.owner.words})` : ""}${row.note ? ` (${row.note.text})` : ""}`).join(", "));
  const acc = (platform: "fansly" | "onlyfans") => columns.filter((column) => column.platform === platform).map((column) => `• ${column.pageLabel} - ${money(column.sumMills)}`).join("\n");
  // Mia-1 (not held this shift) is Mia's: only her post names it.
  const accounts = [
    ...(model === "mia" ? ["Fansly", "• Mia-1 - не в смене", acc("fansly")] : acc("fansly") !== "" ? ["Fansly", acc("fansly")] : []),
    ...(acc("onlyfans") !== "" ? ["OF", acc("onlyfans")] : []),
  ].join("\n");
  const total = columns.reduce((sum, column) => sum + column.sumMills, 0);
  return `🗓 Дата: 12.11.2026\n👤 Чаттер: #lev\n\n📌 Аккаунты:\n${accounts}\n\n💰 Общий доход: ${money(total)}\n\n📈 Основные продажи:\n${lines.join("\n")}\n\n📝 Комментарий:\n${commentOf(state, model).trim() || "-"}\n\nОтчёт № 2318`;
}

/** Gengar reads the candidate (the prototype's `gengarRun`): his proposals stand applied, a card under each. */
function gengarAnswers(state: State) {
  if (state.mode === "silent") {
    state.gengar = "silent";
    return;
  }
  if (state.mode === "clean") {
    state.gengar = "clean";
    return;
  }
  const rows = rowsOf(state);
  G_EDITS.forEach((edit, index) => {
    const row = rows.find((one) => one.id === edit.id);
    if (!row || state.asks.has(row.id) || ownNow(state, row) !== edit.from) return;
    state.proposals.set(edit.id, { id: 5_101 + index, from: edit.from, to: edit.to, why: edit.why, state: "proposed" });
    setOwn(state, row, edit.to);
  });
  const noted = rows.find((one) => one.id === 8);
  if (noted && !state.notes.has(8) && shareOf(state, noted) > 0) state.gNote = { id: 8, text: G_NOTES[8]!, state: "proposed" };
  state.gengar = state.proposals.size > 0 || state.gNote ? "found" : "clean";
}

/** «Сдать смену» (and «Сдать заново»): a candidate, the check begins; `signed` — the bar's totals were the report's. */
function handIn(state: State, nowMs: number, signed = false) {
  const again = state.phase === "fixing";
  state.signed = signed;
  state.signatureDeclined = false;
  // «Сдать заново»: «Было» is the report before the correction.
  state.wasMills = again ? state.wasMills : null;
  state.submittedMills = totalOf(state);
  state.submittedCount = countOf(state);
  state.candidates += 1;
  state.phase = "checking";
  state.gengar = "reading";
  state.submittedAtMs = nowMs;
  state.snapshot = null;
  // A second hand-in is checked again and comes back clean, as in the prototype.
  if (again) state.mode = "clean";
  // Gengar's edits taken earlier stay the row's reason (the prototype's `settleGengar`).
  for (const [id, proposal] of state.proposals) if (proposal.state === "accepted") state.ok.set(id, "поменял Генгар");
  state.proposals.clear();
  state.gNote = null;
}

/** The played answers: Hub after a second, Gengar after four; Gengar's late reading after «по проверке Hub». */
function advance(state: State, nowMs: number) {
  if (state.copiedAtMs !== null && !state.post.seen && nowMs - state.copiedAtMs >= POST_SEEN_MS) state.post = { ...state.post, seen: true };
  if (state.phase === "checking" && state.submittedAtMs !== null && nowMs - state.submittedAtMs >= GENGAR_PAUSE_MS) {
    gengarAnswers(state);
    if (state.wasMills === null) state.wasMills = state.submittedMills;
    state.phase = "confirm";
    // Hub's rule: the signature counts a report the check left as it was; a card of Gengar sends it to the person.
    if (state.signed && state.proposals.size === 0 && state.gNote === null) confirm(state, nowMs);
    else if (state.signed) {
      state.signed = false;
      state.signatureDeclined = true;
    }
  }
  if (state.phase === "counted" && state.gWait && state.countedAtMs !== null && nowMs - state.countedAtMs >= GENGAR_LATE_MS) {
    state.gWait = false;
    state.gengar = "clean";
  }
}

/** «Подтверждаю» (the prototype's `confirmNow` with `settleGengar`). */
function confirm(state: State, nowMs: number) {
  for (const [id, proposal] of state.proposals) {
    if (proposal.state === "proposed") proposal.state = "accepted";
    else if (proposal.state === "declined") {
      state.proposals.delete(id);
      state.ok.set(id, "Генгар предлагал иначе, решит владелец");
    }
  }
  if (state.gNote) {
    state.notes.set(state.gNote.id, { text: state.gNote.text, by: "agent" });
    state.gNote = null;
  }
  state.phase = "counted";
  state.counted = true;
  state.countedAt = state.gengar === "silent" ? COUNTED.silent : COUNTED.found;
  state.countedAtMs = nowMs;
  state.gWait = state.gengar === "silent";
  state.countedMills = totalOf(state);
  state.wasMills = null;
}

/** Hand in and check: the prototype's `confirmScn`; `signed` — the hand-in was the person's signature. */
function confirmState(mode: "found" | "clean" | "silent", signed = false): State {
  const state = fresh();
  state.mode = mode;
  handIn(state, 0, signed);
  advance(state, GENGAR_PAUSE_MS);
  return state;
}
function countedState(): State {
  const state = confirmState("found");
  confirm(state, 0);
  return state;
}

const SCENARIOS: Record<Scenario, (nowMs: number) => State> = {
  draft: fresh,
  note: () => {
    const state = fresh();
    state.notes.set(3, { text: "торг, допродажа", by: "person" });
    state.comment = "Dario ждёт кастом к пятнице, Viggo торгуется";
    return state;
  },
  // «Моя» on Oleg's sale: written to Lev at once, Oleg told; «Отменить» under the row gives it back.
  askColleague: () => {
    const state = fresh();
    state.asks.set(6, { to: "oleg", want: "me", note: "общался я, Felix ответил на мою рассылку в 19:36", state: "taken" });
    return state;
  },
  askOwner: () => {
    const state = fresh();
    state.asks.set(2, { to: "owner", want: "me", note: "тип под постом, но фан написал, что это мне за вечер", state: "asked" });
    return state;
  },
  notInHub: () => ({ ...fresh(), lost: true }),
  // Signed at «Сдать смену», and the check finds nothing: «Учтён» by itself, no «Подтверждаю».
  checking: (nowMs) => {
    const state = fresh();
    state.mode = "clean";
    handIn(state, nowMs, true);
    return state;
  },
  // Signed, and Gengar found edits: the signature is not applied, the person confirms what the board is now.
  gengarFound: () => confirmState("found", true),
  // The first «Подтверждаю» meets Hub's late re-read: one more sale, the board changed, the person presses again.
  gengarClean: () => ({ ...confirmState("clean"), hubFinds: true }),
  gengarSilent: () => confirmState("silent"),
  // Seva wrote Lev's Ash/UK to himself: it counts for Seva at once (Lev's report got its version), Lev is told.
  dispute: () => {
    const state: State = { ...countedState(), post: { copiedAt: at(13, "02:11"), seen: true, changedSinceCopy: false, late: false }, incoming: { id: 23, from: "seva", note: "этот ппв Ash я отправлял 10-го, Лев только напомнил", state: "taken" } };
    state.countedMills = totalOf(state);
    return state;
  },
  late: () => ({ ...countedState(), late: true, post: { copiedAt: null, seen: false, changedSinceCopy: false, late: true } }),
  counted: () => ({ ...countedState(), post: { copiedAt: at(13, "02:11"), seen: false, changedSinceCopy: false, late: false } }),
  fixing: () => {
    const counted = countedState();
    const state = clone(counted);
    state.snapshot = counted;
    state.phase = "fixing";
    state.wasMills = counted.countedMills;
    setOwn(state, BASE.find((row) => row.id === 7)!, "none");
    return state;
  },
  fivePages: () => ({ ...fresh(), pages: ["m2", "m3", "m4", "fr", "vip"] }),
  emptyPage: () => ({ ...fresh(), pages: ["m2", "m3", "fr", "vip", "pr"] }),
  preview: () => ({ ...fresh(), preview: true }),
  // Mia's comment written, Nova's not yet: a field per model, each named.
  twoModels: () => ({ ...fresh(), pages: ["m2", "m3", "nf", "nv"], modelComments: { mia: "Dario ждёт кастом к пятнице" } }),
  splitDay: () => ({ ...fresh(), split: true }),
};

/** Every scenario's board as it stands, per fresh copy (`hub-demo-board`): kept until the demo server restarts. */
const BOARDS = new Map<string, State>();
const BOARD_COOKIE = "hub-demo-board";

function stateOf(request: DemoRequest, scenario: Scenario): State {
  const key = `${request.cookie?.(BOARD_COOKIE) ?? "0"}:${scenario}`;
  let state = BOARDS.get(key);
  if (state === undefined) {
    if (BOARDS.size > 400) BOARDS.clear();
    state = SCENARIOS[scenario](request.now.getTime());
    BOARDS.set(key, state);
  }
  advance(state, request.now.getTime());
  return state;
}

function reportOf(request: DemoRequest, scenario: Scenario): Report {
  const state = stateOf(request, scenario);
  const own = request.role === "chatter";
  const full = boardOf(state, own, request.now.getTime());
  // Hub says it both ways: `preview` on the board and `enabled: false` on the response.
  const board = full;
  const shiftId = DEMO_BOARD_SHIFTS[scenario];
  const version = state.counted ? {
    version: 1, submittedAt: state.countedAt ?? COUNTED.found, door: "workboard" as const, by: LEV.name, totalMills: state.countedMills, madeFor: null,
  } : null;
  const late = board.columns.flatMap((column) => column.rows).filter((row) => row.late && !row.ticked);
  return {
    shift: {
      id: shiftId, userId: LEV.userId, personName: LEV.name, ongoing: false, startedAt: SHIFT_START, endedAt: SHIFT_END,
      workedMinutes: 480, reportDate: "2026-11-12", pages: board.columns.map((column) => column.pageLabel),
    },
    access: own ? "own" : "read",
    enabled: !state.preview,
    boardShift: !state.preview,
    canEdit: own && !state.preview,
    state: version ? "submitted" : "open",
    latest: version,
    versions: version ? [version] : [],
    // The board's comment and «мимо площадки» ride on the draft's body until the board carries them itself.
    view: {
      source: "draft", version: null, submittedAt: null, door: null, lines: [], offPlatform: state.offPlatform, comment: state.comment,
      comments: modelsOf(state).map((model) => ({ modelSlug: model, modelName: MODELS[model], comment: commentOf(state, model) })),
      pages: board.columns.map((column) => ({ pageLabel: column.pageLabel, platform: column.platform, amountMills: column.sumMills })),
      totalMills: board.totals.nowMills, cut: !own, computedAt: request.now.toISOString(),
    },
    afterSubmission: own && late.length ? { count: late.length, mills: late.reduce((sum, row) => sum + row.netMills, 0) } : null,
    posts: own && state.counted ? modelsOf(state).map((model) => ({ modelSlug: model, modelName: MODELS[model], text: postOf(state, board, model) })) : [],
    colleagues: [OLEG, SEVA],
    claims: [],
    board,
    serverNow: request.now.toISOString(),
  };
}

export function isDemoBoardShift(shiftId: number): boolean {
  return SCENARIO_OF.has(shiftId);
}

/** The scenario board of a shift id, or null — not a scenario shift. */
export function demoBoardReport(request: DemoRequest, shiftId: number): Report | null {
  const scenario = SCENARIO_OF.get(shiftId);
  return scenario === undefined ? null : reportOf(request, scenario);
}

const noBoard = (): DemoReply => demoError(404, "Not Found", "No such shift");
const notYours = (): DemoReply => demoError(403, "Forbidden", "Only the person hands their shift in");
const refused = (why: string): DemoReply => demoError(400, "Bad Request", why);

type Write = (state: State, request: DemoRequest) => DemoReply | null;

/** A write on a scenario's board: the person's own (the demo chatter), on the scenario's state. Null — not a board shift. */
function write(request: DemoRequest, shiftId: number, change: Write): Report | DemoReply | null {
  const scenario = SCENARIO_OF.get(shiftId);
  if (scenario === undefined) return null;
  if (request.role !== "chatter") return notYours();
  const state = stateOf(request, scenario);
  const failed = change(state, request);
  return failed ?? reportOf(request, scenario);
}
const shiftOf = (request: DemoRequest) => Number(request.params.shiftId);
const rowById = (state: State, id: number) => rowsOf(state).find((row) => row.id === id) ?? null;
const editing = (state: State) => state.phase === "draft" || state.phase === "fixing";

const fromWord = (body: { statement: string | null; shareWithUserId?: number | null; toUserId?: number | null }, row: Base): Own | null => {
  switch (body.statement) {
    case null: return row.rule;
    case "not_mine": return "none";
    case "mine": return "me";
    case "pot": return "pot";
    case "share": { const who = whoOf(body.shareWithUserId); return who ? `half:${who}` : null; }
    case "give": return whoOf(body.toUserId);
    default: return null;
  }
};

/** The writes of the old operations (shift-reports.ts asks here first for a board shift). */
export function demoBoardWrite(request: DemoRequest, operation: "lineSet" | "comment" | "offPlatformAdd" | "offPlatformWithdraw" | "submit" | "claimable"): unknown {
  const shiftId = shiftOf(request);
  if (!isDemoBoardShift(shiftId)) return null;
  if (operation === "claimable") {
    if (request.role !== "chatter") return notYours();
    const state = stateOf(request, SCENARIO_OF.get(shiftId)!);
    return {
      sales: CLAIMABLE.filter((sale) => !state.extra.some((one) => one.id === sale.id) && state.pages.includes(sale.page)).map((sale) => ({
        transactionId: sale.id, pageLabel: pageOf(sale.page).label, platform: pageOf(sale.page).platform, kind: KIND[sale.kind], occurredAt: at(sale.day, sale.t),
        netMills: m(sale.net), fan: { fanRef: sale.handle, name: sale.name, username: sale.handle }, home: sale.rule === "none" ? "nobody" : "shift", words: sale.why,
      })),
      serverNow: request.now.toISOString(),
    };
  }
  let saved = false;
  const answer = write(request, shiftId, (state) => {
    if (operation === "comment") {
      // With a model: its own comment alone; without: the one comment of every post (Hub's rule, 0432).
      const body = request.body as { comment: string; modelSlug?: string };
      if (body.modelSlug === undefined) {
        state.comment = String(body.comment);
        state.modelComments = {};
      } else {
        const model = modelsOf(state).find((one) => one === body.modelSlug);
        if (model === undefined) return refused("This model is not one of the report's pages");
        state.modelComments = { ...state.modelComments, [model]: String(body.comment) };
      }
      saved = true;
      return null;
    }
    if (operation === "offPlatformAdd") {
      const body = request.body as { amountMills: number; fromWhom: string; whatFor: string };
      state.offPlatform.push({ id: 950 + state.offPlatform.length, amountMills: body.amountMills, fromWhom: body.fromWhom, whatFor: body.whatFor, state: "pending", pageLabel: null });
      saved = true;
      return null;
    }
    if (operation === "offPlatformWithdraw") {
      state.offPlatform = state.offPlatform.filter((one) => one.id !== Number(request.params.offPlatformId));
      saved = true;
      return null;
    }
    if (operation === "submit") {
      if (!editing(state)) return refused("Not a draft");
      // What the bar showed, as Hub compares it: equal to the report, the hand-in is the person's signature.
      const seen = (request.body ?? {}) as { seenTotalMills?: number; seenCount?: number };
      handIn(state, request.now.getTime(), seen.seenTotalMills === totalOf(state) && seen.seenCount === countOf(state));
      return null;
    }
    // lineSet
    const id = Number(request.params.transactionId);
    const body = request.body as { statement: string | null; shareWithUserId?: number | null; toUserId?: number | null; note?: string | null };
    let row = rowById(state, id);
    if (row === null) {
      const claimable = CLAIMABLE.find((sale) => sale.id === id);
      if (claimable === undefined || body.statement !== "mine") return demoError(404, "Not Found", "No such sale");
      row = { ...claimable };
      state.extra.push(row);
      state.ok.set(id, "добавили вы");
    }
    if (!(editing(state) || (state.phase === "confirm" && body.note !== undefined))) return refused("The report is not open for changes");
    if (editing(state)) {
      const own = fromWord(body, row);
      if (own === null) return refused("A word the line does not take");
      if (own !== ownNow(state, row)) {
        setOwn(state, row, own);
        if (!state.ok.has(id) || state.ok.get(id) !== "добавили вы") state.ok.delete(id);
      }
    }
    if (body.note !== undefined) {
      const text = body.note?.trim() ?? "";
      if (text === "") state.notes.delete(id);
      else state.notes.set(id, { text, by: "person" });
    }
    saved = true;
    return null;
  });
  if (answer === null) return null;
  if (saved && !("demoReply" in (answer as object))) {
    return operation === "offPlatformAdd"
      ? { line: (stateOf(request, SCENARIO_OF.get(shiftId)!)).offPlatform.at(-1)!, savedAt: request.now.toISOString() }
      : { savedAt: request.now.toISOString() };
  }
  return answer;
}

/**
 * «Понятно» / «Не согласен» on the board's incoming take (sale-claims.ts asks here first): «Понятно» moves nothing;
 * «Не согласен» sends it to the owner, and until he decides the sale is Lev's by the rule again (his report's version).
 */
export function demoBoardClaimAnswer(request: DemoRequest): unknown {
  const claimId = Number(request.params.claimId);
  if (claimId !== INCOMING_CLAIM_ID) return null;
  if (request.role !== "chatter") return notYours();
  const scenario: Scenario = "dispute";
  const state = stateOf(request, scenario);
  const incoming = state.incoming;
  if (incoming === null || incoming.state !== "taken") return refused("Nothing to answer");
  const body = request.body as { answer: "agree" | "disagree" };
  const row = rowById(state, incoming.id)!;
  incoming.state = body.answer === "agree" ? "agreed" : "disputed";
  if (body.answer === "disagree" && state.counted) state.countedMills = totalOf(state);
  const now = request.now.toISOString();
  return {
    claim: {
      id: claimId, kind: "claim", transactionId: row.id, pageLabel: pageOf(row.page).label,
      claimant: { userId: SEVA.userId, name: SEVA.name }, statement: "mine", note: incoming.note, claimedAt: at(13, "02:30"),
      side: { userId: LEV.userId, name: LEV.name }, sideShiftId: DEMO_BOARD_SHIFTS.dispute,
      state: body.answer === "agree" ? "agreed" : "owner", answer: body.answer, answerNote: null, answeredAt: now,
      escalatedWhy: body.answer === "agree" ? null : "disagree", decision: null, answerBy: null, question: null,
    },
    savedAt: now,
  };
}

export const shiftReportBoardHandlers: DemoHandlers = {
  shiftReportCurrent: (request) => ({ report: reportOf(request, "draft"), phase: stateOf(request, "draft").phase, serverNow: request.now.toISOString() }),
  shiftReportConfirm: (request) => {
    const shiftId = shiftOf(request);
    const scenario = SCENARIO_OF.get(shiftId);
    if (scenario === undefined) return (ownBoardWrites?.confirm(request, shiftId) ?? noBoard()) as never;
    if (request.role !== "chatter") return notYours();
    const state = stateOf(request, scenario);
    if (state.phase !== "confirm") return { confirmed: false, refused: "not_ready", report: reportOf(request, scenario) };
    const body = request.body as { seenTotalMills?: number; seenCount?: number };
    if (state.hubFinds && !state.found) {
      state.found = true;
      return { confirmed: false, refused: "changed", report: reportOf(request, scenario) };
    }
    if ((body.seenTotalMills !== undefined && body.seenTotalMills !== totalOf(state)) || (body.seenCount !== undefined && body.seenCount !== countOf(state))) {
      return { confirmed: false, refused: "changed", report: reportOf(request, scenario) };
    }
    confirm(state, request.now.getTime());
    return { confirmed: true, refused: null, report: reportOf(request, scenario) };
  },
  shiftReportReopen: (request) => write(request, shiftOf(request), (state) => {
    if (state.phase !== "counted" && state.phase !== "confirm") return refused("Nothing to correct");
    // «Исправить» (the prototype's `fix`): Gengar's cards are settled as they stand, then the board as it is now is kept
    // for «Отмена», and the draft opens again with «Было» this total.
    for (const [id, proposal] of state.proposals) {
      if (proposal.state === "declined") {
        state.proposals.delete(id);
        state.ok.set(id, "Генгар предлагал иначе, решит владелец");
      } else proposal.state = "accepted";
    }
    if (state.gNote) {
      state.notes.set(state.gNote.id, { text: state.gNote.text, by: "agent" });
      state.gNote = null;
    }
    state.snapshot = clone(state);
    state.wasMills = totalOf(state);
    state.phase = "fixing";
    return null;
  }) ?? noBoard(),
  shiftReportReopenCancel: (request) => write(request, shiftOf(request), (state) => {
    if (state.phase !== "fixing" || state.snapshot === null) return refused("Not correcting");
    Object.assign(state, clone(state.snapshot), { snapshot: null });
    return null;
  }) ?? noBoard(),
  shiftReportResend: (request) => write(request, shiftOf(request), (state) => {
    if (state.phase !== "counted" || !state.late) return refused("Nothing came after the hand-in");
    state.lateAdded = true;
    state.ok.set(12, "досдано после сдачи");
    if (state.post.copiedAt !== null) state.post.changedSinceCopy = true;
    state.countedMills = totalOf(state);
    return null;
  }) ?? noBoard(),
  shiftReportAsk: (request) => write(request, shiftOf(request), (state) => {
    if (!editing(state)) return refused("Not a draft");
    const body = request.body as { transactionId: number; statement: "mine" | "share"; shareWithUserId?: number | null; note: string };
    const row = rowById(state, body.transactionId);
    if (row === null) return demoError(404, "Not Found", "No such sale");
    const to = askedOf(row.rule);
    if (to === null) return refused("Nobody to ask: the sale is nobody's");
    const share = whoOf(body.shareWithUserId);
    const want: Own = body.statement === "mine" ? "me" : share ? `half:${share}` : "me";
    // A colleague's sale is written to Lev at once, the colleague told (Hub since 2026-11-21); the pot's waits for the owner.
    state.asks.set(row.id, { to, want, note: body.note.trim(), state: to === "owner" ? "asked" : "taken" });
    return null;
  }) ?? noBoard(),
  shiftReportAskWithdraw: (request) => write(request, shiftOf(request), (state) => {
    state.asks.delete(Number(request.params.transactionId));
    return null;
  }) ?? noBoard(),
  shiftReportProposalAnswer: (request) => write(request, shiftOf(request), (state) => {
    const proposal = [...state.proposals.values()].find((one) => one.id === Number(request.params.proposalId));
    if (proposal === undefined || state.phase !== "confirm") return refused("No such card");
    const answer = (request.body as { answer: "decline" | "restore" | "accept" }).answer;
    const id = [...state.proposals].find(([, one]) => one === proposal)![0];
    const row = rowById(state, id)!;
    if (answer === "decline") {
      proposal.state = "declined";
      setOwn(state, row, proposal.from);
    } else {
      proposal.state = "proposed";
      setOwn(state, row, proposal.to);
    }
    return null;
  }) ?? noBoard(),
  shiftReportPostCopied: (request) => (SCENARIO_OF.has(shiftOf(request)) ? null : ownBoardWrites?.postCopied(request, shiftOf(request)) as never) ?? write(request, shiftOf(request), (state) => {
    if (!state.counted) return refused("Nothing counted to copy");
    const model = modelsOf(state).find((one) => one === queryString(request, "model")) ?? modelsOf(state)[0]!;
    state.postCopies = { ...state.postCopies, [model]: request.now.toISOString() };
    state.post = { ...state.post, copiedAt: request.now.toISOString(), seen: false, changedSinceCopy: false };
    state.copiedAtMs = request.now.getTime();
    return null;
  }) ?? noBoard(),
  shiftReportSightingAdd: (request) => write(request, shiftOf(request), (state) => {
    if (!state.lost || !editing(state)) return refused("Nothing to add");
    state.lostAdded = true;
    state.ok.set(4, "добавили вы, Hub сверит");
    return null;
  }) ?? noBoard(),
};

/**
 * The demo chatter's own board shift (the switch on before it began), as Hub reads its phase (shift-reports.ts): the
 * board is no preview then, it hands in, asks «Подтверждаю», counts and copies the post.
 */
export interface DemoOwnBoardPhase {
  phase: ShiftReportPhase;
  handedInAt: string | null;
  countedAt: string | null;
  candidate: ShiftReportBoard["candidate"];
  post: ShiftReportBoard["post"];
}

/**
 * «Мои смены» of the demo's ordinary shifts: the read-only preview board (`preview`) drawn from the shift's existing
 * demo report — a column per page, its sales as rows by the rule and the person's words, nothing to tick. With `own`
 * (a board shift of the demo chatter), the same rows in the shift's phase: «Сдать смену», «Подтверждаю», «Учтён».
 */
export function demoPreviewBoardOf(body: ShiftReportBody, shift: { startedAt: string; pages: string[] }, owner: { userId: number; name: string }, own?: DemoOwnBoardPhase): ShiftReportBoard {
  const platformOf = (label: string) => body.pages.find((page) => page.pageLabel === label)?.platform ?? body.lines.find((line) => line.pageLabel === label)?.platform ?? "onlyfans";
  const labels = [...new Set([...shift.pages, ...body.lines.map((line) => line.pageLabel)])];
  const ownerOfLine = (line: ShiftReportBody["lines"][number]): ShiftReportOwner => {
    if (line.statement === "share" && line.shareWithUserId !== null) {
      const name = line.shareWithName ?? "";
      return { kind: "share", userId: line.shareWithUserId, name, words: `пополам с ${personNameForms(name).ins}` };
    }
    if (line.amountMills > 0 || line.group === "mine") return { kind: "me", userId: owner.userId, name: owner.name, words: "моя" };
    if (line.rule.toUserId !== null && line.rule.toName !== null) return { kind: "user", userId: line.rule.toUserId, name: line.rule.toName, words: personNameForms(line.rule.toName).gen };
    if (line.rule.home === "pot") return { kind: "pot", userId: null, name: null, words: "общак" };
    return { kind: "nobody", userId: null, name: null, words: "ничья" };
  };
  const columns = labels.map((label) => {
    const platform = platformOf(label) === "fansly" ? "fansly" as const : "onlyfans" as const;
    const fansly = platform === "fansly";
    const rows: ShiftReportRow[] = body.lines.filter((line) => line.pageLabel === label)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .map((line) => {
        const kind = line.kind === "tip" || line.kind === "stream_tip" ? "tip" : line.kind === "subscription" ? "sub" : "media";
        const ownerNow = ownerOfLine(line);
        const ref = String(9_813_300_000_000_000 + line.transactionId);
        return {
          key: `t${line.transactionId}`, transactionId: line.transactionId, pageLabel: label, platform,
          platformRef: fansly ? ref : null, refLabel: fansly ? `#…${ref.slice(-4)}` : null,
          kind: line.kind, siteWords: (fansly ? FANSLY_WORDS : OF_WORDS)[kind],
          fan: line.fan, occurredAt: line.occurredAt, netMills: line.netMills,
          grossMills: fansly ? null : Number(millsPercentOf(line.netMills, 125)),
          rule: { owner: ownerNow, reason: line.rule.reason, words: line.rule.words },
          owner: ownerNow, statement: null,
          reasonWords: line.amountMills > 0 && line.group === "mine" ? "" : line.rule.words,
          ticked: line.amountMills > 0, amountMills: line.amountMills,
          before: null, late: false, ask: null, incoming: null, proposal: null,
          note: line.note ? { text: line.note, by: "person" as const, byName: owner.name } : null,
          sighting: null, editable: false, canNote: false, attention: false,
        };
      });
    return {
      pageLabel: label, platform, pageHandle: null, modelName: null, rows,
      before: { count: 0, until: shift.startedAt, people: [], rows: [] },
      marked: rows.filter((row) => row.ticked).length, of: rows.length,
      sumMills: rows.reduce((sum, row) => sum + row.amountMills, 0), attention: false,
    };
  });
  const rows = columns.flatMap((column) => column.rows);
  const phase = own?.phase ?? "draft";
  return {
    phase, chip: SHIFT_REPORT_PHASE_CHIPS[phase], offShift: [], columns, candidate: own?.candidate ?? null,
    totals: { count: rows.filter((row) => row.ticked).length, nowMills: rows.reduce((sum, row) => sum + row.amountMills, 0), wasMills: null },
    waiting: [], colleagues: [], decider: { kind: "owner", user: null, words: "владелец" },
    canConfirm: phase === "confirm", needsMe: phase === "confirm", handedInAt: own?.handedInAt ?? null, countedAt: own?.countedAt ?? null,
    preview: own === undefined, previous: null, post: own?.post ?? null,
  };
}

/** «Подтверждаю» and «Скопировать пост» on the demo chatter's own board shifts (shift-reports.ts answers them). */
interface OwnBoardWrites {
  confirm: (request: DemoRequest, shiftId: number) => unknown;
  postCopied: (request: DemoRequest, shiftId: number) => unknown;
}
let ownBoardWrites: OwnBoardWrites | null = null;
export function onDemoOwnBoard(writes: OwnBoardWrites): void {
  ownBoardWrites = writes;
}
