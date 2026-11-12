import type { KernelOperationResponse, ShiftReportBody, ShiftReportLine } from "@agency_hub_core/contracts";
import { millsPercentOf, millsRoundedTo, millsToNumber } from "@agency_hub_core/shared";

import { demoError, intBetween, rng, type DemoHandlers, type DemoReply, type DemoRequest } from "../core.ts";
import { DEMO_USERS, demoPage, demoUserByRole, type DemoUser } from "../world.ts";
import { DAY_MS, MINUTE_MS, chatterWorld, mskDay, type DemoSale, type DemoShift } from "./account-model.ts";
import { demoClaimedLines, demoLineId, demoLineOutcome, demoOffPlatformOf, demoOwnShare, demoReportClaims, demoShiftId, onDemoSettle } from "./sale-claims.ts";

/**
 * Отчёт смены (ecosystem package F) in the demo: the demo chatter's shifts as
 * Hub's shift rows with their reports, the draft of each from the same sales
 * «Мои смены» shows, and every write kept in memory (until the demo server
 * restarts) — so the whole walk works: mark «не моё», a note, «мимо
 * площадки», the comment, «Сдать смену», «Скопировать пост», «Исправить», the
 * second version. The switch «сдаёт смену в системе» is on for the demo
 * chatter since five days ago: older shifts keep their posts. The shift of two
 * days ago is a long one (60 sales on three pages), the one of three days ago had nothing; both wait to be handed in.
 *
 * Invented data only.
 */

type Report = KernelOperationResponse<"shiftReport">;
type List = KernelOperationResponse<"shiftReportsList">;

const SWITCH_DAYS = 5;

interface Word { statement: ShiftReportLine["statement"]; shareWithUserId: number | null; shareWithName: string | null; note: string | null }
interface Version { version: number; submittedAt: string; door: "workboard" | "telegram"; by: string; madeFor: string | null; body: ShiftReportBody }
interface Kept {
  words: Map<number, Word>;
  comment: string;
  offPlatform: Array<{ id: number; amountMills: number; fromWhom: string; whatFor: string; state: "pending" | "confirmed" | "rejected"; pageLabel: string | null }>;
  versions: Version[];
}

const kept = new Map<number, Kept>();
let nextOffPlatformId = 900;

/** A shift row's id: the Moscow day it is reported on and whose (sale-claims.ts), so it stays the same across requests. */
const shiftIdOf = (shift: DemoShift, user: DemoUser) => demoShiftId(shift, user);
const lineIdOf = (sale: DemoSale) => demoLineId(sale);
const userOf = (username: string | null) => DEMO_USERS.find((user) => user.username === username) ?? null;

function shiftsOf(user: DemoUser, now: Date) {
  return chatterWorld(user, now).shifts.filter((shift) => !shift.visit);
}

/** A long shift for the screen's worst case: the shift of two days ago carries 60 sales. */
function salesOf(shift: DemoShift, back: number, user: DemoUser): DemoSale[] {
  if (back !== 2 || shift.sales.length >= 60 || shift.sales.length === 0) return back === 3 ? [] : shift.sales;
  const random = rng(`long:${user.id}:${shift.start}`);
  const extra: DemoSale[] = [];
  for (let at = 0; shift.sales.length + extra.length < 60; at += 1) {
    const base = shift.sales[at % shift.sales.length]!;
    extra.push({ ...base, ref: `${base.ref}:x${at}`, pageLabel: at % 5 === 0 ? "mia-3" : base.pageLabel, at: shift.start + intBetween(random, 10, Math.max(20, Math.round((shift.end - shift.start) / MINUTE_MS) - 5)) * MINUTE_MS, kind: at % 4 === 0 ? "tip" : "ppv", overlap: false, ppvSender: null });
  }
  return [...shift.sales, ...extra].sort((a, b) => a.at - b.at);
}

function keptOf(id: number): Kept {
  let one = kept.get(id);
  if (!one) {
    one = { words: new Map(), comment: "", offPlatform: [], versions: [] };
    kept.set(id, one);
  }
  return one;
}

