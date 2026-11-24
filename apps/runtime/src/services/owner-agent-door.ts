import {
  OWNER_AGENT_OPERATION_SCHEMAS,
  OWNER_AGENT_REASON_HEADER,
  OWNER_AGENT_REASON_MAX,
  type AdminPersonResponse,
  type OwnerAgentOperation,
  type OwnerAgentPerson,
  type OwnerAgentResult,
} from "@agency_hub_core/contracts";
import {
  findPersonRowByCode,
  listActiveSaleDecisions,
  listHandinNames,
  listHandinPeopleOfUsers,
  listHandinSalesByIds,
  listLoginsByPersonCode,
  listPersonLoginRows,
  listSaleClaims,
  listTestPageIds,
  type Database,
  type SaleDecisionKind,
} from "@agency_hub_core/db";
import type { z } from "zod";

import type { AppContext } from "../bootstrap.ts";
import { principalOfLogin, recordAudit, type AuditContext, type HumanAuthPrincipal, type OwnerAgentPrincipal } from "./auth.ts";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "./errors.ts";
import { readPersonForOwner, updatePerson } from "./people/index.ts";
import { applySaleDecision, cancelSaleDecisionApplied, ownerAgentSettleBy } from "./sale-claims.ts";
import { closeSaleQuestionAsOwner, saleDecisionWire, saleDecisionWires } from "./sale-decisions-door.ts";
import { readStoredShiftReport, readStoredShiftReportVersions, readStoredShiftReports } from "./shift-handins.ts";

/**
 * The owner's agent door (payouts plan 2026-11-24, §1.8, H9): the owner's own agent acting AS the owner, on the
 * owner's word, with a reason on every call. Its key (`act:owner`, 0442) is issued by the server's CLI alone, names the
 * live owner it acts as, and reaches one route, `POST /api/v1/owner-agent/call` (`ownerAgentCall`); every other route
 * refuses it by its kind (auth.ts `OwnerAgentPrincipal`).
 *
 * THIS TABLE is every operation of the door, AND NOTHING ELSE: an operation that is not here is refused (403, deny by
 * default), and `OWNER_AGENT_NEVER` names what is never to be here (tests/owner-agent-door.test.ts: the two never
 * meet). Each row runs the owner's own service with `principalOfLogin(owner)` as the principal and the operator (the
 * key, its name, the owner, the reason) beside it: the history it writes names the key and the owner it acts for
 * (`ownerAgentSettleBy`), the audit names both. A read is a projection of what is stored: no check, no phase moved, no
 * take settled, nothing written but the call's own audit row.
 *
 * Every call, in this order (`callOwnerAgent`): (1) the key is an `act:owner` key of an active owner of the live realm
 * (auth.ts, the route's kind); (2) the reason (`x-hub-owner-reason`, 1 to 500 characters) — else 400 before anything;
 * (3) the operation is on the table — else 403; (4) the call is audited (`owner_agent.call`: op, key, reason) — a
 * failed audit fails the call before it runs; (5) the arguments by the operation's strict schema — else 400; (6) it runs.
 *
 * Adding a row: its arguments and answer in packages/contracts/src/owner-agent.ts (`OWNER_AGENT_OPERATION_SCHEMAS`), the
 * row here with the console operation it does the same as, its call in tests/owner-agent-door.integration.test.ts, and
 * its words in docs/agent-doors.md. Part 2 (H10) adds customs, matters, learn pages, swaps, decision links.
 */

/** Who acts and why: the key, its name, the owner it acts as, the owner's reason. Passed beside the owner's principal. */
export interface OwnerAgentOperator {
  agentKeyId: number;
  keyName: string;
  ownerUserId: number;
  reason: string;
}

type Args<K extends OwnerAgentOperation> = z.output<(typeof OWNER_AGENT_OPERATION_SCHEMAS)[K]["args"]>;
type OwnerApp = AppContext;

