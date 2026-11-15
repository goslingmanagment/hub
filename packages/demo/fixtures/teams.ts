import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { demoError, queryNumber, type DemoHandlers } from "../core.ts";
import { DEMO_MODELS } from "../world.ts";

/**
 * Teams (products package T): the team records and a lead's notes on a shift, kept in memory. The demo's team lead
 * leads «Mia Hart»; the owner grants all three, the lead «видит» and «ведёт кастомы» on it.
 */

type Roles = KernelOperationResponse<"teamRoles">;
type Note = KernelOperationResponse<"reviewNotes">["notes"][number];

const records: Roles["records"] = [
  { personId: 4, personCode: "alex", personName: "Алекс", modelId: 1, kind: "customs", grantedByName: "владелец", grantedAt: "2026-11-01T09:00:00.000Z" },
];
const notes = new Map<string, Note[]>();
let nextNote = 1;

export const teamsHandlers: DemoHandlers = {
  teamRoles: (request) => ({
    models: DEMO_MODELS.map((model) => ({
      id: model.id, slug: model.slug, name: model.name,
      canGrant: request.role === "owner" || (request.role === "team_lead" && model.id === 1),
      canGrantLead: request.role === "owner",
      leadName: model.id === 1 ? "Тимлид" : null,
    })),
    records,
    serverNow: request.now.toISOString(),
  }),
  teamRoleSet: (request) => {
    const body = request.body as { personCode: string; modelId: number; kind: "lead" | "customs" | "view"; granted: boolean };
    if (request.role === "chatter" || (request.role === "team_lead" && (body.kind === "lead" || body.modelId !== 1))) {
      return demoError(403, "Forbidden", "Это может тот, кто ведёт команду этой модели");
    }
    const at = records.findIndex((one) => one.personCode === body.personCode && one.modelId === body.modelId && one.kind === body.kind);
    if (body.granted && at < 0) {
      records.push({ personId: 0, personCode: body.personCode, personName: body.personCode, modelId: body.modelId, kind: body.kind, grantedByName: "вы", grantedAt: request.now.toISOString() });
    }
    if (!body.granted && at >= 0) records.splice(at, 1);
    return { changed: true, savedAt: request.now.toISOString() };
  },
  reviewNotes: (request) => {
    const key = `${queryNumber(request, "userId", 0)}`;
    return { shiftId: 1, notes: notes.get(key) ?? [], canWrite: request.role !== "chatter", serverNow: request.now.toISOString() };
  },
  reviewNoteAdd: (request) => {
    if (request.role === "chatter") return demoError(403, "Forbidden", "Заметку оставляет тот, кто ведёт команду");
    const body = request.body as { userId: number; text: string };
    const list = notes.get(String(body.userId)) ?? [];
    const id = nextNote++;
    list.push({ id, chatKey: null, authorName: request.role === "owner" ? "Владелец" : "Тимлид", text: body.text, createdAt: request.now.toISOString() });
    notes.set(String(body.userId), list);
    return { id, savedAt: request.now.toISOString() };
  },
};
