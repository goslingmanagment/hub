import { formatUsdFromMills, millsPercentOf, millsRoundedTo, millsToNumber } from "@agency_hub_core/shared";

import { weekdayOfDay, type RuleSlot, type SaleHomeKind, type SaleHomeReason } from "./sale-rule.ts";

/**
 * Отчёт смены (ecosystem plan 2026-11-12, package F): which sales a shift's
 * draft holds and what each line counts, the page sums, the reasons in the
 * owner's words and the post in «Отчётность» — pure, no database
 * (tests/shift-handin-rules.test.ts). shift-handins.ts reads the facts and
 * writes the records.
 *
 * The draft of a shift is computed, never stored:
 *  - «Ваши продажи» (`mine`): every sale whose home by the rule gives the person
 *    a share on this shift (or on no work: the owner's claim); and «долёт» —
 *    a sale of the 7 days before the shift the rule gives to the person, that
 *    came after the switch was on, whose own shift's report was submitted
 *    without it (or that belongs to no shift: a look-in, a claim), and that the
 *    newest version of none of the person's reports holds (owner, 2026-11-02:
 *    such a sale goes into today's report);
 *  - «Рядом» (`near`): the other sales the shift held — someone else's, a pot's,
 *    nobody's, waiting, the owner's to decide.
 *  - «Рядом» covers the report's window: the actual shift together with the
 *    schedule slot it ran in (plan §4), on the pages the shift held and the
 *    slot's pages — a sale there nobody held is «ничья»;
 *  - a sale the person adds by hand («Добавить → продажу»: of the last 7 days, on
 *    a page they may open, in no report of theirs) stands under its page marked
 *    «добавлена».
 * A line's amount is the person's share by the rule unless the person says
 * otherwise: «не моё» 0, «делим с…» half the net, «моё» on a near or added sale
 * the whole net (on a nobody's sale plainly; on one the rule or another
 * person's report gives to someone else it counts here and is marked disputed
 * until the other side or the owner agrees). A sale another report of the
 * person already holds counts 0 here. Lines keep exact mills; a page's sum is
 * its lines rounded half up to the cent, the total is the sum of the pages — so
 * the numbers a person sees and the post's lines always add up (the ledger's
 * post reader compares them to the cent). Off-platform money is shown and never
 * summed until the owner confirms it. Money only through money.ts.
 */

export const HANDIN_LOOKBACK_DAYS = 7;

/** A share of a sale's home as the draft reads it. */
export interface DraftShare {
  userId: number;
  /** The work credited (`<userId>:<startedAt>`); null — a person on no work (the owner's claim). */
  workRef: string | null;
  /** That work's shift row; null — none known (a look-in, the claim, or a home computed live). */
  shiftId: number | null;
  mills: number;
}

/** A sale and its home, as the draft reads them. */
export interface DraftSale {
  transactionId: number;
  pageLabel: string;
  platform: string;
  /** Hub's canonical type: message_purchase, post_purchase, tip, stream_tip, subscription. */
  kind: string;
  occurredAt: number;
  netMills: number;
  home: { kind: SaleHomeKind; reason: SaleHomeReason; pot: string | null; shares: readonly DraftShare[] };
  /** The bought PPV's sender; null — none. */
  ppvSenderUserId: number | null;
  /** `window` — inside the report's window, its home computed now; `before` — of the days before it, its home as `sale_homes` keeps it. */
  source: "window" | "before";
  /** The shift's own work held it (window sales only). */
  heldByShift: boolean;
  /** On a page of the report's window (the shift's held pages and the slot's) within its hours (window sales only). */
  inReportWindow: boolean;
}

export interface DraftContext {
  shiftId: number;
  /** The shift's work as the rule names it now; null — not found among the works. */
  workRef: string | null;
  /** The person's logins. */
  userIds: ReadonlySet<number>;
  /** When the switch was turned on; null — off (no «долёт»). */
  switchOnAt: number | null;
  /** The person's shifts whose report is submitted. */
  submittedShiftIds: ReadonlySet<number>;
  /** The sales the newest versions of the person's reports hold, and which report. */
  reported: ReadonlyMap<number, { handinId: number; shiftId: number; reportDate: string }>;
  /** This shift's report; null — none yet. */
  handinId: number | null;
}

export type DraftGroup = "mine" | "near";

