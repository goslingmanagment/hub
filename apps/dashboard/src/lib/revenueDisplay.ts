import { formatMills, formatSignedMills } from "./format.js";

export const SOURCE_LABELS: Record<string, string> = {
  subscription: "Подписки",
  tip: "Чаевые",
  message_purchase: "Платные сообщения",
  post_purchase: "Платные посты",
  stream_tip: "Чаевые в эфире",
  refund: "Возвраты",
  chargeback: "Чарджбэки",
  other: "Прочее",
  payout_reversal: "Отмена выплаты",
};
export const money = (value: number | null | undefined) =>
  value == null ? "—" : formatMills(value);
export const signedMoney = (value: number) => formatSignedMills(value);
