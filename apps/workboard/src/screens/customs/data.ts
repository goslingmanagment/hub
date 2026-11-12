import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CustomOrder, CustomOrderActionBody, CustomOrderCreateBody, CustomOrderDetailResponse, CustomOrderState } from "@agency_hub_core/contracts";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { hubErrorStatus } from "@agency_hub_core/ui/hubClient";
import { kernel } from "@/shared/hub";

/**
 * Кастомы — the data layer and the words. One read for the board (every order
 * the viewer sees, by step), one for an order; every step answers the order
 * after it, so the screen shows what Hub holds, never a guess.
 */

const BOARD_KEY = ["customOrders"] as const;
const orderKey = (code: string) => ["customOrder", code] as const;

export function useCustomBoard(page: string | null) {
  return useQuery({
    queryKey: [...BOARD_KEY, page ?? "all"],
    queryFn: () => kernel.customOrdersBoard({ query: page ? { pageLabel: page } : {} }),
    refetchInterval: 60_000,
  });
}

export function useCustomOrder(code: string) {
  return useQuery({ queryKey: orderKey(code), queryFn: () => kernel.customOrder({ params: { code } }) });
}

export function useCustomStep(code: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: CustomOrderActionBody) => kernel.customOrderAct({ params: { code }, body }),
    onSuccess: (detail: CustomOrderDetailResponse) => qc.setQueryData(orderKey(code), detail),
    onSettled: () => qc.invalidateQueries({ queryKey: BOARD_KEY }),
  });
}

export function useCustomCreate() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: CustomOrderCreateBody) => kernel.customOrderCreate({ body }),
    onSuccess: (detail: CustomOrderDetailResponse) => qc.setQueryData(orderKey(detail.order.code), detail),
    onSettled: () => qc.invalidateQueries({ queryKey: BOARD_KEY }),
  });
}

export function useDismissSale() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (transactionRef: string) => kernel.customSaleDismiss({ params: { transactionRef } }),
    onSettled: () => qc.invalidateQueries({ queryKey: BOARD_KEY }),
  });
}

/** A refused step in words: the reason Hub gave, never its English. */
export function stepFailure(error: unknown): string {
  const status = hubErrorStatus(error);
  const reason = (error as { body?: { reason?: unknown } } | null)?.body?.reason;
  if (status === 409 && reason === "not_suggested") return "Этого уже нет среди подсказок: обновите страницу.";
  if (status === 409 && reason === "taken") return "Эта карточка уже привязана к другому заказу.";
  if (status === 409 && reason === "fan_unknown") return "Такого фана на этой странице Hub не знает.";
  if (status === 409) return "Этот шаг сейчас недоступен: заказ уже изменился. Обновите страницу.";
  if (status === 404) return "Заказ не найден.";
  if (status === null || status >= 500) return "Hub не ответил: неизвестно, сохранилось ли.";
  return "Не получилось. Hub вернул ошибку.";
}

// ── The board's columns ─────────────────────────────────────────────────────

export type ColumnId = "recorded" | "paid" | "at_model" | "shot" | "given";

export const COLUMNS: ReadonlyArray<{ id: ColumnId; title: string; states: readonly CustomOrderState[]; empty: string }> = [
  { id: "recorded", title: "Записаны", states: ["recorded"], empty: "Новых нет" },
  { id: "paid", title: "Оплачены", states: ["paid"], empty: "Все оплаченные у модели" },
  { id: "at_model", title: "У модели", states: ["at_model", "partly", "revision", "refused"], empty: "У модели ничего" },
  { id: "shot", title: "Сняты", states: ["shot"], empty: "Нечего отдавать" },
  { id: "given", title: "Отданы", states: ["given", "closed"], empty: "За неделю не отдавали" },
];

export function columnOf(order: Pick<CustomOrder, "state">): ColumnId | null {
  return COLUMNS.find((column) => column.states.includes(order.state))?.id ?? null;
}

export const STATE_TONE: Partial<Record<CustomOrderState, "success" | "warning" | "danger" | "info" | "off">> = {
  partly: "info",
  revision: "warning",
  refused: "danger",
  shot: "success",
  given: "success",
  closed: "off",
  cancelled: "off",
};

const MSK_OFFSET_MS = 3 * 3_600_000;
const moscowToday = (now: number) => new Date(now + MSK_OFFSET_MS).toISOString().slice(0, 10);
const daysWord = (days: number) => `${days} ${ruPlural(days, "день", "дня", "дней")}`;
const dotted = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;

/** «осталось 2 дня», «сегодня последний день», «просрочен на 3 дня», or nothing without a deadline. */
export function deadlineWords(order: Pick<CustomOrder, "deadlineOn" | "overdueDays" | "state">, serverNow: string): { text: string; late: boolean } | null {
  if (order.deadlineOn === null) return null;
  if (order.overdueDays !== null) return { text: `просрочен на ${daysWord(order.overdueDays)}`, late: true };
  if (!["recorded", "paid", "at_model", "partly", "revision"].includes(order.state)) return { text: `срок был ${dotted(order.deadlineOn)}`, late: false };
  const today = moscowToday(Date.parse(serverNow));
  const left = Math.round((Date.parse(`${order.deadlineOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (left <= 0) return { text: "сегодня последний день", late: false };
  return { text: `осталось ${daysWord(left)}, до ${dotted(order.deadlineOn)}`, late: false };
}

/** The fan as the board names him: his name, or what the card says while he is not confirmed. */
export function fanWords(order: Pick<CustomOrder, "fan" | "buyer" | "fanErased">): { name: string; confirmed: boolean } {
  if (order.fanErased) return { name: "фан стёрт", confirmed: true };
  if (order.fan) return { name: order.fan.displayName ?? order.fan.username ?? `фан ·${order.fan.fanRef.slice(-4)}`, confirmed: true };
  return { name: order.buyer ?? "покупатель не назван", confirmed: false };
}

export const EVENT_WORDS: Record<string, string> = {
  "custom_order.recorded": "Записан",
  "custom_order.payment": "Оплата привязана",
  "custom_order.payment_removed": "Оплата убрана",
  "custom_order.at_model": "Передан модели",
  "custom_order.partly": "Сдан частично",
  "custom_order.delivery": "Модель сдала",
  "custom_order.shot": "Снят",
  "custom_order.revision": "Правка",
  "custom_order.revision_done": "Правка исправлена",
  "custom_order.refused": "Отказ модели",
  "custom_order.given": "Отдан фану",
  "custom_order.closed": "Закрыт",
  "custom_order.cancelled": "Отменён",
  "custom_order.edited": "Карточка изменена",
  "custom_order.deadline": "Срок изменён",
  "custom_order.fan_confirmed": "Фан подтверждён",
  "custom_order.card": "Привязана карточка из Telegram",
  "custom_order.message": "Сообщение в группе модели",
  "custom_order.retracted": "Сдача отозвана",
};

export const DOOR_WORDS: Record<string, string> = {
  extension: "в расширении",
  workboard: "в Workboard",
  api: "через агента",
  telegram: "в Telegram",
  system: "сам Hub",
};

export const PAYMENT_KIND_WORDS: Record<string, string> = {
  tip: "Чаевые",
  subscription: "Подписка",
  message_purchase: "Покупка в чате",
  post_purchase: "Покупка поста",
};

/** A Telegram reference as a link people open: `tg:<chat>/<topic>/<msg>` → `https://t.me/c/<chat>/<topic>/<msg>`. */
export function telegramHref(ref: string): string {
  const path = ref.replace(/^tg:/u, "");
  return /^\d/u.test(path) ? `https://t.me/c/${path}` : `https://t.me/${path}`;
}
