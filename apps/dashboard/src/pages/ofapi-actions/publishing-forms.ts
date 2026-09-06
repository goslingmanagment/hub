import type { OfapiActionField, OfapiActionFormDefinition } from "./form-types.ts";

const field = (name: string, label: string, type: OfapiActionField["type"] = "text", extra: Partial<OfapiActionField> = {}): OfapiActionField => ({ name, label, type, ...extra });
const id = (name: string, label: string) => field(name, label, "text", { required: true });
const media = field("mediaFiles", "Материалы", "strings", { help: "ID материалов из медиатеки этой страницы, по одному на строку. Для загруженного файла используйте полученный ofapi_media ID." });
const preview = field("previews", "Открытые превью", "strings", { help: "ID выбранных выше материалов, которые будут видны до покупки." });
const screen = field("blockBannedWords", "Проверка запрещённых слов", "select", { options: [
  { value: "strict_ban", label: "Все категории" }, { value: "risky", label: "Рискованные и требующие замены" }, { value: "replace_soften", label: "Требующие замены" },
] });
const text = field("text", "Текст", "textarea", { defaultValue: "", help: "Можно оставить пустым, если выбран материал." });
const schedule = field("scheduledDate", "Дата и время публикации", "datetime", { help: "Ваше местное время; на сервер отправляется точное время UTC." });
const saved = field("saveForLater", "Сохранить на потом", "boolean", { help: "Не совмещается с датой публикации." });
const postFields: OfapiActionField[] = [
  text, media,
  field("labelIds", "Метки поста", "strings"),
  field("rfTag", "Участники контента", "strings", { help: "OnlyFans ID авторов, указанных в согласиях на публикацию." }),
  field("expireDays", "Удалить из ленты через, дней", "number", { help: "От 1 до 30. Пустое значение оставляет пост без срока истечения." }),
  schedule, saved, screen,
  field("fundRaisingTargetCents", "Цель сбора, USD", "money"),
  field("fundRaisingTipsPresetCents", "Кнопки чаевых, USD", "money-list", { help: "Суммы через запятую или с новой строки. Не больше цели сбора; целые доллары." }),
  field("votingType", "Опрос или викторина", "select", { options: [{ value: "poll", label: "Опрос" }, { value: "quiz", label: "Викторина" }] }),
  field("votingDue", "Срок голосования, дней", "select", { options: [1, 3, 7, 30].map(value => ({ value, label: String(value) })) }),
  field("votingOptions", "Варианты ответа", "strings", { help: "От 2 до 10 вариантов, по одному на строку." }),
  field("votingCorrectIndex", "Номер правильного ответа", "number", { help: "Только для викторины. Первый вариант имеет номер 0." }),
];
const listHelp = "ID пользовательских списков или системные имена fans, recent, following, rebill_off, tagged. Участников списка определяет OnlyFans при выполнении.";
const campaignFields: OfapiActionField[] = [
  field("userLists", "Списки получателей", "strings", { help: listHelp }),
  field("userIds", "Отдельные получатели", "strings", { help: "OnlyFans ID фанов, по одному на строку. Максимум 1000." }),
  text, media, preview,
  field("priceCents", "Цена сообщения, USD", "money", { help: "0 или от 3 до 200 USD. Платное сообщение требует материала." }),
  field("lockedText", "Скрыть текст до покупки", "boolean"),
  field("giphyId", "GIF из Giphy", "text", { help: "ID выбранного GIF." }), schedule, screen,
];
const overlayFields: OfapiActionField[] = [
  field("text", "Текст или @username", "text", { required: true }),
  field("type", "Тип", "select", { options: [{ value: "text", label: "Текст" }, { value: "mention", label: "Упоминание автора" }] }),
  field("fontFamily", "Шрифт", "select", { options: ["Roboto", "PTMono", "ShantellSans", "SofiaSans", "YanoneKaffeesatz", "RubikMedium", "RubikBlack"].map(value => ({ value, label: value })) }),
  field("fontWeight", "Толщина шрифта", "select", { options: [{ value: 400, label: "Обычный (400)" }, { value: 500, label: "Средний (500)" }, { value: 700, label: "Жирный (700)" }] }),
  field("fontSize", "Размер шрифта, px", "number", { help: "От 8 до 100." }),
  field("color", "Цвет текста", "text", { help: "Например, #FFFFFF." }),
  field("bgColor", "Цвет фона", "text", { help: "#00000000 для прозрачного фона." }),
  field("textAlign", "Выравнивание", "select", { options: [{ value: "left", label: "Слева" }, { value: "center", label: "По центру" }, { value: "right", label: "Справа" }] }),
  field("left", "Отступ слева, %", "number"), field("top", "Отступ сверху, %", "number"),
  field("angle", "Поворот, градусов", "number"), field("scale", "Масштаб", "number"),
  field("zIndex", "Порядок наложения", "number"), field("textWidth", "Ширина текста, px", "number"), field("textHeight", "Высота текста, px", "number"),
];
const highlightFields = [id("title", "Название подборки"), id("coverStoryId", "ID story для обложки"), field("storyIds", "Stories в подборке", "strings", { required: true, help: "Полный список ID. При редактировании заменяет текущий состав." })];
const windowFields = [
  field("publishDateStart", "Начало периода", "text", { required: true, help: "ГГГГ-ММ-ДД, сегодня или позже в выбранном часовом поясе." }),
  field("publishDateEnd", "Конец периода", "text", { required: true, help: "ГГГГ-ММ-ДД; период до 366 дней." }),
  field("timezone", "Часовой пояс", "text", { required: true, defaultValue: "Europe/Moscow", help: "Например, Europe/Moscow или UTC." }),
];
const form = (action: string, label: string, section: string, description: string, fields: OfapiActionField[]): OfapiActionFormDefinition => ({ action, label, section, description, fields });
const postTarget = [id("postId", "ID поста")];
const commentTarget = [...postTarget, id("commentId", "ID комментария")];
const storyTarget = [id("storyId", "ID story")];
const highlightTarget = [id("highlightId", "ID подборки")];
const campaignTarget = [id("campaignId", "ID массовой рассылки")];

