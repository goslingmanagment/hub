import { readFile, writeFile } from "node:fs/promises";

import type { Command } from "commander";

import { createAppContext } from "../../bootstrap.ts";
import {
  applyCustomOrdersImport,
  customOrdersImportArgsSchema,
  planCustomOrdersImport,
  renderCustomOrdersImport,
} from "./import.ts";

// The one-off import of the open custom orders (ecosystem plan 2026-11-12, package I):
//   pnpm cli custom-orders:import --file <args.json> [--format md|json] [--out <file>]
//   pnpm cli custom-orders:import --file <args.json> --apply
// Without --apply it writes nothing: it prints what it would create and what it could not match. The argument file
// (ContentOps' open orders as its API answers, Gengar's orders.json, the card texts) is prepared on the owner's Mac
// and never enters the repository. An order whose card is in Hub already is left as it is.

export function registerCustomOrderCommands(program: Command) {
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
