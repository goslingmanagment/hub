import { z } from "zod";

import {
  agentSaleRequestSchema,
  customOrderCode,
  isoDateTime,
  parseCustomOrderCode,
  STEP_FROM,
  type AgentSaleRequest,
} from "@agency_hub_core/contracts";
import {
  findCustomOrder,
  findCustomTakerOnPage,
  findPageFanByInput,
  listAdminPages,
  listObjectEvents,
  type CustomOrderRow,
  type CustomOrderStateRow,
} from "@agency_hub_core/db";
import { formatUsdFromMills } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { AppError, ConflictError } from "../errors.ts";
import { fillTakerOf, linkNamedSales } from "./agent.ts";
import { giveByMessage } from "./deliveries.ts";
import { checkGivenMessage, checkNamedSales, type EvidenceScope } from "./evidence.ts";
import { applyCustomStep, type CustomActor } from "./index.ts";

/**
 * Заказ кастома, the one-off backfill of the orders that were open before the facts (customs facts spec §14): what
 * the audit of every live order found — the fan and the page of an order that has neither, the agreed price, the
 * sales that paid it, the message that gave it to the fan or a person's word with its day — applied through
 * `applyCustomStep` with the doors' own checks (evidence.ts). The backfill is the system's door with the owner's
 * authority: every page of the live agency is its scope, and it may write «отдан» by a person's word (the agent may
 * not). In this order: the fan, the price, the taker («принял»: a login working on the order's page, only while the
 * order names none), the sales, «отдан». Without `apply` nothing is written: each order says
 * what would be done and what evidence is missing or refused. With it the same again changes nothing, and what a
 * person took off an order (`custom_order_rejections`, a «не отдан») is not applied again. It never closes an order:
 * the checks pass closes it 72 hours after the mark. The file is prepared outside the repository.
 */

type BackfillApp = Pick<AppContext, "db">;

/** The platform's number of a fan or a message, as the agent door takes it. */
const ref = z.string().trim().min(1).max(64).regex(/^[1-9]\d{0,29}$/);

const entrySchema = z.object({
  /** The order's page and its fan by the platform's id: only for an order that names no fan (the agent's step `fan`). */
  pageLabel: z.string().trim().min(1).max(120).optional(),
  fanRef: ref.optional(),
  /** The agreed total, gross. */
  priceMills: z.number().int().positive().max(1_000_000_000).optional(),
  /** «Принял»: the login of the chatter who took it (source `backfill`): only an order with none, one working on its page. */
  acceptedBy: z.string().trim().min(1).max(64).optional(),
  /** The sales that paid it, as the agent door names a sale. */
  sales: z.array(agentSaleRequestSchema).min(1).max(20).optional(),
  /** The page's message that carried the order to its fan. */
  givenMessageRef: ref.optional(),
  /** A person's word that the fan has it: when, and whose word where. */
  givenByWord: z.object({ at: isoDateTime({ offset: true }), note: z.string().trim().min(1).max(500) }).strict().optional(),
}).strict()
  .refine((entry) => (entry.pageLabel === undefined) === (entry.fanRef === undefined), "pageLabel and fanRef come together")
  .refine((entry) => entry.givenMessageRef === undefined || entry.givenByWord === undefined, "givenMessageRef or givenByWord, not both");

export const customOrdersBackfillFileSchema = z.object({
  version: z.literal(1),
  /** One entry per order, by its code. */
  orders: z.record(z.string().regex(/^K-\d{1,12}$/), entrySchema),
}).strict();

export type CustomOrdersBackfillFile = z.infer<typeof customOrdersBackfillFileSchema>;
type Entry = z.infer<typeof entrySchema>;

/** One thing the file names for an order and what became of it. */
export interface CustomBackfillLine {
  what: "order" | "fan" | "price" | "taker" | "sale" | "given";
  /** What it names, as the file names it. */
  subject: string;
  /** would — a dry run would do it; done — done now; already — the order holds it; refused — not done (`reason`). */
  outcome: "would" | "done" | "already" | "refused";
  reason: string | null;
}

export interface CustomBackfillRow {
  code: string;
  /** The order's state before the backfill; null — no such order. */
  state: CustomOrderStateRow | null;
  lines: CustomBackfillLine[];
}

const SYSTEM: CustomActor = { door: "system" };
const ENDED_GIVEN: readonly CustomOrderStateRow[] = ["given", "closed"];

const saleSubject = (sale: AgentSaleRequest) => ("saleRef" in sale ? `sale ${sale.saleRef}` : `sale ${sale.pageLabel}:${sale.transactionRef}`);

/** Why a check refused: its reason, or the plane's 404 as `not_found`. */
function reasonOf(error: unknown): string {
  if (error instanceof ConflictError) return error.reason ?? "conflict";
  if (error instanceof AppError && error.statusCode === 404) return "not_found";
  throw error;
}

