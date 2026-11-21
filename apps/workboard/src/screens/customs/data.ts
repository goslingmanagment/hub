import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CustomBoardOrder, CustomFindingActionBody, CustomOrder, CustomOrderActionBody, CustomOrderCreateBody, CustomOrderDetailResponse, CustomOrderState,
} from "@agency_hub_core/contracts";
import { hubErrorStatus } from "@agency_hub_core/ui/hubClient";
import { customDeadlineWords, customLeaderWords } from "@agency_hub_core/look";
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

export function useCustomOrder(code: string, options: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: orderKey(code), queryFn: () => kernel.customOrder({ params: { code } }), enabled: options.enabled ?? true });
}

/** The facts screen's blocks, each read when it is opened: under the board's key, so a step refreshes them too. */
export function useCustomDone(enabled: boolean) {
  return useQuery({ queryKey: [...BOARD_KEY, "~done"], queryFn: () => kernel.customOrdersDone({ query: { days: 30 } }), enabled, refetchInterval: 60_000 });
}

export function useCustomFindings(enabled: boolean) {
  return useQuery({ queryKey: [...BOARD_KEY, "~findings"], queryFn: () => kernel.customFindingsList(), enabled, refetchInterval: 60_000 });
}

export function useCustomChanges(enabled: boolean) {
  return useQuery({ queryKey: [...BOARD_KEY, "~changes"], queryFn: () => kernel.customOrderChanges(), enabled, refetchInterval: 60_000 });
}

/** A finding answered: recorded as an order, linked to one, dismissed. */
export function useFindingAct() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (input: { findingId: number; body: CustomFindingActionBody }) =>
      kernel.customFindingAct({ params: { findingId: String(input.findingId) }, body: input.body }),
    onSettled: () => qc.invalidateQueries({ queryKey: BOARD_KEY }),
  });
}

/** A step of an order named by its code at the call (an undo in «изменилось само»): the order and the board refresh. */
export function useAnyCustomStep() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (input: { code: string; body: CustomOrderActionBody }) => kernel.customOrderAct({ params: { code: input.code }, body: input.body }),
    onSuccess: (detail: CustomOrderDetailResponse) => qc.setQueryData(orderKey(detail.order.code), detail),
    onSettled: () => qc.invalidateQueries({ queryKey: BOARD_KEY }),
  });
}

/**
 * The board's three numbers (customs facts spec §13), each with its orders: in work (every live order), burning (Hub's
 * `burning`), shot and not given to the fan yet. «Сегодня → команда» shows the same.
 */
export function boardNumbers(orders: readonly CustomBoardOrder[]) {
  const live = orders.filter((order) => LIVE_STATES.includes(order.state));
  return {
    live,
    burning: live.filter((order) => order.burning),
    shotNotGiven: live.filter((order) => order.facts.shot.value === "yes" && order.facts.given.value !== "yes"),
  };
}
const LIVE_STATES: readonly CustomOrderState[] = ["recorded", "paid", "checked", "at_model", "partly", "shot", "revision", "refused"];

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
  if (status === 409 && reason === "resolved") return "Эту находку уже разобрали: обновите страницу.";
  if (status === 409 && reason === "unknown_event") return "Этого шага уже нет в истории заказа: обновите страницу.";
  if (status === 409 && reason === "other_page") return "Находка с другой страницы.";
  if (status === 409) return "Этот шаг сейчас недоступен: заказ уже изменился. Обновите страницу.";
  if (status === 404) return "Заказ не найден.";
  if (status === null || status >= 500) return "Hub не ответил: неизвестно, сохранилось ли.";
  return "Не получилось. Hub вернул ошибку.";
}

// ── The board's columns ─────────────────────────────────────────────────────

export type ColumnId = "recorded" | "paid" | "checked" | "at_model" | "shot" | "given";

