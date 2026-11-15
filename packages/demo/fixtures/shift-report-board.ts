import {
  SHIFT_REPORT_PHASE_CHIPS, personNameForms,
  type KernelOperationResponse, type ShiftReportBoard, type ShiftReportOwner, type ShiftReportPhase, type ShiftReportRow,
} from "@agency_hub_core/contracts";

import { millsFromDollars, millsToNumber } from "@agency_hub_core/shared";

import { demoError, type DemoHandlers, type DemoReply, type DemoRequest } from "../core.ts";

/**
 * The «Отчёт» board (package R) in the demo: one board per scenario of the approved prototype
 * (`8-docs/2026-11-13-products/report-panel-mockups/columns.html`), with the prototype's own invented data — model
 * Mia, pages Mia-2, Mia-3, Mia-4, Mia Free, Mia VIP, Mia Promo; the chatter Lev, his shift of 12 Nov 18:00–02:00;
 * colleagues Oleg (the shift before) and Seva; the same sales, times, sums and reasons as its `baseRows()`.
 *
 * Each scenario has a stable shift id (`DEMO_BOARD_SHIFTS`): `/workboard/report/<id>`. A write on a scenario's board
 * answers the board of the scenario it leads to (Сдать смену → Проверка, Подтверждаю → Учтён, Исправить → Правка…);
 * nothing is kept. Invented data only.
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
} as const;
type Scenario = keyof typeof DEMO_BOARD_SHIFTS;
const SCENARIO_OF = new Map<number, Scenario>(Object.entries(DEMO_BOARD_SHIFTS).map(([key, id]) => [id, key as Scenario]));

const LEV = { userId: 7_101, name: "Лев" };
const OLEG = { userId: 7_102, name: "Олег" };
const SEVA = { userId: 7_103, name: "Сева" };
const WHO = { oleg: OLEG, seva: SEVA } as const;
const person = (one: { userId: number; name: string }) => ({ ...one, forms: personNameForms(one.name) });

const PAGES = [
  { id: "m2", label: "Mia-2", platform: "fansly", handle: "mia.two" },
  { id: "m3", label: "Mia-3", platform: "fansly", handle: "mia.three" },
  { id: "m4", label: "Mia-4", platform: "fansly", handle: "mia.four", extra: "more" },
  { id: "fr", label: "Mia Free", platform: "onlyfans", handle: null },
  { id: "vip", label: "Mia VIP", platform: "onlyfans", handle: null },
  { id: "pr", label: "Mia Promo", platform: "onlyfans", handle: null, extra: "empty" },
] as const;
type PageId = (typeof PAGES)[number]["id"];

type Own = "me" | "pot" | "oleg" | "seva" | "none" | "half:seva" | "";
interface Base {
  id: number; page: PageId; day: 12 | 13; t: string; kind: "media" | "sub" | "tip"; name: string; handle: string;
  net: number; gross: number; tx: string; rule: Own; why: string; late?: boolean; lost?: boolean; before?: boolean;
}
const mk = (id: number, page: PageId, day: 12 | 13, t: string, kind: Base["kind"], name: string, handle: string, net: number, gross: number, tx: string, rule: Own, why: string, extra: Partial<Base> = {}): Base =>
  ({ id, page, day, t, kind, name, handle, net, gross, tx, rule, why, ...extra });

/** The prototype's `baseRows()`, one to one. */
const BASE: Base[] = [
  mk(12, "m2", 13, "02:38", "media", "Harlan/Texas", "harlan_tx", 36, 0, "981341022871530944", "me", "ваш ппв из 01:55", { late: true }),
  mk(1, "m2", 13, "02:12", "media", "Harlan/Texas", "harlan_tx", 24, 0, "981340275518826113", "me", "ваш ппв из 01:40, куплен после смены"),
  mk(2, "m2", 12, "23:48", "tip", "mossrain", "mossrain", 8, 0, "981338810264419842", "pot", "тип под постом"),
  mk(3, "m2", 12, "22:30", "media", "Viggo", "viggo_nord", 48, 0, "981337562090745305", "me", "ваш ппв, отправлен в 22:17"),
  mk(4, "m2", 12, "21:30", "tip", "Wren", "wren_o", 12, 0, "981336977431290668", "me", "", { lost: true }),
  mk(13, "m2", 12, "21:12", "media", "Juno/Oslo", "juno_oslo", 30, 0, "981336851204477390", "half:seva", "ппв Севы из 17:20, дожали вы"),
  mk(5, "m2", 12, "20:41", "sub", "Rowan/Canada", "rowan_k", 8, 0, "981336420187553920", "me", "подписался после вашего сообщения"),
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
];
const MY_NOTES: Record<number, string> = { 7: "голосовое, просил ещё", 22: "тир Gold, обещан кастом 5 минут, сдать до пятницы" };
const G_EDITS = [
  { id: 3, from: "me" as Own, to: "half:seva" as Own, why: "О покупке договорился Сева 11 нояб.: фан написал «возьму завтра вечером». Вы отправили ппв и закрыли продажу." },
  { id: 20, from: "none" as Own, to: "me" as Own, why: "Владелец в чате смены в 23:52: «quill считай Льву, он его вернул»." },
];
const G_NOTES: Record<number, string> = { 8: "офис, часть 2" };