interface OwnerAgentRow<K extends OwnerAgentOperation> {
  /** The console's operation (a route key of `routeSchemas`) this one does the same as: what the NEVER test reads. */
  console: string;
  /** One line for `hub owner ops`. */
  summary: string;
  run(app: OwnerApp, owner: HumanAuthPrincipal, operator: OwnerAgentOperator, args: Args<K>, now: Date): Promise<OwnerAgentResult<K>>;
}

/**
 * What the door never has (§1.8 «Чего у двери нет», H9 «Никогда»): no console operation of these families and no field
 * of these in an operation's arguments. Keys, passwords, sessions, devices, invitations; erasure and deletion, the page
 * browser, sends and broadcasts; pay terms, where people are paid, transfers, prices, discounts; configs, prompts, the
 * pace, the master switches; signing for a chatter, the test wall; people's rights, logins, role, the owner's Telegram.
 */
export const OWNER_AGENT_NEVER = {
  operations: [
    /agentKey/i, /password/i, /session/i, /device/i, /invite/i, /accountLink/i, /signin/i, /sso/i,
    /erasure/i, /erase/i, /delete/i, /remove/i, /pageBrowser/i, /send/i, /outreach/i, /massMessage/i, /peopleMessage/i,
    /payTerm/i, /payout/i, /accountPay/i, /price/i, /discount/i, /transfer/i, /ledger/i,
    /config/i, /prompt/i, /persona/i, /pace/i, /switch/i,
    /sandbox/i, /submit/i, /confirm/i, /proposal/i, /rights/i,
  ],
  fields: [
    "rights", "logins", "agentKeys", "role", "telegram", "payTerms", "payoutDetails", "invite", "password",
    "priceMills", "payment", "paidWord", "leadModelSlugs", "capabilities",
  ],
} as const;

/** Whether a name (an operation of the door, or the console operation it maps to) is of what the door never has. */
export function ownerAgentNever(name: string): boolean {
  return OWNER_AGENT_NEVER.operations.some((pattern) => pattern.test(name));
}

const notFound = () => new NotFoundError("Not found");

async function livePageCheck(db: Database): Promise<(pageId: number | null) => boolean> {
  const test = new Set(await listTestPageIds(db));
  return (pageId) => pageId === null || !test.has(pageId);
}

/** A sale of the live agency, or 404 (one of the test realm answers as one that does not exist). */
async function liveSale(app: OwnerApp, transactionId: number) {
  const sale = (await listHandinSalesByIds(app.db, [transactionId]))[0];
  const live = await livePageCheck(app.db);
  if (sale === undefined || !live(sale.pageId)) throw notFound();
  return sale;
}

/** The door's decision kinds in Hub's words, and the shares checked as the ledger kept them. */
function decisionOf(kind: Args<"sale.decide">["kind"], shares: ReadonlyArray<{ person: string; percent: number }>): SaleDecisionKind {
  const refuse = (message: string) => new BadRequestError(message, { reason: "bad_decision" });
  if (kind === "exclude") {
    if (shares.length > 0) throw refuse("«Не считается никому» has no shares");
    return "nobody";
  }
  if (new Set(shares.map((share) => share.person)).size !== shares.length) throw refuse("A person is in the shares twice");
  if (shares.reduce((sum, share) => sum + share.percent, 0) !== 100) throw refuse("The shares make 100%");
  if (kind === "owner" && shares.length !== 1) throw refuse("owner: one share of 100%");
  if (kind === "split" && shares.length < 2) throw refuse("split: two shares or more; a sale of one person is owner");
  return "split";
}

/** The people the shares name: each a live person with a login. */
async function shareLogins(db: Database, shares: ReadonlyArray<{ person: string; percent: number }>) {
  const logins = await listLoginsByPersonCode(db, shares.map((share) => share.person));
  const unknown: string[] = [];
  for (const share of shares) {
    const row = await findPersonRowByCode(db, share.person);
    if (row === null || row.isTest || (logins.get(share.person) ?? []).length === 0) unknown.push(share.person);
  }
  if (unknown.length > 0) throw new BadRequestError(`No person with the code: ${unknown.join(", ")}`, { reason: "person_unknown" });
  return shares.map((share) => ({ userId: logins.get(share.person)![0]!, percent: share.percent }));
}

