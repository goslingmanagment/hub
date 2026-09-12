import { formatUsdFromMills } from "@agency_hub_core/shared";

export const SOURCE_LABELS: Record<string, string> = {
  subscription: "Подписки",
  tip: "Чаевые",
  message_purchase: "Платные сообщения",
  post_purchase: "Платные посты",
  stream_tip: "Чаевые в эфире",
  refund: "Возвраты",
  chargeback: "Чарджбэки",
  other: "Без классификации",
  payout_reversal: "Отмена выплаты",
};
export const money = (value: number | null | undefined) =>
  value == null ? "—" : formatUsdFromMills(value);
export const signedMoney = (value: number) =>
  `${value > 0 ? "+" : ""}${formatUsdFromMills(value)}`;
