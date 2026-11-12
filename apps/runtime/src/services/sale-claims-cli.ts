import { readFile } from "node:fs/promises";

import type { Command } from "commander";

import { createDb, createPool } from "@agency_hub_core/db";

import { createAppContext } from "../bootstrap.ts";
import { applyImport, formatImportPlan, planImport } from "./sale-claims-import.ts";
import { runSaleClaims } from "./sale-claims.ts";
import { refreshSaleHomes } from "./sale-homes.ts";
import { readOnlyConnectionString } from "./sale-rule-cli.ts";

/**
 * Заявки и договорённости from a terminal (package G):
 *  - `sale-claims:import --decisions <file> --questions <file> [--dry-run]` — the one-off carry-over of the ledger's
 *    `sale_decisions` and `sale_questions` (the files are `ledger sql -json "SELECT * FROM …"` answers). A dry run reads
 *    Hub with a read-only session and prints every record with the sale found or «привязать»; the import writes the
 *    owner's decisions and the disputes, computes the homes of the sales' days again and opens the owner's matters.
 *  - `sale-claims:run` — the claims' pass now, as the worker runs it after each shift-rows pass.
 */
export function registerSaleClaimCommands(program: Command): void {
  program
    .command("sale-claims:import")
    .description("Carry the ledger's «чья продажа» decisions and questions over to Hub, tied to sales where the words allow (once)")
    .requiredOption("--decisions <file>", "`ledger sql -json \"SELECT * FROM sale_decisions\"` saved to a file")
    .requiredOption("--questions <file>", "`ledger sql -json \"SELECT * FROM sale_questions\"` saved to a file")
    .option("--dry-run", "read Hub only (a read-only session) and print what would be carried over")
    .action(async (options) => {
      const files = {
        decisions: JSON.parse(await readFile(String(options.decisions), "utf8")) as unknown,
        questions: JSON.parse(await readFile(String(options.questions), "utf8")) as unknown,
      };
      if (options.dryRun === true) {
        const url = process.env.DATABASE_URL;
        if (url === undefined || url === "") throw new Error("DATABASE_URL is not set");
        const pool = createPool(readOnlyConnectionString(url), { applicationName: "hub-sale-claims-import-dry-run" });
        try {
          const check = await pool.query<{ default_transaction_read_only: string }>("show default_transaction_read_only");
          if (check.rows[0]?.default_transaction_read_only !== "on") throw new Error("the session is not read-only: refusing to run");
          console.log(formatImportPlan(await planImport(createDb(pool), files)));
        } finally {
          await pool.end();
        }
        return;
      }
      const app = await createAppContext();
      try {
        const now = new Date();
        const plan = await planImport(app.db, files);
        const written = await applyImport(app.db, plan, now);
        for (const day of written.days) {
          const from = new Date(`${day}T00:00:00+03:00`);
          await refreshSaleHomes(app.db, { from, to: new Date(Math.min(now.getTime(), from.getTime() + 86_400_000)), now });
        }
        await runSaleClaims(app, now);
        console.log(`carried over: ${written.decisions} decisions, ${written.questions} questions; homes computed again for ${written.days.length} days`);
      } finally {
        await app.close();
      }
    });

  program
    .command("sale-claims:run")
    .description("The claims' pass now: claims to the other side, a day's silence and disagreement to the owner, «мимо площадки», the week's nobody's sales")
    .action(async () => {
      const app = await createAppContext();
      try {
        console.log(JSON.stringify(await runSaleClaims(app)));
      } finally {
        await app.close();
      }
    });
}