function line(sale: DemoSale, user: DemoUser, word: Word | undefined, now: Date): ShiftReportLine {
  const share = word === undefined ? demoOwnShare(now, lineIdOf(sale), user.id) : null;
  const plain = plainLine(sale, user, share === null ? word : { statement: "share", ...share });
  // A claim on it settled (package G): agreed by the other side, or the owner's decision.
  const outcome = demoLineOutcome(now, plain.transactionId, user.id);
  if (outcome === null) return plain;
  return {
    ...plain,
    group: outcome.mine ? "mine" : "near",
    rule: { ...plain.rule, reason: outcome.reason, words: outcome.words, toName: outcome.toName, shareMills: outcome.mine ? outcome.amountMills : 0 },
    statement: null, shareWithUserId: null, shareWithName: null,
    amountMills: outcome.amountMills,
    disputed: false,
  };
}

function plainLine(sale: DemoSale, user: DemoUser, word: Word | undefined): ShiftReportLine {
  const sender = sale.kind === "ppv" ? userOf(sale.ppvSender) : null;
  const near = (sender !== null && sender.id !== user.id) || sale.overlap;
  const other = sender !== null && sender.id !== user.id ? sender : sale.overlap ? DEMO_USERS.find((one) => one.id !== user.id && one.role === "chatter" && one.pages.includes(sale.pageLabel)) ?? null : null;
  const statement = word?.statement ?? null;
  let amountMills = near ? 0 : sale.netMills;
  let disputed = false;
  if (!near && statement === "not_mine") amountMills = 0;
  if (!near && statement === "share") amountMills = millsToNumber(millsPercentOf(sale.netMills, 50));
  if (near && statement === "mine") {
    amountMills = sale.netMills;
    disputed = true;
  }
  const words = near
    ? sender !== null && sender.id !== user.id ? `PPV отправил ${sender.name}` : `стык смен, фану никто из них не писал: решит владелец`
    : sale.kind === "ppv" ? "ваш PPV" : "страницу держала ваша смена";
  const writer = sale.writers[0] ? userOf(sale.writers[0].username) : null;
  return {
    transactionId: lineIdOf(sale),
    group: near ? "near" : "mine",
    pageLabel: sale.pageLabel,
    platform: sale.platform,
    kind: sale.kind === "ppv" ? "message_purchase" : sale.kind === "post" ? "post_purchase" : sale.kind,
    occurredAt: new Date(sale.at).toISOString(),
    netMills: sale.netMills,
    fan: { fanRef: sale.fan.platformUserId, name: sale.fanName ?? sale.fan.displayName, username: sale.fan.username },
    rule: { home: near ? (sale.overlap ? "decide" : "shift") : "shift", reason: near ? (sale.overlap ? "no_last_writer" : "ppv_sender") : sale.kind === "ppv" ? "ppv_sender" : "holder", words, toUserId: near && !sale.overlap ? other?.id ?? null : null, toName: near && !sale.overlap ? other?.name ?? null : null, shareMills: near ? 0 : sale.netMills },
    statement,
    shareWithUserId: word?.shareWithUserId ?? null,
    shareWithName: word?.shareWithName ?? null,
    note: word?.note ?? null,
    amountMills,
    added: false,
    disputed,
    alreadyIn: null,
    facts: {
      ppv: sale.kind === "ppv" ? { senderUserId: sender?.id ?? null, senderName: sender?.name ?? null, sentAt: new Date(sale.at - 40 * MINUTE_MS).toISOString(), withoutAuthor: sale.ppvWithoutAuthor } : null,
      lastWriter: writer === null ? null : { userId: writer.id, name: writer.name, at: new Date(sale.at - 25 * MINUTE_MS).toISOString(), within48h: true },
      writers: sale.writers.map((one) => ({ userId: userOf(one.username)?.id ?? 1, name: userOf(one.username)?.name ?? one.username, messages: one.messages })),
      holders: sale.overlap && other !== null ? [{ userId: other.id, name: other.name, slotRunning: true }] : [],
      ownSlotRunning: sale.overlap ? false : true,
      otherReports: [],
      pot: null,
      renewalOf: null,
    },
  };
}

/** Hub's rule of sums: a page is its lines rounded half up to the cent, the total is the pages. */
const toCent = (mills: number) => millsToNumber(millsRoundedTo(mills, "cent"));

