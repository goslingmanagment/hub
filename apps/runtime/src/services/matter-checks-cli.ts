import { writeFile } from "node:fs/promises";

import type { Command } from "commander";

import { createAppContext } from "../bootstrap.ts";
import { runMatterChecks, type MatterCheckDryKind } from "./matter-checks.ts";

// The checks of package K without writing (ecosystem plan §6):
//   pnpm cli matters:checks --dry-run [--format md|json] [--out <file>]
// Reads the people registry, the logins and the ledger (GET only) and prints,
// per kind, what the checks would open, update and close among the open
// matters. Nothing is written: no matter, no check row. Without --dry-run the
// command refuses: the worker runs the checks.

function renderMarkdown(kinds: readonly MatterCheckDryKind[], at: Date): string {
  const lines = [`# Проверки: что открылось бы (без записи), ${at.toISOString().slice(0, 16).replace("T", " ")} UTC`, ""];
  for (const kind of kinds) {
    lines.push(`## ${kind.kind}`, "");
    if (!kind.answered) {
      lines.push(`Не проверено: ${kind.error ?? "источник не ответил"}`, "");
      continue;
    }
    lines.push(`Открылось бы ${kind.wouldOpen.length}, изменилось бы ${kind.wouldUpdate.length}, закрылось бы ${kind.wouldClose.length}, без изменений ${kind.unchanged}.`, "");
    for (const item of kind.wouldOpen) lines.push(`- открыть \`${item.key}\`: ${item.title}`);
    for (const item of kind.wouldUpdate) lines.push(`- обновить \`${item.key}\` (${item.fields.join(", ")}): ${item.title}`);
    for (const item of kind.wouldClose) lines.push(`- закрыть \`${item.key}\`: ${item.title}`);
    for (const item of kind.waiting ?? []) lines.push(`- красная, но меньше порога: \`${item.key}\` ${item.name} (с ${item.failingSince ?? "неизвестно"})`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function registerMatterCheckCommands(program: Command) {
  program
    .command("matters:checks")
    .description("The people and ledger checks as matters: --dry-run prints what they would open, update and close, writing nothing")
    .option("--dry-run", "read only and print the plan (required: the worker runs the checks themselves)")
    .option("--format <format>", "md or json", "md")
    .option("--out <path>", "write the plan to this file instead of stdout")
    .action(async (options: { dryRun?: boolean; format: string; out?: string }) => {
      if (!options.dryRun) throw new Error("matters:checks runs only with --dry-run: the worker keeps the checks");
      if (options.format !== "md" && options.format !== "json") throw new Error("--format is md or json");
      const app = await createAppContext();
      try {
        const now = new Date();
        const { dry } = await runMatterChecks(app, { now, dryRun: true });
        const text = options.format === "json" ? `${JSON.stringify({ at: now.toISOString(), kinds: dry }, null, 2)}\n` : renderMarkdown(dry, now);
        if (options.out) await writeFile(options.out, text);
        else process.stdout.write(text);
        console.error(JSON.stringify({ kinds: dry.length, wouldOpen: dry.reduce((sum, kind) => sum + kind.wouldOpen.length, 0), written: false }));
      } finally {
        await app.close();
      }
    });
}