const FANSLY_WORDS = { media: "Media Sale to", sub: "Subscription Sale to", tip: "Tip from" } as const;
const OF_WORDS = { media: "Payment for message from", sub: "Subscription from", tip: "Tip from" } as const;
const KIND = { media: "message_purchase", sub: "subscription", tip: "tip" } as const;
const pageOf = (id: PageId) => PAGES.find((page) => page.id === id)!;

/** 12 Nov 2026, Moscow (UTC+3). */
const at = (day: number, time: string) => new Date(Date.UTC(2026, 10, day, Number(time.slice(0, 2)) - 3, Number(time.slice(3)))).toISOString();
const SHIFT_START = at(12, "18:00");
const SHIFT_END = at(13, "02:00");
const HANDED_IN = at(13, "02:04");
const COUNTED = at(13, "02:09");
const m = (usd: number) => millsToNumber(millsFromDollars(usd));

const half = (own: Own) => (own.startsWith("half:") ? own.slice(5) as "seva" : null);
const cut = (own: Own, net: number) => (own === "me" ? net : half(own) ? net / 2 : 0);
function ownerOf(own: Own): ShiftReportOwner {
  if (own === "me") return { kind: "me", userId: LEV.userId, name: LEV.name, words: "моя" };
  const h = half(own);
  if (h) return { kind: "share", userId: WHO[h].userId, name: WHO[h].name, words: `пополам с ${personNameForms(WHO[h].name).ins}` };
  if (own === "oleg" || own === "seva") return { kind: "user", userId: WHO[own].userId, name: WHO[own].name, words: personNameForms(WHO[own].name).gen };
  if (own === "pot") return { kind: "pot", userId: null, name: null, words: "общак" };
  return { kind: "nobody", userId: null, name: null, words: "ничья" };
}
const ruleWord = (own: Own) => (own === "me" ? "ваша" : ownerOf(own).words);
const plainUsd = (v: number) => `$${Number.isInteger(v) ? v : v.toFixed(2)}`;

interface State {
  phase: ShiftReportPhase;
  own: Map<number, Own>;
  ok: Map<number, string>;
  notes: Map<number, { text: string; by: "person" | "agent" }>;
  ask: { id: number; to: "oleg" | "owner"; note: string } | null;
  incoming: { id: number; from: "seva"; note: string } | null;
  proposals: Map<number, { id: number; from: Own; to: Own; why: string; state: "proposed" | "accepted" }>;
  gNote: { id: number; text: string; state: "proposed" | "accepted" } | null;
  lost: boolean;
  late: boolean;
  pages: PageId[];
  gengar: "reading" | "found" | "clean" | "silent" | null;
  wasMills: number | null;
  counted: boolean;
  comment: string;
}

function fresh(): State {
  return {
    phase: "draft", own: new Map(), ok: new Map(), notes: new Map(Object.entries(MY_NOTES).map(([id, text]) => [Number(id), { text, by: "person" as const }])),
    ask: null, incoming: null, proposals: new Map(), gNote: null, lost: false, late: false, pages: ["m2", "m3", "fr", "vip"],
    gengar: null, wasMills: null, counted: false, comment: "",
  };
}

