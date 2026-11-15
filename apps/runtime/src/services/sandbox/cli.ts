import type { Command } from "commander";

import { createAppContext } from "../../bootstrap.ts";
import { executeSandboxRemoval, planSandboxRemoval } from "./remove.ts";
import { SANDBOX_SCENARIOS, SandboxSeedRefused, seedSandbox, type SandboxScenario } from "./seed.ts";

/** `sandbox:seed` and `sandbox:remove` (the test team on production; the wall: sandbox/realm.ts). */
export function registerSandboxCommands(program: Command) {
  program
    .command("sandbox:seed")
    .description("Seed the test team (model «Тест», pages test-1 and test-of, the t-* people); additive and idempotent")
    .option("--scenario <name...>", `scenarios to add for now: ${SANDBOX_SCENARIOS.join(", ")}`)
    .option("--print-invite", "mint a fresh invitation link of t-new and print it (for the coordinator)")
    .option("--print-checker-key", "mint the sandbox-checker agent's key (replacing its live one) and print its value once")
    .action(async (options: { scenario?: string[]; printInvite?: boolean; printCheckerKey?: boolean }) => {
      const scenarios = [...new Set(options.scenario ?? [])];
      const unknown = scenarios.filter((name) => !(SANDBOX_SCENARIOS as readonly string[]).includes(name));
      if (unknown.length > 0) throw new Error(`Unknown scenario: ${unknown.join(", ")}`);
      const app = await createAppContext();
      try {
        const result = await seedSandbox(app, {
          scenarios: scenarios as SandboxScenario[], printInvite: options.printInvite === true, printCheckerKey: options.printCheckerKey === true,
        });
        // Never a password: only whether one was set from the environment.
        console.log(JSON.stringify({
          model: result.model,
          pages: result.pages,
          people: result.people,
          scenarios: result.scenarios,
          checker: result.checker,
          ...(result.invite === null ? {} : { invite: result.invite }),
          // The key's value, this once, only when asked for; never logged anywhere else.
          ...(result.checkerKey === null ? {} : { checkerKey: result.checkerKey }),
        }, null, 2));
      } catch (error) {
        if (error instanceof SandboxSeedRefused) {
          console.error(error.message);
          process.exitCode = 2;
          return;
        }
        throw error;
      } finally {
        await app.close();
      }
    });

  // THE OWNER'S WORD ONLY. A dry run unless --execute; --execute needs --confirm <the test model's id> from the dry run.
  program
    .command("sandbox:remove")
    .description("Take the test team away (owner's word only): a dry run by default, --execute --confirm <model id> to remove")
    .option("--execute", "remove for real (owner's word only)")
    .option("--confirm <modelId>", "the test model's id, as the dry run printed it")
    .action(async (options: { execute?: boolean; confirm?: string }) => {
      const app = await createAppContext();
      try {
        if (options.execute !== true) {
          console.log(JSON.stringify({ dryRun: true, ...(await planSandboxRemoval(app.db)) }, null, 2));
          return;
        }
        const confirm = Number(options.confirm);
        if (!Number.isSafeInteger(confirm) || confirm <= 0) throw new Error("--execute needs --confirm <the test model's id>");
        console.log(JSON.stringify({ removed: true, ...(await executeSandboxRemoval(app.db, { confirmModelId: confirm })) }, null, 2));
      } finally {
        await app.close();
      }
    });
}
