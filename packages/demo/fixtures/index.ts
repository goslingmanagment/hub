import type { DemoHandlers } from "../core.ts";
import { accountHandlers } from "./account.ts";
import { costsAttentionHandlers } from "./costs-attention.ts";
import { mattersHandlers } from "./matters.ts";
import { moneyHandlers } from "./money.ts";
import { pageHandlers } from "./page.ts";
import { peopleHandlers } from "./people.ts";
import { personStartHandlers } from "./person-start.ts";
import { publishOfHandlers } from "./publish-of.ts";
import { settingsHandlers } from "./settings.ts";
import { shiftReportHandlers } from "./shift-reports.ts";
import { shellHandlers } from "./shell.ts";
import { systemHandlers } from "./system.ts";
import { teamHandlers } from "./team.ts";
import { teamLedgerHandlers } from "./team-ledger.ts";
import { teamQuestionsHandlers } from "./team-questions.ts";
import { teamReportsHandlers } from "./team-reports.ts";
import { wbSalesHandlers } from "./wb-sales.ts";
import { wbAdminHandlers, wbHeldHandlers } from "./wb-admin.ts";
import { wbCustomsHandlers } from "./wb-customs.ts";

const AREAS: Readonly<Record<string, DemoHandlers>> = {
  shell: shellHandlers,
  money: moneyHandlers,
  page: pageHandlers,
  // «Что продаёт»: the owner's list of win-back approaches, kept in memory with its write (wb-sales.ts).
  // Выплаты from the agency ledger: the owner's, read by Hub (team-ledger.ts), and every chatter's reports (team-reports.ts);
  // Решения' questions «whose is this sale» the agent keeps in the ledger (team-questions.ts).
  team: { ...teamHandlers, ...wbSalesHandlers, ...teamLedgerHandlers, ...teamReportsHandlers, ...teamQuestionsHandlers },
  account: accountHandlers,
  "publish-of": publishOfHandlers,
  // Workboard «Решения» and «Доступ»: Fansly held sends over the console's queue, and the access writes (wb-admin.ts).
  "costs-attention": { ...costsAttentionHandlers, ...wbHeldHandlers },
  "wb-admin": wbAdminHandlers,
  // The people registry: the team's list, the owner's card with pay terms, and its writes (people.ts).
  people: peopleHandlers,
  // «Ждут вас» from matters (packages D and K); `hub-demo-scenario=matters-0|matters-6|matters-40|matters-off` (matters.ts).
  matters: mattersHandlers,
  // Workboard «Кастомы»: the board, an order and its steps, kept in memory (wb-customs.ts).
  customs: wbCustomsHandlers,
  // Отчёт смены: the demo chatter's shift rows, drafts and versions, kept in memory with every write (shift-reports.ts).
  "shift-reports": shiftReportHandlers,
  // «Начало»: a newcomer's way to the first shift, by the scenario's stage, and where they are paid (person-start.ts).
  "person-start": personStartHandlers,
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
