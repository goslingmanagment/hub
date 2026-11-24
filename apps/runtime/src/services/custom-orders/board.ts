import {
  customOrderCode,
  customUndoOf,
  type CustomBoardOrder,
  type CustomFindingsListResponse,
  type CustomOrderChangesResponse,
  type CustomOrdersBoardResponse,
  type CustomOrdersDoneResponse,
  type CustomSelfChange,
} from "@agency_hub_core/contracts";
import {
  countCustomOrdersDone,
  findPageSummaryByLabel,
  listAgentDismissedCustomFindings,
  listBoardCustomFindings,
  listCustomLookalikeSales,
  listCustomOrderActorNames,
  listCustomOrders,
  listCustomOrdersByIds,
  listCustomOrderSelfChanges,
  listCustomOrdersDone,
  listOnShiftUsersByPage,
  type CustomFindingRow,
  type CustomOrderRealmRow,
  type CustomOrderRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import type { AuthPrincipal, HumanAuthPrincipal } from "../auth.ts";
import { NotFoundError } from "../errors.ts";
import { personOfLogin } from "../teams.ts";
import { FINDINGS_LOOK_BACK_DAYS, findingWire, mayResolveFinding } from "./findings.ts";
import {
  customLeaderContext, customsVerifiedOf, customViewerOf, lookalikesFor, orderWire, requireBoardReader, type CustomLeaderContext, type CustomOnShift,
} from "./index.ts";
import { boardLeads } from "./leaders.ts";
import { waitingCustomSaleIds } from "./readers.ts";
import { leadsSteps, seesOrder, stepsFor, type CustomViewer } from "./rules.ts";
import { customsFactsOn } from "./switch.ts";

/**
 * Workboard «Кастомы»: the board's reads. With the live switch `customsFacts` off, the board as it was — the open
 * orders and the given and closed of the last week, with their card, and the sales that look like a custom. On, the
 * facts screen (customs facts spec §13): the live orders alone, without their card document, and at the top the counts
 * of the open findings the viewer resolves and of the last 24 hours' steps the system and the agents took on the
 * viewer's orders; the given, the closed, the findings and the changes are their own reads, made when their block is
 * opened. The realm is in each query; the visibility is the board's one rule (`seesOrder`). Database only.
 */

type BoardApp = Pick<AppContext, "db" | "config">;

/** The old board shows the given and closed orders of the last week. */
const DONE_DAYS = 7;
const BOARD_LIMIT = 500;
const DAY_MS = 86_400_000;
/** «Закрыто за месяц». */
const CLOSED_DAYS = 30;
const CHANGES_HOURS = 24;
const LIST_LIMIT = 500;

/** The pages a viewer's board reads: one page, every page (the lead and the owner), or their own; and their realm. */
async function boardScope(app: BoardApp, viewer: CustomViewer, pageLabel: string | undefined) {
  let pageId: number | null = null;
  if (pageLabel !== undefined) {
    const page = await findPageSummaryByLabel(app.db, pageLabel);
    if (!page || !seesOrder(viewer, { pageId: page.id })) throw new NotFoundError(`Page "${pageLabel}" was not found`);
    pageId = page.id;
  }
  const everything = viewer.lead || viewer.role === "owner";
  const pageIds = pageId !== null ? [pageId] : everything ? "all" as const : viewer.pageIds;
  const realm: CustomOrderRealmRow = viewer.realm?.test === true ? "test" : "live";
  return { pageId, pageIds, unknownPage: everything || viewer.role === "team_lead", realm };
}

/** An order on the board's lists: without the card document on the facts screen (its volume line alone). */
export function boardOrderWire(
  row: CustomOrderRow, now: Date, leaders: CustomLeaderContext | null, withCard: boolean, onShift?: CustomOnShift,
): CustomBoardOrder {
  const { card, ...order } = orderWire(row, now, leaders, onShift);
  return { ...order, ...(withCard ? { card } : {}), volume: card.duration ?? null };
}

/** The viewer as the people registry names them, else their login. */
function viewerName(leaders: CustomLeaderContext, principal: HumanAuthPrincipal): string | null {
  const personId = personOfLogin(leaders.facts, principal.user.id);
  const named = personId === null ? null : leaders.facts.people.find((person) => person.personId === personId)?.name;
  return named || principal.user.username;
}

/**
 * The pages whose findings the viewer resolves (`mayResolveFinding`, in SQL before the limit): the owner and the customs
 * lead every page of their realm and those of no page; the check's leader of a page its findings; anyone else none.
 */
function resolvedPages(viewer: CustomViewer): "all" | readonly number[] {
  return viewer.role === "owner" || viewer.lead ? "all" : viewer.leads?.check ?? [];
}

/** The open findings the viewer resolves (findings.ts, `mayResolveFinding`), of their realm. */
async function findingsFor(app: BoardApp, viewer: CustomViewer): Promise<CustomFindingRow[]> {
  const pageIds = resolvedPages(viewer);
  if (pageIds !== "all" && pageIds.length === 0) return [];
  const rows = await listBoardCustomFindings(app.db, { realm: viewer.realm?.test === true ? "test" : "live", pageIds, limit: LIST_LIMIT });
  return rows.filter((row) => mayResolveFinding(viewer, row));
}

/**
 * «Отклонено агентом» (spec §10: what the system did by itself is shown and undone): the findings an agent dismissed as
 * «не кастом» in the last two weeks that the viewer resolves, the newest first — a person may bring one back.
 */
async function agentDismissedFor(app: BoardApp, viewer: CustomViewer, now: Date): Promise<CustomFindingRow[]> {
  const pageIds = resolvedPages(viewer);
  if (pageIds !== "all" && pageIds.length === 0) return [];
  const rows = await listAgentDismissedCustomFindings(app.db, {
    realm: viewer.realm?.test === true ? "test" : "live", pageIds, since: new Date(now.getTime() - FINDINGS_LOOK_BACK_DAYS * DAY_MS), limit: LIST_LIMIT,
  });
  return rows.filter((row) => mayResolveFinding(viewer, row));
}

/** The order's fan as the board names him, or the card's buyer; null — not known, or erased. */
function fanNameOf(row: CustomOrderRow): string | null {
  if (row.fanErasedAt !== null) return null;
  return row.fanDisplayName ?? row.fanUsername ?? row.buyer;
}

/**
 * «За сутки изменилось само» (spec §10): the steps of the system's and the agents' doors in the last 24 hours on the
 * orders the board shows the viewer, the newest first, each with its undo when the viewer may take it back
 * (`customUndoOf`, the one rule the order's facts use too).
 */
async function selfChangesFor(app: BoardApp, viewer: CustomViewer, now: Date): Promise<CustomSelfChange[]> {
  // The board's own scope in the query (the viewer's pages, their realm), before the limit.
  const scope = await boardScope(app, viewer, undefined);
  const rows = await listCustomOrderSelfChanges(app.db, {
    since: new Date(now.getTime() - CHANGES_HOURS * 3_600_000), realm: scope.realm, pageIds: scope.pageIds, unknownPage: scope.unknownPage, limit: LIST_LIMIT,
  });
  if (rows.length === 0) return [];
  const orders = new Map((await listCustomOrdersByIds(app.db, [...new Set(rows.map((row) => row.orderId))])).map((order) => [order.id, order]));
  const seen = rows.filter((row) => {
    const order = orders.get(row.orderId);
    return order !== undefined && seesOrder(viewer, order);
  });
  const agentKeyIds = [...new Set(seen.map((row) => row.actorAgentKeyId).filter((id): id is number => id !== null))];
  const names = await listCustomOrderActorNames(app.db, { userIds: [], agentKeyIds });
  const steps = new Map<number, ReadonlySet<string>>();
  const stepsOf = (order: CustomOrderRow) => {
    let set = steps.get(order.id);
    if (set === undefined) {
      set = new Set(stepsFor(viewer, order));
      steps.set(order.id, set);
    }
    return set;
  };
  return seen.map((row) => {
    const order = orders.get(row.orderId)!;
    return {
      id: row.id,
      at: row.at.toISOString(),
      code: customOrderCode(order.id),
      fan: fanNameOf(order),
      event: row.event,
      door: row.door,
      actor: row.actorAgentKeyId === null ? null : names.agentKeys.get(row.actorAgentKeyId) ?? null,
      changes: row.changes,
      undo: customUndoOf(row, order, row.applied, (action) => stepsOf(order).has(action)),
    };
  });
}

export async function readCustomOrdersBoard(
  app: BoardApp,
  principal: AuthPrincipal,
  query: { pageLabel?: string | undefined },
  now: Date = new Date(),
): Promise<CustomOrdersBoardResponse> {
  requireBoardReader(principal);
  return customOrdersBoardAs(app, principal, query, now);
}

/**
 * The board as `principal` reads it, the door checked by the caller: the board's own reader above, and the owner's
 * agent door AS the owner (services/owner-agent-door.ts, whose principal is no cookie session).
 */
export async function customOrdersBoardAs(
  app: BoardApp,
  principal: HumanAuthPrincipal,
  query: { pageLabel?: string | undefined },
  now: Date = new Date(),
): Promise<CustomOrdersBoardResponse> {
  const viewer = await customViewerOf(app, principal);
  const scope = await boardScope(app, viewer, query.pageLabel);
  const factsOn = await customsFactsOn(app);
  const [rows, lookalikes, leaders, onShift, verified] = await Promise.all([
    listCustomOrders(app.db, { ...scope, doneSince: new Date(now.getTime() - DONE_DAYS * DAY_MS), live: factsOn, limit: BOARD_LIMIT + 1 }),
    // The last week's, and the older ones a matter still waits about: «Записать» or «Не кастом» closes it here. The
    // facts screen has the findings instead.
    factsOn
      ? Promise.resolve([])
      : listCustomLookalikeSales(app.db, { from: new Date(now.getTime() - DONE_DAYS * DAY_MS), to: now, limit: 200, alsoIds: await waitingCustomSaleIds(app.db) }),
    customLeaderContext(app, principal),
    // Whose move a shot order is: whoever is on shift on the fan's page now (slice 3, leaders.ts `customMoveOf`).
    listOnShiftUsersByPage(app.db, now),
    // «Сверено N минут назад»: the reader's routines in «Система → Состояние».
    customsVerifiedOf(app, now),
  ]);
  const [findings, dismissed, changes, done] = factsOn
    ? await Promise.all([
      findingsFor(app, viewer),
      agentDismissedFor(app, viewer, now),
      selfChangesFor(app, viewer, now),
      countCustomOrdersDone(app.db, { ...scope, closedSince: new Date(now.getTime() - CLOSED_DAYS * DAY_MS) }),
    ])
    : [[], [], [], { given: 0, closed: 0 }] as const;
  const visible = rows.filter((row) => seesOrder(viewer, row));
  const fans = [...new Set(findings.map((row) => row.fanDisplayName ?? row.fanUsername).filter((name): name is string => name !== null))];
  return {
    viewer: { lead: leadsSteps(viewer), owner: viewer.role === "owner", name: viewerName(leaders, principal), userId: principal.user.id },
    // The header by the one rule, for the models of the pages the viewer sees, of their realm (never a global right).
    leads: boardLeads(leaders.facts, scope.pageIds, viewer.realm?.test === true),
    factsOn,
    orders: visible.slice(0, BOARD_LIMIT).map((row) => boardOrderWire(row, now, leaders, !factsOn, onShift)),
    capped: visible.length > BOARD_LIMIT,
    lookalikes: lookalikesFor(viewer, lookalikes)
      .filter((row) => scope.pageId === null || row.pageId === scope.pageId)
      .map((row) => ({
        transactionRef: String(row.transactionId),
        pageLabel: row.pageLabel,
        fan: row.fanRef === null ? null : { platform: row.platform, fanRef: row.fanRef, username: row.fanUsername, displayName: row.fanDisplayName },
        kind: row.kind,
        detail: row.detail,
        grossMills: row.grossMills,
        at: row.at.toISOString(),
      })),
    findings: {
      open: findings.length,
      amountMills: findings.reduce((sum, row) => sum + (row.amountMills ?? 0), 0),
      fans: fans.slice(0, 3),
      agentDismissed: dismissed.length,
    },
    verified,
    changes: { count: changes.length, newest: changes[0] ?? null },
    done,
    serverNow: now.toISOString(),
  };
}

/** `customOrdersDone`: «Отдано, ждём слово фана» (every given order) and «Закрыто за месяц» (closed in `days`). */
export async function readCustomOrdersDone(
  app: BoardApp,
  principal: AuthPrincipal,
  query: { days: number },
  now: Date = new Date(),
): Promise<CustomOrdersDoneResponse> {
  requireBoardReader(principal);
  const viewer = await customViewerOf(app, principal);
  const scope = await boardScope(app, viewer, undefined);
  const [rows, leaders] = await Promise.all([
    listCustomOrdersDone(app.db, { ...scope, closedSince: new Date(now.getTime() - query.days * DAY_MS), limit: BOARD_LIMIT + 1 }),
    customLeaderContext(app, principal),
  ]);
  const visible = rows.filter((row) => seesOrder(viewer, row)).slice(0, BOARD_LIMIT);
  const wire = (row: CustomOrderRow) => boardOrderWire(row, now, leaders, false);
  return {
    given: visible.filter((row) => row.state === "given").map(wire),
    closed: visible.filter((row) => row.state === "closed").map(wire),
    capped: rows.length > BOARD_LIMIT,
    serverNow: now.toISOString(),
  };
}

/** `customFindingsList`: the open findings the viewer resolves, the newest first, and the ones an agent dismissed. */
export async function readCustomFindings(app: BoardApp, principal: AuthPrincipal, now: Date = new Date()): Promise<CustomFindingsListResponse> {
  requireBoardReader(principal);
  return customFindingsAs(app, principal, now);
}

/** The findings as `principal` reads them, the door checked by the caller (the owner's agent door AS the owner). */
export async function customFindingsAs(app: BoardApp, principal: HumanAuthPrincipal, now: Date = new Date()): Promise<CustomFindingsListResponse> {
  const viewer = await customViewerOf(app, principal);
  const [open, dismissed] = await Promise.all([findingsFor(app, viewer), agentDismissedFor(app, viewer, now)]);
  return { findings: open.map(findingWire), dismissedByAgent: dismissed.map(findingWire), serverNow: now.toISOString() };
}

/** `customOrderChanges`: the last 24 hours' steps of the system and the agents on the viewer's orders. */
export async function readCustomOrderChanges(app: BoardApp, principal: AuthPrincipal, now: Date = new Date()): Promise<CustomOrderChangesResponse> {
  requireBoardReader(principal);
  const viewer = await customViewerOf(app, principal);
  return { changes: await selfChangesFor(app, viewer, now), serverNow: now.toISOString() };
}
