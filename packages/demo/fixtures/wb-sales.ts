// Workboard «Что продаёт» in the demo, over the shared fixtures (team.ts, team-extra.ts):
//  - the one write of the group, the owner's list of win-back approaches
//    (`teamWinBackApproachSave`), as Hub does it (services/win-back.ts, db
//    repositories/winback.ts): the owner only; an id updates that approach (404
//    when there is none), no id adds one; a taken name is a 409; the answer is the
//    whole list, retired ones included. Kept in memory until the dev server
//    restarts; the list read (`teamWinBackApproaches`) answers from the same memory.
//    The results (`teamWinBackResults`) are team-extra.ts's, ripened from the written.
import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { demoError, type DemoHandlers } from "../core.ts";
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

export const wbSalesHandlers: DemoHandlers = {
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