type Claimable = KernelOperationResponse<"shiftReportClaimable">["sales"][number];

/**
 * What «Добавить → продажу» offers the demo chatter: two nobody's subscriptions of the weekend and a tip a colleague's
 * shift took the night before — the cases a chatter today adds by words.
 */
function claimableOf(user: DemoUser, now: Date): Claimable[] {
  const fans = salesOf(shiftsOf(user, now)[1] ?? shiftsOf(user, now)[0]!, 9, user).map((sale) => sale.fan);
  const fan = (at: number) => fans[at % Math.max(1, fans.length)] ?? null;
  const day = (back: number, hour: number) => new Date(Date.parse(`${mskDay(now.getTime() - back * DAY_MS)}T${String(hour).padStart(2, "0")}:12:00+03:00`)).toISOString();
  const row = (id: number, back: number, hour: number, page: string, kind: string, net: number, home: string, words: string, fanAt: number): Claimable => {
    const one = fan(fanAt);
    return { transactionId: 990_000 + id, pageLabel: page, platform: "fansly", kind, occurredAt: day(back, hour), netMills: net,
      fan: { fanRef: one?.platformUserId ?? null, name: one?.displayName ?? null, username: one?.username ?? null }, home, words };
  };
  return [
    row(1, 3, 14, "mia-1", "subscription", 12_800, "nobody", "ничья: страницу никто не держал", 0),
    row(2, 4, 11, "mia-1", "subscription", 12_800, "nobody", "ничья: страницу никто не держал", 1),
    row(3, 1, 23, "mia-2", "tip", 32_000, "shift", "последним фану писал Денис", 2),
    row(4, 1, 23, "mia-2", "subscription", 96_000, "shift", "последним фану писал Денис", 2),
  ];
}

function claimedLine(sale: Claimable, word: Word): ShiftReportLine {
  return {
    transactionId: sale.transactionId, group: "mine", pageLabel: sale.pageLabel, platform: sale.platform, kind: sale.kind, occurredAt: sale.occurredAt,
    netMills: sale.netMills, fan: sale.fan,
    rule: { home: sale.home, reason: sale.home === "nobody" ? "no_holder" : "last_writer", words: sale.home === "nobody" ? "по правилу ничья" : sale.words, toUserId: null, toName: null, shareMills: 0 },
    statement: "mine", shareWithUserId: null, shareWithName: null, note: word.note, amountMills: sale.netMills, added: true, disputed: sale.home !== "nobody", alreadyIn: null,
    facts: { ppv: null, lastWriter: null, writers: [], holders: null, ownSlotRunning: null, otherReports: [], pot: null, renewalOf: null },
  };
}

function bodyOf(shift: DemoShift, back: number, user: DemoUser, id: number, now: Date): ShiftReportBody {
  const one = keptOf(id);
  const lines = salesOf(shift, back, user).map((sale) => line(sale, user, one.words.get(lineIdOf(sale)), now));
  // The sales the person claimed of a colleague's (package G): lines added by hand.
  for (const claimed of demoClaimedLines(now, user.id, id)) if (!lines.some((row) => row.transactionId === claimed.transactionId)) lines.push(claimed);
  const known = new Set(lines.map((row) => row.transactionId));
  for (const sale of claimableOf(user, now)) {
    const word = one.words.get(sale.transactionId);
    if (word?.statement === "mine" && !known.has(sale.transactionId)) lines.push(claimedLine(sale, word));
  }
  lines.sort((a, b) => (a.group === b.group ? a.occurredAt.localeCompare(b.occurredAt) : a.group === "mine" ? -1 : 1));
  const labels = [...new Set([...shift.pages, ...lines.map((row) => row.pageLabel)])];
  const offPlatform = [...one.offPlatform, ...demoOffPlatformOf(now, id)];
  // Hub's rule of sums: a page is its lines and its confirmed «мимо площадки», rounded to the cent.
  const pages = labels.map((pageLabel) => ({
    pageLabel,
    platform: demoPage(pageLabel)?.platform ?? "fansly",
    amountMills: toCent(lines.filter((row) => row.pageLabel === pageLabel).reduce((sum, row) => sum + row.amountMills, 0)
      + offPlatform.filter((row) => row.state === "confirmed" && row.pageLabel === pageLabel).reduce((sum, row) => sum + row.amountMills, 0)),
  }));
  return {
    source: "draft", version: null, submittedAt: null, door: null, lines, offPlatform, comment: one.comment, pages,
    totalMills: pages.reduce((sum, page) => sum + page.amountMills, 0), cut: false, computedAt: now.toISOString(),
  };
}

