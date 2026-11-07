// Workboard «Что продаёт» in the demo, over the shared fixtures (team.ts, team-extra.ts):
//  - the one write of the group, the owner's list of win-back approaches
//    (`teamWinBackApproachSave`), as Hub does it (services/win-back.ts, db
//    repositories/winback.ts): the owner only; an id updates that approach (404
//    when there is none), no id adds one; a taken name is a 409; the answer is the
//    whole list, retired ones included. Kept in memory until the dev server
//    restarts; the list read (`teamWinBackApproaches`) answers from the same memory;
//  - `teamWinBackResults` wrapped: the shared fixture ripens the results from the
//    picks, Hub from the written ones (repositories/winback.ts: «of the sent»), so
//    «ответили 22 из 74» stood next to «написали 72». Here every matured count is
//    scaled to the written and never exceeds them, as on production.
import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { demoError, isDemoReply, type DemoHandlers, type DemoReply, type DemoRequest } from "../core.ts";
import { teamHandlers } from "./team.ts";
import { teamWinBackApproaches } from "./team-extra.ts";

type Approach = KernelOperationResponse<"teamWinBackApproaches">["approaches"][number];

let list: Approach[] | null = null;

function current(): Approach[] {
  list ??= teamWinBackApproaches().approaches.map((approach) => ({ ...approach }));
  return list;
}

function sorted(): KernelOperationResponse<"teamWinBackApproachSave"> {
  return { approaches: [...current()].sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id) };
}

type Results = KernelOperationResponse<"teamWinBackResults">;

/** The shared answer with its matured counts taken from the written, not the picked. */
function ripenedFromWritten(request: DemoRequest): Results | DemoReply {
  const answer = teamHandlers.teamWinBackResults?.(request);
  if (answer === undefined) return demoError(501, "not_implemented", "Демо: нет данных для teamWinBackResults");
  if (isDemoReply(answer)) return answer;
  return {
    ...answer,
    rows: answer.rows.map((row) => {
      const part = row.attempts > 0 ? row.sent / row.attempts : 0;
      const ripe = (count: number) => Math.min(row.sent, Math.round(count * part));
      const matured72h = ripe(row.matured72h);
      const matured7d = ripe(row.matured7d);
      const matured30d = ripe(row.matured30d);
      return {
        ...row,
        matured72h,
        replied72h: Math.min(matured72h, row.replied72h),
        matured7d,
        bought7d: Math.min(matured7d, row.bought7d),
        matured30d,
        spent30dMills: matured30d > 0 ? row.spent30dMills : 0,
      };
    }),
  };
}

export const wbSalesHandlers: DemoHandlers = {
  teamWinBackResults: ripenedFromWritten,

  teamWinBackApproaches: (request) => {
    if (request.role !== "owner") return demoError(403, "Forbidden", "Подходы меняет только владелец.");
    return sorted();
  },

  teamWinBackApproachSave: (request) => {
    if (request.role !== "owner") return demoError(403, "Forbidden", "Подходы меняет только владелец.");
    const body = (request.body ?? {}) as { id?: number; label?: string; sortOrder?: number; active?: boolean };
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (label === "" || label.length > 80) return demoError(400, "Bad Request", "label: от 1 до 80 знаков.");
    const approaches = current();
    if (approaches.some((approach) => approach.label === label && approach.id !== body.id)) {
      return demoError(409, "Conflict", "An approach with this name exists");
    }
    const sortOrder = typeof body.sortOrder === "number" ? body.sortOrder : 0;
    const active = body.active ?? true;
    if (body.id === undefined) {
      approaches.push({ id: Math.max(0, ...approaches.map((approach) => approach.id)) + 1, label, sortOrder, active });
      return sorted();
    }
    const found = approaches.find((approach) => approach.id === body.id);
    if (!found) return demoError(404, "Not Found", "The approach was not found");
    Object.assign(found, { label, sortOrder, active });
    return sorted();
  },
};