/** The backfill's scope: every page of the live agency, with its model. */
async function scopeOf(app: BackfillApp): Promise<EvidenceScope> {
  const pages = await listAdminPages(app.db);
  return { pages: pages.map((page) => ({ id: page.id, pageLabel: page.label, platform: page.platform, modelSlug: page.modelSlug })) };
}

/** Whether a person (or anyone) once took «отдан» off the order: a word is then not applied to it again. */
async function wasUngiven(app: BackfillApp, orderId: number): Promise<boolean> {
  const events = await listObjectEvents(app.db, { objectType: "custom_order", objectId: String(orderId), limit: 1000 });
  return events.some((event) => event.event === "custom_order.ungiven");
}

/**
 * The file's entries against the orders, in the file's order. `apply` false writes nothing; true applies what holds,
 * step by step, each in its own transaction (a step refused leaves the ones before it in place).
 */
export async function runCustomOrdersBackfill(
  app: BackfillApp,
  file: CustomOrdersBackfillFile,
  input: { apply: boolean; now?: Date },
): Promise<CustomBackfillRow[]> {
  const scope = await scopeOf(app);
  const rows: CustomBackfillRow[] = [];
  for (const [code, entry] of Object.entries(file.orders)) {
    rows.push(await backfillOrder(app, scope, code, entry, input.apply, input.now ?? new Date()));
  }
  return rows;
}

