import { ofapiSocialButtonTypes } from "../../../../../packages/contracts/src/ofapi-actions-account.ts";
import type { OfapiActionField, OfapiActionFormDefinition } from "./form-types.ts";

const pagination: OfapiActionField[] = [
  { name: "limit", label: "Записей на странице", type: "number", required: true, defaultValue: 10, help: "От 1 до 100. Каждый запрос загружает одну страницу." },
  { name: "offset", label: "Пропустить записей", type: "number", required: true, defaultValue: 0 },
];
const period: OfapiActionField = { name: "period", label: "Интервал", type: "select", required: true, defaultValue: 24, options: [6, 12, 24, 48].map(value => ({ value, label: `Каждые ${value} ч` })) };
const buttonId: OfapiActionField = { name: "buttonId", label: "ID кнопки", type: "text", required: true, help: "ID из результата «Социальные кнопки»." };
const mediaHelp = "ID материалов из медиатеки или завершённой загрузки. По одному на строку.";
const read = (action: string, label: string, section: string, description: string, fields: OfapiActionField[] = []): OfapiActionFormDefinition => ({ action, label, section, description, fields });

export const ofapiAccountForms: OfapiActionFormDefinition[] = [
  read("bank_payout_details_read", "Банковские реквизиты", "Банкинг и выплаты", "Показать сохранённые реквизиты и требования платёжного метода. Данные доступны только владельцу."),
  read("bank_legal_form_read", "Юридическая форма", "Банкинг и выплаты", "Показать юридическую форму аккаунта и доступные варианты. Изменение формы этим API не предусмотрено."),
  read("bank_legal_tax_status_read", "Налоговый и юридический статус", "Банкинг и выплаты", "Показать статус налоговых данных и проверки личности; чтение ничего не меняет."),
  read("bank_dac7_form_read", "Данные DAC7", "Банкинг и выплаты", "Показать налоговую форму DAC7 выбранного аккаунта. Данные доступны только владельцу."),
  read("bank_account_country_read", "Страна аккаунта", "Банкинг и выплаты", "Показать страну банковского профиля и требования к выплатам."),
  read("bank_countries_read", "Страны для выплат", "Банкинг и выплаты", "Получить справочник стран провайдера."),
  read("bank_payout_systems_read", "Способы выплат", "Банкинг и выплаты", "Показать доступные платёжные системы и их требования."),
  read("payout_eligibility_read", "Доступность выплат", "Банкинг и выплаты", "Показать текущую возможность запросить выплату. Это не запрос вывода денег."),
  { action: "payout_frequency_update", label: "Частота выплат", section: "Банкинг и выплаты", description: "Изменить расписание выплат в OnlyFans. Еженедельный и ежемесячный режимы выполняет провайдер.", fields: [{ name: "frequency", label: "Частота", type: "select", required: true, options: [{ value: "manual", label: "Вручную" }, { value: "weekly", label: "Еженедельно" }, { value: "monthly", label: "Ежемесячно" }] }] },
  { action: "payout_withdrawal_request", label: "Запросить вывод денег", section: "Банкинг и выплаты", description: "Создать заявку в ручном режиме выплат. Сумма должна соответствовать текущим лимитам и балансу OnlyFans. Подтверждение означает принятую заявку, а не поступление денег в банк.", fields: [{ name: "amountCents", label: "Сумма, USD", type: "money", required: true, help: "Провайдер документирует целые доллары. Перед запросом проверьте баланс, лимиты и ручную частоту выплат." }] },
  read("saved_messages_read", "Отложенные сообщения", "Автоматические сценарии", "Показать одну страницу сообщений Saved for Later. Чтение не запускает рассылку.", pagination),
  read("saved_message_settings_read", "Настройки авторассылки", "Автоматические сценарии", "Показать действующие настройки отправки сообщений Saved for Later."),
  { action: "saved_message_autosend_update", label: "Включить или изменить авторассылку", section: "Автоматические сценарии", description: "OnlyFans будет отправлять сохранённые сообщения с выбранным интервалом. Сначала проверьте содержимое Saved for Later и действующие настройки. Расписание продолжит работать у провайдера после закрытия Hub.", fields: [period] },
  { action: "saved_message_autosend_disable", label: "Отключить авторассылку", section: "Автоматические сценарии", description: "Отключить автоматическую отправку Saved for Later в OnlyFans. Уже отправленные сообщения сохраняются.", fields: [] },
  read("saved_posts_read", "Отложенные посты", "Автоматические сценарии", "Показать одну страницу постов Saved for Later. Чтение не публикует контент.", pagination),
  read("saved_post_settings_read", "Настройки автопубликации", "Автоматические сценарии", "Показать действующие настройки публикации постов Saved for Later."),
  { action: "saved_post_autopost_update", label: "Включить или изменить автопубликацию", section: "Автоматические сценарии", description: "OnlyFans будет публиковать сохранённые посты с выбранным интервалом. Сначала проверьте Saved for Later. Расписание продолжит работать у провайдера после закрытия Hub.", fields: [period] },
  { action: "saved_post_autopost_disable", label: "Отключить автопубликацию", section: "Автоматические сценарии", description: "Отключить автоматическую публикацию Saved for Later в OnlyFans. Опубликованные посты сохраняются.", fields: [] },
  read("account_settings_read", "Настройки аккаунта", "Профиль и настройки", "Показать текущие настройки выбранного аккаунта."),
  { action: "account_profile_update", label: "Изменить профиль", section: "Профиль и настройки", description: "Заполните только поля, которые хотите изменить. Пустые необязательные поля сохраняют текущие значения. Для удаления значения выберите поле в списке очистки.", fields: [
    { name: "username", label: "Имя пользователя", type: "text", help: "Сначала выполните проверку доступности имени." },
    { name: "name", label: "Отображаемое имя", type: "text" },
    { name: "avatar", label: "Новый аватар", type: "text", help: "ID завершённой загрузки вида ofapi_media_…" },
    { name: "header", label: "Новый баннер", type: "text", help: "ID завершённой загрузки вида ofapi_media_…" },
    { name: "about", label: "О себе", type: "textarea" }, { name: "location", label: "Местоположение", type: "text" },
    { name: "website", label: "Сайт", type: "text" }, { name: "wishlist", label: "Список желаний", type: "text" },
    { name: "clearFields", label: "Очистить поля", type: "strings", options: [{ value: "name", label: "Отображаемое имя" }, { value: "about", label: "О себе" }, { value: "location", label: "Местоположение" }, { value: "website", label: "Сайт" }, { value: "wishlist", label: "Список желаний" }], help: "Выбранные значения будут удалены. Имя вернётся к стандартному." },
  ] },
  { action: "subscription_price_update", label: "Цена подписки", section: "Профиль и настройки", description: "Изменить цену подписки на этот аккаунт. OnlyFans разрешает менять её не более трёх раз в сутки.", fields: [{ name: "priceCents", label: "Цена, USD", type: "money", required: true, help: "0 — бесплатный аккаунт; платная подписка — от 4,99 до 200 USD." }] },
  read("blocked_countries_read", "Геоблокировки", "Профиль и настройки", "Показать текущий список стран и регионов с ограниченным доступом."),
  { action: "blocked_countries_update", label: "Изменить геоблокировки", section: "Профиль и настройки", description: "Полностью заменить списки стран и регионов, включая текущие ограничения. Пустой список снимает соответствующие ограничения; сначала прочитайте действующие геоблокировки.", fields: [
    { name: "blockedCountries", label: "Заблокированные страны", type: "strings", required: true, help: "Двухбуквенные коды ISO в верхнем регистре, по одному на строку: RU, US. Пустой список разблокирует все страны." },
    { name: "blockedStates", label: "Заблокированные регионы", type: "strings", required: true, help: "Значения из текущих настроек OnlyFans. Пустой список снимает ограничения по регионам." },
  ] },
  read("welcome_message_read", "Приветственное сообщение", "Приветственное сообщение", "Показать текст, вложения, цену и состояние автоматического приветствия."),
  { action: "welcome_message_enabled_update", label: "Включить или отключить приветствие", section: "Приветственное сообщение", description: "Изменить автоматическое приветствие новых подписчиков в OnlyFans.", fields: [{ name: "enabled", label: "Приветствие включено", type: "boolean", required: true }] },
  { action: "welcome_message_update", label: "Изменить приветствие", section: "Приветственное сообщение", description: "Сохранить новый шаблон для будущих подписчиков. Текст или вложение обязательны. Состояние отправки управляется отдельным действием.", fields: [
    { name: "text", label: "Текст", type: "textarea" }, { name: "lockedText", label: "Скрыть текст до покупки", type: "boolean", defaultValue: false },
    { name: "priceCents", label: "Цена, USD", type: "money", required: true, defaultValue: 0, help: "0 либо от 3 до 200 целых USD. Платный шаблон должен содержать медиа." },
    { name: "mediaFiles", label: "Вложения", type: "strings", help: mediaHelp },
    { name: "previews", label: "Бесплатные превью", type: "strings", help: "Выберите ID из списка вложений. Эти материалы видны до покупки." },
    { name: "rfTag", label: "Отмеченные авторы", type: "strings", help: "OnlyFans ID авторов, по одному на строку." },
    { name: "rfGuest", label: "Участники по release form", type: "strings", help: "ID гостей из release forms, по одному на строку." },
    { name: "rfPartner", label: "Партнёры по release form", type: "strings", help: "ID партнёров из release forms, по одному на строку." },
    { name: "isForward", label: "Пересланное сообщение", type: "boolean" },
  ] },
  read("account_drm_read", "Состояние DRM", "Профиль и настройки", "Показать действующую настройку защиты медиа."),
  { action: "account_drm_update", label: "Изменить DRM", section: "Профиль и настройки", description: "Изменить защиту медиа в настройках OnlyFans. Результат показывает принятие настройки; он не подтверждает переработку ранее загруженных файлов.", fields: [{ name: "enabled", label: "DRM включён", type: "boolean", required: true }] },
  read("username_availability_read", "Проверить имя пользователя", "Профиль и настройки", "Проверить доступность имени. Профиль останется без изменений.", [{ name: "username", label: "Имя пользователя", type: "text", required: true }]),
  { action: "social_buttons_reorder", label: "Порядок социальных кнопок", section: "Социальные кнопки", description: "Задать полный порядок существующих кнопок. Сначала получите актуальный список.", fields: [{ name: "buttonIds", label: "ID кнопок в нужном порядке", type: "strings", required: true, help: "По одному на строку, без повторений." }] },
  read("social_buttons_read", "Социальные кнопки", "Социальные кнопки", "Показать кнопки профиля, их ID, адреса и текущий порядок."),
  { action: "social_button_create", label: "Добавить социальную кнопку", section: "Социальные кнопки", description: "Добавить ссылку в профиль выбранного аккаунта.", fields: [{ name: "label", label: "Подпись", type: "text", required: true }, { name: "type", label: "Площадка", type: "select", required: true, options: ofapiSocialButtonTypes.map(value => ({ value, label: value })) }, { name: "value", label: "Имя пользователя или ссылка", type: "text", required: true }] },
  { action: "social_button_update", label: "Переименовать социальную кнопку", section: "Социальные кнопки", description: "Провайдер поддерживает изменение подписи. Для другой ссылки или площадки создайте новую кнопку.", fields: [buttonId, { name: "label", label: "Новая подпись", type: "text", required: true }] },
  { action: "social_button_delete", label: "Удалить социальную кнопку", section: "Социальные кнопки", description: "Удалить выбранную кнопку из профиля OnlyFans.", fields: [buttonId] },
];
