import { KernelApiError } from "@agency_hub_core/contracts";

export type NotificationDelivery = {
  id: string; ownerId: number; kind: "test" | "report"; recipient: string | null; startedAt: string;
  phase: "sending" | "unknown" | "sent" | "not_sent"; detail: string; reportDate: string | null;
};
export type NotificationDeliveryWorkspace = { current: NotificationDelivery | null; history: NotificationDelivery[]; storageError: string };
export const notificationDeliveryKey = (ownerId: number) => `hub:notification-delivery:v1:${ownerId}`;

export function restoreNotificationDelivery(raw: string | null, ownerId: number, interrupted = true): NotificationDeliveryWorkspace {
  if (raw === null) return { current: null, history: [], storageError: "" };
  const value = JSON.parse(raw) as { version?: number; ownerId?: number; current?: unknown; history?: unknown };
  if (value?.version !== 1 || value.ownerId !== ownerId || !Array.isArray(value.history)) throw new Error("Контекст отправки не соответствует текущей сессии.");
  function parse(input: unknown): NotificationDelivery {
    const item = input as Partial<NotificationDelivery> | null;
    if (!item || item.ownerId !== ownerId || typeof item.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id)
      || !["test", "report"].includes(item.kind ?? "") || !["sending", "unknown", "sent", "not_sent"].includes(item.phase ?? "")
      || typeof item.startedAt !== "string" || !Number.isFinite(Date.parse(item.startedAt)) || typeof item.detail !== "string"
      || !(item.recipient === null || typeof item.recipient === "string") || !(item.reportDate === null || typeof item.reportDate === "string")) throw new Error("Контекст отправки повреждён.");
    return { ...item as NotificationDelivery, phase: interrupted && item.phase === "sending" ? "unknown" : item.phase as NotificationDelivery["phase"], detail: interrupted && item.phase === "sending" ? "Страница была перезагружена во время отправки. Сообщение могло попасть в Telegram." : item.detail };
  }
  return { current: value.current === null ? null : parse(value.current), history: value.history.map(parse), storageError: "" };
}
export function readNotificationDelivery(ownerId: number | undefined, interrupted = true): NotificationDeliveryWorkspace {
  if (ownerId === undefined || typeof window === "undefined") return { current: null, history: [], storageError: "" };
  try { return restoreNotificationDelivery(window.sessionStorage.getItem(notificationDeliveryKey(ownerId)), ownerId, interrupted); }
  catch { return { current: null, history: [], storageError: "Контекст предыдущей отправки не прочитан. Новая отправка недоступна; настройки и историю можно обновить." }; }
}
export function writeNotificationDelivery(ownerId: number, value: NotificationDeliveryWorkspace) {
  window.sessionStorage.setItem(notificationDeliveryKey(ownerId), JSON.stringify({ version: 1, ownerId, current: value.current, history: value.history }));
}
export function settleNotificationDelivery(value: NotificationDeliveryWorkspace, outcome: NotificationDelivery): NotificationDeliveryWorkspace {
  if (value.current?.id === outcome.id) return { ...value, current: outcome };
  return { ...value, history: value.history.map(item => item.id === outcome.id ? outcome : item) };
}
export const notificationDeliveryUnresolved = (current: NotificationDelivery | null) => current?.phase === "sending" || current?.phase === "unknown";
export function notificationDeliveryFailure(error: unknown): Pick<NotificationDelivery, "phase" | "detail"> {
  const refused = error instanceof KernelApiError && error.category !== "contract" && error.status !== null && error.status >= 400 && error.status < 500;
  return refused ? { phase: "not_sent", detail: `Сервер отказал в отправке: ${error.message}` } : { phase: "unknown", detail: "Подтверждение не получено. Сообщение могло попасть в Telegram; проверьте чат и историю перед отдельной новой отправкой." };
}
