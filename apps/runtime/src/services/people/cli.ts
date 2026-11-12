import { readFile, writeFile } from "node:fs/promises";

import type { Command } from "commander";

import { PERSON_RIGHTS, type PersonRight } from "@agency_hub_core/contracts";
import { findUserById, listAgentKeys } from "@agency_hub_core/db";

import { createAppContext } from "../../bootstrap.ts";
import {
  applyPeopleImport,
  loadImportCatalog,
  peopleImportArgsSchema,
  planPeopleImport,
  renderImportMarkdown,
} from "./import.ts";
import { readPersonForOwner, updatePerson } from "./index.ts";

// The people registry's one-off import (ecosystem plan 2026-11-12, package A):
//   pnpm cli people:import --file <args.json> [--format md|json] [--out <file>]
//   pnpm cli people:import --file <args.json> --apply --owner-user-id <id>
// Without --apply it writes nothing and prints the plan: the drafts, every
// disagreement between the sources, the logins it proposes as service. The
// argument file is prepared on the owner's Mac and never enters the repository.
// No login is touched: `users` is only read.

// Two edits of a person's card for the owner's word given in chat (the card in Workboard «Люди» does the same):
//   pnpm cli people:right <code> --grant <right...> --revoke <right...> --owner-user-id <id>
//   pnpm cli people:agent-key <agentCode> --link <keyName...> --unlink <keyName...> --owner-user-id <id>
// Both go through the registry's own edit (`updatePerson`): the same checks and the same audit rows, source cli.

async function requireOwner(app: Awaited<ReturnType<typeof createAppContext>>, ownerUserId: number) {
  const owner = await findUserById(app.db, ownerUserId);
  if (!owner || owner.role !== "owner" || owner.disabledAt !== null || owner.deletedAt !== null) {
    throw new Error(`Active owner required: user ID ${ownerUserId}`);
  }
  return owner;
}

function knownRights(values: readonly string[]): PersonRight[] {
  const unknown = values.filter((value) => !(PERSON_RIGHTS as readonly string[]).includes(value));
  if (unknown.length > 0) throw new Error(`Unknown right: ${unknown.join(", ")} (known: ${PERSON_RIGHTS.join(", ")})`);
  return values as PersonRight[];
}

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

  program
    .command("people:right")
    .description("Grant or revoke a person's narrow rights (the card's switches); audited like the card")
    .argument("<code>", "the person's code")
    .option("--grant <right...>", `rights to grant: ${PERSON_RIGHTS.join(", ")}`)
    .option("--revoke <right...>", "rights to take away")
    .requiredOption("--owner-user-id <id>", "the active owner who asked for it", positiveInt)
    .action(async (code: string, options: { grant?: string[]; revoke?: string[]; ownerUserId: number }) => {
      const grant = knownRights([...new Set(options.grant ?? [])]);
      const revoke = knownRights([...new Set(options.revoke ?? [])]);
      if (grant.length === 0 && revoke.length === 0) throw new Error("Pass --grant and/or --revoke");
      const both = grant.filter((right) => revoke.includes(right));
      if (both.length > 0) throw new Error(`Both granted and revoked: ${both.join(", ")}`);
      const app = await createAppContext();
      try {
        const owner = await requireOwner(app, options.ownerUserId);
        const before = (await readPersonForOwner(app, code)).person.rights.map((right) => right.right);
        const after = [...new Set([...before.filter((right) => !revoke.includes(right)), ...grant])];
        const updated = await updatePerson(app, code, { rights: after }, { source: "cli", actorUserId: owner.id });
        console.log(JSON.stringify({ code, before, after: updated.person.rights.map((right) => right.right) }));
      } finally {
        await app.close();
      }
    });

  program
    .command("people:agent-key")
    .description("Link agent keys to the agent they belong to, or unlink them (never issues or revokes a key); audited like the card")
    .argument("<agentCode>", "the agent's code in the registry")
    .option("--link <keyName...>", "names of the keys that belong to this agent")
    .option("--unlink <keyName...>", "names of the keys to take off this agent")
    .requiredOption("--owner-user-id <id>", "the active owner who asked for it", positiveInt)
    .action(async (agentCode: string, options: { link?: string[]; unlink?: string[]; ownerUserId: number }) => {
      const link = [...new Set(options.link ?? [])];
      const unlink = [...new Set(options.unlink ?? [])];
      if (link.length === 0 && unlink.length === 0) throw new Error("Pass --link and/or --unlink");
      const app = await createAppContext();
      try {
        const owner = await requireOwner(app, options.ownerUserId);
        const keys = await listAgentKeys(app.db);
        const idOf = (name: string) => {
          const key = keys.find((candidate) => candidate.name === name);
          if (!key) throw new Error(`No agent key named ${name}`);
          return key.id;
        };
        const updated = await updatePerson(
          app,
          agentCode,
          { agentKeys: { ...(link.length > 0 ? { add: link.map(idOf) } : {}), ...(unlink.length > 0 ? { remove: unlink.map(idOf) } : {}) } },
          { source: "cli", actorUserId: owner.id },
        );
        console.log(JSON.stringify({ agent: agentCode, keys: updated.person.agentKeys.map((key) => key.name) }));
      } finally {
        await app.close();
      }
    });
}
