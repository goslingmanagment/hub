import { readFile, writeFile } from "node:fs/promises";

import type { Command } from "commander";

import { findUserById } from "@agency_hub_core/db";

import { createAppContext } from "../../bootstrap.ts";
import {
  applyPeopleImport,
  loadImportCatalog,
  peopleImportArgsSchema,
  planPeopleImport,
  renderImportMarkdown,
} from "./import.ts";

// The people registry's one-off import (ecosystem plan 2026-11-12, package A):
//   pnpm cli people:import --file <args.json> [--format md|json] [--out <file>]
//   pnpm cli people:import --file <args.json> --apply --owner-user-id <id>
// Without --apply it writes nothing and prints the plan: the drafts, every
// disagreement between the sources, the logins it proposes as service. The
// argument file is prepared on the owner's Mac and never enters the repository.
// No login is touched: `users` is only read.

function positiveInt(value: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`Expected a positive integer, got ${value}`);
  return number;
}

export function registerPeopleCommands(program: Command) {
  program
    .command("people:import")
    .description("Draft the people registry from the sources (an argument file) and list every disagreement; --apply writes it")
    .requiredOption("--file <path>", "the argument file (JSON, version 1), prepared outside the repository")
    .option("--format <format>", "md (the owner's report, Russian) or json", "md")
    .option("--out <path>", "write the report to this file instead of stdout")
    .option("--apply", "write the drafts (one transaction); codes already in the registry are left as they are")
    .option("--owner-user-id <id>", "the active owner who asked (required with --apply)", positiveInt)
    .action(async (options: { file: string; format: string; out?: string; apply?: boolean; ownerUserId?: number }) => {
      if (options.format !== "md" && options.format !== "json") throw new Error("--format is md or json");
      const args = peopleImportArgsSchema.parse(JSON.parse(await readFile(options.file, "utf8")));
      const app = await createAppContext();
      try {
        const plan = planPeopleImport(args, await loadImportCatalog(app.db));
        const report = options.format === "json"
          ? `${JSON.stringify(plan, null, 2)}\n`
          : renderImportMarkdown(plan, { title: "Импорт реестра людей: черновики и расхождения", preparedAt: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC" });
        if (options.out) await writeFile(options.out, report);
        else process.stdout.write(report);
        if (options.apply) {
          if (options.ownerUserId === undefined) throw new Error("--apply needs --owner-user-id");
          const owner = await findUserById(app.db, options.ownerUserId);
          if (!owner || owner.role !== "owner" || owner.disabledAt !== null || owner.deletedAt !== null) {
            throw new Error(`Active owner required: user ID ${options.ownerUserId}`);
          }
          const result = await applyPeopleImport(app, plan, { source: "cli", actorUserId: owner.id });
          console.error(JSON.stringify({ created: result.created.length, skipped: plan.skipped.length, discrepancies: plan.discrepancies.length }));
        } else {
          console.error(JSON.stringify({ drafts: plan.drafts.length, skipped: plan.skipped.length, discrepancies: plan.discrepancies.length, written: false }));
        }
      } finally {
        await app.close();
      }
    });
}
