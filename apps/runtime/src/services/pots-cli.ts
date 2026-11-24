import { InvalidArgumentError, type Command } from "commander";

import { readPotsSwitch } from "@agency_hub_core/db";

import { createAppContext } from "../bootstrap.ts";
import { setPotsFromSwitch } from "./pots.ts";

/**
 * Workboard pots CLI (H11):
 *  - `pots:from [YYYY-MM-DD] [--off] [--by <who>]` — show or set `pots_switch.pots_from`.
 *    Enabling enqueues affected Moscow days >= `pots_from` into `sale_home_refresh_due`.
 *    `--off` is refused once any non-reversed Hub distribution exists.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(value: string): string {
  if (!DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new InvalidArgumentError("a Moscow day, YYYY-MM-DD");
  }
  return value;
}

export function registerPotsCommands(program: Command): void {
  program
    .command("pots:from [day]")
    .description("Show or set the Moscow day from which pots live in Workboard (refuses --off once any non-reversed Hub distribution exists)")
    .option("--off", "turn Workboard pots off (refused once any non-reversed Hub distribution exists)")
    .option("--by <who>", "whose word it is", "owner")
    .action(async (dayArg: string | undefined, options: { off?: boolean; by?: string }) => {
      if (dayArg !== undefined && options.off === true) {
        throw new Error("pass either <YYYY-MM-DD> or --off, not both");
      }
      const parsedDay = dayArg === undefined ? undefined : parseDay(dayArg);
      const app = await createAppContext();
      try {
        if (parsedDay !== undefined || options.off === true) {
          const by = typeof options.by === "string" && options.by.trim() !== "" ? options.by.trim() : "owner";
          const next = await setPotsFromSwitch(app.db, {
            potsFrom: options.off === true ? null : parsedDay!,
            setBy: by,
            at: new Date(),
          });
          console.log(
            next.potsFrom === null
              ? `off: pots stay in ledger (${next.setBy ?? "?"}, ${next.setAt?.toISOString() ?? "?"})`
              : `on from ${next.potsFrom} (${next.setBy ?? "?"}, ${next.setAt?.toISOString() ?? "?"}) — affected days queued for refresh`,
          );
          return;
        }
        const state = await readPotsSwitch(app.db);
        console.log(
          state.potsFrom === null
            ? "off: pots stay in ledger"
            : `on from ${state.potsFrom} (${state.setBy ?? "?"}, ${state.setAt?.toISOString() ?? "?"})`,
        );
      } finally {
        await app.close();
      }
    });
}
