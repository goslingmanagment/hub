/**
 * A custom order's words beside its step (products plan §4.5): its deadline and who has it now — the same in
 * Workboard's «Кастомы» and in the extension's fan panel (vendored), never a second copy. The step's own word is the
 * contracts' CUSTOM_STATE_WORDS («Записан», «Оплачен», «Проверен», «У модели», «Снят», «Отдан»).
 */
import { ruPlural } from "./plural.js";

const MSK_OFFSET_MS = 3 * 3_600_000;
const moscowDayOfMs = (ms: number) => new Date(ms + MSK_OFFSET_MS).toISOString().slice(0, 10);
const daysWord = (days: number) => `${days} ${ruPlural(days, "день", "дня", "дней")}`;
const dotted = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
/** The steps an order is still to be shot or given in (not given, not ended). */
const STILL_TO_SHOOT: readonly string[] = ["recorded", "paid", "checked", "at_model", "partly", "revision"];

/** «осталось 2 дня, до 17.11», «сегодня последний день», «просрочен на 3 дня», or nothing without a deadline. */
export function customDeadlineWords(
  order: { readonly deadlineOn: string | null; readonly overdueDays: number | null; readonly state: string },
  serverNow: string,
): { text: string; late: boolean } | null {
  if (order.deadlineOn === null) return null;
  if (order.overdueDays !== null) return { text: `просрочен на ${daysWord(order.overdueDays)}`, late: true };
  if (!STILL_TO_SHOOT.includes(order.state)) return { text: `срок был ${dotted(order.deadlineOn)}`, late: false };
  const today = moscowDayOfMs(Date.parse(serverNow));
  const left = Math.round((Date.parse(`${order.deadlineOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (left <= 0) return { text: "сегодня последний день", late: false };
  return { text: `осталось ${daysWord(left)}, до ${dotted(order.deadlineOn)}`, late: false };
}

/** «У кого сейчас»: who leads the order's current step, and where («в ContentOps» for the shooting); null — nobody named. */
export function customLeaderWords(leader: { readonly name: string | null; readonly product: string } | null): string | null {
  if (leader === null) return null;
  const who = leader.name ?? "владелец";
  return leader.product === "contentops" ? `${who}, в ContentOps` : who;
}