function rowsOf(state: State) {
  return BASE.filter((row) => state.pages.includes(row.page) && (!row.lost || state.lost) && (!row.late || state.late));
}
const ownNow = (state: State, row: Base): Own => state.own.get(row.id) ?? (row.lost ? "me" : row.rule);
const lateOpen = (state: State, row: Base) => !!row.late && state.own.get(row.id) === undefined;
function shareOf(state: State, row: Base): number {
  if (row.before || (row.lost && state.own.get(row.id) === undefined) || lateOpen(state, row)) return 0;
  if (state.ask?.id === row.id || state.incoming?.id === row.id) return 0;
  return cut(ownNow(state, row), row.net);
}

function rowOf(state: State, row: Base): ShiftReportRow {
  const page = pageOf(row.page);
  const fansly = page.platform === "fansly";
  const own = ownNow(state, row);
  const share = shareOf(state, row);
  const editing = state.phase === "draft" || state.phase === "fixing";
  const lostOpen = !!row.lost && state.own.get(row.id) === undefined;
  const plain = !row.before && !lostOpen && !lateOpen(state, row);
  const proposal = state.proposals.get(row.id) ?? null;
  const note = state.notes.get(row.id) ?? (state.gNote?.id === row.id ? { text: state.gNote.text, by: "agent" as const } : null);
  let owner = ownerOf(own);
  let reasonWords = "";
  if (lostOpen) {
    owner = { kind: "me", userId: LEV.userId, name: LEV.name, words: "нет в Hub" };
    reasonWords = "Hub не поймал";
  } else if (lateOpen(state, row)) {
    owner = { kind: "me", userId: LEV.userId, name: LEV.name, words: "после сдачи" };
    reasonWords = row.why;
  } else if (state.ask?.id === row.id) {
    reasonWords = state.ask.to === "owner" ? "ждём владельца" : "ждём ответа Олега";
  } else if (state.incoming?.id === row.id) {
    reasonWords = "Сева оспаривает";
  } else if (proposal && (proposal.state === "proposed" || proposal.state === "accepted")) {
    reasonWords = "поменял Генгар";
  } else if (state.ok.has(row.id)) {
    reasonWords = state.ok.get(row.id)!;
  } else if (own !== row.rule && !row.lost) {
    reasonWords = `по правилу ${ruleWord(row.rule)}`;
  } else if (share <= 0) {
    reasonWords = row.why;
  }
  // The prototype's `ownerInfo`: on a half that counts, line 2 says the person's half; the reason moves to the title.
  if (half(own) && share > 0 && !lostOpen && !lateOpen(state, row)) reasonWords = `вам ${plainUsd(share)}`;
  const attention = lostOpen || lateOpen(state, row) || state.incoming?.id === row.id
    || (state.phase === "confirm" && (proposal?.state === "proposed" || (state.gNote?.id === row.id && note?.by === "agent")));
  return {
    key: lostOpen ? `s${row.id}` : `t${row.id}`,
    transactionId: lostOpen ? null : row.id,
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
    rule: { owner: row.before ? ownerOf("oleg") : ownerOf(row.lost ? "me" : row.rule), reason: row.before ? "holder" : "demo", words: row.why },
    owner: row.before ? ownerOf("oleg") : owner,
    statement: own === row.rule || row.before ? null : own === "none" ? "not_mine" : own === "me" ? "mine" : half(own) ? "share" : own === "pot" ? "pot" : "give",
    reasonWords: row.before ? "смена Олега" : reasonWords,
    ticked: share > 0,
    amountMills: m(share),
    before: row.before ? { user: person(OLEG) } : null,
    late: !!row.late,
    ask: state.ask?.id === row.id ? {
      claimId: 8_001,
      to: state.ask.to === "owner" ? "owner" : "colleague",
      toUser: state.ask.to === "owner" ? null : person(OLEG),
      want: ownerOf("me"),
      note: state.ask.note,
      state: "asked",
      answerNote: null,
      answerBy: state.ask.to === "owner" ? null : at(13, "19:40"),
      decision: null,
    } : null,
    incoming: state.incoming?.id === row.id ? {
      claimId: 8_002, from: person(SEVA), statement: "mine", note: state.incoming.note, state: "asked", canAnswer: true, answer: null, answerBy: at(14, "02:10"),
    } : null,
    proposal: proposal ? {
      id: proposal.id, kind: "owner_change", from: ownerOf(proposal.from), to: ownerOf(proposal.to),
      note: null, deltaMills: m(cut(proposal.to, row.net) - cut(proposal.from, row.net)), why: proposal.why, state: proposal.state, afterCounted: false, by: "Генгар",
    } : state.gNote?.id === row.id ? {
      id: 5_103, kind: "note", from: null, to: null, note: state.gNote.text, deltaMills: 0, why: "Из переписки: фан просил вторую часть офиса.", state: state.gNote.state, afterCounted: false, by: "Генгар",
    } : null,
    note: note ? { text: note.text, by: note.by, byName: note.by === "agent" ? "Генгар" : LEV.name } : null,
    sighting: row.lost ? { id: row.id, seenAt: at(12, "21:31"), added: !lostOpen } : null,
    editable: editing && plain,
    canNote: (editing || state.phase === "confirm") && plain,
    attention,
  };
}