export interface ClassifiedSale {
  sale: DraftSale;
  group: DraftGroup;
  /** Outside the window, added to this report: «долёт» by the rule, or by the person's own hand (`claimed`). */
  added: boolean;
  /** Added by the person's own hand («Добавить → продажу»): counts only with their «моё». */
  claimed?: boolean;
  /** Another person's handed-in report holds it (a claim on it is disputed). */
  otherReport?: boolean;
  /** The person's share by the rule (mine), else 0. */
  shareMills: number;
  /** Whose the rule says it is when it is not the person's (the first share's person); null — nobody's or a pot's. */
  toUserId: number | null;
  /** Another report of the person holds it already: it counts 0 here. */
  alreadyIn: { shiftId: number; reportDate: string } | null;
}

/** Which group a sale is of this shift's draft; null — not of it. Pure. */
export function classifySale(sale: DraftSale, context: DraftContext): ClassifiedSale | null {
  const own = sale.home.shares.find((share) => context.userIds.has(share.userId)) ?? null;
  const other = sale.home.shares.find((share) => !context.userIds.has(share.userId)) ?? null;
  const reported = context.reported.get(sale.transactionId);
  const alreadyIn = reported !== undefined && reported.handinId !== context.handinId
    ? { shiftId: reported.shiftId, reportDate: reported.reportDate }
    : null;
  const mine = (added: boolean): ClassifiedSale => ({ sale, group: "mine", added, shareMills: own!.mills, toUserId: null, alreadyIn });
  const ownThisShift = own !== null
    && (own.shiftId === context.shiftId || (context.workRef !== null && own.workRef === context.workRef) || (sale.source === "window" && own.workRef === null));
  if (ownThisShift) return mine(false);
  if (own !== null) {
    // The person's on another work of theirs: «долёт» after the switch, when that work's own report will not hold it —
    // a look-in or a claim (no shift row), or a shift handed in without it — and no report of the person holds it.
    if (context.switchOnAt === null || sale.occurredAt < context.switchOnAt) return null;
    if (own.shiftId !== null && !context.submittedShiftIds.has(own.shiftId)) return null;
    if (reported !== undefined) return null;
    return mine(true);
  }
  if (sale.source === "window" && (sale.heldByShift || sale.inReportWindow)) {
    return { sale, group: "near", added: false, shareMills: 0, toUserId: other?.userId ?? null, alreadyIn };
  }
  return null;
}

/** A sale the person added by hand («Добавить → продажу») as a line of the draft. Pure. */
export function claimedSale(sale: DraftSale, context: Pick<DraftContext, "userIds" | "reported" | "handinId">, otherReport: boolean): ClassifiedSale {
  const other = sale.home.shares.find((share) => !context.userIds.has(share.userId)) ?? null;
  const reported = context.reported.get(sale.transactionId);
  const alreadyIn = reported !== undefined && reported.handinId !== context.handinId ? { shiftId: reported.shiftId, reportDate: reported.reportDate } : null;
  return { sale, group: "mine", added: true, claimed: true, otherReport, shareMills: 0, toUserId: other?.userId ?? null, alreadyIn };
}

/**
 * The report's window by the person's schedule: the slot occurrences that ran together with the shift, joined with
 * it — from the earlier start to the later end — and their pages (null: every page of the person). Null — no slot
 * ran with it. `slots` name the person by login (`personId`), as the rule reads them. Pure.
 */
