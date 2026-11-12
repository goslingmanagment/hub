import { readFile } from "node:fs/promises";

import { InvalidArgumentError, type Command } from "commander";

import { createDb, createPool, readSaleRuleSwitch, setSaleRuleSwitch } from "@agency_hub_core/db";

import { createAppContext } from "../bootstrap.ts";
import { NO_SLOTS, refreshSaleHomes, registrySlots, type SaleSlotProvider } from "./sale-homes.ts";
import { formatSaleRuleComparison, ledgerCli, runSaleRuleComparison } from "./sale-rule-compare.ts";
import { RULE_WEEKDAYS, type RuleSlot, type RuleWeekday } from "./sale-rule.ts";
import { syncShiftRowsSince } from "./shift-rows.ts";

/**
 * The one rule of whose a sale is and the shift rows, from a terminal:
 *  - `sale-rule:compare` — read-only on both sides: Hub's homes by the rule against the ledger's `fact_homes`, Gengar's
 *    layouts and the posted reports (sale-rule-compare.ts). It forces its own session read-only and refuses to run
 *    if the database does not say so.
 *  - `sale-homes:refresh`, `shifts:sync` — write Hub's own shadow tables (`sale_homes`, `shifts`), as their jobs do.
 *  - `sale-rule:switch` — the screens' switch to the rule (off until the owner's date).
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function parseDay(value: string): string {
  if (!DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new InvalidArgumentError("a Moscow day, YYYY-MM-DD");
  return value;
}

function parseDays(value: string): number {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 62) throw new InvalidArgumentError("1 to 62 days");
  return days;
}

const mskStart = (day: string) => new Date(`${day}T00:00:00+03:00`);

/** A slots file's RuleSlot[]; a slot without `weekdays` runs every day (files written before the registry). */
export function slotsOfFile(value: unknown): RuleSlot[] {
  if (!Array.isArray(value)) throw new Error("--slots: a JSON array of slots");
  const days: ReadonlySet<string> = new Set(RULE_WEEKDAYS);
  return value.map((one: Partial<RuleSlot> & { weekdays?: unknown }, at): RuleSlot => {
    if (typeof one.personId !== "number" || typeof one.startMinute !== "number" || typeof one.endMinute !== "number") {
      throw new Error(`--slots: slot ${at} needs personId, startMinute, endMinute`);
    }
    const weekdays = one.weekdays ?? null;
    if (weekdays !== null && !(Array.isArray(weekdays) && weekdays.every((day) => days.has(String(day))))) {
      throw new Error(`--slots: slot ${at} has weekdays other than ${RULE_WEEKDAYS.join(", ")}`);
    }
    return {
      personId: one.personId, pageId: one.pageId ?? null, startMinute: one.startMinute, endMinute: one.endMinute,
      weekdays: weekdays as RuleWeekday[] | null, validFrom: one.validFrom ?? null, validTo: one.validTo ?? null,
    };
  });
}

/** A connection string whose every session is read-only, whatever the string already sets. */
export function readOnlyConnectionString(url: string): string {
  const parsed = new URL(url);
  const options = parsed.searchParams.get("options");
  parsed.searchParams.set("options", `${options === null ? "" : `${options} `}-c default_transaction_read_only=on`);
  return parsed.toString();
}