function boardOf(state: State): ShiftReportBoard {
  const rows = rowsOf(state);
  const columns = state.pages.map((id) => {
    const page = pageOf(id);
    const all = rows.filter((row) => row.page === id).sort((a, b) => b.day * 1440 + Number(b.t.slice(0, 2)) * 60 + Number(b.t.slice(3)) - (a.day * 1440 + Number(a.t.slice(0, 2)) * 60 + Number(a.t.slice(3))));
    const shift = all.filter((row) => !row.before).map((row) => rowOf(state, row));
    const before = all.filter((row) => row.before).map((row) => rowOf(state, row));
    return {
      pageLabel: page.label, platform: page.platform, pageHandle: page.handle, modelName: "Mia",
      rows: shift,
      before: { count: before.length, until: SHIFT_START, people: before.length ? [person(OLEG)] : [], rows: before },
      marked: shift.filter((row) => row.ticked).length,
      of: shift.length,
      sumMills: shift.reduce((sum, row) => sum + row.amountMills, 0),
      attention: shift.some((row) => row.attention),
    };
  });
  const flat = columns.flatMap((column) => column.rows);
  const nowMills = flat.reduce((sum, row) => sum + row.amountMills, 0);
  const count = flat.filter((row) => row.ticked).length;
  const handed = state.phase !== "draft";
  const proposals = [...state.proposals.values()].length;
  const gengarState = state.gengar ?? (state.counted ? "found" : "idle");
  const waiting = flat.filter((row) => row.ask || row.incoming || (row.sighting && !row.sighting.added) || (row.late && !row.ticked)).map((row) => ({
    key: row.key, transactionId: row.transactionId, pageLabel: row.pageLabel, fanName: row.fan.name, netMills: row.netMills,
    why: row.ask ? "ask" as const : row.incoming ? "incoming" as const : row.sighting ? "sighting" as const : "late" as const,
  }));
  return {
    phase: state.phase,
    chip: SHIFT_REPORT_PHASE_CHIPS[state.phase],
    offShift: [{ pageLabel: "Mia-1", platform: "fansly" }],
    columns,
    candidate: handed ? {
      id: 6_001, number: 1, madeAt: HANDED_IN, by: LEV.name, door: "workboard", cutoffAt: HANDED_IN,
      count: 17, totalMills: m(477.4),
      hub: {
        state: "matched",
        pages: columns.map((column) => ({ pageLabel: column.pageLabel, state: "matched" as const, foundCount: 0, foundMills: 0, at: at(13, "02:05") })),
        foundCount: 0, foundMills: 0,
      },
      gengar: {
        state: gengarState, since: HANDED_IN,
        answeredAt: gengarState === "found" || gengarState === "clean" ? at(13, "02:07") : null,
        proposals, notes: state.gNote ? 1 : 0,
      },
      superseded: false,
    } : null,
    totals: { count, nowMills, wasMills: state.wasMills },
    waiting,
    colleagues: [person(OLEG), person(SEVA)],
    decider: { kind: "owner", user: null, words: "владелец" },
    canConfirm: state.phase === "confirm",
    needsMe: state.phase === "confirm" || waiting.some((one) => one.why === "incoming" || one.why === "late"),
    handedInAt: handed ? HANDED_IN : null,
    countedAt: state.counted ? COUNTED : null,
  };
}