export function slotWindowOf(
  slots: readonly RuleSlot[],
  input: { userIds: ReadonlySet<number>; startedAt: number; endedAt: number },
): { from: number; to: number; pageIds: Array<number | null> } | null {
  const own = slots.filter((slot) => input.userIds.has(slot.personId));
  if (own.length === 0) return null;
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  const pageIds = new Set<number | null>();
  const first = moscowDay(input.startedAt - DAY_MS);
  for (let day = first; Date.parse(`${day}T00:00:00+03:00`) <= input.endedAt; day = moscowDay(Date.parse(`${day}T12:00:00+03:00`) + DAY_MS)) {
    const midnight = Date.parse(`${day}T00:00:00+03:00`);
    const weekday = weekdayOfDay(day);
    for (const slot of own) {
      if ((slot.validFrom !== null && day < slot.validFrom) || (slot.validTo !== null && day > slot.validTo)) continue;
      if (slot.weekdays !== null && !slot.weekdays.includes(weekday)) continue;
      const minutes = (slot.endMinute - slot.startMinute + MINUTES_OF_DAY) % MINUTES_OF_DAY || (slot.endMinute === MINUTES_OF_DAY ? MINUTES_OF_DAY - slot.startMinute : 0);
      if (minutes <= 0) continue;
      const start = midnight + slot.startMinute * MINUTE_MS;
      const end = start + minutes * MINUTE_MS;
      if (end <= input.startedAt || start >= input.endedAt) continue;
      from = Math.min(from, start);
      to = Math.max(to, end);
      pageIds.add(slot.pageId);
    }
  }
  return Number.isFinite(from) ? { from, to, pageIds: [...pageIds] } : null;
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const MINUTES_OF_DAY = 1440;
const moscowDay = (at: number) => new Date(at + 3 * 3_600_000).toISOString().slice(0, 10);

export type Statement = "mine" | "not_mine" | "share";

/** The statements a person may make of a line of a group: of «Ваши продажи» «не моё» and «делим с…», of «Рядом» «моё». */
export function statementAllowed(group: DraftGroup, statement: Statement): boolean {
  return group === "mine" ? statement === "not_mine" || statement === "share" : statement === "mine";
}

/**
 * What a line counts and whether it is disputed. «Моё» on a near or an added sale counts the whole net: plainly when
 * the rule gives it to nobody and no other person's report holds it, else disputed. Pure.
 */
export function lineAmount(input: {
  group: DraftGroup;
  netMills: number;
  shareMills: number;
  homeKind: SaleHomeKind;
  statement: Statement | null;
  alreadyIn: boolean;
  /** Added by the person's own hand: counts only with «моё». */
  claimed?: boolean;
  /** Another person's handed-in report holds it. */
  otherReport?: boolean;
}): { amountMills: number; disputed: boolean } {
  if (input.alreadyIn) return { amountMills: 0, disputed: false };
  if (input.group === "mine" && input.claimed !== true) {
    if (input.statement === "not_mine") return { amountMills: 0, disputed: false };
    if (input.statement === "share") return { amountMills: millsToNumber(millsPercentOf(input.netMills, 50)), disputed: false };
    return { amountMills: input.shareMills, disputed: false };
  }
  if (input.statement !== "mine") return { amountMills: 0, disputed: false };
  return { amountMills: input.netMills, disputed: input.homeKind !== "nobody" || input.otherReport === true };
}

/**
 * The page sums of the lines, in the order of `pages` (the shift's pages first), and the total — the one place every
 * number of a report is made: a page's sum is the exact mills of its lines rounded half up to the whole cent, the
 * total is the sum of the page sums. The draft, the version, the post, the ledger's feed and «Мои смены» all read
 * this result, so what a person sees adds up and the post's page lines equal its «Общий доход» to the cent. Pure.
 */
export function pageSums(
  lines: ReadonlyArray<{ pageLabel: string | null; amountMills: number }>,
  pages: readonly string[],
): { pages: Array<{ pageLabel: string; amountMills: number }>; totalMills: number } {
  const order = [...pages];
  const sums = new Map<string, number>(pages.map((page) => [page, 0]));
  for (const line of lines) {
    if (line.pageLabel === null) continue;
    if (!sums.has(line.pageLabel)) {
      sums.set(line.pageLabel, 0);
      order.push(line.pageLabel);
    }
    sums.set(line.pageLabel, sums.get(line.pageLabel)! + line.amountMills);
  }
  const out = order.map((pageLabel) => ({ pageLabel, amountMills: millsToNumber(millsRoundedTo(sums.get(pageLabel)!, "cent")) }));
  return { pages: out, totalMills: out.reduce((total, page) => total + page.amountMills, 0) };
}

// ── Words ────────────────────────────────────────────────────────────────────

/**
 * Why a sale's home is what it is, in plain words, from the side of the person
 * reading their draft: «ваш PPV», «PPV отправил Максим», «идёт слот Вани»,
 * «общак: чаевые под постом». `nameOf` — a person's name by login.
 */
export function reasonWords(input: {
  group: DraftGroup;
  added: boolean;
  /** Added by the person's own hand. */
  claimed?: boolean;
  reason: SaleHomeReason;
  homeKind: SaleHomeKind;
  toName: string | null;
  senderName: string | null;
  alreadyIn: { reportDate: string } | null;
}): string {
  if (input.alreadyIn !== null) return `уже в отчёте смены ${dayWords(input.alreadyIn.reportDate)}`;
  if (input.claimed === true) {
    if (input.homeKind === "nobody") return "по правилу ничья";
    return input.toName !== null ? `по правилу ${input.toName}` : "по правилу не ваша";
  }
  if (input.group === "mine") {
    if (input.added) return "долёт: по правилу ваша, в отчёт своей смены не вошла";
    switch (input.reason) {
      case "ppv_sender": return "ваш PPV";
      case "ppv_sender_other_page": return "ваш PPV с другой страницы";
      case "ppv_sender_next_shift": return "ваш PPV, куплен до этой смены";
      case "ppv_sender_left": return "PPV ушедшего из команды: смене, в которую купили";
      case "holder": return "страницу держала ваша смена";
      case "last_writer": return "держали несколько смен, последними фану писали вы";
      case "slot_owner": return "стык смен: шёл ваш слот";
      case "look_in_last_writer": return "заход: последними фану писали вы";
      case "owner_claim": return "ничья, отдана вам владельцем";
      case "owner_split": return "раздел владельца";
      case "marks": return "по меткам чаттеров";
      default: return "ваша по правилу";
    }
  }
  const who = input.toName ?? "коллеге";
  switch (input.homeKind) {
    case "pot":
      return input.reason === "campaign" ? "общак: Campaign OnlyFans" : "общак: чаевые под постом";
    case "waiting":
      return `PPV отправил ${input.senderName ?? "коллега"}: ждёт его смены`;
    case "decide":
      return input.reason === "marks_disagree" ? "метки чаттеров не сходятся: решит владелец" : "стык смен, фану никто из них не писал: решит владелец";
    case "nobody":
      return input.reason === "ppv_sender_no_shift" ? "ничья: у отправителя PPV не было смены 7 дней" : "ничья: страницу никто не держал";
    case "before_rule":
      return "продажа до правила";
    case "unknown":
      return "факты неполны: правило не решило";
    default:
      break;
  }
  switch (input.reason) {
    case "ppv_sender":
    case "ppv_sender_other_page":
    case "ppv_sender_next_shift":
      return `PPV отправил ${who}`;
    case "ppv_sender_left": return `PPV ушедшего из команды: смене ${who}`;
    case "last_writer": return `последним фану писал ${who}`;
    case "slot_owner": return `идёт слот ${who}`;
    case "look_in_last_writer": return `заход ${who}: последним фану писал он`;
    case "owner_claim": return `ничья, отдана владельцем: ${who}`;
    case "owner_split": return `раздел владельца: ${who}`;
    case "marks": return `по меткам чаттеров: ${who}`;
    default: return `по правилу: ${who}`;
  }
}

const MSK = "Europe/Moscow";
const DAY_MONTH = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: MSK });
const CLOCK = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: MSK });