export const ofapiPublishingForms: OfapiActionFormDefinition[] = [
  form("post_create", "Создать пост", "Посты", "Публикация сейчас, по расписанию или в «Сохранить на потом». Документация провайдера не определяет цену при создании поста; платная публикация этим действием не заявлена.", [...postFields, preview]),
  form("post_update", "Изменить пост", "Посты", "Изменение опубликованного или запланированного поста. Заполненные списки материалов и меток заменяют текущие; незаполненные поля не отправляются.", [...postTarget, ...postFields, field("priceCents", "Цена поста, USD", "money", { help: "0 или от 3 до 100 целых USD; при ненулевой цене нужен материал." })]),
  form("post_delete", "Удалить пост", "Посты", "Удаляет выбранный пост в OnlyFans.", postTarget),
  form("post_archive", "Архивировать пост", "Посты", "Переносит выбранный пост в архив OnlyFans.", postTarget),
  form("post_unarchive", "Вернуть пост из архива", "Посты", "Возвращает выбранный пост из архива.", postTarget),
  form("post_toggle_pin", "Переключить закрепление поста", "Посты", "OnlyFans переключает текущее состояние: закреплённый пост открепится, незакреплённый закрепится. После неопределённого результата проверьте состояние поста.", postTarget),
  form("post_label_create", "Создать метку постов", "Посты", "Создаёт именованную метку для организации публикаций.", [id("name", "Название метки")]),
  form("post_comment_create", "Оставить комментарий", "Комментарии", "Комментарий к своему посту или ответ на существующий комментарий.", [...postTarget, field("text", "Текст комментария", "textarea", { required: true }), field("answerTo", "ID комментария для ответа"), field("giphyId", "ID GIF из Giphy")]),
  form("post_comment_delete", "Удалить комментарий", "Комментарии", "Удаляет выбранный комментарий под постом.", commentTarget),
  form("post_comment_pin", "Закрепить комментарий", "Комментарии", "Закрепляет выбранный комментарий.", commentTarget),
  form("post_comment_unpin", "Открепить комментарий", "Комментарии", "Снимает закрепление выбранного комментария.", commentTarget),
  form("post_comment_like", "Поставить лайк комментарию", "Комментарии", "Ставит лайк выбранному комментарию.", commentTarget),
  form("post_comment_unlike", "Убрать лайк с комментария", "Комментарии", "Убирает лайк с выбранного комментария.", commentTarget),
  form("story_create", "Опубликовать story", "Stories", "Публикует выбранные материалы с текстом, упоминаниями и стикером вопроса. Упоминание добавляет автора в release forms. Редактирование и расписание stories провайдер не описывает.", [
    { ...media, required: true }, field("texts", "Текст и упоминания поверх story", "rows", { fields: overlayFields }),
    field("questionText", "Вопрос для зрителей"), field("questionColor", "Цвет стикера вопроса", "text", { help: "Например, #FF51DC." }),
    field("questionLeft", "Стикер: отступ слева, %", "number"), field("questionTop", "Стикер: отступ сверху, %", "number"),
    field("questionWidth", "Ширина стикера, px", "number"), field("questionHeight", "Высота стикера, px", "number"),
    field("canvasWidth", "Ширина холста, px", "number"), field("canvasHeight", "Высота холста, px", "number"),
  ]),
  form("story_delete", "Удалить story", "Stories", "Удаляет выбранную story в OnlyFans.", storyTarget),
  form("story_mark_watched", "Отметить story просмотренной", "Stories", "Меняет статус просмотра выбранной story.", storyTarget),
  form("highlight_create", "Создать highlight", "Highlights", "Создаёт подборку stories с названием и обложкой.", highlightFields),
  form("highlight_update", "Изменить highlight", "Highlights", "Передаёт полные название, обложку и состав подборки. Сохраните прежние значения, которые не нужно менять.", [...highlightTarget, ...highlightFields]),
  form("highlight_delete", "Удалить highlight", "Highlights", "Удаляет выбранную подборку.", highlightTarget),
  form("highlight_add_story", "Добавить story в highlight", "Highlights", "Добавляет одну выбранную story в подборку.", [...highlightTarget, ...storyTarget]),
  form("highlight_remove_story", "Убрать story из highlight", "Highlights", "Убирает story из подборки.", [...highlightTarget, ...storyTarget]),
  form("campaign_create", "Создать массовую рассылку", "Рассылки", "Выберите получателей, материал, цену и время. Подтверждение приёма запроса не означает доставку всем получателям; состав списков раскрывает OnlyFans при выполнении.", [...campaignFields,
    field("excludedLists", "Исключить списки", "strings", { help: listHelp }),
    field("subscribedWithinLastDays", "Подписались за последние N дней", "number", { help: "От 1 до 30, включая сегодня. Этот фильтр несовместим с расписанием и «Сохранить на потом»." }),
    field("rfTag", "ID авторов контента", "strings"), field("rfPartner", "ID партнёров в release forms", "strings"), field("rfGuest", "ID гостей в release forms", "strings"), saved,
  ]),
  form("campaign_update", "Изменить массовую рассылку", "Рассылки", "Меняет текст, получателей, материалы, цену или дату существующей рассылки. Получателей нужно выбрать явно. Исключения и фильтр недавней подписки для изменения не документированы.", [...campaignTarget, ...campaignFields]),
  form("campaign_cancel", "Отменить или отозвать рассылку", "Рассылки", "Удаляет запланированную рассылку либо отзывает недавно отправленную, если OnlyFans ещё разрешает это. Купленный контент остаётся доступен покупателям.", campaignTarget),
  form("queue_list", "Посмотреть очередь публикаций", "Очередь", "Посты и массовые сообщения за выбранный период. Один запрос возвращает до 100 элементов; полный список не гарантируется.", [...windowFields, field("limit", "Количество элементов", "number", { defaultValue: 20 }), field("types", "Типы публикаций", "strings", { options: [{ value: "post", label: "Посты" }, { value: "chat", label: "Рассылки" }] })]),
  form("queue_counts", "Посчитать публикации в очереди", "Очередь", "Количество постов и сообщений по датам в выбранном часовом поясе.", windowFields),
  form("queue_publish", "Опубликовать элемент очереди сейчас", "Очередь", "Запускает выбранный пост или массовое сообщение немедленно, независимо от расписания. Для рассылки это начало выполнения, а не подтверждение доставки всем.", [id("queueId", "ID элемента очереди")]),
];