/** The prototype's `postText()`: the counted report as today's post in «Отчётность». */
function postOf(state: State, board: ShiftReportBoard): string {
  const money = (mills: number) => `$${(mills / 1000).toFixed(2).replace(".", ",")}`;
  const word = (row: ShiftReportRow) => (row.kind === "message_purchase" ? "ппв" : row.kind === "tip" ? "тип" : row.netMills >= 20_000 ? "тир" : "саб");
  const fans = new Map<string, ShiftReportRow[]>();
  board.columns.flatMap((column) => column.rows).filter((row) => row.ticked).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    .forEach((row) => fans.set(row.pageLabel + row.fan.username, [...(fans.get(row.pageLabel + row.fan.username) ?? []), row]));
  const lines = [...fans.values()].map((rows) => `${rows[0]!.platform === "fansly" ? "https://fansly.com/" : "https://onlyfans.com/"}${rows[0]!.fan.username} - ${rows[0]!.fan.name}, `
    + rows.map((row) => `${word(row)} ${money(row.amountMills)}${row.owner.kind === "share" ? ` (${row.owner.words})` : ""}${row.note ? ` (${row.note.text})` : ""}`).join(", "));
  const acc = (platform: "fansly" | "onlyfans") => board.columns.filter((column) => column.platform === platform).map((column) => `• ${column.pageLabel} - ${money(column.sumMills)}`).join("\n");
  return `🗓 Дата: 12.11.2026\n👤 Чаттер: #lev\n\n📌 Аккаунты:\nFansly\n• Mia-1 - не в смене\n${acc("fansly")}\nOF\n${acc("onlyfans")}\n\n💰 Общий доход: ${money(board.totals.nowMills)}\n\n📈 Основные продажи:\n${lines.join("\n")}\n\n📝 Комментарий:\n${state.comment.trim() || "-"}\n\nОтчёт № 1`;
}

/** Hand in and check: the prototype's `confirmScn`. */
function confirmState(mode: "found" | "clean" | "silent"): State {
  const state = fresh();
  state.phase = "confirm";
  state.gengar = mode;
  if (mode === "found") {
    state.wasMills = m(477.4);
    G_EDITS.forEach((edit, at) => {
      state.proposals.set(edit.id, { id: 5_101 + at, from: edit.from, to: edit.to, why: edit.why, state: "proposed" });
      state.own.set(edit.id, edit.to);
    });
    state.gNote = { id: 8, text: G_NOTES[8]!, state: "proposed" };
  }
  return state;
}
function countedState(): State {
  const state = confirmState("found");
  state.phase = "counted";
  state.counted = true;
  state.wasMills = null;
  state.proposals.forEach((one) => { one.state = "accepted"; });
  if (state.gNote) state.gNote.state = "accepted";
  return state;
}

const SCENARIOS: Record<Scenario, () => State> = {
  draft: fresh,
  note: () => {
    const state = fresh();
    state.notes.set(3, { text: "торг, допродажа", by: "person" });
    state.comment = "Dario ждёт кастом к пятнице, Viggo торгуется";
    return state;
  },
  askColleague: () => ({ ...fresh(), ask: { id: 6, to: "oleg", note: "Felix ответил на мою рассылку в 19:36" } }),
  askOwner: () => ({ ...fresh(), ask: { id: 2, to: "owner", note: "тип под постом, но фан написал, что это мне за вечер" } }),
  notInHub: () => ({ ...fresh(), lost: true }),
  checking: () => ({ ...fresh(), phase: "checking", gengar: "reading" }),
  gengarFound: () => confirmState("found"),
  gengarClean: () => confirmState("clean"),
  gengarSilent: () => confirmState("silent"),
  dispute: () => ({ ...countedState(), incoming: { id: 23, from: "seva", note: "этот ппв Ash я отправлял 10-го, Лев только напомнил" } }),
  late: () => ({ ...countedState(), late: true }),
  counted: countedState,
  fixing: () => {
    const state = countedState();
    state.phase = "fixing";
    state.wasMills = m(461.4);
    state.own.set(7, "none");
    return state;
  },
  fivePages: () => ({ ...fresh(), pages: ["m2", "m3", "m4", "fr", "vip"] }),
  emptyPage: () => ({ ...fresh(), pages: ["m2", "m3", "fr", "vip", "pr"] }),
};

