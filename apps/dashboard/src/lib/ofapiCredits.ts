import { formatUsdFromMills } from "@agency_hub_core/shared";
import { ruPlural } from "@/lib/plural";

// OnlyFans API credits in words: one version for Деньги → Расходы → OnlyFans API
// and Система → OnlyFans API.

/** Plain names of the ledger's operation codes: the hub's own collection, chatters'
 *  commands, reads for the desktop app. An unknown code stays as it is. */
const OPERATION_LABELS: Readonly<Record<string, string>> = {
  ofapi_chats: "Сбор чатов",
  ofapi_chat_messages: "Сбор сообщений",
  ofapi_dm_conversations: "Сбор диалогов",
  ofapi_transactions: "Сбор операций",
  ofapi_fans_active: "Сбор активных фанов",
  ofapi_fans_expired: "Сбор истёкших фанов",
  ofapi_audience: "Сбор аудитории",
  ofapi_audience_sweep: "Обход аудитории",
  ofapi_sync_events: "Сбор событий",
  ofapi_balance_ping: "Проверка баланса",
  ofapi_admin_accounts: "Проверка аккаунта",
  ofapi_webhook_crud: "Настройка событий",
  ofapi_command_send_text: "Отправка сообщения",
  ofapi_command_send_media: "Отправка медиа",
  ofapi_command_mark_chat_read: "Отметка чата прочитанным",
  ofapi_command_unsend_message: "Отзыв сообщения",
  ofapi_command_typing_active: "Индикатор набора",
  ofapi_gateway_chats: "Чаты (приложение)",
  ofapi_gateway_chat_message: "Сообщение чата (приложение)",
  ofapi_gateway_chat_messages: "Сообщения чата (приложение)",
  ofapi_gateway_chat_media: "Медиа чата (приложение)",
  ofapi_gateway_users_list: "Поиск фанов (приложение)",
  ofapi_gateway_user: "Профиль фана (приложение)",
  ofapi_gateway_transactions: "Операции (приложение)",
  ofapi_gateway_fans_active: "Активные фаны (приложение)",
  ofapi_gateway_fans_expired: "Истёкшие фаны (приложение)",
  ofapi_gateway_user_lists: "Списки фанов (приложение)",
  ofapi_gateway_user_list_users: "Участники списка (приложение)",
  ofapi_gateway_vault_media: "Медиа медиатеки (приложение)",
  ofapi_gateway_vault_lists: "Списки медиатеки (приложение)",
  ofapi_gateway_vault_media_item: "Файл медиатеки (приложение)",
  ofapi_gateway_upload_status: "Статус загрузки (приложение)",
};
export const operationLabel = (operation: string) => OPERATION_LABELS[operation] ?? operation;

export const fmtCredits = (value: number) => value.toLocaleString("ru-RU");
export const creditsWord = (value: number) => ruPlural(value, "кредит", "кредита", "кредитов");
/** «1 500 кредитов»: the amount with its unit, for prose. */
export const credits = (value: number) => `${fmtCredits(value)} ${creditsWord(value)}`;

/** Micro-USD per credit → dollars, through the shared mills formatter. */
export function creditsToUsd(amount: number, microUsdPerCredit: number) {
  return formatUsdFromMills(Math.round((amount * microUsdPerCredit) / 1000));
}
