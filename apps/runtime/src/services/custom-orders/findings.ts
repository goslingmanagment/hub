import {
  customOrderCode,
  parseCustomOrderCode,
  parseTelegramRef,
  type AgentCustomFindingsBody,
  type AgentCustomFindingsResponse,
  type CustomFinding,
  type CustomFindingActionBody,
} from "@agency_hub_core/contracts";
import {
  findCustomFinding,
  findCustomOrder,
  findCustomSale,
  findPageFanByInput,
  findPageSummaryByLabel,
  insertCustomFinding,
  resolveCustomFinding,
  type CustomFindingRow,
  type Database,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { requireSessionUser, type AuthPrincipal, type HumanAuthPrincipal } from "../auth.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import type { AgentCustomScope } from "./agent.ts";
import { applyCustomStep, customViewerOf, recordCustomOrder, resolveFanOnPage } from "./index.ts";
import { seesOrder, type CustomViewer } from "./rules.ts";

/**
 * A custom with no order (customs facts spec §8): one object for every trace of it, `custom_findings`, once by
 * `(source, ref)`. The reader posts what only reading can find (`agentPostCustomFindings`, read:money + read:messages,
 * the key's pages only) and dismisses a candidate it read as «не кастом»; the check's leader of the finding's page
 * (the customs lead, the owner) resolves one: records it as an order (the board's «Записать кастом»; a sale's finding
 * brings its sale), links it to an order there is, or dismisses it with a reason from the list. A resolved finding
 * never opens again. Database only.
 */

type FindingsApp = Pick<AppContext, "db">;

export function findingWire(row: CustomFindingRow): CustomFinding {
  return {
    id: row.id,
    source: row.source,
    ref: row.ref,
    pageLabel: row.pageLabel,
    fan: row.fanRef === null || row.platform === null
      ? null
      : { platform: row.platform, fanRef: row.fanRef, username: row.fanUsername, displayName: row.fanDisplayName },
    amountMills: row.amountMills,
    quote: row.quote,
    happenedAt: row.happenedAt.toISOString(),
    status: row.status,
    orderCode: row.orderId === null ? null : customOrderCode(row.orderId),
    dismissReason: row.dismissReason,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A sale's finding is named by Hub's id of the sale, written as digits only (one sale, one `(source, ref)`). */
const SALE_REF = /^[1-9]\d{0,18}$/;

/**
 * `POST /api/v1/agent/custom-findings`: each trace once by `(source, ref)`. A sale's is the sale Hub holds on one of the
 * key's pages, its page, fan, sum and time Hub's own; any other names its page (of the key's) and the fan's platform id
 * there, or no page. `notCustom` keeps a new one dismissed as «не кастом» at once; a finding Hub has already stays as it
 * is — a person resolves it.
 */
export async function agentPostCustomFindings(
  app: FindingsApp,
  scope: AgentCustomScope,
  body: AgentCustomFindingsBody,
  now: Date = new Date(),
): Promise<AgentCustomFindingsResponse> {
  const keyPages = new Map(scope.pages.map((page) => [page.id, page]));
  const findings: AgentCustomFindingsResponse["findings"] = [];
  for (const item of body.findings) {
    const answer = (outcome: AgentCustomFindingsResponse["findings"][number]["outcome"], id: number | null) =>
      findings.push({ source: item.source, ref: item.ref, outcome, id });
    const page = item.pageLabel === undefined ? null : scope.pages.find((one) => one.pageLabel === item.pageLabel) ?? null;
    if (item.pageLabel !== undefined && page === null) {
      answer("not_found", null);
      continue;
    }
    let pageId = page?.id ?? null;
    let fanId: number | null = null;
    let amountMills = item.amountMills ?? null;
    let happenedAt = new Date(item.happenedAt);
    if (item.source === "sale") {
      const sale = SALE_REF.test(item.ref) ? await findCustomSale(app.db, Number(item.ref)) : null;
      if (sale === null || !keyPages.has(sale.pageId) || (pageId !== null && pageId !== sale.pageId)) {
        answer("not_found", null);
        continue;
      }
      pageId = sale.pageId;
      fanId = sale.fanId;
      amountMills = sale.grossMills > 0 ? sale.grossMills : null;
      happenedAt = sale.at;
    } else if (item.fanRef !== undefined && page !== null) {
      const fan = await findPageFanByInput(app.db, { pageId: page.id, platform: page.platform, platformUserId: item.fanRef, username: null });
      if (fan === null) {
        answer("not_found", null);
        continue;
      }
      fanId = fan.fanId;
    }
    const kept = await insertCustomFinding(app.db, {
      source: item.source, ref: item.ref, pageId, fanId, amountMills, quote: item.quote ?? null, happenedAt, at: now,
      ...(item.notCustom === true ? { dismissed: { reason: "not_custom" as const, agentKeyId: scope.principal.agentKeyId, userId: null } } : {}),
    });
    answer(!kept.created ? "already" : item.notCustom === true ? "dismissed" : "created", kept.id);
  }
  return { findings };
}

/** A narrow session (from the extension, no password) resolves nothing. */
function isNarrow(principal: HumanAuthPrincipal): boolean {
  return principal.narrowDeviceTokenId !== undefined || principal.clientProfile !== undefined;
}

/**
 * Who resolves a finding: the owner; the customs lead (the right «ведёт кастомы»); the check's leader of the finding's
 * page by the one rule (leaders.ts). Of the viewer's realm only.
 */
export function mayResolveFinding(viewer: CustomViewer, finding: { pageId: number | null }): boolean {
  if (!seesOrder({ ...viewer, lead: true }, finding)) return false;
  if (viewer.role === "owner" || viewer.lead) return true;
  return finding.pageId !== null && (viewer.leads?.check ?? []).includes(finding.pageId);
}

const resolvedAlready = () => new ConflictError("The finding is resolved already", { reason: "resolved" });

/**
 * `customFindingAct`: one answer to an open finding by whoever resolves it. A finding the viewer does not resolve reads
 * like one that does not exist. Each answer and the finding's resolution are one transaction.
 */
export async function actOnCustomFinding(
  app: FindingsApp,
  principal: AuthPrincipal,
  input: { findingId: string; body: CustomFindingActionBody },
  now: Date = new Date(),
): Promise<{ finding: CustomFinding }> {
  requireSessionUser(principal);
  const human = principal as HumanAuthPrincipal;
  const viewer = await customViewerOf(app, human);
  const id = Number(input.findingId);
  const seen = await findCustomFinding(app.db, id);
  if (seen === null || isNarrow(human) || !mayResolveFinding(viewer, seen)) throw new NotFoundError("The finding was not found");
  if (seen.status !== "open") throw resolvedAlready();
  const userId = human.user.id;
  const body = input.body;
  await app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const finding = (await findCustomFinding(db, id, { lock: true }))!;
    if (finding.status !== "open") throw resolvedAlready();
    const sale = finding.source === "sale" && /^[1-9]\d{0,18}$/.test(finding.ref) ? Number(finding.ref) : null;
    switch (body.action) {
      case "dismiss":
        await resolveCustomFinding(db, { id, status: "dismissed", orderId: null, dismissReason: body.reason, userId, at: now });
        return;
      case "record": {
        // The board's «Записать кастом», filled from the finding: its page and fan, else the ones the person gives.
        let pageId = finding.pageId;
        let pageLabel = finding.pageLabel;
        let fanId = finding.fanId;
        let buyer: string | null = null;
        let conversationRef: string | null = null;
        // A page the person names is always one they resolve findings of; it must be the finding's own when it has one.
        if (body.pageLabel !== undefined || pageId === null || pageLabel === null) {
          const page = body.pageLabel === undefined ? null : await findPageSummaryByLabel(db, body.pageLabel);
          if (!page || !mayResolveFinding(viewer, { pageId: page.id })) throw new NotFoundError(`Page "${body.pageLabel ?? ""}" was not found`);
          if (pageId !== null && page.id !== pageId) throw new ConflictError(`The finding is ${pageLabel}'s, not ${page.label}'s`, { reason: "other_page" });
          pageId = page.id;
          pageLabel = page.label;
        }
        if (fanId === null && body.fan !== undefined) {
          const found = await resolveFanOnPage(db, { pageLabel, fan: body.fan });
          fanId = found?.fanId ?? null;
          if (found?.platform === "onlyfans") conversationRef = found.fanRef;
          // A fan that matches no fan of the page stays the buyer's string, as on the board.
          if (found === null) buyer = body.fan.slice(0, 300);
        }
        const telegramRef = body.telegramRef === undefined ? null : parseTelegramRef(body.telegramRef);
        const orderId = await recordCustomOrder({ db }, {
          pageId, fanId, buyer, conversationRef, card: body.card, deadlineOn: null, acceptedByUserId: userId, origin: "workboard",
          paymentTransactionId: sale, telegramRefs: telegramRef === null ? [] : [telegramRef], actor: { door: "workboard", userId }, now,
        });
        await resolveCustomFinding(db, { id, status: "recorded", orderId, dismissReason: null, userId, at: now });
        return;
      }
      case "link": {
        const orderId = parseCustomOrderCode(body.code);
        const order = orderId === null ? null : await findCustomOrder(db, orderId);
        if (order === null || !seesOrder(viewer, order)) throw new NotFoundError("The custom order was not found");
        // A sale's finding pays the order it is linked to: the person's own step (it takes a sale off no other order).
        if (sale !== null) await applyCustomStep({ db }, { orderId: order.id, step: { action: "payment", transactionId: sale }, actor: { door: "workboard", userId }, viewer: null, now });
        await resolveCustomFinding(db, { id, status: "linked", orderId: order.id, dismissReason: null, userId, at: now });
        return;
      }
    }
  });
  return { finding: findingWire((await findCustomFinding(app.db, id))!) };
}