function money(mills: number): string {
  return `$${(Math.trunc(mills / 10) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function postOf(body: ShiftReportBody, shift: DemoShift, user: DemoUser): Report["posts"] {
  const [year, month, day] = mskDay(shift.start).split("-");
  const lines = [`🗓 Дата: ${day}.${month}.${year}`, `👤 Чаттер: #${user.username.split(".")[0]}`, "", "📌 Аккаунты:", "Fansly"];
  for (const page of body.pages) lines.push(`• ${page.pageLabel} - ${money(page.amountMills)}`);
  lines.push("", `💰Общий доход: ${money(body.totalMills)}`, "", "📈 Основные продажи:");
  for (const row of body.lines.filter((one) => one.amountMills > 0).slice(0, 8)) {
    lines.push(`https://fansly.com/${row.fan.username ?? "fan"}/posts - ${row.kind === "message_purchase" ? "ppv" : row.kind === "tip" ? "tip" : "sub"} ${money(row.amountMills)}${row.note ? `. ${row.note}` : ""}`);
  }
  lines.push("", "📝 Комментарий:");
  if (body.comment) lines.push(body.comment);
  return [{ modelName: "Mia", text: lines.join("\n") }];
}

interface Found { shift: DemoShift; back: number; id: number; owner: DemoUser }