/** A person as the door reads them: a white list, field by field (never pay terms, payout details, keys, proposals). */
function ownerAgentPersonOf(detail: AdminPersonResponse): OwnerAgentPerson {
  const { person } = detail;
  return {
    code: person.code,
    displayName: person.displayName,
    kind: person.kind,
    role: person.role,
    state: person.state,
    leftOn: person.leftOn,
    telegram: person.telegram,
    logins: person.logins,
    workingPages: person.workingPages,
    schedule: person.schedule,
    pageSchedules: person.pageSchedules,
    scheduleSlots: detail.scheduleSlots,
    rights: person.rights,
    onboarding: person.onboarding,
    note: person.note,
    start: detail.start,
    updatedAt: person.updatedAt,
  };
}

const auditOf = (operator: OwnerAgentOperator): AuditContext => ({
  source: "owner_agent", actorUserId: operator.ownerUserId, actorAgentKeyId: operator.agentKeyId,
});

export const OWNER_AGENT_OPERATIONS: { [K in OwnerAgentOperation]: OwnerAgentRow<K> } = {
  // ── Отчёты смен: what is stored, read as it is ──
  "shiftReport.list": {
    console: "shiftReportsList",
    summary: "A person's shifts of a window (at most 62 Moscow days) with their stored reports: state, version, total.",
    run: (app, _owner, _operator, args) => readStoredShiftReports(app, args),
  },
  "shiftReport.show": {
    console: "shiftReport",
    summary: "A shift's stored report whole: the newest version, or the one named; never a draft, nothing recomputed.",
    run: (app, _owner, _operator, args) => readStoredShiftReport(app, args),
  },
  "shiftReport.versions": {
    console: "shiftReport",
    summary: "A shift's stored versions, newest first: who handed each in, its total, why the system made it.",
    run: (app, _owner, _operator, args) => readStoredShiftReportVersions(app, args),
  },

  // ── Продажа ──
  "sale.show": {
    console: "saleDispute",
    summary: "A sale: whose it is by the rule, every decision and every claim or question about it, an open dispute or not.",
    run: async (app, _owner, _operator, args) => {
      const sale = await liveSale(app, args.transactionId);
      const claims = (await listSaleClaims(app.db, { transactionIds: [sale.transactionId] })).reverse();
      const userIds = [
        ...(sale.home?.shares ?? []).map((share) => share.userId),
        ...claims.flatMap((claim) => [claim.claimantUserId, claim.sideUserId]),
      ].filter((id): id is number => id !== null);
      const people = await listHandinPeopleOfUsers(app.db, userIds);
      const names = await listHandinNames(app.db, userIds);
      const who = (userId: number | null) => (userId === null ? null : people.get(userId)?.code ?? names.get(userId) ?? `#${userId}`);
      return {
        sale: {
          transactionId: sale.transactionId,
          pageLabel: sale.pageLabel,
          platform: sale.platform,
          kind: sale.kind,
          occurredAt: sale.occurredAt.toISOString(),
          netMills: sale.netMills,
          fan: sale.fan,
          home: sale.home === null ? null : {
            home: sale.home.home,
            reason: sale.home.reason,
            pot: sale.home.pot,
            shares: sale.home.shares.map((share) => ({ person: who(share.userId), mills: share.mills })),
          },
        },
        decisions: await saleDecisionWires(app, sale.transactionId),
        claims: claims.map((claim) => ({
          id: claim.id,
          kind: claim.kind,
          state: claim.state,
          claimant: who(claim.claimantUserId),
          side: who(claim.sideUserId),
          statement: claim.statement,
          question: claim.question,
          claimedAt: claim.claimedAt.toISOString(),
          decisionId: claim.decisionId,
          closedAt: claim.closedAt?.toISOString() ?? null,
        })),
        openDispute: claims.some((claim) => claim.state === "owner" || claim.state === "asked"),
      };
    },
  },
  "sale.decide": {
    console: "saleDisputeDecide",
    summary: "Decide whose a known sale is (owner, split, exclude) as the owner, with why. A sale with an open dispute: decide"
      + " the dispute in Workboard (409). A sale with an active decision: name it in supersedes.",
    run: async (app, _owner, operator, args, now) => {
      const sale = await liveSale(app, args.transactionId);
      const kind = decisionOf(args.kind, args.shares);
      const shares = kind === "nobody" ? [] : await shareLogins(app.db, args.shares);
      const transactionId = sale.transactionId;
      const applied = await applySaleDecision(app, {
        transactionId,
        insert: {
          kind, shares, pot: null, outcome: "said", note: args.note, decidedByUserId: operator.ownerUserId, decidedAt: now,
          saidBy: null, source: "agent", ledgerDecisionId: null, ledgerRef: null, agentKeyId: operator.agentKeyId,
        },
        // Read in the decision's own transaction, in the settlements' turn: what it may decide.
        first: async (txDb) => {
          const open = await listSaleClaims(txDb, { transactionIds: [transactionId], states: ["owner", "asked"] });
          if (open.length > 0) {
            throw new ConflictError("У продажи открытый спор: решите спор в Workboard", { reason: "open_dispute" });
          }
          const active = (await listActiveSaleDecisions(txDb, [transactionId])).get(transactionId) ?? null;
          if (active !== null && args.supersedes !== active.id) {
            throw new ConflictError(`The sale has an active decision ${active.id}: name it in supersedes`, { reason: "decision_exists" });
          }
          if (active === null && args.supersedes !== undefined) {
            throw new ConflictError("The decision it replaces is not active", { reason: "not_active" });
          }
          // The sale's own active decision is superseded by the write itself.
          return {};
        },
        madeFor: (decisionId) => ({ kind: "decision", decisionId: decisionId ?? 0, transactionId, outcome: "said" }),
        by: ownerAgentSettleBy(operator),
      }, sale, now);
      const decision = applied.decisionId === null ? null : await saleDecisionWire(app, applied.decisionId);
      if (decision === null) throw new ConflictError("The decision was not written", { reason: "not_written" });
      return { decision, versions: applied.versions.map((one) => ({ shiftId: one.shiftId, version: one.version })) };
    },
  },
  "sale.cancel": {
    console: "saleDisputeDecide",
    summary: "Cancel an active decision, with why: the reports it settled get a new version with what rules now.",
    run: async (app, _owner, operator, args, now) => {
      const live = await livePageCheck(app.db);
      const cancelled = await cancelSaleDecisionApplied(app, {
        decisionId: args.decisionId,
        note: args.note,
        check: async (decision) => {
          if (decision === null || !live(decision.pageId)) throw notFound();
          return decision;
        },
        by: ownerAgentSettleBy(operator),
      }, now);
      const decision = await saleDecisionWire(app, args.decisionId);
      if (decision === null) throw notFound();
      return { decision, versions: cancelled.versions.map((one) => ({ shiftId: one.shiftId, version: one.version })) };
    },
  },
  "sale.close": {
    console: "saleDisputeDecide",
    summary: "Close an open sale question without a decision, with why (once: a closed one is 409).",
    run: (app, _owner, _operator, args, now) => closeSaleQuestionAsOwner(app, args, now),
  },

  // ── Человек ──
  "people.show": {
    console: "adminPerson",
    summary: "A person: who, logins, pages, schedule, rights, onboarding, the owner's note. Never pay terms or payout details.",
    run: async (app, owner, _operator, args, now) => ({ person: ownerAgentPersonOf(await readPersonForOwner(app, args.code, now, owner)) }),
  },
  "people.edit": {
    console: "adminPersonUpdate",
    summary: "Change a person's name, note, onboarding, schedule, working pages, state or day left. People only; the working"
      + " pages of a person with a content manager's login are the owner's own (409).",
    run: async (app, owner, operator, args, now) => {
      const { code, ...fields } = args;
      const row = await findPersonRowByCode(app.db, code);
      if (row === null || row.isTest) throw new NotFoundError(`No person «${code}»`);
      if (row.kind !== "human") throw new ConflictError(`«${code}» is not a person: the door changes people only`, { reason: "not_human" });
      if (fields.workingPageLabels !== undefined) {
        // A content manager's working pages open ContentOps' pages of their models (person-door.ts): the owner's own word.
        const logins = await listPersonLoginRows(app.db, [row.id]);
        if (logins.some((login) => login.role === "content_manager")) {
          throw new ConflictError(
            `«${code}» has a content manager's login: their working pages open ContentOps, the owner sets them himself`,
            { reason: "content_manager_pages" },
          );
        }
      }
      const detail = await updatePerson(app, code, fields, auditOf(operator), now, owner);
      return { person: ownerAgentPersonOf(detail) };
    },
  },
};