function reportOf(request: DemoRequest, scenario: Scenario): Report {
  const state = SCENARIOS[scenario]();
  const board = boardOf(state);
  const own = request.role === "chatter";
  const shiftId = DEMO_BOARD_SHIFTS[scenario];
  const version = state.counted ? {
    version: 1, submittedAt: COUNTED, door: "workboard" as const, by: LEV.name, totalMills: m(461.4), madeFor: null,
  } : null;
  const late = board.columns.flatMap((column) => column.rows).filter((row) => row.late && !row.ticked);
  return {
    shift: {
      id: shiftId, userId: LEV.userId, personName: LEV.name, ongoing: false, startedAt: SHIFT_START, endedAt: SHIFT_END,
      workedMinutes: 480, reportDate: "2026-11-12", pages: board.columns.map((column) => column.pageLabel),
    },
    access: own ? "own" : "read",
    enabled: true,
    canEdit: own,
    state: version ? "submitted" : "open",
    latest: version,
    versions: version ? [version] : [],
    view: null,
    afterSubmission: own && late.length ? { count: late.length, mills: late.reduce((sum, row) => sum + row.netMills, 0) } : null,
    posts: own && state.counted ? [{ modelName: "Mia", text: postOf(state, board) }] : [],
    colleagues: [OLEG, SEVA],
    claims: [],
    board: own ? board : { ...board, canConfirm: false, needsMe: false },
    serverNow: request.now.toISOString(),
  };
}

/** Where a write on a scenario's board leads. */
const NEXT: Partial<Record<"submit" | "confirm" | "reopen" | "cancel" | "resend", Partial<Record<Scenario, Scenario>>>> = {
  submit: { draft: "checking", note: "checking", askColleague: "checking", askOwner: "checking", notInHub: "checking", fixing: "gengarClean", fivePages: "checking", emptyPage: "checking" },
  confirm: { gengarFound: "counted", gengarClean: "counted", gengarSilent: "counted" },
  reopen: { counted: "fixing", late: "fixing", dispute: "fixing", gengarFound: "fixing", gengarClean: "fixing", gengarSilent: "fixing" },
  cancel: { fixing: "counted" },
  resend: { late: "counted" },
};

export function isDemoBoardShift(shiftId: number): boolean {
  return SCENARIO_OF.has(shiftId);
}

/** The scenario board of a shift id, or null — not a scenario shift. */
export function demoBoardReport(request: DemoRequest, shiftId: number, write?: keyof typeof NEXT): Report | null {
  const scenario = SCENARIO_OF.get(shiftId);
  if (scenario === undefined) return null;
  const next = write === undefined ? scenario : NEXT[write]?.[scenario] ?? scenario;
  return reportOf(request, next);
}

const noBoard = (): DemoReply => demoError(404, "Not Found", "No such shift");
const same = (request: DemoRequest): Report | DemoReply => demoBoardReport(request, Number(request.params.shiftId)) ?? noBoard();
const guard = (request: DemoRequest) => isDemoBoardShift(Number(request.params.shiftId));

export const shiftReportBoardHandlers: DemoHandlers = {
  shiftReportCurrent: (request) => ({ report: reportOf(request, "draft"), phase: "draft", serverNow: request.now.toISOString() }),
  shiftReportConfirm: (request) => {
    if (!guard(request)) return noBoard();
    const scenario = SCENARIO_OF.get(Number(request.params.shiftId))!;
    const confirmed = NEXT.confirm?.[scenario] !== undefined;
    return { confirmed, refused: confirmed ? null : "not_ready", report: demoBoardReport(request, DEMO_BOARD_SHIFTS[scenario], "confirm")! };
  },
  shiftReportReopen: (request) => demoBoardReport(request, Number(request.params.shiftId), "reopen") ?? same(request),
  shiftReportReopenCancel: (request) => demoBoardReport(request, Number(request.params.shiftId), "cancel") ?? same(request),
  shiftReportResend: (request) => demoBoardReport(request, Number(request.params.shiftId), "resend") ?? same(request),
  shiftReportAsk: (request) => same(request),
  shiftReportAskWithdraw: (request) => same(request),
  shiftReportProposalAnswer: (request) => same(request),
  shiftReportSightingAdd: (request) => same(request),
};

/** «Сдать смену» on a scenario's board. */
export function demoBoardSubmit(request: DemoRequest, shiftId: number): Report | null {
  return demoBoardReport(request, shiftId, "submit");
}

/** For the demo's own checks: a scenario's board as the person sees it. */
export function demoBoardOf(scenario: Scenario): ShiftReportBoard {
  return boardOf(SCENARIOS[scenario]());
}
