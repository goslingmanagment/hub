import type { DemoHandlers } from "../core.ts";
import { accountHandlers } from "./account.ts";
import { costsAttentionHandlers } from "./costs-attention.ts";
import { moneyHandlers } from "./money.ts";
import { pageHandlers } from "./page.ts";
import { publishOfHandlers } from "./publish-of.ts";
import { settingsHandlers } from "./settings.ts";
import { shellHandlers } from "./shell.ts";
import { systemHandlers } from "./system.ts";
import { teamHandlers } from "./team.ts";

const AREAS: Readonly<Record<string, DemoHandlers>> = {
  shell: shellHandlers,
  money: moneyHandlers,
  page: pageHandlers,
  team: teamHandlers,
  account: accountHandlers,
  "publish-of": publishOfHandlers,
  "costs-attention": costsAttentionHandlers,
  settings: settingsHandlers,
  system: systemHandlers,
};

/** Every area's answers in one table. An operation belongs to one area only:
 *  a second definition is a mistake, so loading the demo fails loudly. */
function merge(): DemoHandlers {
  const merged: Record<string, unknown> = {};
  const owner: Record<string, string> = {};
  for (const [area, handlers] of Object.entries(AREAS)) {
    for (const [key, handler] of Object.entries(handlers)) {
      if (owner[key]) throw new Error(`demo: ${key} is defined in both ${owner[key]} and ${area}`);
      owner[key] = area;
      merged[key] = handler;
    }
  }
  return merged as DemoHandlers;
}

export const demoHandlers: DemoHandlers = merge();