async function backfillOrder(app: BackfillApp, scope: EvidenceScope, code: string, entry: Entry, apply: boolean, now: Date): Promise<CustomBackfillRow> {
  const id = parseCustomOrderCode(code);
  const found = id === null ? null : await findCustomOrder(app.db, id);
  const keyPages = new Set(scope.pages.map((page) => page.id));
  // An order of the test realm, or of a page gone from the agency, is none of the backfill's.
  if (found === null || (found.pageId !== null && !keyPages.has(found.pageId))) {
    return { code, state: null, lines: [{ what: "order", subject: code, outcome: "refused", reason: "not_found" }] };
  }
  const lines: CustomBackfillLine[] = [];
  const line = (what: CustomBackfillLine["what"], subject: string, outcome: CustomBackfillLine["outcome"], reason: string | null = null) => {
    lines.push({ what, subject, outcome, reason });
  };
  /** One step applied under the order's lock: whether it changed anything, or why the step refused it there. */
  const step = async (stepInput: Parameters<typeof applyCustomStep>[1]["step"]): Promise<"done" | "already" | { refused: string }> => {
    try {
      return (await applyCustomStep(app, { orderId: found.id, step: stepInput, actor: SYSTEM, viewer: null, now })) ? "done" : "already";
    } catch (error) {
      return { refused: reasonOf(error) };
    }
  };
  /** A step's answer as the order's line. */
  const applied = (what: CustomBackfillLine["what"], subject: string, result: Awaited<ReturnType<typeof step>>) => {
    if (typeof result === "string") line(what, subject, result);
    else line(what, subject, "refused", result.refused);
  };
  const reread = async () => (await findCustomOrder(app.db, found.id))!;
  /** The order as the next step sees it: re-read after a step applied, as it would be after one a dry run only plans. */
  let order: CustomOrderRow = found;

  // 1. The fan and the page, for an order that names no fan: the agent's step `fan` (spec §11).
  if (entry.pageLabel !== undefined && entry.fanRef !== undefined) {
    const subject = `${entry.pageLabel} fan ${entry.fanRef}`;
    const page = scope.pages.find((candidate) => candidate.pageLabel === entry.pageLabel);
    const fan = page === undefined ? null
      : await findPageFanByInput(app.db, { pageId: page.id, platform: page.platform, platformUserId: entry.fanRef, username: null });
    if (page === undefined) line("fan", subject, "refused", "page_unknown");
    else if (fan === null) line("fan", subject, "refused", "fan_unknown");
    else if (order.fanId === fan.fanId && order.pageId === page.id) line("fan", subject, "already");
    else if (order.fanId !== null || order.fanErasedAt !== null) line("fan", subject, "refused", "fan_known");
    else if (order.pageId !== null && order.pageId !== page.id) line("fan", subject, "refused", "other_page");
    else if (!STEP_FROM.fan.includes(order.state)) line("fan", subject, "refused", "not_allowed");
    else {
      const conversationRef = page.platform === "onlyfans" ? fan.platformUserId : null;
      if (apply) {
        applied("fan", subject, await step({ action: "fan", pageId: page.id, fanId: fan.fanId, conversationRef, by: "agent" }));
        order = await reread();
      } else {
        order = { ...order, pageId: page.id, pageLabel: page.pageLabel, platform: page.platform, modelSlug: page.modelSlug, fanId: fan.fanId, conversationRef };
        line("fan", subject, "would");
      }
    }
  }

  // 2. The agreed price, as the agent's edit: a price a person set is theirs and stays.
  if (entry.priceMills !== undefined) {
    const subject = `price ${formatUsdFromMills(entry.priceMills)}`;
    if (order.priceMills === entry.priceMills) line("price", subject, "already");
    else if (order.personFields.includes("priceMills")) line("price", subject, "refused", "edited_by_person");
    else if (!STEP_FROM.edit.includes(order.state)) line("price", subject, "refused", "not_allowed");
    else if (apply) {
      applied("price", subject, await step({ action: "edit", priceMills: entry.priceMills, by: "agent" }));
      order = await reread();
    } else {
      order = { ...order, priceMills: entry.priceMills };
      line("price", subject, "would");
    }
  }

  // 3. The taker, by the step `accepted_by` (source backfill): it fills only an order that names none — before the sales,
  // whose one home would otherwise name it.
  if (entry.acceptedBy !== undefined) {
    const subject = `taker ${entry.acceptedBy}`;
    const taker = order.pageId === null ? null : await findCustomTakerOnPage(app.db, { pageId: order.pageId, login: entry.acceptedBy });
    if (taker === null) line("taker", subject, "refused", "taker_unknown");
    else if (order.acceptedByUserId === taker.userId) line("taker", subject, "already");
    else if (order.acceptedByUserId !== null) line("taker", subject, "refused", "taker_set");
    else if (order.personFields.includes("acceptedBy")) line("taker", subject, "refused", "person_set");
    else if (apply) {
      const filled = await fillTakerOf(app, { orderId: order.id, taker, source: "backfill", actor: SYSTEM, now });
      line("taker", subject, filled.changed ? "done" : filled.outcome.reason === null ? "already" : "refused", filled.outcome.reason);
      order = await reread();
    } else {
      order = { ...order, acceptedByUserId: taker.userId };
      line("taker", subject, "would");
    }
  }

  // 4. The sales, each checked as the agent's (spec §5) and linked by the payment step; one that does not hold is answered.
  if (entry.sales !== undefined) {
    if (apply) {
      const linked = await linkNamedSales(app, { pages: scope.pages, money: true }, order.id, entry.sales, SYSTEM, now);
      for (const one of linked.outcomes) {
        line("sale", saleSubject(one.sale), one.result === "linked" ? "done" : one.result, one.reason);
      }
      order = await reread();
    } else {
      const checked = await checkNamedSales(app.db, scope, order, entry.sales, true);
      for (const one of checked) {
        if (one.verdict === "already") line("sale", saleSubject(one.sale), "already");
        else if (one.verdict !== "ok") line("sale", saleSubject(one.sale), "refused", one.verdict);
        else if (!STEP_FROM.payment.includes(order.state)) line("sale", saleSubject(one.sale), "refused", "not_allowed");
        else line("sale", saleSubject(one.sale), "would");
      }
    }
  }

  // 5. «Отдан»: by the page's message, checked as the agent's (spec §6); or by a person's word, the owner's authority.
  if (entry.givenMessageRef !== undefined) {
    const messageRef = entry.givenMessageRef;
    const subject = `given by message ${messageRef}`;
    if (ENDED_GIVEN.includes(order.state)) {
      line("given", subject, order.givenMessageRef === messageRef ? "already" : "refused", order.givenMessageRef === messageRef ? null : "given_otherwise");
    } else if (!STEP_FROM.given.includes(order.state)) {
      line("given", subject, "refused", "not_allowed");
    } else {
      const checked = await checkGivenMessage(app.db, scope, order, messageRef).then((value) => value, (error: unknown) => reasonOf(error));
      if (typeof checked === "string") line("given", subject, "refused", checked);
      else if (apply) {
        // «Отдан» and the message's purchase as the order's payment, in one transaction, on the order as it was checked.
        const current = await reread();
        const done = await giveByMessage(app, {
          orderId: found.id, messageRef, at: checked.at, purchaseIds: checked.purchaseIds, states: STEP_FROM.given, version: current.version, actor: SYSTEM, now,
        }).then((value) => value, (error: unknown) => reasonOf(error));
        if (typeof done === "string") line("given", subject, "refused", done);
        else if (done === null) line("given", subject, "refused", "version_changed");
        else line("given", subject, done.given ? "done" : "already");
      } else {
        line("given", subject, "would");
      }
    }
  } else if (entry.givenByWord !== undefined) {
    const at = new Date(entry.givenByWord.at);
    const subject = `given by word ${entry.givenByWord.at}`;
    if (ENDED_GIVEN.includes(order.state)) line("given", subject, "already");
    else if (!STEP_FROM.given.includes(order.state)) line("given", subject, "refused", "not_allowed");
    else if (at.getTime() > now.getTime()) line("given", subject, "refused", "in_future");
    // A person took «отдан» off it once: a word from before is not put back by the backfill.
    else if (await wasUngiven(app, order.id)) line("given", subject, "refused", "ungiven_before");
    else if (apply) {
      applied("given", subject, await step({ action: "given", messageRef: null, at, note: entry.givenByWord.note }));
    } else {
      line("given", subject, "would");
    }
  }

  return { code: customOrderCode(found.id), state: found.state, lines };
}
