import { KernelApiError, ofapiMediaUploadSchema, ofapiMediaRouteSchemas } from "@agency_hub_core/contracts";

export type MediaUploadBody = ReturnType<typeof ofapiMediaUploadSchema.parse>;
export type MediaUploadReceipt = ReturnType<typeof ofapiMediaRouteSchemas.ofapiMediaUploadCreate.response[200]["parse"]>;
export interface MediaUploadRecord {
  body: MediaUploadBody;
  pageLabel: string;
  sourceFilename: string;
  startedAt: string;
  phase: "sending" | "uncertain" | "confirmed" | "refused";
  receipt: MediaUploadReceipt | null;
  error: string;
}
export interface MediaUploadCustody { current: MediaUploadRecord | null; history: MediaUploadRecord[]; error: string }
export const mediaUploadCustodyKey = (ownerId: number) => `hub:media-upload:v1:owner:${ownerId}`;
export const mediaUploadUnresolved = (record: MediaUploadRecord | null) => record?.phase === "sending" || record?.phase === "uncertain";
export const findMediaUpload = (state: MediaUploadCustody, requestId: string) => state.current?.body.requestId === requestId
  ? state.current : state.history.find(item => item.body.requestId === requestId);

/** A confirmed queue receipt remains authoritative over any later response. */
export function mergeMediaUploadOutcome(state: MediaUploadCustody, outcome: MediaUploadRecord): MediaUploadCustody {
  const merge = (item: MediaUploadRecord) => item.body.requestId === outcome.body.requestId && item.phase !== "confirmed" ? outcome : item;
  return { ...state, current: state.current ? merge(state.current) : null, history: state.history.map(merge) };
}

function record(value: unknown, recoverInterrupted: boolean): MediaUploadRecord {
  const item = value as Partial<MediaUploadRecord> | null;
  if (!item || typeof item.pageLabel !== "string" || typeof item.sourceFilename !== "string" || typeof item.startedAt !== "string"
    || !Number.isFinite(Date.parse(item.startedAt)) || !["sending", "uncertain", "confirmed", "refused"].includes(item.phase ?? "")
    || typeof item.error !== "string") throw new Error("Invalid upload record");
  const body = ofapiMediaUploadSchema.parse(item.body);
  if (body.dryRun !== false) throw new Error("Only an approved upload can be recovered");
  const receipt = item.receipt === null ? null : ofapiMediaRouteSchemas.ofapiMediaUploadCreate.response[200].parse(item.receipt);
  if (receipt && (receipt.dryRun || !receipt.jobId || receipt.sourceId !== body.sourceId || receipt.destination !== body.destination || receipt.maxCredits !== body.maxCredits)) throw new Error("Upload receipt does not match the approved request");
  if (item.phase === "confirmed" && !receipt) throw new Error("Missing upload receipt");
  return { body, receipt, pageLabel: item.pageLabel, sourceFilename: item.sourceFilename, startedAt: item.startedAt,
    phase: recoverInterrupted && item.phase === "sending" ? "uncertain" : item.phase as MediaUploadRecord["phase"],
    error: recoverInterrupted && item.phase === "sending" ? "Страница была перезагружена во время отправки. Загрузка могла попасть в очередь." : item.error };
}

export function parseMediaUploadCustody(raw: string | null, ownerId: number, recoverInterrupted = true): MediaUploadCustody {
  if (raw === null) return { current: null, history: [], error: "" };
  const envelope = JSON.parse(raw) as { version?: number; ownerId?: number; current?: unknown; history?: unknown };
  if (!envelope || envelope.version !== 1 || envelope.ownerId !== ownerId || !Array.isArray(envelope.history)) throw new Error("Invalid upload workspace");
  return { current: envelope.current === null ? null : record(envelope.current, recoverInterrupted), history: envelope.history.map(value => record(value, true)), error: "" };
}

export function readMediaUploadCustody(ownerId: number, recoverInterrupted = true): MediaUploadCustody {
  try { return parseMediaUploadCustody(typeof window === "undefined" ? null : window.sessionStorage.getItem(mediaUploadCustodyKey(ownerId)), ownerId, recoverInterrupted); }
  catch { return { current: null, history: [], error: "Не удалось восстановить исход загрузки этой вкладки. Новая загрузка недоступна; сохранённую историю можно читать." }; }
}
function requireSaved(ownerId: number) {
  const saved = readMediaUploadCustody(ownerId, false);
  if (saved.error) throw new Error(saved.error);
  return saved;
}
function write(ownerId: number, state: MediaUploadCustody) {
  window.sessionStorage.setItem(mediaUploadCustodyKey(ownerId), JSON.stringify({ version: 1, ownerId, current: state.current, history: state.history }));
  return { ...state, error: "" };
}

/** Atomic admission before the approved POST. Replays keep the entire body, including requestId. */
export function startMediaUpload(ownerId: number, input: MediaUploadRecord) {
  const approved = record(input, false), saved = requireSaved(ownerId);
  const existing = findMediaUpload(saved, approved.body.requestId);
  if (existing && JSON.stringify(existing.body) !== JSON.stringify(approved.body)) throw new Error("Параметры исходной загрузки изменились.");
  if (existing?.phase === "confirmed") return saved;
  if (mediaUploadUnresolved(saved.current) && saved.current?.body.requestId !== approved.body.requestId) throw new Error("Сначала проверьте исход предыдущей загрузки.");
  const history = saved.current && saved.current.body.requestId !== approved.body.requestId ? [...saved.history, saved.current] : saved.history;
  return write(ownerId, { current: approved, history, error: "" });
}

/** A response from an earlier mount or acknowledged intent cannot replace the current one. */
export function settleMediaUpload(ownerId: number, input: MediaUploadRecord) {
  const outcome = record(input, false), saved = requireSaved(ownerId);
  if (findMediaUpload(saved, outcome.body.requestId)?.phase === "confirmed") return saved;
  return write(ownerId, mergeMediaUploadOutcome(saved, outcome));
}
export function acknowledgeSeparateMediaUpload(ownerId: number, requestId: string, acknowledged: boolean) {
  const saved = requireSaved(ownerId);
  if (!acknowledged || !mediaUploadUnresolved(saved.current) || saved.current?.body.requestId !== requestId) throw new Error("Сначала подтвердите сверку исходной загрузки.");
  return write(ownerId, { current: null, history: [...saved.history, { ...saved.current, phase: "uncertain" }], error: "" });
}
export function mediaUploadFailure(error: unknown, wasUncertain: boolean) {
  const refused = !wasUncertain && error instanceof KernelApiError && error.category !== "contract" && error.status !== null
    && [400, 401, 403, 404, 405, 409, 422, 429].includes(error.status);
  return { phase: refused ? "refused" as const : "uncertain" as const,
    error: refused ? `Сервер отказал в загрузке: ${error.message}` : "Подтверждение не получено. Загрузка могла попасть в очередь; восстановите исходный запрос с тем же ID или проверьте историю перед отдельной новой загрузкой." };
}
