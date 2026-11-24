import { createHash } from "node:crypto";

import {
  isMatterCheckKind,
  isMatterInfoKind,
  HUB_WAITING_PATH,
  WAITING_GROUPS,
  WAITING_PRODUCTS,
  WORKBOARD_WAITING_PATH,
  waitingGroupLink,
  waitingGroupOf,
  waitingSinceOf,
  waitingToneOf,
  worstWaitingTone,
  isCustomOrderCheckKind,
  isMatterMirrorKind,
  isMatterPersonStartKind,
  isMatterServerKind,
  MATTER_CHECK_KIND_PERIODS,
  MATTER_CHECK_KINDS,
  MATTER_INFO_KINDS,
  MATTER_MIRROR_KIND_ROLES,
  MATTER_MIRROR_KINDS,
  isShiftReportMatterKind,
  isReportPostMatterKind,
  isSaleClaimMatterKind,
  isPotMatterKind,
  isTeamQuestionMatterKind,
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
  type MattersWaitingResponse,
} from "@agency_hub_core/contracts";
import {
  closeMatter,
  commentMatter,
  countVisibleOpenMatters,
  findMatterByKey,
  findMatterPerson,
  isTestUser,
  listMatterChecks,
  listMatterPageLabels,
  listMatterUsernames,
  listOpenMattersOfKinds,
  listVisibleMatters,
  matterChanges,
  MatterWriterConflictError,
  openMatter,
  listTestPageIds,
  touchMatters,
  type MatterActor,
  type MatterCheckRow,
  type MatterOpenInput,
  type MatterOwner,
  type MatterOwnerRole,
  type MatterRow,
  type MatterSource,
  type MatterViewer,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import type { AgentAuthPrincipal, HumanAuthPrincipal } from "./auth.ts";
import { awaitingGivingOf, customsLeadOwner } from "./custom-orders/readers.ts";
import { AppError, ConflictError, NotFoundError } from "./errors.ts";
import { ledPagesFor, teamFactsFor } from "./teams.ts";

/**
 * Дела (ecosystem plan §2, §6, package D): the reads of matters by every door
 * and the agent's writes. Who reads what is the repository's one rule
 * (`matterVisibility`): the owner every matter; a team lead their own and
 * their role's on their pages; a chatter their own; a matter with money the
 * owner's alone. A kind Hub mirrors whose source did not answer lately is «не
 * проверено» (`checked: false` of its group), never a zero. Database only.
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
  // A chatter's post to fix: the mirror's ledger read of the reports, every five minutes.
  if (isReportPostMatterKind(kind)) return 5 * MINUTE;
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

// ── «Ждут вас», from matters ────────────────────────────────────────────────

/** The mirrored kinds whose matters wait for one of these roles (MATTER_MIRROR_KIND_ROLES). */
function mirroredKindsOf(roles: readonly MatterOwnerRole[]): MatterMirrorKind[] {
  return MATTER_MIRROR_KINDS.filter((kind) => roles.includes(MATTER_MIRROR_KIND_ROLES[kind]));
}

/** What the groups need of each kind. */
export interface MatterKindState {
  checked: boolean;
  /** Shown at all (the OnlyFans history requests only while the OnlyFans API is on). */
  applicable: boolean;
}

type WaitingMatter = Pick<MatterRow, "id" | "kind" | "pageIds" | "evidence"> & Partial<Pick<MatterRow, "title" | "openedAt" | "link">>;

/** The events a counter matter stands for (`extension.critical`: its 7 days' total), else 1: the mirror's tally. */
export function matterWeight(matter: Pick<MatterRow, "kind" | "evidence">): number {
  if (matter.kind !== "extension.critical") return 1;
  const total = matter.evidence.total;
  return typeof total === "number" && Number.isSafeInteger(total) && total > 0 ? total : 0;
}

/**
 * «Ждут вас» by the list's groups (contracts waiting-groups.ts, the one table): a group per kind of the viewer's own
 * open matters, in the list's order, never «Для сведения»; counted as the list counts — one per matter, and the
 * custom orders' number in «Кастомы». A group is `checked: false` when a source of it
 * (a kind the viewer's checks keep, `trackedKinds`, or a kind of its open matters) did not answer lately; such a group
 * is shown with what it has, and a group with nothing and everything answered is left out.
 */
export function buildWaitingGroups(input: {
  matters: readonly WaitingMatter[];
  kindState: (kind: string) => MatterKindState;
  trackedKinds: readonly string[];
  customOrders?: number | null;
  /** The list the groups lead to: Workboard's (default), or the owner's combined one in Hub. */
  list?: string;
}): MattersWaitingResponse["groups"] {
  const groups: MattersWaitingResponse["groups"] = [];
  for (const group of WAITING_GROUPS) {
    if (group.id === "info") continue;
    const kinds = new Set([
      ...input.trackedKinds.filter((kind) => waitingGroupOf(kind) === group.id && input.kindState(kind).applicable),
      ...input.matters.filter((matter) => waitingGroupOf(matter.kind) === group.id).map((matter) => matter.kind),
    ]);
    let count = input.matters.filter((matter) => waitingGroupOf(matter.kind) === group.id).length;
    let checked = [...kinds].every((kind) => input.kindState(kind).checked);
    if (group.id === "customs" && input.customOrders !== undefined) {
      if (input.customOrders === null) checked = false;
      else count += input.customOrders;
    }
    if (count === 0 && checked) continue;
    // The worst of its matters' tones; a group not checked is at least «outcome unknown».
    const tone = worstWaitingTone([
      ...input.matters.filter((matter) => waitingGroupOf(matter.kind) === group.id).map((matter) => waitingToneOf(matter.kind)),
      checked ? null : "warn",
    ]);
    groups.push({ id: group.id, title: group.title, count, checked, tone, to: waitingGroupLink(group.id, input.list), product: group.product });
  }
  return groups;
}

/**
 * The groups by product (Hub · Workboard · ContentOps): the Home's tiles and Workboard's number. A product's count is
 * its groups' sum, so the products sum to `total`; its oldest is the matter waiting longest since its reason began.
 */
export function buildWaitingProducts(groups: MattersWaitingResponse["groups"], matters: readonly WaitingMatter[], now: Date): MattersWaitingResponse["products"] {
  const products: MattersWaitingResponse["products"] = [];
  for (const product of WAITING_PRODUCTS) {
    const own = groups.filter((group) => group.product === product.id);
    if (own.length === 0) continue;
    const ids = new Set(own.map((group) => group.id));
    let oldest: { title: string; since: string; link: string | null } | null = null;
    for (const matter of matters) {
      if (!ids.has(waitingGroupOf(matter.kind)) || matter.title === undefined || matter.openedAt === undefined) continue;
      const since = waitingSinceOf({ kind: matter.kind, openedAt: matter.openedAt.toISOString(), evidence: matter.evidence }, now.getTime());
      if (oldest === null || since < oldest.since) oldest = { title: matter.title, since, link: matter.link ?? null };
    }
    products.push({
      id: product.id, title: product.title,
      count: own.reduce((sum, group) => sum + group.count, 0),
      checked: own.every((group) => group.checked),
      tone: worstWaitingTone(own.map((group) => group.tone)),
      oldest,
    });
  }
  return products;
}

// ── A server writer's kinds, made what its findings say ─────────────────────

const SYSTEM: MatterActor = { door: "system" };

/**
 * The one reconcile of a writer's matters («one writer per kind, closes itself when the cause is gone»): every input
 * opened, updated or reopened by its key (the first of a key counts; one that would change nothing is only touched,
 * all of them in one batch), and every open matter of `kinds` that is not among them closed as «cause gone» — unless
 * `keep` holds it — by `closeAs`, or by the writer it was opened by. One that cannot be written does not stop the
 * rest: the writer's `onOpenError` / `onCloseError` says it. The read of the open matters and the touch throw.
 */
export async function reconcileKindMatters(
  app: Pick<AppContext, "db">,
  input: {
    kinds: readonly string[];
    inputs: readonly MatterOpenInput[];
    keep?: ((key: string) => boolean) | undefined;
    closeAs?: MatterSource;
    onOpenError: (error: unknown, key: string) => void;
    onCloseError: (error: unknown, key: string) => void;
  },
  now: Date,
): Promise<{ opened: number; closed: number }> {
  const open = new Map((await listOpenMattersOfKinds(app.db, input.kinds)).map((matter) => [matter.key, matter]));
  const seen = new Set<string>();
  const touched: string[] = [];
  let opened = 0;
  let closed = 0;
  for (const matter of input.inputs) {
    if (seen.has(matter.key)) continue;
    seen.add(matter.key);
    const existing = open.get(matter.key);
    if (existing !== undefined && matterChanges(existing, matter).length === 0) {
      touched.push(matter.key);
      continue;
    }
    try {
      const result = await openMatter(app.db, matter, SYSTEM, now);
      if (result.transition === "opened" || result.transition === "reopened") opened += 1;
    } catch (error) {
      input.onOpenError(error, matter.key);
    }
  }
  for (const [key, matter] of open) {
    if (seen.has(key) || input.keep?.(key)) continue;
    try {
      const result = await closeMatter(app.db, { key, how: "cause_gone", writer: input.closeAs ?? matter.source }, SYSTEM, now);
      if (result.transition === "closed") closed += 1;
    } catch (error) {
      input.onCloseError(error, key);
    }
  }
  await touchMatters(app.db, touched, now);
  return { opened, closed };
}

// ── The doors ───────────────────────────────────────────────────────────────

type MattersApp = Pick<AppContext, "db">;

/**
 * Who reads: the session's person by their role — except a narrow web session
 * (opened from the extension), which reads as a chatter whatever the role: the
 * person's own matters, never one with money.
 */
export async function matterViewerOf(app: Pick<AppContext, "db">, principal: HumanAuthPrincipal): Promise<MatterViewer> {
  const role = principal.narrowDeviceTokenId === undefined ? principal.user.role as MatterOwnerRole : "chatter";
  // The pages of the teams the person leads by the records (services/teams.ts); a narrow session leads nothing.
  const leadPageIds = role === "owner" ? [] : await ledPagesFor(app, principal);
  // A test person's login reads the test realm's matters only (sandbox/realm.ts).
  return {
    userId: principal.user.id, role, pageIds: principal.assignedPageIds, leadPageIds,
    ...(principal.sandbox?.test === true ? { realm: "test" as const } : {}),
  };
}

/**
 * The roles whose matters wait for the viewer themself (besides their user's): the owner's own, and a team lead's role
 * matters of the models that have no lead (he is the acting lead there); a person who leads a team by the records,
 * the team lead's role matters of that model (`matterHeldBy` cuts them by the model, 0415); anyone else none.
 */
export async function heldRolesOf(_app: Pick<AppContext, "db">, viewer: MatterViewer): Promise<MatterOwnerRole[]> {
  if (viewer.role === "owner") return ["owner", "team_lead"];
  return (viewer.leadPageIds ?? []).length > 0 ? ["team_lead"] : [];
}

/** Whether a matter waits for the viewer themself. */
export function matterIsMine(
  matter: Pick<MatterRow, "owner" | "pageIds">,
  viewer: MatterViewer,
  heldRoles: readonly MatterOwnerRole[],
  /** The pages whose model has a lead (0415): a team lead's role matter there is the lead's, not the owner's. */
  ledPages: ReadonlySet<number> = new Set(),
): boolean {
  if ("userId" in matter.owner) return matter.owner.userId === viewer.userId;
  if (!heldRoles.includes(matter.owner.role)) return false;
  if (matter.owner.role !== "team_lead") return true;
  // As `matterHeldBy`: the owner holds it while no model of its pages has a lead; a lead, on the pages they lead.
  if (viewer.role === "owner") return !matter.pageIds.some((pageId) => ledPages.has(pageId));
  const mine = new Set(viewer.leadPageIds ?? []);
  return matter.pageIds.some((pageId) => mine.has(pageId));
}

/** The pages whose model's team has a lead. */
async function ledPagesOfAll(app: Pick<AppContext, "db">): Promise<Set<number>> {
  const facts = await teamFactsFor(app);
  const led = new Set(facts.roles.filter((role) => role.kind === "lead").map((role) => role.modelId));
  return new Set(facts.pages.filter((page) => led.has(page.modelId)).map((page) => page.pageId));
}

/**
 * «Кастомы»'s orders: the orders paid or shot and not given, of the viewer's pages (the owner every page); null — the
 * read failed; undefined — a chatter's, who has no such line. It is the lead's line: the viewer's only while customs
 * are led by the team lead's role they hold (`customsLeadOwner`). When a person leads customs it is nobody's (zero):
 * that person reads their own matters, the owner sees them under «Ждут других» and has the board.
 */
async function customOrdersCount(app: MattersApp, viewer: MatterViewer): Promise<number | null | undefined> {
  if (viewer.role === "chatter") return undefined;
  if ("userId" in (await customsLeadOwner(app))) return 0;
  try {
    // "all" is the live agency's; the test owner's every page is the test realm's (sandbox/realm.ts).
    const every = viewer.realm === "test" ? await listTestPageIds(app.db) : "all" as const;
    return (await awaitingGivingOf(app, { pageIds: viewer.role === "owner" ? every : viewer.pageIds, limit: 5000 })).length;
  } catch {
    return null;
  }
}

function kindStates(checks: readonly MatterCheckRow[], now: Date): (kind: string) => MatterKindState {
  const byKind = new Map(checks.map((check) => [check.kind, check]));
  return (kind) => {
    const check = byKind.get(kind);
    // A kind nobody checks (an agent's) is known as it is: its matters are what its writer said.
    if (check === undefined && matterKindPeriodMs(kind) === null) return { checked: true, applicable: true };
    return { checked: matterKindChecked(check, kind, now), applicable: check?.applicable ?? true };
  };
}

async function pageIdOf(app: MattersApp, pageLabel: string | undefined, idOf: Map<string, number>): Promise<number | null> {
  if (pageLabel === undefined) return null;
  const id = idOf.get(pageLabel);
  if (id === undefined) throw new NotFoundError(`Page "${pageLabel}" was not found`);
  return id;
}

/**
 * `mattersWaiting`: «Ждут вас» from matters, for a dashboard session — the list's groups for every role (the one
 * table), so the number, the chips and the list are one count: a team lead's number is what their list shows.
 */
export async function readMattersWaiting(app: MattersApp, principal: HumanAuthPrincipal, now: Date = new Date()): Promise<MattersWaitingResponse> {
  const viewer = await matterViewerOf(app, principal);
  const heldRoles = await heldRolesOf(app, viewer);
  // A chatter who leads no team waits for their own matters alone (Workboard «Ждут вас», products package W): no
  // tracked kind, no customs line.
  const plain = viewer.role === "chatter" && heldRoles.length === 0;
  const [matters, checks] = await Promise.all([
    // What waits for the viewer themself (a plain chatter holds no role: their own user's alone).
    listVisibleMatters(app.db, { viewer, state: "open", heldRoles, limit: 5000 }),
    listMatterChecks(app.db),
  ]);
  const kindState = kindStates(checks, now);
  const orders = heldRoles.includes("team_lead") ? await customOrdersCount(app, viewer) : undefined;
  // The kinds the viewer's own sources keep — the mirrored ones of the roles they hold, the owner's checks — so a
  // group whose source failed shows even with nothing open in it.
  const trackedKinds = plain ? [] : [
    ...mirroredKindsOf(heldRoles),
    ...(viewer.role === "owner" ? MATTER_CHECK_KINDS.filter((kind) => !isMatterInfoKind(kind)) : []),
  ];
  const waiting = matters.filter((matter) => !isMatterInfoKind(matter.kind));
  const groups = buildWaitingGroups({
    matters: waiting, kindState, trackedKinds,
    ...(orders === undefined ? {} : { customOrders: orders }),
    // The owner's groups lead to the owner's combined list in Hub; everyone else's to Workboard's.
    list: viewer.role === "owner" ? HUB_WAITING_PATH : WORKBOARD_WAITING_PATH,
  });
  return {
    // A constant for the tabs opened before the switch was removed (contracts matters.ts): nothing of ours reads it.
    active: true,
    groups,
    products: buildWaitingProducts(groups, waiting, now),
    total: groups.reduce((sum, group) => sum + group.count, 0),
    failed: groups.filter((group) => !group.checked).map((group) => group.id),
    customOrders: orders ?? 0,
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
  const viewer = await matterViewerOf(app, principal);
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
  const ledPages = viewer.role === "owner" ? await ledPagesOfAll(app) : new Set<number>();
  // The person's name where the login is a person's (the name «Люди» and «Кастомы» show): one read for all.
  const checkOf = new Map(checks.map((check) => [check.kind, check]));
  // The kinds the server keeps for this viewer: the mirrored ones they read (the owner every one, a team lead their
  // role's), and the owner's checks (package K).
  const readRoles: MatterOwnerRole[] = viewer.role === "owner" ? ["owner", "team_lead"] : heldRoles;
  const mirrored = new Set<string>([...mirroredKindsOf(readRoles), ...(viewer.role === "owner" ? MATTER_CHECK_KINDS : [])]);
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
    matters: rows.map((row) => matterWire(row, pages.labelOf, usernameOf, matterIsMine(row, viewer, heldRoles, ledPages))),
    kinds,
    serverNow: now.toISOString(),
  };
}

const CLIENT_MATTERS_LIMIT = 50;

/** The extension's number: what waits for the person themself, never one with money, never one that only informs. */
export async function countClientMatters(app: Pick<AppContext, "db">, principal: HumanAuthPrincipal): Promise<number> {
  const viewer = await matterViewerOf(app, principal);
  const counts = await countVisibleOpenMatters(app.db, { viewer, withoutMoney: true, heldRoles: await heldRolesOf(app, viewer) });
  return [...counts].reduce((sum, [kind, value]) => sum + (isMatterInfoKind(kind) ? 0 : value), 0);
}

/** `clientMatters`: the extension's count and the longest waiting of the person's matters; never evidence, never money. */
export async function readClientMatters(app: MattersApp, principal: HumanAuthPrincipal, now: Date = new Date()): Promise<ClientMattersResponse> {
  const viewer = await matterViewerOf(app, principal);
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
  // of package I, the shift report's of package F, a newcomer's way of package J, the claims' of package G and a
  // question's to whoever decides — are never an agent's.
  if (isMatterMirrorKind(body.kind) || isMatterServerKind(body.kind) || isMatterCheckKind(body.kind) || isCustomOrderCheckKind(body.kind)
    || isShiftReportMatterKind(body.kind) || isMatterPersonStartKind(body.kind) || isReportPostMatterKind(body.kind)
    || isSaleClaimMatterKind(body.kind) || isPotMatterKind(body.kind) || isTeamQuestionMatterKind(body.kind)) {
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

// ── The owner's agent door (services/owner-agent-door.ts) ──────────────────

/**
 * Where a matter closes when it is not an agent's: its kind's own service. A kind Hub's server keeps closes by its
 * pass when its cause is gone, or by its object's own step; the ledger's, ContentOps' and a person's by theirs. Null —
 * an agent's matter: its writer closes it by its key (the agent's door, the owner's agent door).
 */
export function matterClosedWhere(matter: Pick<MatterRow, "kind" | "source">): string | null {
  const kind = matter.kind;
  if (isSaleClaimMatterKind(kind)) return "the sale's own step: sale.decide, sale.close, decision.link, or Workboard";
  if (isTeamQuestionMatterKind(kind)) return "the question's own step: swap.approve, swap.revoke, or Workboard";
  if (isCustomOrderCheckKind(kind)) return "the order's or the finding's own step: custom.step, customFinding.answer";
  if (matter.source === "agent" && !isMatterMirrorKind(kind) && !isMatterServerKind(kind) && !isMatterCheckKind(kind)
    && !isShiftReportMatterKind(kind) && !isMatterPersonStartKind(kind) && !isReportPostMatterKind(kind)) return null;
  if (matter.source === "ledger") return "the ledger: it closes when the ledger's cause is gone";
  if (matter.source === "contentops") return "ContentOps: it closes when its cause there is gone";
  if (matter.source === "person") return "the person's own step";
  return "Hub's own pass: it closes when its cause is gone";
}

/** A matter the owner reads, of the live realm, by its key; one that waits for a test login is not found. */
async function ownerMatterOf(app: MattersApp, key: string): Promise<MatterRow> {
  const matter = await findMatterByKey(app.db, key);
  if (matter === null || ("userId" in matter.owner && await isTestUser(app.db, matter.owner.userId))) throw new NotFoundError("No such matter");
  return matter;
}

/**
 * Closes a matter by its key for the owner, through its kind's own service: an agent's matter by its writer (as the
 * agent's door closes it, `writer: agent`); any other is 409 `matter_kind_service`, naming where it closes. A closed one
 * stays as it was.
 */
export async function closeMatterAsOwner(
  app: MattersApp,
  body: { key: string; how: AgentMatterCloseBody["how"]; note?: string | undefined },
  actor: MatterActor,
  now: Date = new Date(),
): Promise<{ matter: AgentMatterResponse["matter"]; transition: "closed" | "unchanged" }> {
  const matter = await ownerMatterOf(app, body.key);
  const where = matterClosedWhere(matter);
  if (where !== null) throw new ConflictError(`A «${matter.kind}» matter closes through ${where}`, { reason: "matter_kind_service" });
  try {
    const closed = await closeMatter(app.db, { key: body.key, how: body.how, note: body.note ?? null, writer: "agent" }, actor, now);
    if (closed.matter === null) throw new NotFoundError("No such matter");
    return { matter: stateOf(closed.matter), transition: closed.transition === "closed" ? "closed" : "unchanged" };
  } catch (error) {
    if (error instanceof MatterWriterConflictError) throw new ConflictError(`A «${matter.kind}» matter is not an agent's`, { reason: "matter_kind_service" });
    throw error;
  }
}

/** A comment on any matter the owner reads, by its key, in its history (the matters' one writer of comments, every kind's). */
export async function commentMatterAsOwner(
  app: MattersApp,
  body: { key: string; text: string },
  actor: MatterActor,
  now: Date = new Date(),
): Promise<AgentMatterCommentResponse> {
  await ownerMatterOf(app, body.key);
  const commented = await commentMatter(app.db, { key: body.key, text: body.text }, actor, now);
  if (commented === null) throw new NotFoundError("No such matter");
  return { matter: stateOf(commented.matter), eventId: commented.eventId };
}

/** The digest of an agent's text for its audit row (never the text). */
export function matterTextDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