/** «11 нояб.» of a YYYY-MM-DD. */
export function dayWords(day: string): string {
  return DAY_MONTH.format(new Date(`${day}T12:00:00+03:00`));
}

/** «11 нояб., 18:14–02:36»: a shift by Moscow time. */
export function shiftWords(startedAt: Date, endedAt: Date): string {
  return `${DAY_MONTH.format(startedAt)}, ${CLOCK.format(startedAt)}–${CLOCK.format(endedAt)}`;
}

/** The matter of a shift not handed in: «Сдайте смену 11 нояб., 18:14–02:36». */
export function missingTitle(startedAt: Date, endedAt: Date): string {
  return `Сдайте смену ${shiftWords(startedAt, endedAt)}`;
}

// ── The post in «Отчётность» ────────────────────────────────────────────────

export interface PostPage {
  pageLabel: string;
  platform: string;
  modelSlug: string;
  modelName: string;
  amountMills: number;
}

export interface PostLine {
  pageLabel: string | null;
  platform: string;
  kind: string;
  amountMills: number;
  fan: { name: string | null; username: string | null; fanRef: string | null };
  note: string | null;
}

/** The words of a sale kind in the team's posts. */
function postKind(kind: string): string {
  switch (kind) {
    case "message_purchase":
    case "post_purchase":
      return "ppv";
    case "subscription":
      return "sub";
    case "tip":
    case "stream_tip":
      return "tip";
    default:
      return kind;
  }
}

function fanLink(platform: string, fan: PostLine["fan"]): string {
  const username = fan.username?.trim() ?? "";
  if (username !== "") return platform === "onlyfans" ? `https://onlyfans.com/${username}` : `https://fansly.com/${username}/posts`;
  return fan.name?.trim() || "фан";
}

const money = (mills: number) => formatUsdFromMills(mills);

/** «11.11.2026» of a YYYY-MM-DD. */
function postDate(day: string): string {
  const [year, month, date] = day.split("-");
  return `${date}.${month}.${year}`;
}

