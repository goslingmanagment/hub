import { createHash } from "node:crypto";

import {
  isMatterCheckKind,
  isMatterInfoKind,
  isCustomOrderCheckKind,
  isMatterMirrorKind,
  isMatterPersonStartKind,
  isMatterServerKind,
  LEDGER_CHECK_KINDS,
  MATTER_CHECK_KIND_PERIODS,
  MATTER_CHECK_KINDS,
  MATTER_INFO_KINDS,
  PEOPLE_CHECK_KINDS,
  isShiftReportMatterKind,
  type AgentMatterCloseBody,
  type AgentMatterCommentBody,
  type AgentMatterCommentResponse,
  type AgentMatterOpenBody,
  type AgentMatterResponse,
  type ClientMattersResponse,
  type Matter,
  type MatterMirrorKind,
  type MattersListQuery,
  type MattersListResponse,
  type MattersWaitingQuery,
  type MattersWaitingResponse,
  type MattersWaitingRow,
  type WaitingRowId,
} from "@agency_hub_core/contracts";
import {
  closeMatter,
  commentMatter,
  countVisibleOpenMatters,
  findMatterByKey,
  findMatterPerson,
  listMatterChecks,
  listMatterPageLabels,
  listMatterUsernames,
  listVisibleMatters,
  MatterWriterConflictError,
  openMatter,
  teamLeadRoleHeld,
  type MatterCheckRow,
  type MatterOwner,
  type MatterOwnerRole,
  type MatterRow,
  type MatterViewer,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import type { AgentAuthPrincipal, HumanAuthPrincipal } from "./auth.ts";
import { awaitingGivingOf, customOrdersReadOn, customsLeadOwner } from "./custom-orders/readers.ts";
import { loadEffectiveConfigField } from "./effective-config.ts";
import { AppError, ConflictError, NotFoundError } from "./errors.ts";

/**
 * Дела (ecosystem plan §2, §6, package D): the reads of matters by every door
 * and the agent's writes. Who reads what is the repository's one rule
 * (`matterVisibility`): the owner every matter; a team lead their own and
 * their role's on their pages; a chatter their own; a matter with money the
 * owner's alone. A kind Hub mirrors whose source did not answer lately is «не
 * проверено» (`count: null`), never a zero. Database only.
 *
 * Reading is not waiting: «Ждут вас», its number on the menu and on the
 * Home, and the extension's icon count only what waits for the viewer THEMSELF
 * — their user's matters and those of a role they hold (`heldRolesOf`). The
 * owner reads every other matter too, as oversight («Ждут других»), counted
 * nowhere.
 */

// ── When a mirrored kind is known ───────────────────────────────────────────

const MINUTE = 60_000;
/** The ledger's reads are heavier and change with the posts' collection: every five minutes, as the screens read them. */
const LEDGER_KINDS: ReadonlySet<MatterMirrorKind> = new Set(["ledger.sale_question", "ledger.report_post", "ledger.paid_day_changed"]);

/** How often the mirror asks a kind's source. */
export function matterMirrorPeriodMs(kind: MatterMirrorKind): number {
  return LEDGER_KINDS.has(kind) ? 5 * MINUTE : MINUTE;
}

/** How often Hub's server asks the source of a kind it keeps (the mirrors' and the checks' of package K); null — another writer's kind. */
export function matterKindPeriodMs(kind: string): number | null {
  if (isMatterMirrorKind(kind)) return matterMirrorPeriodMs(kind);
  if (isMatterCheckKind(kind)) return MATTER_CHECK_KIND_PERIODS[kind] * MINUTE;
  return null;
}

/**
 * Whether a kind the server keeps is known now: its source answered on the
 * last try, within three of its periods and a minute. Otherwise it is «не
 * проверено». Another writer's kind with a check row is known while its last
 * try answered.
 */
export function matterKindChecked(check: MatterCheckRow | undefined, kind: string, now: Date): boolean {
  if (check === undefined || check.answeredAt === null) return false;
  if (check.attemptedAt.getTime() > check.answeredAt.getTime()) return false;
  const period = matterKindPeriodMs(kind);
  return period === null || now.getTime() - check.answeredAt.getTime() <= 3 * period + MINUTE;
}

// ── «Ждут вас» and «Решения», from matters ──────────────────────────────────

interface WaitingRowSpec {
  id: WaitingRowId;
  kinds: readonly MatterMirrorKind[];
  /** A team lead's row too (the rest are the owner's). */
  teamLead: boolean;
  label: string;
  to: string;
}

/** «Ждут вас»'s rows: the same words, order and links as apps/dashboard/src/api/waiting.ts. */
const WAITING_ROW_SPECS: readonly WaitingRowSpec[] = [
  { id: "drafts", kinds: ["publication.draft"], teamLead: false, label: "Посты на утверждение", to: "/publications?status=draft&window=all&page=all" },
  { id: "unknown", kinds: ["publication.unknown"], teamLead: false, label: "Публикации: исход неизвестен", to: "/publications?status=unknown&window=all&page=all" },
  { id: "questions", kinds: ["ledger.sale_question"], teamLead: false, label: "Чья продажа: вопросы ждут вашего слова", to: "/workboard/decisions#questions" },
  { id: "reports", kinds: ["ledger.report_post", "ledger.paid_day_changed"], teamLead: false, label: "Отчёты смен ждут решения", to: "/workboard/decisions#reports" },
  { id: "customs", kinds: ["custom.paid_not_delivered"], teamLead: true, label: "Кастомы оплачены, не отданы", to: "/workboard/decisions#customs" },
  { id: "held", kinds: ["send.held"], teamLead: true, label: "Проверить отправки", to: "/workboard/decisions#held" },
  { id: "login", kinds: ["page.login_needed"], teamLead: false, label: "Нужен вход в Fansly", to: "/system/collection?page=all" },
  { id: "failures", kinds: ["incident.open"], teamLead: false, label: "Сбои", to: "/system/failures?page=all" },
  { id: "extension", kinds: ["extension.critical"], teamLead: false, label: "Критичные сбои расширения", to: "/system/dev/extension" },
  { id: "history", kinds: ["history.request"], teamLead: false, label: "Заявки на историю", to: "/system/history-requests?state=requested&page=all" },
];

/** The kinds a role reads in «Ждут вас»: the owner every one, a team lead customs and held sends, a chatter none. */
export function waitingKindsOf(role: MatterOwnerRole): MatterMirrorKind[] {
  if (role === "chatter") return [];
  return WAITING_ROW_SPECS.filter((spec) => role === "owner" || spec.teamLead).flatMap((spec) => [...spec.kinds]);
}

/**
 * The rows after the old ones (package K): matters no old row counts. The
 * people's and the ledger's checks are the owner's; every other kind (another
 * package's, an agent's) is whoever's it is. A kind that only informs is in
 * none: it waits for nobody.
 */
const FAMILY_ROW_SPECS: ReadonlyArray<{ id: Extract<WaitingRowId, "people" | "ledger" | "other">; label: string; to: string; checks: readonly string[] }> = [
  { id: "people", label: "Люди и доступ", to: "/workboard/decisions#people", checks: PEOPLE_CHECK_KINDS.filter((kind) => !isMatterInfoKind(kind)) },
  { id: "ledger", label: "Проверки ledger", to: "/workboard/decisions#ledger", checks: LEDGER_CHECK_KINDS },
  { id: "other", label: "Другие дела", to: "/workboard/decisions", checks: [] },
];

/** The family row a kind no old row counts belongs to; null — an old row's kind, or one that only informs. */
export function waitingFamilyOf(kind: string): "people" | "ledger" | "other" | null {
  if (isMatterMirrorKind(kind) || isMatterInfoKind(kind)) return null;
  // A newcomer's way (package J): the people's family, as the checks' of people and access.
  if ((kind.startsWith("people.") && isMatterCheckKind(kind)) || isMatterPersonStartKind(kind)) return "people";
  if ((LEDGER_CHECK_KINDS as readonly string[]).includes(kind)) return "ledger";
  return "other";
}

/** What the builders need of each mirrored kind. */
export interface MatterKindState {
  checked: boolean;
  /** Shown at all (the OnlyFans history requests only while the OnlyFans API is on). */
  applicable: boolean;
  capped: boolean;
}

type WaitingMatter = Pick<MatterRow, "id" | "kind" | "pageIds" | "evidence">;

/** The events a counter matter stands for (`extension.critical`: its 7 days' total), else 1. */
export function matterWeight(matter: Pick<MatterRow, "kind" | "evidence">): number {
  if (matter.kind !== "extension.critical") return 1;
  const total = matter.evidence.total;
  return typeof total === "number" && Number.isSafeInteger(total) && total > 0 ? total : 0;
}

/**
 * «Ждут вас» from the viewer's open matters: the rows in the screen's order,
 * none with a zero, a row whose source is not known with `count: null`.
 */
export function buildWaitingRows(input: {
  role: MatterOwnerRole;
  /** The viewer's OWN open matters (`heldRolesOf`): what waits for them, never for someone else. */
  matters: readonly WaitingMatter[];
  kindState: (kind: string) => MatterKindState;
  labelOf: (pageId: number) => string | undefined;
  /** The owner holds the team lead's role (nobody else does): its rows are his; default — he does. */
  teamLeadRows?: boolean;
  /**
   * The custom orders are the home of customs (`customOrdersReadEnabled`): the customs row is the number of the
   * viewer's orders paid or shot and not given (null — the read failed), leading to the board; undefined — the old
   * kind's matters, as before.
   */
  customOrders?: number | null;
}): Pick<MattersWaitingResponse, "rows" | "total" | "failed"> {
  const rows: MattersWaitingRow[] = [];
  const teamLeadRows = input.teamLeadRows ?? true;
  for (const spec of WAITING_ROW_SPECS) {
    if (input.role === "chatter" || (input.role === "team_lead" && !spec.teamLead)) continue;
    // The team lead's rows (customs, held sends) are the owner's only while he is the acting team lead.
    if (input.role === "owner" && spec.teamLead && !teamLeadRows) continue;
    if (spec.id === "customs" && input.customOrders !== undefined) {
      if (input.customOrders !== 0) {
        rows.push({ id: "customs", label: spec.label, count: input.customOrders, capped: false, pageLabel: null, to: "/workboard/customs", matterIds: [] });
      }
      continue;
    }
    const states = spec.kinds.map(input.kindState);
    if (!states.every((state) => state.applicable)) continue;
    const kinds = new Set<string>(spec.kinds);
    const mine = input.matters.filter((matter) => kinds.has(matter.kind));
    const checked = states.every((state) => state.checked);
    const count = checked ? mine.reduce((sum, matter) => sum + matterWeight(matter), 0) : null;
    if (count === 0) continue;
    let { label, to } = spec;
    let pageLabel: string | null = null;
    if (spec.id === "login") {
      const pages = mine.flatMap((matter) => matter.pageIds).map(input.labelOf).filter((one): one is string => one !== undefined);
      if (pages.length === 1) {
        pageLabel = pages[0]!;
        label = `Нужен вход в Fansly: ${pageLabel}`;
        to = `/pages/${encodeURIComponent(pageLabel)}/browser-login`;
      }
    }
    rows.push({
      id: spec.id,
      label,
      count,
      capped: checked && states.some((state) => state.capped),
      pageLabel,
      to,
      matterIds: mine.map((matter) => matter.id),
    });
  }
  // The checks' rows: the owner's checks count for the owner only; a team lead sees «другие» of their own.
  for (const spec of FAMILY_ROW_SPECS) {
    if (input.role === "chatter" || (input.role === "team_lead" && spec.id !== "other")) continue;
    const mine = input.matters.filter((matter) => waitingFamilyOf(matter.kind) === spec.id);
    const checked = spec.checks.every((kind) => input.kindState(kind).checked) && mine.every((matter) => input.kindState(matter.kind).checked);
    const count = checked ? mine.length : null;
    if (count === 0) continue;
    rows.push({ id: spec.id, label: spec.label, count, capped: false, pageLabel: null, to: spec.to, matterIds: mine.map((matter) => matter.id) });
  }
  return {
    rows,
    total: rows.reduce((sum, row) => sum + (row.count ?? 0), 0),
    failed: rows.filter((row) => row.count === null).map((row) => row.id),
  };
}

/**
 * «Решения»'s four queues from the viewer's open matters, on one page or all
 * (a matter of no page is every page's): the rule of
 * apps/workboard/src/shared/decisions.ts. The questions and the reports are the
 * owner's: a team lead's are null and not a failure.
 */
export function buildDecisions(input: {
  role: MatterOwnerRole;
  /** The viewer's OWN open matters, as for the rows. */
  matters: readonly WaitingMatter[];
  kindState: (kind: string) => MatterKindState;
  pageId: number | null;
  /** The custom orders are customs' home: their count of the page (or of all), as the customs row; undefined — the old kind. */
  customOrders?: { onPage: number; all: number } | null;
}): MattersWaitingResponse["decisions"] {
  const owner = input.role === "owner";
  const onPage = (matter: WaitingMatter) => input.pageId === null || matter.pageIds.length === 0 || matter.pageIds.includes(input.pageId);
  const of = (kind: MatterMirrorKind) => input.matters.filter((matter) => matter.kind === kind);
  const known = (kinds: readonly MatterMirrorKind[]) => kinds.every((kind) => input.kindState(kind).checked);
  const queue = (kinds: readonly MatterMirrorKind[], mine: boolean) => {
    if (!mine || !known(kinds)) return { count: null, all: 0 };
    const matters = kinds.flatMap(of);
    return { count: matters.filter(onPage).length, all: matters.length };
  };
  const staff = input.role === "owner" || input.role === "team_lead";
  const questions = queue(["ledger.sale_question"], owner);
  const posts = queue(["ledger.report_post"], owner);
  const changes = queue(["ledger.paid_day_changed"], owner);
  const customs = input.customOrders === undefined ? queue(["custom.paid_not_delivered"], staff)
    : !staff || input.customOrders === null ? { count: null, all: 0 } : { count: input.customOrders.onPage, all: input.customOrders.all };
  const held = queue(["send.held"], staff);
  const reportParts = posts.count === null || changes.count === null ? null : { posts: posts.count, changes: changes.count };
  const reports = reportParts === null ? null : reportParts.posts + reportParts.changes;
  const failed: MattersWaitingResponse["decisions"]["failed"] = [];
  if (owner && questions.count === null) failed.push("questions");
  if (owner && reports === null) failed.push("reports");
  if (staff && customs.count === null) failed.push("customs");
  if (staff && held.count === null) failed.push("held");
  const elsewhere = input.pageId === null ? 0
    : (questions.all - (questions.count ?? questions.all)) + (posts.all - (posts.count ?? posts.all))
      + (customs.all - (customs.count ?? customs.all)) + (held.all - (held.count ?? held.all));
  return {
    questions: questions.count,
    reports,
    reportParts,
    customs: customs.count,
    held: held.count,
    total: (questions.count ?? 0) + (reports ?? 0) + (customs.count ?? 0) + (held.count ?? 0),
    elsewhere,
    failed,
  };
}

// ── The doors ───────────────────────────────────────────────────────────────

type MattersApp = Pick<AppContext, "db" | "config">;

/**
 * Who reads: the session's person by their role — except a narrow web session
 * (opened from the extension), which reads as a chatter whatever the role: the
 * person's own matters, never one with money.
 */
export function matterViewerOf(principal: HumanAuthPrincipal): MatterViewer {
  const role = principal.narrowDeviceTokenId === undefined ? principal.user.role as MatterOwnerRole : "chatter";
  return { userId: principal.user.id, role, pageIds: principal.assignedPageIds };
}

/**
 * The roles whose matters wait for the viewer themself (besides their user's): the owner's own, and the team
 * lead's while nobody holds that role (he is the acting team lead: the registry and the logins say so, not a
 * constant); a team lead's; a chatter none.
 */
export async function heldRolesOf(app: Pick<AppContext, "db">, viewer: MatterViewer): Promise<MatterOwnerRole[]> {
  if (viewer.role === "owner") return (await teamLeadRoleHeld(app.db)) ? ["owner"] : ["owner", "team_lead"];
  if (viewer.role === "team_lead") return ["team_lead"];
  return [];
}

/** Whether a matter waits for the viewer themself. */
export function matterIsMine(matter: Pick<MatterRow, "owner">, viewer: MatterViewer, heldRoles: readonly MatterOwnerRole[]): boolean {
  return "userId" in matter.owner ? matter.owner.userId === viewer.userId : heldRoles.includes(matter.owner.role);
}

/**
 * The customs row while the custom orders are customs' home: the orders paid or shot and not given, of the viewer's
 * pages (the owner every page), all and on `pageId`; null — the read failed; undefined — the old kind counts. It is
 * the lead's line: the viewer's only while customs are led by the team lead's role they hold (`customsLeadOwner`).
 * When a person leads customs it is nobody's (zero): that person reads their own matters, the owner sees them under
 * «Ждут других» and has the board.
 */
async function customOrdersCount(app: MattersApp, viewer: MatterViewer, pageId: number | null): Promise<{ onPage: number; all: number } | null | undefined> {
  if (viewer.role === "chatter" || !(await customOrdersReadOn(app))) return undefined;
  if ("userId" in (await customsLeadOwner(app))) return { onPage: 0, all: 0 };
  try {
    const orders = await awaitingGivingOf(app, { pageIds: viewer.role === "owner" ? "all" : viewer.pageIds, limit: 5000 });
    const onPage = pageId === null ? orders.length : orders.filter((order) => order.pageId === null || order.pageId === pageId).length;
    return { onPage, all: orders.length };
  } catch {
    return null;
  }
}

function kindStates(checks: readonly MatterCheckRow[], now: Date): (kind: string) => MatterKindState {
  const byKind = new Map(checks.map((check) => [check.kind, check]));
  return (kind) => {
    const check = byKind.get(kind);
    // A kind nobody checks (an agent's) is known as it is: its matters are what its writer said.
    if (check === undefined && matterKindPeriodMs(kind) === null) return { checked: true, applicable: true, capped: false };
    return { checked: matterKindChecked(check, kind, now), applicable: check?.applicable ?? true, capped: check?.capped ?? false };
  };
}

async function pageIdOf(app: MattersApp, pageLabel: string | undefined, idOf: Map<string, number>): Promise<number | null> {
  if (pageLabel === undefined) return null;
  const id = idOf.get(pageLabel);
  if (id === undefined) throw new NotFoundError(`Page "${pageLabel}" was not found`);
  return id;
}

/** `mattersWaiting`: «Ждут вас» and «Решения» from matters, for a dashboard session. */
export async function readMattersWaiting(app: MattersApp, principal: HumanAuthPrincipal, query: MattersWaitingQuery, now: Date = new Date()): Promise<MattersWaitingResponse> {
  const viewer = matterViewerOf(principal);
  const heldRoles = await heldRolesOf(app, viewer);
  const [matters, checks, pages, active] = await Promise.all([
    // What waits for the viewer themself: the old rows' kinds and, after them, the rest (package K).
    viewer.role === "chatter" ? Promise.resolve([]) : listVisibleMatters(app.db, { viewer, state: "open", heldRoles, limit: 5000 }),
    listMatterChecks(app.db),
    listMatterPageLabels(app.db),
    loadEffectiveConfigField(app.db, app.config, "mattersReadEnabled"),
  ]);
  const kindState = kindStates(checks, now);
  const pageId = await pageIdOf(app, query.pageLabel, pages.idOf);
  const teamLeadRows = heldRoles.includes("team_lead");
  const orders = teamLeadRows ? await customOrdersCount(app, viewer, pageId) : undefined;
  return {
    active: active === true,
    ...buildWaitingRows({
      role: viewer.role, matters, kindState, labelOf: (id) => pages.labelOf.get(id), teamLeadRows,
      ...(orders === undefined ? {} : { customOrders: orders === null ? null : orders.all }),
    }),
    decisions: buildDecisions({ role: viewer.role, matters, kindState, pageId, ...(orders === undefined ? {} : { customOrders: orders }) }),
    serverNow: now.toISOString(),
  };
}

function matterWire(row: MatterRow, labelOf: Map<number, string>, usernameOf: Map<number, { username: string; displayName: string | null }>, mine: boolean): Matter {
  return {
    id: row.id,
    key: row.key,
    kind: row.kind,
    source: row.source,
    state: row.state,
    closedHow: row.closedHow,
    title: row.title,
    object: row.object,
    pageLabels: row.pageIds.map((id) => labelOf.get(id)).filter((label): label is string => label !== undefined),
    owner: "userId" in row.owner
      ? { kind: "user", userId: row.owner.userId, username: usernameOf.get(row.owner.userId)?.username ?? "", displayName: usernameOf.get(row.owner.userId)?.displayName ?? null }
      : { kind: "role", role: row.owner.role },
    watcherUserIds: row.watcherUserIds,
    mine,
    money: row.money,
    evidence: row.evidence,
    link: row.link,
    openedAt: row.openedAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}

/** `mattersList`: the session's matters, the owner's by kind, with whether each mirrored kind is known. */
export async function readMattersList(app: MattersApp, principal: HumanAuthPrincipal, query: MattersListQuery, now: Date = new Date()): Promise<MattersListResponse> {
  const viewer = matterViewerOf(principal);
  const heldRoles = await heldRolesOf(app, viewer);
  const pages = await listMatterPageLabels(app.db);
  const pageId = await pageIdOf(app, query.pageLabel, pages.idOf);
  const [rows, counts, checks] = await Promise.all([
    listVisibleMatters(app.db, {
      viewer, state: query.state, kinds: query.kind === undefined ? undefined : [query.kind], pageId: pageId ?? undefined, limit: query.limit,
    }),
    countVisibleOpenMatters(app.db, { viewer }),
    listMatterChecks(app.db),
  ]);
  const usernameOf = await listMatterUsernames(app.db, rows.flatMap((row) => ("userId" in row.owner ? [row.owner.userId] : [])));
  // The person's name where the login is a person's (the name «Люди» and «Кастомы» show): one read for all.
  const checkOf = new Map(checks.map((check) => [check.kind, check]));
  // The kinds the server keeps for this viewer: the mirrored ones of their rows, and the owner's checks (package K).
  const mirrored = new Set<string>([...waitingKindsOf(viewer.role), ...(viewer.role === "owner" ? MATTER_CHECK_KINDS : [])]);
  const kinds = [...new Set([...mirrored, ...counts.keys()])].sort().map((kind) => {
    const isMirrored = mirrored.has(kind);
    const check = checkOf.get(kind);
    return {
      kind,
      open: counts.get(kind) ?? 0,
      checked: isMirrored ? (matterKindChecked(check, kind, now) ? "yes" as const : "no" as const) : "not_mirrored" as const,
      checkedAt: isMirrored ? check?.answeredAt?.toISOString() ?? null : null,
    };
  });
  return {
    matters: rows.map((row) => matterWire(row, pages.labelOf, usernameOf, matterIsMine(row, viewer, heldRoles))),
    kinds,
    serverNow: now.toISOString(),
  };
}

const CLIENT_MATTERS_LIMIT = 50;

/** The extension's number: what waits for the person themself, never one with money, never one that only informs. */
export async function countClientMatters(app: Pick<AppContext, "db">, principal: HumanAuthPrincipal): Promise<number> {
  const viewer = matterViewerOf(principal);
  const counts = await countVisibleOpenMatters(app.db, { viewer, withoutMoney: true, heldRoles: await heldRolesOf(app, viewer) });
  return [...counts].reduce((sum, [kind, value]) => sum + (isMatterInfoKind(kind) ? 0 : value), 0);
}

/** `clientMatters`: the extension's count and the longest waiting of the person's matters; never evidence, never money. */
export async function readClientMatters(app: MattersApp, principal: HumanAuthPrincipal, now: Date = new Date()): Promise<ClientMattersResponse> {
  const viewer = matterViewerOf(principal);
  const heldRoles = await heldRolesOf(app, viewer);
  const [rows, count, pages] = await Promise.all([
    listVisibleMatters(app.db, { viewer, state: "open", withoutMoney: true, heldRoles, limit: CLIENT_MATTERS_LIMIT + MATTER_INFO_KINDS.length }),
    countClientMatters(app, principal),
    listMatterPageLabels(app.db),
  ]);
  return {
    count,
    matters: rows.filter((row) => !isMatterInfoKind(row.kind)).slice(0, CLIENT_MATTERS_LIMIT).map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      link: row.link,
      pageLabels: row.pageIds.map((id) => pages.labelOf.get(id)).filter((label): label is string => label !== undefined),
      openedAt: row.openedAt.toISOString(),
    })),
    serverNow: now.toISOString(),
  };
}