function find(request: DemoRequest, id: number): Found | null {
  for (const owner of DEMO_USERS.filter((user) => user.role === "chatter" && user.active)) {
    const shifts = shiftsOf(owner, request.now);
    const at = shifts.findIndex((shift) => shiftIdOf(shift, owner) === id);
    if (at >= 0) {
      const today = mskDay(request.now.getTime());
      const back = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${mskDay(shifts[at]!.start)}T00:00:00Z`)) / DAY_MS);
      return { shift: shifts[at]!, back, id, owner };
    }
  }
  return null;
}

/** The demo's history: shifts of the switch's days before yesterday were handed in once, by the person. */
function seed(found: Found, now: Date) {
  const one = keptOf(found.id);
  if (one.versions.length > 0 || found.back < 3 || found.back > SWITCH_DAYS || found.shift.ongoing) return;
  // The empty shift stays to be handed in: the screen's other extreme.
  if (salesOf(found.shift, found.back, found.owner).length === 0) return;
  const body = bodyOf(found.shift, found.back, found.owner, found.id, now);
  const at = new Date(found.shift.end + 7 * MINUTE_MS).toISOString();
  // A version keeps the claims' state of its moment: a settled claim is a later version of its own.
  const unsettled = { ...body, lines: body.lines.map((row) => ({ ...row, facts: null })) };
  one.versions.push({ version: 1, submittedAt: at, door: found.back === 4 ? "telegram" : "workboard", by: found.back === 4 ? "Генгар, со слов" : found.owner.name, madeFor: null, body: { ...unsettled, source: "version", version: 1, submittedAt: at, door: found.back === 4 ? "telegram" : "workboard" } });
}

function reportOf(request: DemoRequest, found: Found): Report | DemoReply {
  const viewer = demoUserByRole(request.role);
  const own = viewer.id === found.owner.id;
  if (!own && viewer.role === "chatter" && !viewer.pages.some((page) => found.shift.pages.includes(page))) return demoError(403, "Forbidden", "This shift is on pages you do not work");
  seed(found, request.now);
  const one = keptOf(found.id);
  const enabled = true;
  const latest = one.versions.at(-1) ?? null;
  const draft = bodyOf(found.shift, found.back, found.owner, found.id, request.now);
  const view = own || (latest === null && viewer.role !== "chatter") ? draft : latest?.body ?? null;
  const summary = (version: Version) => ({ version: version.version, submittedAt: version.submittedAt, door: version.door, by: version.by, totalMills: version.body.totalMills, madeFor: version.madeFor });
  let afterSubmission: Report["afterSubmission"] = null;
  if (own && latest) {
    const held = new Set(latest.body.lines.map((row) => row.transactionId));
    const fresh = draft.lines.filter((row) => row.group === "mine" && row.amountMills > 0 && !held.has(row.transactionId));
    if (fresh.length > 0) afterSubmission = { count: fresh.length, mills: fresh.reduce((sum, row) => sum + row.amountMills, 0) };
  }
  return {
    shift: {
      id: found.id, userId: found.owner.id, personName: found.owner.name, ongoing: found.shift.ongoing,
      startedAt: new Date(found.shift.start).toISOString(), endedAt: new Date(found.shift.end).toISOString(),
      workedMinutes: found.shift.workedMinutes, reportDate: mskDay(found.shift.start), pages: found.shift.pages,
    },
    access: own ? "own" : "read",
    enabled,
    canEdit: own && enabled,
    state: latest ? "submitted" : "open",
    latest: latest ? summary(latest) : null,
    versions: [...one.versions].reverse().map(summary),
    view,
    afterSubmission,
    posts: own && latest ? postOf(latest.body, found.shift, found.owner) : [],
    colleagues: own ? DEMO_USERS.filter((user) => user.active && user.id !== found.owner.id && user.role === "chatter" && user.pages.some((page) => found.shift.pages.includes(page))).map((user) => ({ userId: user.id, name: user.name })) : [],
    claims: demoReportClaims({ now: request.now, shiftId: found.id, ownerId: found.owner.id, lineIds: new Set((view?.lines ?? draft.lines).map((row) => row.transactionId)), own }),
    serverNow: request.now.toISOString(),
  };
}

/** A settled claim or «мимо площадки» decided (sale-claims.ts): the report's next version, made by the system. */
onDemoSettle((shiftId, change, now) => {
  const one = kept.get(shiftId);
  const latest = one?.versions.at(-1);
  if (one === undefined || latest === undefined) return;
  const lines = latest.body.lines.map((row) => (change.kind === "line" && row.transactionId === change.transactionId ? { ...row, amountMills: change.amountMills, disputed: false } : row));
  const offPlatform = change.kind === "off_platform" ? demoOffPlatformOf(now, shiftId) : latest.body.offPlatform;
  const pages = latest.body.pages.map((page) => ({
    ...page,
    amountMills: toCent(lines.filter((row) => row.pageLabel === page.pageLabel && (row.group === "mine" || row.amountMills !== 0)).reduce((sum, row) => sum + row.amountMills, 0)
      + offPlatform.filter((row) => row.state === "confirmed" && row.pageLabel === page.pageLabel).reduce((sum, row) => sum + row.amountMills, 0)),
  }));
  const version = one.versions.length + 1;
  const at = now.toISOString();
  one.versions.push({
    version, submittedAt: at, door: "workboard", by: "Hub", madeFor: change.madeFor,
    body: { ...latest.body, lines, offPlatform, pages, totalMills: pages.reduce((sum, page) => sum + page.amountMills, 0), version, submittedAt: at },
  });
});

function idOf(request: DemoRequest): number {
  return Number(request.params.shiftId);
}

function writable(request: DemoRequest): Found | DemoReply {
  const found = find(request, idOf(request));
  if (found === null) return demoError(404, "Not Found", "No such shift");
  if (demoUserByRole(request.role).id !== found.owner.id) return demoError(403, "Forbidden", "Only the person hands their shift in");
  seed(found, request.now);
  return found;
}

const isReply = (value: unknown): value is DemoReply => typeof value === "object" && value !== null && "demoReply" in value;

export const shiftReportHandlers: DemoHandlers = {
  shiftReportsList: (request): List | DemoReply => {
    const viewer = demoUserByRole(request.role);
    const userId = request.query.userId === undefined ? viewer.id : Number(request.query.userId);
    const owner = DEMO_USERS.find((user) => user.id === userId);
    if (!owner || owner.role !== "chatter") return { enabled: false, enabledSince: null, shifts: [], serverNow: request.now.toISOString() };
    const from = String(request.query.from ?? "");
    const to = String(request.query.to ?? "");
    const since = Date.parse(`${mskDay(request.now.getTime() - SWITCH_DAYS * DAY_MS)}T00:00:00+03:00`);
    const shifts = shiftsOf(owner, request.now).filter((shift) => {
      const day = mskDay(shift.start);
      return day >= from && day <= to;
    });
    return {
      enabled: true,
      enabledSince: new Date(since).toISOString(),
      shifts: shifts.map((shift) => {
        const id = shiftIdOf(shift, owner);
        const found = find(request, id);
        if (found) seed(found, request.now);
        const latest = keptOf(id).versions.at(-1) ?? null;
        return {
          shiftId: id, startedAt: new Date(shift.start).toISOString(), endedAt: new Date(shift.end).toISOString(), ongoing: shift.ongoing,
          reportDate: mskDay(shift.start), pages: shift.pages, state: latest ? "submitted" as const : "open" as const,
          version: latest?.version ?? null, submittedAt: latest?.submittedAt ?? null, totalMills: latest?.body.totalMills ?? null,
          draftTotalMills: latest === null && found !== null && owner.id === viewer.id && Date.parse(new Date(shift.start).toISOString()) >= since
            ? bodyOf(shift, found.back, owner, id, request.now).totalMills : null,
        };
      }),
      serverNow: request.now.toISOString(),
    };
  },
  shiftReportClaimable: (request) => {
    const found = writable(request);
    if (isReply(found)) return found;
    const words = keptOf(found.id).words;
    const sales = claimableOf(found.owner, request.now).filter((sale) => words.get(sale.transactionId)?.statement !== "mine");
    return { sales, serverNow: request.now.toISOString() };
  },
  shiftReport: (request) => {
    const found = find(request, idOf(request));
    return found === null ? demoError(404, "Not Found", "No such shift") : reportOf(request, found);
  },
  shiftReportLineSet: (request) => {
    const found = writable(request);
    if (isReply(found)) return found;
    const body = request.body as { statement: Word["statement"]; shareWithUserId?: number | null; note?: string | null };
    const share = body.shareWithUserId ?? null;
    keptOf(found.id).words.set(Number(request.params.transactionId), {
      statement: body.statement, shareWithUserId: share, shareWithName: DEMO_USERS.find((user) => user.id === share)?.name ?? null, note: body.note?.trim() || null,
    });
    return { savedAt: request.now.toISOString() };
  },
  shiftReportCommentSet: (request) => {
    const found = writable(request);
    if (isReply(found)) return found;
    keptOf(found.id).comment = String((request.body as { comment: string }).comment);
    return { savedAt: request.now.toISOString() };
  },
  shiftReportOffPlatformAdd: (request) => {
    const found = writable(request);
    if (isReply(found)) return found;
    const body = request.body as { amountMills: number; fromWhom: string; whatFor: string };
    const row = { id: nextOffPlatformId++, amountMills: body.amountMills, fromWhom: body.fromWhom, whatFor: body.whatFor, state: "pending" as const, pageLabel: null };
    keptOf(found.id).offPlatform.push(row);
    return { line: row, savedAt: request.now.toISOString() };
  },
  shiftReportOffPlatformWithdraw: (request) => {
    const found = writable(request);
    if (isReply(found)) return found;
    const one = keptOf(found.id);
    one.offPlatform = one.offPlatform.filter((row) => row.id !== Number(request.params.offPlatformId));
    return { savedAt: request.now.toISOString() };
  },
  shiftReportSubmit: (request) => {
    const found = writable(request);
    if (isReply(found)) return found;
    const one = keptOf(found.id);
    const body = bodyOf(found.shift, found.back, found.owner, found.id, request.now);
    const version = one.versions.length + 1;
    const at = request.now.toISOString();
    one.versions.push({ version, submittedAt: at, door: "workboard", by: found.owner.name, madeFor: null, body: { ...body, source: "version", version, submittedAt: at, door: "workboard", lines: body.lines.map((row) => ({ ...row, facts: null })) } });
    return reportOf(request, found);
  },
};