/**
 * The report as today's post in «Отчётность», one text per model (a shift on two models' pages is two posts, as
 * the team posts them): the date, the person's #tag, the accounts with their sums, the total, the sales by fan
 * with links and notes, the comment. Off-platform money goes to the comment of the first post, said to wait for
 * the owner, never into the sums. The ledger's post reader reads it as it reads the posts written by hand. Pure.
 */
export function postTexts(input: {
  reportDate: string;
  tag: string;
  pages: readonly PostPage[];
  lines: readonly PostLine[];
  comment: string;
  offPlatform: ReadonlyArray<{ amountMills: number; fromWhom: string; whatFor: string }>;
}): Array<{ modelSlug: string; modelName: string; text: string }> {
  const models: Array<{ slug: string; name: string }> = [];
  for (const page of input.pages) {
    if (!models.some((model) => model.slug === page.modelSlug)) models.push({ slug: page.modelSlug, name: page.modelName });
  }
  const modelOfPage = new Map(input.pages.map((page) => [page.pageLabel, page.modelSlug]));
  return models.map((model, index) => {
    const pages = input.pages.filter((page) => page.modelSlug === model.slug);
    const out: string[] = [`🗓 Дата: ${postDate(input.reportDate)}`, `👤 Чаттер: ${input.tag}`, "", "📌 Аккаунты:"];
    for (const platform of ["fansly", "onlyfans"]) {
      const ofPlatform = pages.filter((page) => page.platform === platform);
      if (ofPlatform.length === 0) continue;
      out.push(platform === "onlyfans" ? "OF" : "Fansly");
      for (const page of ofPlatform) out.push(`• ${page.pageLabel} - ${money(page.amountMills)}`);
    }
    for (const page of pages.filter((one) => one.platform !== "fansly" && one.platform !== "onlyfans")) {
      out.push(`• ${page.pageLabel} - ${money(page.amountMills)}`);
    }
    const total = pages.reduce((sum, page) => sum + page.amountMills, 0);
    out.push("", `💰Общий доход: ${money(total)}`, "", "📈 Основные продажи:");
    // By fan: the sales that count, the larger first; a fan with a note though nothing counts.
    type FanSum = { platform: string; fan: PostLine["fan"]; kinds: Map<string, { count: number; mills: number }>; mills: number; notes: string[] };
    const byFan = new Map<string, FanSum>();
    for (const line of input.lines) {
      if (line.pageLabel === null || modelOfPage.get(line.pageLabel) !== model.slug) continue;
      if (line.amountMills <= 0 && (line.note === null || line.note.trim() === "")) continue;
      const key = `${line.platform}:${line.fan.fanRef ?? line.fan.username ?? line.fan.name ?? "?"}`;
      const fan: FanSum = byFan.get(key) ?? { platform: line.platform, fan: line.fan, kinds: new Map(), mills: 0, notes: [] };
      if (line.amountMills > 0) {
        const kind = postKind(line.kind);
        const known = fan.kinds.get(kind) ?? { count: 0, mills: 0 };
        fan.kinds.set(kind, { count: known.count + 1, mills: known.mills + line.amountMills });
        fan.mills += line.amountMills;
      }
      const note = line.note?.trim() ?? "";
      if (note !== "" && !fan.notes.includes(note)) fan.notes.push(note);
      byFan.set(key, fan);
    }
    const fans = [...byFan.values()].sort((a, b) => b.mills - a.mills);
    for (const fan of fans) {
      const kinds = [...fan.kinds.entries()].map(([kind, sum]) => `${kind}${sum.count > 1 ? ` x${sum.count}` : ""} ${money(millsToNumber(millsRoundedTo(sum.mills, "cent")))}`).join(" · ");
      const notes = fan.notes.join(". ");
      out.push(`${fanLink(fan.platform, fan.fan)}${kinds !== "" ? ` - ${kinds}` : ""}${notes !== "" ? `. ${notes}` : ""}`);
    }
    out.push("", "📝 Комментарий:");
    if (input.comment.trim() !== "") out.push(input.comment.trim());
    if (index === 0) {
      for (const line of input.offPlatform) {
        out.push(`Мимо площадки, ждёт подтверждения владельца: ${money(line.amountMills)} от ${line.fromWhom}, ${line.whatFor}`);
      }
    }
    return { modelSlug: model.slug, modelName: model.name, text: out.join("\n") };
  });
}