export const COLUMNS: ReadonlyArray<{ id: ColumnId; title: string; states: readonly CustomOrderState[]; empty: string }> = [
  { id: "recorded", title: "Записаны", states: ["recorded"], empty: "Новых нет" },
  { id: "paid", title: "Оплачены", states: ["paid"], empty: "Все оплаченные проверены" },
  { id: "checked", title: "Проверены", states: ["checked"], empty: "Все проверенные у модели" },
  { id: "at_model", title: "У модели", states: ["at_model", "partly", "revision", "refused"], empty: "У модели ничего" },
  { id: "shot", title: "Сняты", states: ["shot"], empty: "Нечего отдавать" },
  { id: "given", title: "Отданы", states: ["given", "closed"], empty: "За неделю не отдавали" },
];

export function columnOf(order: Pick<CustomOrder, "state">): ColumnId | null {
  return COLUMNS.find((column) => column.states.includes(order.state))?.id ?? null;
}

/** A part of an order, as the card orders it. */
export type CustomPart = CustomOrder["partsDone"][number];
export const PART_WORDS: Record<CustomPart, string> = { video: "видео", photos: "фото" };
/** «видео», «видео и фото». */
export const partsWords = (parts: readonly CustomPart[]) => parts.map((part) => PART_WORDS[part]).join(" и ");

export const STATE_TONE: Partial<Record<CustomOrderState, "success" | "warning" | "danger" | "info" | "off">> = {
  checked: "info",
  partly: "info",
  revision: "warning",
  refused: "danger",
  shot: "success",
  given: "success",
  closed: "off",
  cancelled: "off",
};

/** «осталось 2 дня», «сегодня последний день», «просрочен на 3 дня», or nothing without a deadline (Hub's look: one copy). */
export function deadlineWords(order: Pick<CustomBoardOrder, "deadlineOn" | "overdueDays" | "state">, serverNow: string): { text: string; late: boolean } | null {
  return customDeadlineWords(order, serverNow);
}

/** «У кого сейчас»: who leads the order's current step, and where (Hub's look: the extension's fan panel says the same). */
export function leaderWords(order: Pick<CustomOrder, "leader">): string | null {
  return customLeaderWords(order.leader);
}

/** The fan as the board names him: his name, or what the card says while he is not confirmed. */
export function fanWords(order: Pick<CustomBoardOrder, "fan" | "buyer" | "fanErased">): { name: string; confirmed: boolean } {
  if (order.fanErased) return { name: "фан стёрт", confirmed: true };
  if (order.fan) return { name: order.fan.displayName ?? order.fan.username ?? `фан ·${order.fan.fanRef.slice(-4)}`, confirmed: true };
  return { name: order.buyer ?? "покупатель не назван", confirmed: false };
}

export const EVENT_WORDS: Record<string, string> = {
  "custom_order.recorded": "Записан",
  "custom_order.payment": "Оплата привязана",
  "custom_order.payment_removed": "Оплата убрана",
  "custom_order.checked": "Проверен",
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
  "custom_order.settled": "Шаг пересчитан по сообщениям",
  "custom_order.ungiven": "«Отдан» отменён",
  "custom_order.hold": "На паузе",
  "custom_order.unhold": "Снят с паузы",
  "custom_order.issue": "Источники расходятся",
  "custom_order.issue_cleared": "Расхождение снято",
  "custom_order.paid_word": "Слово владельца об оплате",
  "custom_order.fan_asked": "Фан спросил, где заказ",
  "custom_order.sent": "Отправлен фану, не открыт",
};

/** A step of an order's history in words: the event's word, or what its changes make of it (an import, a mark taken off). */
export function eventWords(item: { event: string; changes: Record<string, unknown> }): string {
  if (item.event === "custom_order.recorded" && item.changes.origin === "import") return "Перенесён из старых карточек";
  if (item.event === "custom_order.sent" && item.changes.cleared === true) return "Отметка «отправлен» снята";
  return EVENT_WORDS[item.event] ?? item.event;
}

export const DOOR_WORDS: Record<string, string> = {
  extension: "в расширении",
  workboard: "в Workboard",
  contentops: "в ContentOps",
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
