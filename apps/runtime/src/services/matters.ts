import { createHash } from "node:crypto";

import {
  isMatterCheckKind,
  isMatterInfoKind,
  WAITING_GROUPS,
  waitingGroupLink,
  waitingGroupOf,
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
import { awaitingGivingOf, customsLeadOwner } from "./custom-orders/readers.ts";
import { AppError, ConflictError, NotFoundError } from "./errors.ts";

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

type WaitingMatter = Pick<MatterRow, "id" | "kind" | "pageIds" | "evidence">;

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
    groups.push({ id: group.id, title: group.title, count, checked, tone, to: waitingGroupLink(group.id) });
  }
  return groups;
}

// ── The doors ───────────────────────────────────────────────────────────────

type MattersApp = Pick<AppContext, "db">;

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
 * «Кастомы»'s orders: the orders paid or shot and not given, of the viewer's pages (the owner every page); null — the
 * read failed; undefined — a chatter's, who has no such line. It is the lead's line: the viewer's only while customs
 * are led by the team lead's role they hold (`customsLeadOwner`). When a person leads customs it is nobody's (zero):
 * that person reads their own matters, the owner sees them under «Ждут других» and has the board.
 */
async function customOrdersCount(app: MattersApp, viewer: MatterViewer): Promise<number | null | undefined> {
  if (viewer.role === "chatter") return undefined;
  if ("userId" in (await customsLeadOwner(app))) return 0;
  try {
    return (await awaitingGivingOf(app, { pageIds: viewer.role === "owner" ? "all" : viewer.pageIds, limit: 5000 })).length;
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
  const viewer = matterViewerOf(principal);
  const heldRoles = await heldRolesOf(app, viewer);
  const [matters, checks] = await Promise.all([
    // What waits for the viewer themself.
    viewer.role === "chatter" ? Promise.resolve([]) : listVisibleMatters(app.db, { viewer, state: "open", heldRoles, limit: 5000 }),
    listMatterChecks(app.db),
  ]);
  const kindState = kindStates(checks, now);
  const orders = heldRoles.includes("team_lead") ? await customOrdersCount(app, viewer) : undefined;
  // The kinds the viewer's own sources keep — the mirrored ones of the roles they hold, the owner's checks — so a
  // group whose source failed shows even with nothing open in it.
  const trackedKinds = viewer.role === "chatter" ? [] : [
    ...mirroredKindsOf(heldRoles),
    ...(viewer.role === "owner" ? MATTER_CHECK_KINDS.filter((kind) => !isMatterInfoKind(kind)) : []),
  ];
  const groups = viewer.role === "chatter" ? [] : buildWaitingGroups({
    matters: matters.filter((matter) => !isMatterInfoKind(matter.kind)), kindState, trackedKinds,
    ...(orders === undefined ? {} : { customOrders: orders }),
  });
  return {
    groups,
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
  // The kinds the server keeps for this viewer: the mirrored ones they read (the owner every one, a team lead their
  // role's), and the owner's checks (package K).
  const readRoles: MatterOwnerRole[] = viewer.role === "owner" ? ["owner", "team_lead"] : viewer.role === "team_lead" ? ["team_lead"] : [];
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
  // of package I, the shift report's of package F, a newcomer's way of package J and the claims' of package G — are never an agent's.
  if (isMatterMirrorKind(body.kind) || isMatterServerKind(body.kind) || isMatterCheckKind(body.kind) || isCustomOrderCheckKind(body.kind)
    || isShiftReportMatterKind(body.kind) || isMatterPersonStartKind(body.kind) || isReportPostMatterKind(body.kind)
    || isSaleClaimMatterKind(body.kind)) {
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