/** The reason as the header carries it: percent-encoded UTF-8, 1 to 500 characters after trimming; else 400. */
export function ownerReasonOf(header: unknown): string {
  const refuse = (why: string) => new BadRequestError(`${OWNER_AGENT_REASON_HEADER}: ${why}`, { reason: "owner_reason" });
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") throw refuse("required: why the owner asks for this, in a line (no fan's name)");
  let text: string;
  try {
    text = decodeURIComponent(raw);
  } catch {
    throw refuse("not percent-encoded UTF-8");
  }
  const reason = text.trim();
  if (reason.length === 0) throw refuse("required: why the owner asks for this, in a line (no fan's name)");
  if ([...reason].length > OWNER_AGENT_REASON_MAX) throw refuse(`at most ${OWNER_AGENT_REASON_MAX} characters`);
  return reason;
}

function rowOf(op: string): OwnerAgentRow<OwnerAgentOperation> | null {
  if (!Object.hasOwn(OWNER_AGENT_OPERATIONS, op) || ownerAgentNever(op)) return null;
  return OWNER_AGENT_OPERATIONS[op as OwnerAgentOperation] as unknown as OwnerAgentRow<OwnerAgentOperation>;
}

/** One call of the door, in the order its header names. */
export async function callOwnerAgent(
  app: OwnerApp,
  principal: OwnerAgentPrincipal,
  input: { reasonHeader: unknown; op: string; args: unknown },
  now: Date = new Date(),
): Promise<{ op: string; result: unknown; serverNow: string }> {
  // (2) The reason, before anything else.
  const reason = ownerReasonOf(input.reasonHeader);
  // (3) The operation: on the table, or refused.
  const row = rowOf(input.op);
  if (row === null) throw new ForbiddenError("Not an operation of the owner's agent door");
  const op = input.op as OwnerAgentOperation;
  const operator: OwnerAgentOperator = { agentKeyId: principal.agentKeyId, keyName: principal.keyName, ownerUserId: principal.ownerUserId, reason };
  // (4) The audit, before the operation runs: a call that cannot be recorded does not happen.
  await recordAudit(app, {
    ...auditOf(operator),
    eventType: "owner_agent.call",
    targetUserId: null,
    metadata: { op, keyName: operator.keyName, reason },
  });
  // (5) The arguments, by the operation's own strict schema.
  const schemas = OWNER_AGENT_OPERATION_SCHEMAS[op];
  const parsed = schemas.args.safeParse(input.args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.map(String).join(".") || "args"}: ${issue.message}`);
    throw new BadRequestError(`${op}: ${issues.join("; ")}`, { reason: "owner_agent_args" });
  }
  // (6) As the owner: the same principal a session of his would be, re-read now.
  const owner = await principalOfLogin(app, principal.ownerUserId);
  if (owner === null || owner.user.role !== "owner" || owner.sandbox?.test === true) {
    throw new UnauthorizedError("The owner this key acts as is not an active owner", { reason: null });
  }
  const result = await row.run(app, owner, operator, parsed.data as never, now);
  return { op, result: schemas.result.parse(result), serverNow: now.toISOString() };
}
