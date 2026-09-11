import { ofapiMarketingIntentSchema } from "@agency_hub_core/contracts";

export type PendingOfapiEvidence =
  | { kind: "marketing"; requestId: string; intent: ReturnType<typeof ofapiMarketingIntentSchema.parse> }
  | { kind: "redelivery"; requestId: string; id: string; attemptId: number };
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const evidenceCustodyKey = (ownerId: number, kind: PendingOfapiEvidence["kind"]) => `hub:ofapi-evidence:v1:${ownerId}:${kind}`;

export function parseEvidenceCustody(raw: string | null, ownerId: number, kind: PendingOfapiEvidence["kind"]): PendingOfapiEvidence | null {
  if (raw === null) return null;
  const value = JSON.parse(raw) as { version?: number; ownerId?: number; request?: Partial<PendingOfapiEvidence> };
  const request = value?.request;
  if (value?.version !== 1 || value.ownerId !== ownerId || !request || request.kind !== kind || !uuid(request.requestId)) throw new Error("Контекст отправки не соответствует текущей сессии.");
  if (request.kind === "marketing") return { kind: "marketing", requestId: request.requestId, intent: ofapiMarketingIntentSchema.parse(request.intent) };
  if (request.kind !== "redelivery" || !uuid(request.id) || !Number.isSafeInteger(request.attemptId) || request.attemptId! <= 0) throw new Error("Контекст повтора доставки повреждён.");
  return { kind: "redelivery", requestId: request.requestId, id: request.id, attemptId: request.attemptId! };
}

export function readEvidenceCustody(ownerId: number | undefined, kind: PendingOfapiEvidence["kind"]) {
  if (ownerId === undefined || typeof window === "undefined") return { request: null, error: "" };
  try { return { request: parseEvidenceCustody(window.sessionStorage.getItem(evidenceCustodyKey(ownerId, kind)), ownerId, kind), error: "" }; }
  catch { return { request: null, error: "Контекст незавершённой отправки не прочитан. Новая отправка недоступна; сохранённую историю можно обновить." }; }
}

/** Only a safe persisted preview or an existing delivery ID is stored. No command
 * secrets or permission flags are saved, and reading this marker never sends. */
export function saveEvidenceCustody(ownerId: number | undefined, request: PendingOfapiEvidence) {
  if (ownerId === undefined) throw new Error("Сессия владельца не подтверждена.");
  window.sessionStorage.setItem(evidenceCustodyKey(ownerId, request.kind), JSON.stringify({ version: 1, ownerId, request }));
}

export function clearEvidenceCustody(ownerId: number | undefined, request: PendingOfapiEvidence) {
  try { if (ownerId !== undefined && readEvidenceCustody(ownerId, request.kind).request?.requestId === request.requestId) window.sessionStorage.removeItem(evidenceCustodyKey(ownerId, request.kind)); }
  catch { /* A confirmed response remains confirmed; reload remains conservative. */ }
}
