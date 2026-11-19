import { z } from "zod";

import type { OfLinkContractorPaid, OfLinkPayment } from "@agency_hub_core/contracts";
import { trafficLedgerNameKey } from "@agency_hub_core/db";

import { ServiceUnavailableError } from "./errors.ts";
import { ledgerGet, ledgerShapeIssues, list, micros, payMillsOf, type LedgerReadApp } from "./ledger-payouts.ts";

/**
 * What is paid to a traffic contractor («Трафик → Источники»): the ledger's journal keeps the money; Hub reads it by
 * the contractor's names in the journal (`traffic_contractors.ledger_names`, 0428), never stores or recomputes it.
 * One GET of the ledger for all the names asked; each row goes back to its contractor by its «Кому/Откуда»
 * (`counterparty`, trimmed, case aside). A name two contractors share belongs to neither.
 *
 * The sum: an expense adds, an income (a refund from the contractor) subtracts; a pending row is listed, not summed;
 * only USD, USDT and USDC count as dollars (1:1) — a row in another currency is listed, not summed, and flags the
 * figure. Three states, never a zero in place of an unknown: known (may be 0), unknown no_ledger_names, unknown
 * ledger_unavailable (no answer, 403/404, a truncated list, a shape Hub does not know).
 */

const LEDGER_CLIENT = "traffic-payments";
const DOLLARS = new Set(["USD", "USDT", "USDC"]);

const ledgerPaymentsSchema = z.object({
  generatedAt: z.string(),
  truncated: z.boolean(),
  payments: list(z.object({
    num: z.union([z.number().int(), z.string()]),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    type: z.enum(["expense", "income"]),
    category: z.string().nullish(),
    counterparty: z.string(),
    model: z.string().nullish(),
    amountMicros: micros,
    currency: z.string(),
    status: z.enum(["paid", "pending"]),
    note: z.string().nullish(),
  })),
});

export type LedgerPayment = z.output<typeof ledgerPaymentsSchema>["payments"][number];

/** The ledger's answer: its rows, or no usable answer. */
export type LedgerPaymentsAnswer =
  | { state: "answered"; payments: LedgerPayment[] }
  | { state: "unavailable" };

/** Reads the journal's rows of these counterparty names (one request). Never throws for the ledger's sake. */
export type LedgerPaymentsReader = (names: readonly string[]) => Promise<LedgerPaymentsAnswer>;

export function ledgerPaymentsReader(app: LedgerReadApp, options: { fetchImpl?: typeof fetch } = {}): LedgerPaymentsReader {
  return async (names) => {
    if (names.length === 0) return { state: "answered", payments: [] };
    let body: unknown;
    try {
      body = await ledgerGet(app, "/v1/payouts/counterparty-payments", { name: [...names] }, {
        client: LEDGER_CLIENT,
        absentOn: [403, 404],
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
    } catch (error) {
      if (error instanceof ServiceUnavailableError) {
        app.logger.warn({ reason: error.message }, "traffic payments: the ledger did not answer");
        return { state: "unavailable" };
      }
      throw error;
    }
    if (body === undefined) return { state: "unavailable" };
    const parsed = ledgerPaymentsSchema.safeParse(body);
    if (!parsed.success) {
      app.logger.warn({ issues: ledgerShapeIssues(parsed.error) }, "traffic payments: unexpected answer");
      return { state: "unavailable" };
    }
    // A cut list would be a smaller sum served as the whole.
    if (parsed.data.truncated) return { state: "unavailable" };
    return { state: "answered", payments: parsed.data.payments };
  };
}

export interface TrafficContractorNames {
  key: string;
  title: string;
  ledgerNames: readonly string[];
}

export interface ContractorPayments {
  paid: OfLinkContractorPaid;
  /** The contractor's rows, newest first; [] when unknown. */
  payments: OfLinkPayment[];
}

/** Each contractor's names Hub may ask by: those no other contractor has. */
export function askableLedgerNames(contractors: readonly TrafficContractorNames[]): Map<string, string[]> {
  const owners = new Map<string, Set<string>>();
  for (const contractor of contractors) {
    for (const name of contractor.ledgerNames) {
      const key = trafficLedgerNameKey(name);
      if (key === "") continue;
      owners.set(key, (owners.get(key) ?? new Set()).add(contractor.key));
    }
  }
  const askable = new Map<string, string[]>();
  for (const contractor of contractors) {
    const names = contractor.ledgerNames.filter((name) => owners.get(trafficLedgerNameKey(name))?.size === 1);
    askable.set(contractor.key, names);
  }
  return askable;
}

const unknown = (reason: "no_ledger_names" | "ledger_unavailable", shared: boolean): OfLinkContractorPaid => ({
  status: "unknown", reason, paidMills: null, paymentCount: null, lastPaymentDate: null, shared, otherCurrency: false,
});

/**
 * The paid state and rows of each asked contractor, from the ledger's answer. `contractors` is every contractor
 * Hub has (a name shared with any of them is nobody's); `asked` the keys wanted; `sourcesOf` how many sources each
 * contractor has had a term on, over all time. Pure.
 */
export function contractorPayments(input: {
  contractors: readonly TrafficContractorNames[];
  asked: readonly string[];
  sourcesOf: ReadonlyMap<string, number>;
  answer: LedgerPaymentsAnswer;
}): Map<string, ContractorPayments> {
  const askable = askableLedgerNames(input.contractors);
  const ownerOf = new Map<string, string>();
  for (const [contractorKey, names] of askable) {
    for (const name of names) ownerOf.set(trafficLedgerNameKey(name), contractorKey);
  }
  const titles = new Map(input.contractors.map((contractor) => [contractor.key, contractor.title]));
  const out = new Map<string, ContractorPayments>();
  for (const key of input.asked) {
    const shared = (input.sourcesOf.get(key) ?? 0) > 1;
    if ((askable.get(key) ?? []).length === 0) {
      out.set(key, { paid: unknown("no_ledger_names", shared), payments: [] });
      continue;
    }
    if (input.answer.state !== "answered") {
      out.set(key, { paid: unknown("ledger_unavailable", shared), payments: [] });
      continue;
    }
    const payments: OfLinkPayment[] = input.answer.payments
      .filter((row) => ownerOf.get(trafficLedgerNameKey(row.counterparty)) === key)
      .map((row) => {
        const currency = row.currency.trim().toUpperCase();
        const magnitude = payMillsOf(Math.abs(row.amountMicros));
        return {
          contractorKey: key,
          contractorTitle: titles.get(key) ?? key,
          num: String(row.num),
          date: row.date,
          type: row.type,
          status: row.status,
          currency,
          amountMills: row.type === "income" ? -magnitude : magnitude,
          summed: row.status === "paid" && DOLLARS.has(currency),
          note: row.note?.trim() || null,
        };
      })
      .sort((left, right) => right.date.localeCompare(left.date) || right.num.localeCompare(left.num, "en", { numeric: true }));
    const paidRows = payments.filter((row) => row.status === "paid");
    out.set(key, {
      paid: {
        status: "known",
        reason: null,
        paidMills: payments.reduce((sum, row) => sum + (row.summed ? row.amountMills : 0), 0),
        paymentCount: paidRows.length,
        lastPaymentDate: paidRows[0]?.date ?? null,
        shared,
        otherCurrency: payments.some((row) => !DOLLARS.has(row.currency)),
      },
      payments,
    });
  }
  return out;
}
