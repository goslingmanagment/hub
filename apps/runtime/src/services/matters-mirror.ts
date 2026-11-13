import {
  MATTER_MIRROR_KIND_ROLES,
  REPORT_POST_FIXABLE_FLAGS,
  type MatterMirrorKind,
  type ReportPostMatterKind,
  type SyncBlocksPage,
  type SyncPagesResponse,
  type TeamLedgerPayoutsResponse,
  type TeamLedgerQuestion,
  type TeamLedgerReportsResponse,
} from "@agency_hub_core/contracts";
import {
  closeMatter,
  listAgentHydrationRequests,
  listClientSendCustody,
  listMatterChecks,
  listMatterPageLabels,
  listNotificationIncidentsWithPages,
  listChatterLoginsOfPeople,
  listOpenMattersOfKinds,
  listSyncPages,
  listVisibleMatters,
  matterChanges,
  MatterWriterConflictError,
  openMatter,
  recordMatterCheckAnswered,
  recordMatterCheckFailed,
  touchMatters,
  type MatterActor,
  type MatterCheckRow,
  type MatterOpenInput,
  type MatterOwner,
  type MatterSource,
} from "@agency_hub_core/db";
import { formatDay, incidentKindWord } from "@agency_hub_core/look";
import { MOSCOW_TIME_ZONE, toBusinessDate } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { readSyncPageStatuses } from "../sync/inspect.ts";
import { toSyncPageStatusWire } from "../sync/requests/wire.ts";
import { getClientHealthView } from "./client-health-view.ts";
import { readLedgerPayouts } from "./ledger-payouts.ts";
import { readTeamLedgerQuestions } from "./ledger-questions.ts";
import { readTeamLedgerReports } from "./ledger-team-reports.ts";
import { matterMirrorPeriodMs, matterWeight } from "./matters.ts";
import { listPublicationsWire } from "./publications.ts";
import { getSyncBlocksOverview } from "./sync-blocks.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

/**
 * Дела, the shadow week (ecosystem plan, package D): every minute Hub reads
 * the sources «Ждут вас» and «Решения» read today (the ledger's every five
 * minutes, as the screens do), turns what waits into matters by the screens'
 * own rules, and closes the matters whose cause went away. After each kind it
 * counts the matters back through the read the API serves and compares that
 * with the old list's count of the same answer: a difference is logged and kept
 * in matter_checks (`mismatch_since`). A source that did not answer leaves its
 * matters as they were and its kind «не проверено». The screens keep their own
 * reads until the owner's switch (`mattersReadEnabled`).
 *
 * The rules below are ports of the screens' (each names its original); a unit
 * test runs both on the same answers. Database and Hub's own ledger only:
 * nothing here asks a platform or sends anything.
 */

export const MATTERS_MIRROR_QUEUE = "matters.mirror";

/** One thing that waits, as a mirror finds it. */
export interface MirrorItem {
  key: string;
  title: string;
  object: { type: string; id: string } | null;
  pageLabels: readonly string[];
  money: boolean;
  evidence: Record<string, unknown>;
  link: string | null;
  /** Whom this one waits for when not the kind's (a chatter's own post to fix). */
  owner?: MatterOwner;
}

/** Who writes a kind and whom it waits for: the owner, or (held sends) the team leads (MATTER_MIRROR_KIND_ROLES). */
function kindMeta(kind: MatterMirrorKind): { source: MatterSource; owner: MatterOwner } {
  return { source: kind.startsWith("ledger.") ? "ledger" : "server", owner: { role: MATTER_MIRROR_KIND_ROLES[kind] } };
}

const SYSTEM: MatterActor = { door: "system" };
/** What the screens read at most: «Ждут вас»'s publications list. */
const PUBLICATIONS_LIMIT = 1000;
const HELD_LIMIT = 1000;
const INCIDENTS_LIMIT = 200;
const HISTORY_LIMIT = 200;
const DAY_MS = 86_400_000;

// ── The screens' rules, on the same answers ────────────────────────────────

