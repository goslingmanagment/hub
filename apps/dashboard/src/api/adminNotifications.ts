import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NotificationsDiscoverChatsBody, NotificationsSettingsUpdateBody } from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";
import { useAuthMe } from "./auth.js";
import { useSessionWorkspace } from "@/lib/useSessionWorkspace";
import { notificationDeliveryFailure, notificationDeliveryUnresolved, readNotificationDelivery, settleNotificationDelivery, writeNotificationDelivery, type NotificationDelivery, type NotificationDeliveryWorkspace } from "@/lib/notificationDelivery";

function useNotificationDelivery() {
  const ownerId = useAuthMe().data?.user.id;
  const qc = useQueryClient();
  const [workspace, update, read] = useSessionWorkspace<NotificationDeliveryWorkspace>(`notifications-delivery:${ownerId ?? "pending"}`, () => readNotificationDelivery(ownerId));
  function save(value: NotificationDeliveryWorkspace) {
    if (ownerId === undefined) throw new Error("Сессия владельца не подтверждена.");
    writeNotificationDelivery(ownerId, value); update(value);
  }
  function settle(outcome: NotificationDelivery) {
    const stored = readNotificationDelivery(ownerId, false);
    if (!stored.storageError) {
      try { save(settleNotificationDelivery(stored, outcome)); return; } catch { /* Keep the known receipt visible in the current session. */ }
    }
    update(current => ({ ...settleNotificationDelivery(current, outcome), storageError: "Результат получен, но не сохранён в этой вкладке. Сохраните исход перед уходом; новая отправка пока недоступна." }));
  }
  async function send<T extends { status: string; error: string | null; reportDate?: string | null }>(kind: "test" | "report", action: () => Promise<T>): Promise<T> {
    const current = read();
    if (current.storageError || notificationDeliveryUnresolved(current.current)) throw new Error("Сначала проверьте исход предыдущей отправки.");
    if (ownerId === undefined) throw new Error("Сессия владельца не подтверждена.");
    const stored = readNotificationDelivery(ownerId, false);
    if (stored.storageError || notificationDeliveryUnresolved(stored.current)) throw new Error("Сначала восстановите контекст предыдущей отправки.");
    const settings = qc.getQueryData<{ chatId: string | null }>(["notifications", "settings"]);
    const pending: NotificationDelivery = { id: crypto.randomUUID(), ownerId, kind, recipient: settings?.chatId ?? null, startedAt: new Date().toISOString(), phase: "sending", detail: "Запрос отправляется. Не создавайте вторую отправку.", reportDate: null };
    try { save({ ...stored, current: pending }); }
    catch { update(value => ({ ...value, storageError: "Не удалось сохранить контекст в этой вкладке. Отправка не началась; разрешите хранилище браузера и восстановите запись." })); throw new Error("Контекст не сохранён. Отправка не началась."); }
    try {
      const result = await action();
      settle({ ...pending, phase: result.status === "sent" ? "sent" : result.status === "skipped" ? "not_sent" : "unknown", reportDate: result.reportDate ?? null,
        detail: result.status === "sent" ? "Telegram подтвердил отправку." : result.status === "skipped" ? "Сервер пропустил отправку; сообщение не отправлялось." : `Доставка не подтверждена: ${result.error ?? "Telegram не вернул подтверждение"}` });
      return result;
    } catch (error) { settle({ ...pending, ...notificationDeliveryFailure(error) }); throw error; }
  }
  function recoverDelivery() { update(readNotificationDelivery(ownerId)); }
  function allowSeparateDelivery(acknowledged: boolean) {
    const current = read();
    if (!acknowledged || current.storageError || current.current?.phase !== "unknown") return false;
    const stored = readNotificationDelivery(ownerId, false);
    if (stored.storageError || stored.current?.id !== current.current.id) { recoverDelivery(); return false; }
    if (!notificationDeliveryUnresolved(stored.current)) { update(stored); return false; }
    try { save({ current: null, history: [...stored.history, { ...stored.current, phase: "unknown", detail: current.current.detail }], storageError: "" }); return true; }
    catch { update(value => ({ ...value, storageError: "Предыдущий исход не сохранён. Новая отправка пока недоступна." })); return false; }
  }
  return { send, delivery: workspace.current, deliveryHistory: workspace.history, deliveryError: workspace.storageError, deliveryBlocked: !!workspace.storageError || notificationDeliveryUnresolved(workspace.current), recoverDelivery, allowSeparateDelivery };
}

export function useNotificationsSettings() {
  return useQuery({
    queryKey: ["notifications", "settings"],
    queryFn: () => kernel.notificationsSettings(),
    meta: { suppressGlobalError: true },
  });
}

export function useUpdateNotificationsSettings() {
  const qc = useQueryClient();
  const pending = useIsMutating({ mutationKey: ["notifications", "mutation"] });
  const mutation = useMutation({
    mutationKey: ["notifications", "mutation", "settings"],
    meta: { suppressGlobalError: true },
    mutationFn: (body: NotificationsSettingsUpdateBody) =>
      kernel.notificationsSettingsUpdate({ body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications", "settings"] }),
  });
  return { ...mutation, isPending: mutation.isPending || pending > 0 };
}

export function useSendTestMessage() {
  const qc = useQueryClient();
  const pending = useIsMutating({ mutationKey: ["notifications", "mutation"] });
  const delivery = useNotificationDelivery();
  const mutation = useMutation({
    mutationKey: ["notifications", "mutation", "test"],
    meta: { suppressGlobalError: true },
    mutationFn: () => delivery.send("test", () => kernel.notificationsTestMessage()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications", "settings"] }),
  });
  return { ...mutation, ...delivery, isPending: mutation.isPending || pending > 0 };
}

export function useDiscoverTelegramChats() {
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: NotificationsDiscoverChatsBody) =>
      kernel.notificationsDiscoverChats({ body }),
  });
}

export function useNotificationIncidents(params: {
  status?: string;
  kind?: string;
  pageLabel?: string;
  limit?: number;
  offset?: number;
} = {}) {
  return useQuery({
    queryKey: ["notifications", "incidents", params],
    queryFn: () => kernel.notificationsIncidents({
      query: params as Parameters<typeof kernel.notificationsIncidents>[0]["query"],
    }),
    refetchInterval: 30_000,
  });
}

export function useResolveIncident() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (incidentId: number) =>
      kernel.notificationsResolveIncident({ params: { incidentId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications", "incidents"] }),
  });
}

export function useReportPreview() {
  return useQuery({
    queryKey: ["notifications", "reportPreview"],
    queryFn: () => kernel.notificationsReportPreview(),
    enabled: false,
    meta: { suppressGlobalError: true },
  });
}

export function useSendReport() {
  const qc = useQueryClient();
  const pending = useIsMutating({ mutationKey: ["notifications", "mutation"] });
  const delivery = useNotificationDelivery();
  const mutation = useMutation({
    mutationKey: ["notifications", "mutation", "report"],
    meta: { suppressGlobalError: true },
    mutationFn: () => delivery.send("report", () => kernel.notificationsReportSend()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications", "reportHistory"] }),
  });
  return { ...mutation, ...delivery, isPending: mutation.isPending || pending > 0 };
}

export function useReportHistory() {
  return useQuery({
    queryKey: ["notifications", "reportHistory"],
    queryFn: () => kernel.notificationsReportHistory(),
    meta: { suppressGlobalError: true },
  });
}
