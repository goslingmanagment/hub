import { ofapiCollectionJobSchema } from "@agency_hub_core/contracts";

export type OfapiCaptureCustody =
  | { kind: "marketing"; body: ReturnType<typeof ofapiCollectionJobSchema.parse>; pageLabel: string; startedAt: string; clientRequestId: string }
  | { kind: "dictionary"; maxPages: number; startedAt: string; clientRequestId: string };

export function captureCustodyKey(ownerId: number, kind: OfapiCaptureCustody["kind"]) {
  return `hub:ofapi-capture:v1:${ownerId}:${kind}`;
}

export function parseCaptureCustody(raw: string | null, ownerId: number, kind: OfapiCaptureCustody["kind"]): OfapiCaptureCustody | null {
  if (raw === null) return null;
  const envelope = JSON.parse(raw) as { version?: number; ownerId?: number; record?: Partial<OfapiCaptureCustody> };
  if (!envelope || envelope.version !== 1 || envelope.ownerId !== ownerId || envelope.record?.kind !== kind || typeof envelope.record.startedAt !== "string" || !Number.isFinite(Date.parse(envelope.record.startedAt)) || typeof envelope.record.clientRequestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(envelope.record.clientRequestId)) throw new Error("Сохранённая проверка не соответствует текущей сессии.");
  const record = envelope.record;
  if (record.kind === "marketing") {
    if (typeof record.pageLabel !== "string" || !record.pageLabel) throw new Error("Не сохранена страница задания.");
    return { kind: "marketing", body: ofapiCollectionJobSchema.parse(record.body), pageLabel: record.pageLabel, startedAt: record.startedAt!, clientRequestId: record.clientRequestId! };
  }
  if (record.kind !== "dictionary" || !Number.isInteger(record.maxPages) || record.maxPages! < 1 || record.maxPages! > 30) throw new Error("Не сохранён предел словаря.");
  return { kind: "dictionary", maxPages: record.maxPages!, startedAt: record.startedAt!, clientRequestId: record.clientRequestId! };
}

export function readCaptureCustody(ownerId: number | undefined, kind: OfapiCaptureCustody["kind"]) {
  if (typeof window === "undefined" || ownerId === undefined) return { record: null, history: [] as OfapiCaptureCustody[], error: "" };
  try {
    const key = captureCustodyKey(ownerId, kind);
    const historyRaw: unknown = JSON.parse(window.sessionStorage.getItem(`${key}:history`) ?? "[]");
    if (!Array.isArray(historyRaw)) throw new Error("Invalid history");
    const history = historyRaw.map(record => parseCaptureCustody(JSON.stringify({ version: 1, ownerId, record }), ownerId, kind)!);
    return { record: parseCaptureCustody(window.sessionStorage.getItem(key), ownerId, kind), history, error: "" };
  }
  catch { return { record: null, history: [] as OfapiCaptureCustody[], error: "Не удалось восстановить незавершённый сбор этой вкладки. Новая отправка недоступна; чтение сохранённых данных работает." }; }
}

/** Save before the non-idempotent POST. Records contain caps, never secrets.
 *  Reload restores only an unknown outcome and never replays the request. */
export function saveCaptureCustody(ownerId: number | undefined, record: OfapiCaptureCustody) {
  if (ownerId === undefined) throw new Error("Сессия владельца не подтверждена.");
  try { window.sessionStorage.setItem(captureCustodyKey(ownerId, record.kind), JSON.stringify({ version: 1, ownerId, record })); }
  catch { throw new Error("Не удалось сохранить контекст сбора в этой вкладке. Разрешите хранилище браузера перед отправкой."); }
}

export function clearCaptureCustody(ownerId: number | undefined, record: OfapiCaptureCustody) {
  try { if (ownerId !== undefined && readCaptureCustody(ownerId, record.kind).record?.clientRequestId === record.clientRequestId) window.sessionStorage.removeItem(captureCustodyKey(ownerId, record.kind)); }
  catch { /* A confirmed response stays confirmed; a reload conservatively retains the pending marker. */ }
}

/** The owner explicitly allows a separate new read after manual reconciliation.
 * The old unknown outcome is retained; acknowledging never repeats any POST. */
export function acknowledgeCaptureCustody(ownerId: number | undefined, record: OfapiCaptureCustody) {
  if (ownerId === undefined) throw new Error("Сессия владельца не подтверждена.");
  const saved = readCaptureCustody(ownerId, record.kind);
  if (saved.error || saved.record?.clientRequestId !== record.clientRequestId) throw new Error("Контекст сбора изменился. Перечитайте сохранённое состояние перед новым решением.");
  const history = [...saved.history.filter(item => item.clientRequestId !== record.clientRequestId), record];
  window.sessionStorage.setItem(`${captureCustodyKey(ownerId, record.kind)}:history`, JSON.stringify(history));
  window.sessionStorage.removeItem(captureCustodyKey(ownerId, record.kind));
  return history;
}