/** Publications of one status (Публикации; «Ждут вас» rows «Посты на утверждение» and «Исход неизвестен»). */
export function publicationItems(
  kind: "publication.draft" | "publication.unknown",
  publications: ReadonlyArray<{ id: number; pageLabel: string; kind: string; publishAt: string; version: number }>,
): MirrorItem[] {
  const status = kind === "publication.draft" ? "draft" : "unknown";
  return publications.map((publication) => ({
    key: `${kind}:${publication.id}`,
    title: kind === "publication.draft" ? `Пост на утверждение: ${publication.pageLabel}` : `Исход публикации неизвестен: ${publication.pageLabel}`,
    object: { type: "publication", id: String(publication.id) },
    pageLabels: [publication.pageLabel],
    money: false,
    evidence: { publicationId: publication.id, kind: publication.kind, publishAt: publication.publishAt, version: publication.version },
    link: `/content/publications?status=${status}&window=all&page=all`,
  }));
}

/** Held sends (Решения → «Зависшие отправки»): who sent and when, never the fan or the text. */
export function heldSendItems(sends: ReadonlyArray<{
  attemptId: string; pageLabel: string; username: string; purpose: string; partIndex: number; partCount: number; createdAt: string;
}>): MirrorItem[] {
  return sends.map((send) => ({
    key: `send.held:${send.attemptId}`,
    title: `Отправка без отчёта: ${send.pageLabel}`,
    object: { type: "client_send", id: send.attemptId },
    pageLabels: [send.pageLabel],
    money: false,
    evidence: { attemptId: send.attemptId, purpose: send.purpose, partIndex: send.partIndex, partCount: send.partCount, sentBy: send.username, sentAt: send.createdAt },
    link: `/workboard/decisions?send=${encodeURIComponent(send.attemptId)}#held`,
  }));
}

/** The engine modes in which a page's status is read (apps/dashboard engineDisplay.ts ENGINE_READING_MODES). */
const ENGINE_READING_MODES: ReadonlySet<string> = new Set(["handover", "live"]);
/** The holds that mean Fansly refuses the page's credentials (engineDisplay.ts CREDENTIALS_HOLDS). */
const CREDENTIALS_HOLDS: ReadonlySet<string> = new Set(["auth", "identity_mismatch"]);
const ENGINE_BLOCK_KEYS = ["connection", "financials", "audience", "messages_live", "messages_history"] as const;

/**
 * The Fansly pages that need a login: their browser was signed out or Fansly
 * refuses the session, or a block of the engine stops on refused credentials —
 * `fanslyPagesNeedingLogin` of apps/dashboard/src/api/waiting.ts with the
 * first two checks of `enginePageStatus`.
 */
export function loginPageLabels(blocks: readonly SyncBlocksPage[], engine: SyncPagesResponse["pages"]): string[] {
  return blocks
    .filter((page) => page.platform === "fansly")
    .filter((page) => {
      const status = engine.find((candidate) => candidate.pageLabel === page.pageLabel);
      if (status !== undefined && ENGINE_READING_MODES.has(status.mode) && status.browser?.login.needed) return true;
      return ENGINE_BLOCK_KEYS.map((key) => page.blocks[key])
        .filter((block) => block.state === "engine" && block.engine !== undefined)
        .some((block) => block.engine!.stops.some((stop) => stop.reason === "page_hold" && stop.by.some((kind) => CREDENTIALS_HOLDS.has(kind))));
    })
    .map((page) => page.pageLabel);
}

export function loginItems(labels: readonly string[]): MirrorItem[] {
  return labels.map((label) => ({
    key: `page.login_needed:${label}`,
    title: `Нужен вход в Fansly: ${label}`,
    object: { type: "page", id: label },
    pageLabels: [label],
    money: false,
    evidence: { pageLabel: label },
    link: `/settings/pages/${encodeURIComponent(label)}/login`,
  }));
}

