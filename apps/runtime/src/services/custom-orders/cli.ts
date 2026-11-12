import { readFile, writeFile } from "node:fs/promises";

import type { Command } from "commander";

import { CUSTOM_STATE_WORDS, parseCustomOrderCode } from "@agency_hub_core/contracts";

import { createAppContext } from "../../bootstrap.ts";
import {
  applyCustomOrdersImport,
  customOrdersImportArgsSchema,
  planCustomOrdersImport,
  renderCustomOrdersImport,
} from "./import.ts";
import { settleCustomOrders } from "./index.ts";

// The one-off import of the open custom orders (ecosystem plan 2026-11-12, package I):
//   pnpm cli custom-orders:import --file <args.json> [--format md|json] [--out <file>]
//   pnpm cli custom-orders:import --file <args.json> --apply
// Without --apply it writes nothing: it prints what it would create and what it could not match. The argument file
// (ContentOps' open orders as its API answers, Gengar's orders.json, the card texts) is prepared on the owner's Mac
// and never enters the repository. An order whose card is in Hub already is left as it is.

// The orders whose kept messages disagree with their state (an import stored the messages without a step, and a
// repeat of a kept message changes nothing, so no door applies them any more):
//   pnpm cli custom-orders:settle                    the list: code, state now, state by its messages; writes nothing
//   pnpm cli custom-orders:settle --apply            each put where its messages say, with a line in its history
//   pnpm cli custom-orders:settle --apply --code K-123 --code K-140     only these
// An order a person moved by their own hand after its newest message is listed and left as it is. A second run of
// --apply finds nothing to settle.

export function registerCustomOrderCommands(program: Command) {
  program
    .command("custom-orders:settle")
    .description("List the custom orders whose kept messages disagree with their state; --apply puts each where its messages say")
    .option("--apply", "settle them (an order a person moved by hand after its newest message is left)")
    .option("--code <code>", "only this order, K-<number> (repeat for several)", (value: string, all: string[]) => [...all, value], [] as string[])
    .option("--json", "print the list as JSON")
    .action(async (options: { apply?: boolean; code: string[]; json?: boolean }) => {
      const orderIds = options.code.map((code) => {
        const id = parseCustomOrderCode(code);
        if (id === null) throw new Error(`--code ${code}: an order's code is K-<number>`);
        return id;
      });
      const app = await createAppContext();
      try {
        const rows = await settleCustomOrders(app, { apply: options.apply === true, ...(orderIds.length > 0 ? { orderIds } : {}) });
        if (options.json) {
          console.log(JSON.stringify(rows, null, 2));
        } else {
          const parts = (list: readonly string[]) => (list.length === 0 ? "—" : list.join("+"));
          const words = { differs: "would be settled (dry run)", settled: "settled", by_hand: "left: a person moved it by hand after its newest message" } as const;
          for (const row of rows) {
            console.log(`${row.code}\t«${CUSTOM_STATE_WORDS[row.state]}» → «${CUSTOM_STATE_WORDS[row.byMessages]}»\tparts ${parts(row.partsDone)} → ${parts(row.partsByMessages)}\t${words[row.outcome]}`);
          }
        }
        console.error(JSON.stringify({
          listed: rows.length, settled: rows.filter((row) => row.outcome === "settled").length,
          leftByHand: rows.filter((row) => row.outcome === "by_hand").length, written: options.apply === true,
        }));
      } finally {
        await app.close();
      }
    });

  program
    .command("custom-orders:import")
    .description("Bring the open custom orders (ContentOps and Gengar's board, united by the Telegram card) into Hub; --apply writes them")
    .requiredOption("--file <path>", "the argument file (JSON, version 1), prepared outside the repository")
    .option("--format <format>", "md (the plan in Russian) or json", "md")
    .option("--out <path>", "write the plan to this file instead of stdout")
    .option("--apply", "create the orders (an order whose card is in Hub already is left)")
    .action(async (options: { file: string; format: string; out?: string; apply?: boolean }) => {
      if (options.format !== "md" && options.format !== "json") throw new Error("--format is md or json");
      const args = customOrdersImportArgsSchema.parse(JSON.parse(await readFile(options.file, "utf8")));
      const app = await createAppContext();
      try {
        const plan = await planCustomOrdersImport(app, args);
        const report = options.format === "json"
          ? `${JSON.stringify(plan, null, 2)}\n`
          : renderCustomOrdersImport(plan, { title: "Перенос открытых кастомов: что будет заведено и что не сопоставлено", preparedAt: `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC` });
        if (options.out) await writeFile(options.out, report);
        else process.stdout.write(report);
        if (options.apply) {
          const codes = await applyCustomOrdersImport(app, plan);
          console.error(JSON.stringify({ created: codes.length, codes, skipped: plan.skipped.length, existing: plan.existing.length }));
        } else {
          console.error(JSON.stringify({ orders: plan.orders.length, unmatched: plan.orders.filter((order) => order.unmatched.length > 0).length, skipped: plan.skipped.length, existing: plan.existing.length, written: false }));
        }
      } finally {
        await app.close();
      }
    });
}
