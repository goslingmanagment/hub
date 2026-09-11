import { ofapiActionSchema, type OfapiAction, type OfapiActionIntent } from "@agency_hub_core/contracts";

export interface PendingOfapiAction {
  id: string;
  pageId: number;
  label: string;
  operation: "prepare" | "dispatch" | "cancel" | "repair";
  command: OfapiAction;
  outcome?: "dispatching" | "indeterminate";
}
export const actionCustodyKey = (ownerId: number) => `hub:ofapi-action:v1:owner:${ownerId}`;

export function parseActionCustody(raw: string | null, ownerId: number): PendingOfapiAction | null {
  if (raw === null) return null;
  const value = JSON.parse(raw) as { version?: number; ownerId?: number; request?: Partial<PendingOfapiAction> };
  const request = value?.request;
  if (value?.version !== 1 || value.ownerId !== ownerId || !request || typeof request.id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.id)
    || !Number.isSafeInteger(request.pageId) || request.pageId! <= 0 || typeof request.label !== "string"
    || !["prepare", "dispatch", "cancel", "repair"].includes(request.operation ?? "")
    || (request.outcome !== undefined && !["dispatching", "indeterminate"].includes(request.outcome))) throw new Error("Invalid saved action request");
  const command = ofapiActionSchema.parse(request.command);
  if (command.pageId !== request.pageId) throw new Error("Saved action account mismatch");
  return { id: request.id, pageId: request.pageId!, label: request.label, operation: request.operation!, command, ...(request.outcome ? { outcome: request.outcome } : {}) };
}
export function readActionCustody(ownerId: number) {
  if (typeof window === "undefined") return null;
  return parseActionCustody(window.sessionStorage.getItem(actionCustodyKey(ownerId)), ownerId);
}
export function saveActionCustody(ownerId: number, request: PendingOfapiAction) {
  window.sessionStorage.setItem(actionCustodyKey(ownerId), JSON.stringify({ version: 1, ownerId, request }));
}
export function clearActionCustody(ownerId: number, id: string) {
  if (readActionCustody(ownerId)?.id === id) window.sessionStorage.removeItem(actionCustodyKey(ownerId));
}

// A successful HTTP response can still describe an unresolved physical send.
export function settleActionCustody(ownerId: number, result: Pick<OfapiActionIntent, "id" | "pageId" | "command" | "state">, label: string) {
  const saved = readActionCustody(ownerId);
  if (saved && saved.id !== result.id) return saved;
  if (result.state === "dispatching" || result.state === "indeterminate") {
    const pending: PendingOfapiAction = { id: result.id, pageId: result.pageId, command: result.command,
      label: saved?.label ?? label, operation: saved?.operation ?? "dispatch", outcome: result.state };
    saveActionCustody(ownerId, pending);
    return pending;
  }
  clearActionCustody(ownerId, result.id);
  return null;
}

export function acknowledgeActionCustody(ownerId: number, id: string) {
  const saved = readActionCustody(ownerId);
  if (saved?.id !== id || saved.outcome !== "indeterminate") throw new Error("Unresolved action changed");
  window.sessionStorage.setItem(`${actionCustodyKey(ownerId)}:reviewed:${id}`, JSON.stringify({ version: 1, ownerId, request: saved, reviewedAt: new Date().toISOString() }));
  clearActionCustody(ownerId, id);
}