/** A failure of the OnlyFans API while its key is off: nothing to repair (apps/dashboard/src/lib/failures.ts isOfapiOffFailure). */
export function isOfapiOffIncident(item: { kind: string; platform: string | null; incidentKey: string }): boolean {
  if (item.kind === "ofapi_platform_notice") return false;
  if (item.kind.startsWith("ofapi_")) return true;
  if (item.platform === "onlyfans" && item.kind !== "chatspace_tab") return true;
  return item.incidentKey.includes(":ofapi_");
}

/**
 * The open failures that wait for a person («Ждут вас» `failures`,
 * `countsAsFailure`): not the OnlyFans API's while its key is off, not a page's
 * blocked login the login row already shows.
 */
export function failureItems(
  incidents: ReadonlyArray<{ id: number; incidentKey: string; kind: string; pageLabel: string | null; platform: string | null; openedAt: Date | string }>,
  input: { loginPages: ReadonlySet<string>; ofapiOff: boolean },
): MirrorItem[] {
  return incidents
    .filter((incident) => !(input.ofapiOff && isOfapiOffIncident(incident)))
    .filter((incident) => !(incident.kind === "auth_blocked" && incident.pageLabel !== null && input.loginPages.has(incident.pageLabel)))
    .map((incident) => ({
      key: `incident.open:${incident.id}`,
      // The console's words for the kind («Система → Сбои»), its code only for a kind the dictionary does not know.
      title: `${incidentKindWord(incident.kind) ?? `Сбой: ${incident.kind}`}${incident.pageLabel === null ? "" : ` · ${incident.pageLabel}`}`,
      object: { type: "notification_incident", id: String(incident.id) },
      pageLabels: incident.pageLabel === null ? [] : [incident.pageLabel],
      money: false,
      evidence: {
        incidentId: incident.id, incidentKind: incident.kind, incidentKey: incident.incidentKey, platform: incident.platform,
        openedAt: new Date(incident.openedAt).toISOString(),
      },
      link: "/system/failures?page=all",
    }));
}

/** The extension's critical counters (`p1.*`) of the last 7 days with something counted («Критичные сбои расширения»). */
export function extensionItems(counters: ReadonlyArray<{ code: string; total: number }>, range: { from: string; to: string }): MirrorItem[] {
  return counters.filter((counter) => counter.code.startsWith("p1.") && counter.total > 0).map((counter) => ({
    key: `extension.critical:${counter.code}`,
    title: `Критичный сбой расширения: ${counter.code}`,
    object: null,
    pageLabels: [],
    money: false,
    evidence: { code: counter.code, total: counter.total, from: range.from, to: range.to },
    link: "/system/dev#extension",
  }));
}

/** History requests that wait for the owner's approval: not Fansly's, which take none (`hydrationRequestTakesApproval`). */
export function historyItems(requests: ReadonlyArray<{ requestRef: string; platform: string; pageLabel: string | null; createdAt: Date | string }>): MirrorItem[] {
  return requests.filter((request) => request.platform !== "fansly").map((request) => ({
    key: `history.request:${request.requestRef}`,
    title: request.pageLabel === null ? "Заявка на историю" : `Заявка на историю: ${request.pageLabel}`,
    object: { type: "hydration_request", id: request.requestRef },
    pageLabels: request.pageLabel === null ? [] : [request.pageLabel],
    money: false,
    evidence: { requestRef: request.requestRef, platform: request.platform, requestedAt: new Date(request.createdAt).toISOString() },
    link: "/system/history-requests?state=requested&page=all",
  }));
}

/** The questions «whose is this sale» that wait for the owner's word (`teamLedgerQuestions().owner`): never their text. */
export function saleQuestionItems(owner: readonly TeamLedgerQuestion[]): MirrorItem[] {
  return owner.map((question) => ({
    key: `ledger.sale_question:${question.id}`,
    title: question.pageLabel === "" ? `Вопрос «чья продажа» №${question.id}` : `Вопрос «чья продажа» №${question.id}: ${question.pageLabel}`,
    object: { type: "ledger_question", id: String(question.id) },
    pageLabels: question.pageLabel === "" ? [] : [question.pageLabel],
    money: question.netMills !== null,
    evidence: { questionId: question.id, askedAt: question.askedAt, occurredAt: question.occurredAt, netMills: question.netMills },
    link: "/workboard/decisions#questions",
  }));
}