export function registerSaleRuleCommands(program: Command): void {
  program
    .command("sale-rule:compare")
    .description("Whose each sale is: Hub's rule against the ledger's fact_homes, Gengar's layouts and the posts (read-only)")
    .requiredOption("--from <day>", "first Moscow day, YYYY-MM-DD", parseDay)
    .option("--to <day>", "last Moscow day, YYYY-MM-DD (default: --from)", parseDay)
    .requiredOption("--ledger-bin <path>", "the ledger CLI: `ledger sql --json`, SELECT only, its own credentials")
    .option(
      "--slots <registry|none|file>",
      "the people's schedule slots: registry (the people registry, as the job), none, or a JSON file of sale-rule.ts RuleSlot[]",
      "registry",
    )
    .option("--json", "the whole comparison as JSON")
    .action(async (options) => {
      const url = process.env.DATABASE_URL;
      if (url === undefined || url === "") throw new Error("DATABASE_URL is not set");
      const first = options.from as string;
      const last = (options.to as string | undefined) ?? first;
      if (last < first) throw new Error("--to is before --from");
      const given = String(options.slots);
      const fromFile = given === "registry" || given === "none" ? null : slotsOfFile(JSON.parse(await readFile(given, "utf8")));
      const pool = createPool(readOnlyConnectionString(url), { applicationName: "hub-sale-rule-compare" });
      try {
        const db = createDb(pool);
        const check = await pool.query<{ default_transaction_read_only: string }>("show default_transaction_read_only");
        if (check.rows[0]?.default_transaction_read_only !== "on") throw new Error("the session is not read-only: refusing to run");
        const slots: SaleSlotProvider = fromFile !== null ? { slotsFor: async () => fromFile } : given === "registry" ? registrySlots(db) : NO_SLOTS;
        const slotsSource = fromFile !== null ? "file" : given === "registry" ? "registry" : "none";
        const report = await runSaleRuleComparison(db, { first, last, now: new Date(), ledger: ledgerCli(String(options.ledgerBin)), slots, slotsSource });
        console.log(options.json ? JSON.stringify(report, null, 2) : formatSaleRuleComparison(report));
      } finally {
        await pool.end();
      }
    });

  program
    .command("sale-homes:refresh")
    .description("Recompute whose each sale of the Moscow days is (sale_homes) by the people registry's slots, as the hourly job does for two weeks")
    .requiredOption("--from <day>", "first Moscow day, YYYY-MM-DD", parseDay)
    .option("--to <day>", "last Moscow day, YYYY-MM-DD (default: today)", parseDay)
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const now = new Date();
        const to = options.to === undefined ? now : new Date(Math.min(now.getTime(), mskStart(String(options.to)).getTime() + DAY_MS));
        const result = await refreshSaleHomes(app.db, { from: mskStart(String(options.from)), to, now });
        console.log(`sale homes: ${result.sales} sales, ${result.written} rows written`);
      } finally {
        await app.close();
      }
    });

  program
    .command("shifts:sync")
    .description("Write everyone's shifts of the last days as rows with a stable id (shifts), as the job does for two days")
    .option("--days <n>", "how many days back", parseDays, 14)
    .action(async (options) => {
      const app = await createAppContext();
      try {
        const now = new Date();
        const result = await syncShiftRowsSince(app.db, { from: new Date(now.getTime() - (options.days as number) * DAY_MS), now });
        console.log(`shifts: opened ${result.opened}, updated ${result.updated}, merged ${result.merged}, dropped ${result.dropped}, traced ${result.traced}`);
      } finally {
        await app.close();
      }
    });

  program
    .command("sale-rule:switch")
    .description("The screens' switch to the one rule of whose a sale is: show it, or set the owner's date")
    .option("--screens-from <day>", "the first Moscow day the screens count by the rule", parseDay)
    .option("--off", "turn it off")
    .option("--by <who>", "whose word it is (with --screens-from or --off)")
    .action(async (options) => {
      const app = await createAppContext();
      try {
        if (options.screensFrom !== undefined || options.off === true) {
          if (options.screensFrom !== undefined && options.off === true) throw new Error("--screens-from or --off, not both");
          if (typeof options.by !== "string" || options.by.trim() === "") throw new Error("--by: whose word it is");
          await setSaleRuleSwitch(app.db, { screensFrom: options.off === true ? null : String(options.screensFrom), setBy: options.by.trim(), at: new Date() });
        }
        const state = await readSaleRuleSwitch(app.db);
        console.log(state.screensFrom === null ? "off: the screens count as before" : `on from ${state.screensFrom} (${state.setBy ?? "?"}, ${state.setAt?.toISOString() ?? "?"})`);
      } finally {
        await app.close();
      }
    });
}