// ── The agent's door (write:matters) ────────────────────────────────────────

/** The plane's one 404: missing and out of grant are the same bytes (modules/agent-read/errors.ts). */
const notFound = () => new AppError("Not found", 404, "not_found");

function notAgents(key: string): ConflictError {
  return new ConflictError(`Matter "${key}" is not the agent's to write: Hub's server keeps its kind`, { reason: "matter_not_agents" });
}

async function personOf(app: MattersApp, username: string): Promise<{ userId: number; role: MatterOwnerRole }> {
  const person = await findMatterPerson(app.db, username);
  if (person === null) throw new ConflictError(`No living person "${username}"`, { reason: "person_unknown" });
  return person;
}

const stateOf = (matter: MatterRow): AgentMatterResponse["matter"] => ({
  id: matter.id, key: matter.key, kind: matter.kind, state: matter.state, closedHow: matter.closedHow,
});

export interface AgentMatterScope {
  principal: AgentAuthPrincipal;
  /** The key's granted pages. */
  pages: ReadonlyArray<{ id: number; pageLabel: string }>;
}

/** Opens (or updates, or reopens) an agent's matter by its key. */
export async function agentOpenMatter(app: MattersApp, scope: AgentMatterScope, body: AgentMatterOpenBody, now: Date = new Date()): Promise<AgentMatterResponse> {
  // The kinds Hub's server keeps — the mirrors', the system state's, the checks' of package K, the custom checks'
  // of package I, the shift report's of package F and a newcomer's way of package J — are never an agent's.
  if (isMatterMirrorKind(body.kind) || isMatterServerKind(body.kind) || isMatterCheckKind(body.kind) || isCustomOrderCheckKind(body.kind)
    || isShiftReportMatterKind(body.kind) || isMatterPersonStartKind(body.kind)) {
    throw notAgents(body.key);
  }
  const owner: MatterOwner = "user" in body.owner ? { userId: (await personOf(app, body.owner.user)).userId } : { role: body.owner.role };
  const watcherUserIds: number[] = [];
  for (const watcher of body.watchers ?? []) watcherUserIds.push((await personOf(app, watcher)).userId);
  const onBehalfOf = body.onBehalfOf === undefined ? null : (await personOf(app, body.onBehalfOf)).userId;
  const pageIds: number[] = [];
  for (const label of body.pageLabels ?? []) {
    const page = scope.pages.find((candidate) => candidate.pageLabel === label);
    if (!page) throw notFound();
    if (!pageIds.includes(page.id)) pageIds.push(page.id);
  }
  try {
    const { matter, transition } = await openMatter(app.db, {
      key: body.key,
      kind: body.kind,
      source: "agent",
      title: body.title,
      object: body.object ?? null,
      pageIds,
      owner,
      watcherUserIds: [...new Set(watcherUserIds)],
      money: body.money ?? false,
      evidence: body.evidence ?? {},
      link: body.link ?? null,
    }, { door: "api", agentKeyId: scope.principal.agentKeyId, onBehalfOfUserId: onBehalfOf }, now);
    return { matter: stateOf(matter), transition };
  } catch (error) {
    if (error instanceof MatterWriterConflictError) throw notAgents(body.key);
    throw error;
  }
}