const MSK_OFFSET_MS = 3 * 3_600_000;
function moscowDay(iso: string): string | null {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : new Date(at + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The posts the ledger could not use that wait for the owner: a blocking flag,
 * of the days it pays from the posts (`unparsedPostsToDecide` of
 * packages/ui/src/shiftReports.ts). The post's pages are its account lines.
 */
export function reportPostItems(reports: Pick<TeamLedgerReportsResponse, "posts">, payouts: Pick<TeamLedgerPayoutsResponse, "reportsFrom">): MirrorItem[] {
  const from = payouts.reportsFrom;
  if (!from) return [];
  return reports.posts
    .filter((post) => {
      if (!post.blocking) return false;
      const day = post.reportDate ?? moscowDay(post.postedAt);
      return day !== null && day >= from;
    })
    .map((post) => ({
      key: `ledger.report_post:${post.id}`,
      title: `Пост в «Отчётности» не разобран: ${post.reportDate ?? moscowDay(post.postedAt) ?? "без даты"}`,
      object: { type: "ledger_report_post", id: String(post.id) },
      pageLabels: [...new Set(post.pages.map((line) => line.pageLabel).filter((label): label is string => label !== null))],
      money: true,
      evidence: { postId: post.id, reportDate: post.reportDate, postedAt: post.postedAt, flags: post.flags, totalMills: post.totalMills, telegram: post.link },
      link: "/workboard/decisions#reports",
    }));
}

/** Why a post cannot be accrued, as its author reads it, by the first fixable flag (REPORT_POST_FIXABLE_FLAGS). */
const POST_FIX_WORDS: Readonly<Record<(typeof REPORT_POST_FIXABLE_FLAGS)[number], string>> = {
  sum_mismatch: "строки аккаунтов не дают итог. Поправьте пост в «Отчётности»",
  date_mismatch: "в посте стоит не та дата. Поправьте пост в «Отчётности»",
  no_date: "дата в посте не читается. Поправьте пост в «Отчётности»",
  duplicate: "за этот день два поста, оставьте один",
};

/**
 * The posts of the days the reports accrue from whose author can fix what keeps them out of the pay (a fixable flag):
 * one matter per post for the author's living chatter login (`loginOf`: the ledger's code is the registry's), never
 * money — no sum in the title or the evidence. A post of nobody's chatter login opens nothing. The link is where the
 * author sees the post's numbers against Hub's: that day's report, open in its row of «Мои смены», the week of the
 * day (`?report=`); the owner's line of it opens «Выплаты → Отчёты» (Workboard's list makes that address).
 */
export function reportPostFixItems(
  reports: Pick<TeamLedgerReportsResponse, "posts">,
  payouts: Pick<TeamLedgerPayoutsResponse, "reportsFrom">,
  loginOf: ReadonlyMap<string, number>,
): MirrorItem[] {
  const from = payouts.reportsFrom;
  if (!from) return [];
  const items: MirrorItem[] = [];
  for (const post of reports.posts) {
    const flags = REPORT_POST_FIXABLE_FLAGS.filter((flag) => post.flags.includes(flag));
    const day = post.reportDate ?? moscowDay(post.postedAt);
    if (flags.length === 0 || day === null || day < from) continue;
    const userId = post.person.slug === null ? undefined : loginOf.get(post.person.slug);
    if (userId === undefined) continue;
    items.push({
      key: `report.post_fix:${post.id}`,
      title: `Отчёт за ${formatDay(`${day}T12:00:00+03:00`)} не начислен: ${POST_FIX_WORDS[flags[0]!]}`,
      object: { type: "ledger_report_post", id: String(post.id) },
      pageLabels: [...new Set(post.pages.map((line) => line.pageLabel).filter((label): label is string => label !== null))],
      money: false,
      evidence: { postId: post.id, reportDate: post.reportDate, day, postedAt: post.postedAt, flags, telegram: post.link },
      link: `/workboard/my/shifts?week=${day}&report=${day}`,
      owner: { userId },
    });
  }
  return items;
}

/** Paid days whose report changed since (`pendingChangesOf`): a person's pay, on every page. */
export function paidDayChangeItems(payouts: Pick<TeamLedgerPayoutsResponse, "people">): MirrorItem[] {
  return payouts.people.flatMap((person) => person.pendingChanges.map((change) => ({
    key: `ledger.paid_day_changed:${change.id}`,
    title: `Выплаченный день изменён: ${person.hubUser?.username ?? person.slug}, ${change.day}`,
    object: { type: "ledger_pending_change", id: String(change.id) },
    pageLabels: [],
    money: true,
    evidence: { changeId: change.id, day: change.day, model: change.model, person: person.slug, postedMills: change.postedMills, newMills: change.newMills },
    link: `/workboard/payouts?person=${encodeURIComponent(person.slug)}`,
  })));
}

/** The 31 Moscow days the reports' questions are read for (`reportQuestionsWindow`, REPORT_QUESTIONS_DAYS). */
export function reportQuestionsWindow(today: string): { from: string; to: string } {
  return { from: new Date(Date.parse(`${today}T00:00:00Z`) - 30 * DAY_MS).toISOString().slice(0, 10), to: today };
}

// ── The pass ────────────────────────────────────────────────────────────────

export interface KindAnswer {
  kind: MatterMirrorKind;
  items: MirrorItem[];
  capped?: boolean;
  /** The kind is shown at all (the history requests only while the OnlyFans API is on). */
  applicable?: boolean;
}

export interface MattersMirrorTally {
  /** The mirrored kinds, and the authors' posts to fix that ride the reports' read. */
  answered: Array<MatterMirrorKind | ReportPostMatterKind>;
  failed: Array<MatterMirrorKind | ReportPostMatterKind>;
  /** The kinds whose matters, read back, differ from the old list's count. */
  mismatched: MatterMirrorKind[];
  opened: number;
  closed: number;
}

type MirrorApp = AppContext;

/** Every open matter of the kind as the owner reads it: the shadow's new count (`extension.critical` counts its events). */
async function readBackCount(app: MirrorApp, kind: MatterMirrorKind): Promise<number> {
  const matters = await listVisibleMatters(app.db, { viewer: { userId: 0, role: "owner", pageIds: [] }, state: "open", kinds: [kind], limit: 10_000 });
  return matters.reduce((sum, matter) => sum + matterWeight(matter), 0);
}

/** Makes the matters of `kind` what the answer says: opens or updates its items, closes the rest (cause gone). */
export async function reconcileMatterKind(
  app: Pick<AppContext, "db" | "logger">,
  answer: KindAnswer,
  idOf: ReadonlyMap<string, number>,
  now: Date,
): Promise<{ opened: number; closed: number }> {
  return reconcileMatters(app, { kind: answer.kind, ...kindMeta(answer.kind), items: answer.items }, idOf, now);
}

/** The same for any kind the server keeps (the mirrors' and the checks' of package K): its writer and owner are the caller's. */
export async function reconcileMatters(
  app: Pick<AppContext, "db" | "logger">,
  answer: { kind: string; source: MatterSource; owner: MatterOwner; items: readonly MirrorItem[] },
  idOf: ReadonlyMap<string, number>,
  now: Date,
): Promise<{ opened: number; closed: number }> {
  const meta = { source: answer.source, owner: answer.owner };
  const open = new Map((await listOpenMattersOfKinds(app.db, [answer.kind])).map((matter) => [matter.key, matter]));
  const seen = new Set<string>();
  const touched: string[] = [];
  let opened = 0;
  let closed = 0;
  for (const item of answer.items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    const input: MatterOpenInput = {
      key: item.key,
      kind: answer.kind,
      source: meta.source,
      title: item.title.slice(0, 300),
      object: item.object,
      pageIds: [...new Set(item.pageLabels.map((label) => idOf.get(label)).filter((id): id is number => id !== undefined))],
      owner: item.owner ?? meta.owner,
      money: item.money,
      evidence: item.evidence,
      link: item.link,
    };
    const existing = open.get(item.key);
    if (existing !== undefined && matterChanges(existing, input).length === 0) {
      touched.push(item.key);
      continue;
    }
    try {
      const result = await openMatter(app.db, input, SYSTEM, now);
      if (result.transition === "opened" || result.transition === "reopened") opened += 1;
    } catch (error) {
      // One item that cannot be kept does not stop the rest: the shadow count says it is missing.
      app.logger.error({ err: error, kind: answer.kind, key: item.key, writer: error instanceof MatterWriterConflictError ? error.heldBy : undefined }, "matters mirror: a matter could not be opened");
    }
  }
  for (const [key, matter] of open) {
    if (seen.has(key)) continue;
    try {
      const result = await closeMatter(app.db, { key, how: "cause_gone", writer: matter.source }, SYSTEM, now);
      if (result.transition === "closed") closed += 1;
    } catch (error) {
      app.logger.error({ err: error, kind: answer.kind, key }, "matters mirror: a matter could not be closed");
    }
  }
  await touchMatters(app.db, touched, now);
  return { opened, closed };
}

const errorText = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 300);

/**
 * One pass of the mirror: each due kind's source read, its matters made what
 * the answer says, the two counts compared. Never throws for a source: a kind
 * that did not answer is recorded as such.
 */
export async function runMattersMirror(
  app: MirrorApp,
  options: { now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<MattersMirrorTally> {
  const now = options.now ?? new Date();
  const checks = new Map<string, MatterCheckRow>((await listMatterChecks(app.db)).map((check) => [check.kind, check]));
  // A kind is due one period after its last try (a few seconds early, so a tick's jitter never skips a period).
  const due = (kind: MatterMirrorKind) => {
    const check = checks.get(kind);
    return check === undefined || now.getTime() - check.attemptedAt.getTime() >= matterMirrorPeriodMs(kind) - 5_000;
  };
  const { idOf } = await listMatterPageLabels(app.db);
  const tally: MattersMirrorTally = { answered: [], failed: [], mismatched: [], opened: 0, closed: 0 };
  const ledgerRead = options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl };
  const today = toBusinessDate(now, MOSCOW_TIME_ZONE);
  const ofapiOn = Boolean(app.config.ofapiApiKey);

  const failed = async (kinds: readonly MatterMirrorKind[], error: unknown) => {
    for (const kind of kinds) {
      const before = checks.get(kind);
      // Said once when a kind stops answering, and once when it answers again (below).
      if (before === undefined || before.error === null) {
        app.logger.warn({ kind, err: error }, "matters mirror: the source did not answer; the kind reads «не проверено»");
      }
      tally.failed.push(kind);
      await recordMatterCheckFailed(app.db, { kind, at: now, error: errorText(error) }).catch((recordError: unknown) => {
        app.logger.error({ kind, err: recordError }, "matters mirror: the failed check could not be recorded");
      });
    }
  };

  const apply = async (answer: KindAnswer) => {
    try {
      const done = await reconcileMatterKind(app, answer, idOf, now);
      tally.opened += done.opened;
      tally.closed += done.closed;
      const legacyCount = answer.kind === "extension.critical"
        ? answer.items.reduce((sum, item) => sum + (typeof item.evidence.total === "number" ? item.evidence.total : 0), 0)
        : new Set(answer.items.map((item) => item.key)).size;
      const matterCount = await readBackCount(app, answer.kind);
      const check = await recordMatterCheckAnswered(app.db, {
        kind: answer.kind, at: now, applicable: answer.applicable ?? true, capped: answer.capped ?? false, legacyCount, matterCount,
      });
      tally.answered.push(answer.kind);
      if (checks.get(answer.kind)?.error) app.logger.info({ kind: answer.kind }, "matters mirror: the source answers again");
      if (legacyCount !== matterCount) {
        tally.mismatched.push(answer.kind);
        app.logger.warn(
          { kind: answer.kind, legacyCount, matterCount, mismatchSince: check.mismatchSince?.toISOString() ?? null },
          "matters mirror: the matters' count differs from the old list's",
        );
      }
    } catch (error) {
      await failed([answer.kind], error);
    }
  };

  const read = async (kinds: readonly MatterMirrorKind[], source: () => Promise<KindAnswer[]>): Promise<boolean> => {
    if (!kinds.some(due)) return false;
    let answers: KindAnswer[];
    try {
      answers = await source();
    } catch (error) {
      await failed(kinds, error);
      return false;
    }
    for (const answer of answers) await apply(answer);
    return true;
  };

  await read(["publication.draft"], async () => {
    const items = publicationItems("publication.draft", await listPublicationsWire(app.db, { pageIds: null, status: "draft", limit: PUBLICATIONS_LIMIT }));
    return [{ kind: "publication.draft", items, capped: items.length === PUBLICATIONS_LIMIT }];
  });
  await read(["publication.unknown"], async () => [{
    kind: "publication.unknown",
    items: publicationItems("publication.unknown", await listPublicationsWire(app.db, { pageIds: null, status: "unknown", limit: PUBLICATIONS_LIMIT })),
  }]);
  await read(["send.held"], async () => {
    const list = await listClientSendCustody(app.db, { state: "held", pages: "all", limit: HELD_LIMIT, offset: 0 });
    return [{ kind: "send.held", items: heldSendItems(list.items.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() }))) }];
  });

  // The login pages first: a page's blocked login is its row, not a failure besides. Without them, no page is subtracted
  // (as the screen does when its reads fail).
  let loginPages = new Set<string>();
  const loginDue = due("page.login_needed") || due("incident.open");
  if (loginDue) {
    try {
      const [overview, statuses] = await Promise.all([
        getSyncBlocksOverview(app, { now }),
        readSyncPageStatuses(app.db, app.config, await listSyncPages(app.db)),
      ]);
      const labels = loginPageLabels(overview.pages, statuses.map(toSyncPageStatusWire));
      loginPages = new Set(labels);
      if (due("page.login_needed")) await apply({ kind: "page.login_needed", items: loginItems(labels) });
    } catch (error) {
      if (due("page.login_needed")) await failed(["page.login_needed"], error);
    }
  }
  await read(["incident.open"], async () => {
    const incidents = await listNotificationIncidentsWithPages(app.db, { status: "open", limit: INCIDENTS_LIMIT });
    return [{ kind: "incident.open", items: failureItems(incidents.items, { loginPages, ofapiOff: !ofapiOn }) }];
  });
  await read(["extension.critical"], async () => {
    const range = { from: new Date(Date.parse(`${today}T00:00:00Z`) - 6 * DAY_MS).toISOString().slice(0, 10), to: today };
    const view = await getClientHealthView(app, { ...range, clientName: "chat-extension" }, now);
    return [{ kind: "extension.critical", items: extensionItems(view.counters, range) }];
  });
  // Fansly's history requests go by themselves and OnlyFans' cannot be approved while its API is off: the row stays away.
  await read(["history.request"], async () => {
    if (!ofapiOn) return [{ kind: "history.request", items: [], applicable: false }];
    const { rows } = await listAgentHydrationRequests(app.db, { states: ["requested"], limit: HISTORY_LIMIT });
    return [{ kind: "history.request", items: historyItems(rows) }];
  });

  // The ledger's, through Hub's payouts key.
  await read(["ledger.sale_question"], async () => {
    const answer = await readTeamLedgerQuestions(app, { ...ledgerRead, now });
    return [{ kind: "ledger.sale_question", items: saleQuestionItems(answer.owner) }];
  });
  // The same read gives the authors their own posts to fix (`report.post_fix`): answered or not with it.
  let reportReads: { reports: TeamLedgerReportsResponse; payouts: TeamLedgerPayoutsResponse } | null = null;
  let reportError: unknown = undefined;
  await read(["ledger.report_post", "ledger.paid_day_changed"], async () => {
    const window = reportQuestionsWindow(today);
    try {
      const [reports, payouts] = await Promise.all([
        readTeamLedgerReports(app, window, { ...ledgerRead, now }),
        readLedgerPayouts(app, window, { ...ledgerRead, now }),
      ]);
      reportReads = { reports, payouts };
    } catch (error) {
      reportError = error;
      throw error;
    }
    return [
      { kind: "ledger.report_post", items: reportPostItems(reportReads.reports, reportReads.payouts) },
      { kind: "ledger.paid_day_changed", items: paidDayChangeItems(reportReads.payouts) },
    ];
  });
  if (reportReads !== null || reportError !== undefined) {
    const done = await mirrorReportPostFix(app, reportReads, reportError, { idOf, now, wasFailing: checks.get(POST_FIX_KIND)?.error != null });
    tally.opened += done.opened;
    tally.closed += done.closed;
    if (done.answered) tally.answered.push(POST_FIX_KIND);
    else tally.failed.push(POST_FIX_KIND);
  }

  return tally;
}

