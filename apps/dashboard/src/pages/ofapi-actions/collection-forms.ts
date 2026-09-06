import type { OfapiActionField, OfapiActionFormDefinition } from "./form-types";

const listId: OfapiActionField = { name: "listId", label: "ID списка", type: "text", required: true, help: "ID из списка OnlyFans. Для пользовательских списков допустимы также friends и tagged." };
const vaultListId: OfapiActionField = { name: "listId", label: "ID папки vault", type: "text", required: true };
const userId: OfapiActionField = { name: "userId", label: "ID пользователя OnlyFans", type: "text", required: true };
const fanId: OfapiActionField = { name: "fanId", label: "ID фана OnlyFans", type: "text", required: true };
const userName: OfapiActionField = { name: "name", label: "Название списка", type: "text", required: true, help: "До 64 символов." };
const vaultName: OfapiActionField = { name: "name", label: "Название папки vault", type: "text", required: true, help: "До 255 символов." };
const mediaIds: OfapiActionField = { name: "mediaIds", label: "ID материалов", type: "strings", required: true, help: "По одному ID в строке, до 1000 уникальных материалов." };

export const ofapiCollectionForms: OfapiActionFormDefinition[] = [
  { action: "user_list_create", section: "Списки фанов", label: "Создать список фанов", description: "Создать пользовательский список в выбранном аккаунте OnlyFans.", fields: [userName] },
  { action: "user_list_update", section: "Списки фанов", label: "Изменить список фанов", description: "Изменить название и, при выборе, закрепление списка в ленте OnlyFans.", fields: [listId, userName, { name: "isPinnedToFeed", label: "Закрепление в ленте", type: "select", options: [{ value: true, label: "Закрепить" }, { value: false, label: "Открепить" }], help: "Оставьте пустым, чтобы сохранить текущее закрепление." }] },
  { action: "user_list_delete", section: "Списки фанов", label: "Удалить список фанов", description: "Удалить выбранный список в OnlyFans.", fields: [listId] },
  { action: "user_list_add_users", section: "Списки фанов", label: "Добавить фанов в список", description: "Добавить выбранных пользователей. Результат с пропуском отклонённых ID показывает отдельно добавленных и отклонённых фанов.", fields: [listId, { name: "ids", label: "ID пользователей", type: "strings", required: true, help: "По одному ID в строке, до 1000 уникальных пользователей." }, { name: "skip_invalid", label: "Пропускать отклонённые ID", type: "boolean", defaultValue: false, help: "Провайдер может выполнить до пяти внутренних попыток: резерв до 5 credits вместо 1." }] },
  { action: "user_list_clear", section: "Списки фанов", label: "Очистить список фанов", description: "Удалить всех участников из выбранного списка OnlyFans.", fields: [listId] },
  { action: "user_list_remove_user", section: "Списки фанов", label: "Убрать фана из списка", description: "Удалить одного выбранного пользователя из списка.", fields: [listId, userId] },
  { action: "user_list_pin_toggle", section: "Списки фанов", label: "Переключить закрепление фана", description: "OnlyFans переключит текущее закрепление пользователя в этом списке. Перед действием проверьте текущий список закреплённых; после неопределённого результата проверьте его снова.", fields: [listId, userId] },
  { action: "vault_list_create", section: "Медиатека", label: "Создать папку vault", description: "Создать список материалов в vault выбранного аккаунта.", fields: [vaultName] },
  { action: "vault_list_update", section: "Медиатека", label: "Переименовать папку vault", description: "Изменить название выбранного списка материалов.", fields: [vaultListId, vaultName] },
  { action: "vault_list_delete", section: "Медиатека", label: "Удалить папку vault", description: "Удалить выбранный список материалов в OnlyFans.", fields: [vaultListId] },
  { action: "vault_list_add_media", section: "Медиатека", label: "Добавить материалы в папку", description: "Добавить существующие материалы vault в выбранный список.", fields: [vaultListId, mediaIds] },
  { action: "vault_list_remove_media", section: "Медиатека", label: "Убрать материалы из папки", description: "Убрать выбранные материалы из списка; файлы останутся в vault.", fields: [vaultListId, mediaIds] },
  { action: "vault_media_delete", section: "Медиатека", label: "Удалить материалы из vault", description: "Удалить выбранные материалы из vault аккаунта OnlyFans. Это отдельное действие от удаления из папки.", fields: [mediaIds] },
  { action: "user_block", section: "Модерация", label: "Заблокировать пользователя", description: "Заблокировать доступ выбранного пользователя к профилю OnlyFans.", fields: [userId] },
  { action: "user_unblock", section: "Модерация", label: "Разблокировать пользователя", description: "Снять блокировку выбранного пользователя.", fields: [userId] },
  { action: "user_restrict", section: "Модерация", label: "Ограничить пользователя", description: "Ограничить пользователя: его сообщения и комментарии перестанут отображаться аккаунту.", fields: [userId] },
  { action: "user_unrestrict", section: "Модерация", label: "Снять ограничение пользователя", description: "Возобновить отображение сообщений и комментариев выбранного пользователя.", fields: [userId] },
  { action: "fan_notes_get", section: "Заметки OnlyFans", label: "Прочитать заметку OnlyFans", description: "Получить текущую заметку фана из OnlyFans. Она хранится отдельно от локальных заметок Hub.", fields: [fanId] },
  { action: "fan_notes_update", section: "Заметки OnlyFans", label: "Записать заметку OnlyFans", description: "Заменить заметку выбранного фана в OnlyFans. Локальные заметки Hub не изменяются.", fields: [fanId, { name: "notes", label: "Текст заметки OnlyFans", type: "textarea", required: true, help: "До 16 000 символов. Для удаления заметки используйте действие очистки." }] },
  { action: "fan_notes_clear", section: "Заметки OnlyFans", label: "Очистить заметку OnlyFans", description: "Удалить текущую заметку фана в OnlyFans. История локальных заметок Hub сохраняется.", fields: [fanId] },
];