/** Closes an agent's matter by its key; a closed one stays as it was. */
export async function agentCloseMatter(app: MattersApp, scope: AgentMatterScope, body: AgentMatterCloseBody, now: Date = new Date()): Promise<AgentMatterResponse> {
  const onBehalfOf = body.onBehalfOf === undefined ? null : (await personOf(app, body.onBehalfOf)).userId;
  try {
    const closed = await closeMatter(app.db, { key: body.key, how: body.how, note: body.note ?? null, writer: "agent" }, {
      door: "api", agentKeyId: scope.principal.agentKeyId, onBehalfOfUserId: onBehalfOf,
    }, now);
    if (closed.matter === null) throw notFound();
    return { matter: stateOf(closed.matter), transition: closed.transition === "closed" ? "closed" : "unchanged" };
  } catch (error) {
    if (error instanceof MatterWriterConflictError) throw notAgents(body.key);
    throw error;
  }
}

/** A comment on a matter by its key (any writer's; a matter of pages outside the key's grant is not found). */
export async function agentCommentMatter(app: MattersApp, scope: AgentMatterScope, body: AgentMatterCommentBody, now: Date = new Date()): Promise<AgentMatterCommentResponse> {
  const matter = await findMatterByKey(app.db, body.key);
  const granted = new Set(scope.pages.map((page) => page.id));
  if (matter === null || (matter.pageIds.length > 0 && !matter.pageIds.some((id) => granted.has(id)))) throw notFound();
  const onBehalfOf = body.onBehalfOf === undefined ? null : (await personOf(app, body.onBehalfOf)).userId;
  const commented = await commentMatter(app.db, { key: body.key, text: body.text }, {
    door: "api", agentKeyId: scope.principal.agentKeyId, onBehalfOfUserId: onBehalfOf,
  }, now);
  if (commented === null) throw notFound();
  return { matter: stateOf(commented.matter), eventId: commented.eventId };
}

/** The digest of an agent's text for its audit row (never the text). */
export function matterTextDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