const POST_FIX_KIND: ReportPostMatterKind = "report.post_fix";

/**
 * `report.post_fix` from the reports' read of this pass: the authors' own posts to fix, kept as matters; a read
 * that did not answer (or a ledger that does not let Hub read the posts) leaves them as they are, «не проверено».
 */
async function mirrorReportPostFix(
  app: MirrorApp,
  reads: { reports: TeamLedgerReportsResponse; payouts: TeamLedgerPayoutsResponse } | null,
  error: unknown,
  input: { idOf: ReadonlyMap<string, number>; now: Date; wasFailing: boolean },
): Promise<{ answered: boolean; opened: number; closed: number }> {
  const fail = async (cause: unknown) => {
    if (!input.wasFailing) app.logger.warn({ kind: POST_FIX_KIND, err: cause }, "matters mirror: the source did not answer; the kind reads «не проверено»");
    await recordMatterCheckFailed(app.db, { kind: POST_FIX_KIND, at: input.now, error: errorText(cause) }).catch((recordError: unknown) => {
      app.logger.error({ kind: POST_FIX_KIND, err: recordError }, "matters mirror: the failed check could not be recorded");
    });
    return { answered: false, opened: 0, closed: 0 };
  };
  if (reads === null) return fail(error);
  if (!reads.reports.postsRead) return fail(new Error("the ledger does not let Hub read the posts"));
  try {
    const authors = [...new Set(reads.reports.posts.map((post) => post.person.slug).filter((slug): slug is string => slug !== null))];
    const loginOf = await listChatterLoginsOfPeople(app.db, authors);
    const items = reportPostFixItems(reads.reports, reads.payouts, loginOf);
    const done = await reconcileMatters(app, { kind: POST_FIX_KIND, source: "ledger", owner: { role: "owner" }, items }, input.idOf, input.now);
    const open = (await listOpenMattersOfKinds(app.db, [POST_FIX_KIND])).length;
    await recordMatterCheckAnswered(app.db, {
      kind: POST_FIX_KIND, at: input.now, applicable: true, capped: false, legacyCount: new Set(items.map((item) => item.key)).size, matterCount: open,
    });
    if (input.wasFailing) app.logger.info({ kind: POST_FIX_KIND }, "matters mirror: the source answers again");
    return { answered: true, ...done };
  } catch (cause) {
    return fail(cause);
  }
}

export async function ensureMattersMirrorQueue(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, MATTERS_MIRROR_QUEUE, { policy: "exclusive" }, createdQueues);
}

export async function ensureMattersMirrorSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }
  await boss.schedule(MATTERS_MIRROR_QUEUE, "* * * * *", null, { tz: "UTC" });
}
