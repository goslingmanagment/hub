# Операции Fansly, публикации и медиапайплайн FBuddy

Дата проверки: **2026-09-28**. Источник — поставляемый клиент **2026.927.830**, CRX SHA-256 `3fd413555f9d8a4b8754e7ee198f22f1d0d885367e59331c9d1d39c118b8ecce`, [неизменённый пакет](/Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/fbuddy.crx). Ссылки ниже ведут в форматированную проекцию этого пакета. Критические функции сверены с AST неизменённого bundle. Это статическое исследование контрактов и callers; авторизованные запросы, отправки и загрузки не выполнялись. Срез `2026.909.1354` использован только для навигации: его вывод о неактивном native broadcast уже устарел.

Для [Project Browser](../context.md) полезнее всего разделение **платформенного объекта, браузерного исполнения и сохранённого результата**. FBuddy показывает, как получить и связать идентификаторы, но его наличие не доказывает полноту сбора, продолжение после restart или однократность отправки.

## Карта операций

Пути относительно `https://apiv3.fansly.com/api/v1`; upload API — `https://mediav2.fansly.com/api/v1`. В этой таблице «клиент» означает API-клиент в content script; конкретный сетевой транспорт рассмотрен отдельно. `ngsw-bypass=true` опущен.

| Операция | HTTP и существенные поля | Где исполняется; доказательство |
|---|---|---|
| Список диалогов, группа | GET `/messaging/groups`: `sortOrder,flags,subscriptionTierId,listIds,search,limit,offset`; GET `/group/{id}` | Клиент; [группы][groups] |
| История и непрочитанные | GET `/message`: `groupId,limit,offset`; GET `/message/unread`: `limit,offset,before` | Клиент; [read methods][read] |
| Прочтение | POST `/message/ack`: `messageIds,type:2` | Отдельная mutation; [ACK][ack] |
| Создать DM, отправить, typing | POST `/group`: `users,recipients,type`; POST `/message`: `groupId,content,attachments,type,scheduledFor,inReplyTo,createdAt`; POST `/message/typing`: `groupId` | Клиент; [createGroup][group-create], [send и typing][send] |
| Native broadcast | POST `/group`: broadcast `type,groupFlags,groupFlagsMetadata,users,recipients`; POST `/message/broadcast`: message payload | Клиент готовит группу и медиа, Fansly получает одну broadcast-команду; [orchestrator][broadcast] |
| История broadcast | GET `/message/broadcast/stats` и `/message/broadcast/stats/deleted`: `before,limit`; GET `/message/broadcast/scheduled` | Клиент; [methods][broadcast-api], [постраничный caller][broadcast-history] |
| Опубликованные посты | GET `/timelinenew/{accountId}`: `before,after,wallId,contentSearch`; GET `/post`: `ids` | Клиент; [обход стены][timeline], [посты по ID][posts-by-id] |
| Статистика страницы и media offer | GET `/it/amoie/stats`: `beforeDate,afterDate,period,year,month`; GET `/it/moie/statsnew`: `mediaOfferId,beforeDate,afterDate,period` | Клиент; [account stats][account-stats], [media stats][media-stats] |
| Создать пост / расписание | POST `/post`: `content,attachments,scheduledFor,expiresAt,wallIds,postReplyPermissionFlags`; GET `/post/scheduled` | Bulk/Auto Posts в клиенте создают будущие посты; [API][post], [Bulk caller][bulk-send] |
| Переместить / удалить / отменить пост | POST `/wall/postedit`: `postId,wallIds`; POST `/post/{id}/delete`; POST `/post/scheduled/{id}/cancel` | Клиент; [wall edit/delete][post-edit], [cancel][post-cancel] |
| Upload | POST media-host `/media/upload/create`: `fileSize,mimeType,fileName`; PUT каждого `uploadUrl`; POST `/media/upload/complete`; GET `/media/upload/{id}` | Клиент оркестрирует, хранилище принимает parts, Fansly обрабатывает; [pipeline][upload] |
| Создать доступное вложение | POST `/account/media` массив моделей; POST `/account/media/bundle`: `accountMediaModels,permissions,previewId` | Клиент преобразует media в offer; [API][account-media], [attachment caller][attach] |
| Vault | GET `/vault/albumsnew`, `/media/vaultnew`: `albumId` либо `type`, `before,after,mediaType,search`; POST `/vault/albums/media`: `albumId,mediaIds` | Клиент; [Vault API][vault] |
| Права / удаление сообщения / story | POST `/account/media/permissions`, `/account/media/bundle/permissions`; POST `/message/delete`: `messageId,id`; POST `/mediastories`: `contentType,contentId` | Клиент; [permissions][account-media], [delete][delete-message], [story caller][story] |

Здесь **edit post не означает изменение любого поля**: найденный `editWallPost` меняет только стены. Отдельный проверенный контракт редактирования текста/вложений готового поста этим методом не восстановлен. Для Project Browser это пробел следующего исследования, а не поддержанная операция.

## История, аудитория и деньги

Чтение `/message` отделено от ACK. Caller обхода unread берёт страницы по 100, двигает `before` последним `messageId`, проверяет неподвижный cursor; затем история каждой группы читается через `offset` до нахождения нужных сообщений. Вызов ACK находится в отдельном шаге. Полезен сам способ обхода и проверки покрытия; это **не доказательство**, что открытая страница Fansly не отправит собственный ACK. Для требования «без отметок прочтения» Project Browser должен проверять весь browser traffic, а не только свой GET. Этот caller ищет классифицируемые unread, а не подтверждает полную архивную выгрузку. [Обход и отдельный ACK][read-loop].

В [текущем адаптере Hub][hub-adapter] `getMessagesPage` использует для `/message` cursor `before`, а не `offset` этого FBuddy caller. При замене транспорта нужно сохранить контракт Hub и отдельно проверить границы страниц; найденный обход unread не является основанием менять пагинацию архива.

Для аудитории доступны GET `/account/{id}/followersnew` с `before,after,limit,offset,search,lastSeenAfter`, `/subscribers` с `before,after,status,subscriptionTierId,limit,offset,search` и `/subscriptions/tiers`. Реальный Mass DM caller берёт followers по 100 с cursor последнего follower record, subscribers по 100 со смещением. Часть ошибок здесь превращается в пустой массив и завершённый источник — такой результат нельзя переносить в Hub как доказательство исчерпания. Нужны отдельные состояния «пусто», «ошибка», «полностью пройдено». [Endpoints][followers], [callers][audience-loop].

Деньги: `/account/wallets/earnings`, `/account/wallets/earnings/accounts`, `/account/wallets/earnings/monthlystats/accounts`, `/account/wallets/earnings/stats/accounts`, `/account/wallets/earnings/transactions` и новый `/account/wallets/earnings/transactions/accounts`; существенны диапазон `before/after`, `correlationAccountId`, `limit/offset`. Дополнительно есть `/account/stats/{summary,fans,media,media/top,media/benchmarks,tags,activehours}`. Это разные семейства исходных транзакций и агрегатов, их нельзя складывать как независимые доходы. [Wallet methods][wallet], [новые route builders][stats-routes]. Range-loader transactions хранит cache и может вернуть его частичное содержимое после ошибки очередной страницы; полезен cache, но для Hub нужны наблюдения и явные coverage/gap, а не только массив результата. [Range-loader][wallet-loader].

Для первого этапа Project Browser существенны также уже используемые Hub `getAccountStats`, `getMediaOfferStats` и `getPostsPage`; их контракты видны в [адаптере][hub-adapter]. `/it/amoie/stats` получает `beforeDate,afterDate,period,year,month`, `/it/moie/statsnew` — `mediaOfferId,beforeDate,afterDate,period`. Даты и период передаются в миллисекундах. В FBuddy ветка длинного диапазона без preset для платного доступа делит историю на месяцы и читает их параллельно. Сшивание отбрасывает ответы без `dataset`, но в итоговом объекте указывает запрошенные `dateAfter/dateBefore`: успех части запросов может выглядеть цельным диапазоном. Нужны сохранённые ответы и покрытие каждой части, проверка возвращённых границ и явный gap при недостающем месяце. Алгоритм FBuddy не подтверждает, что сервер исполнил все запрошенные границы. [Account loader][account-stats-loader], [media loader][media-stats-loader], [сшивание][stats-stitch], [итоговый диапазон][stats-result].

`fetchPostsFromWall` читает `/timelinenew/{accountId}` с `before:"0"`, `after:"0"`, обязательным для этого caller `wallId` и пустым `contentSearch`; затем переносит последний `post.id` в `before`. Даты постов (`createdAt` в секундах) фильтруются локально после перевода в ms. Пустая страница, повтор cursor и ошибка очередной страницы завершают loop возвратом накопленных данных. Поэтому массив сам по себе не подтверждает полноту. Отдельный `fetchPostsFromWallPage` при невалидном ответе бросает ошибку. В Hub `wallId` опционален, по умолчанию читается account timeline — ограничивать сбор одной стеной при переносе нельзя. [Обход][timeline], [одна страница][timeline-page], [Hub][hub-adapter].

## Личное сообщение и две разные массовые отправки

`createGroup` сначала использует cache, объединяет одновременные creates в одном экземпляре и создаёт direct group из владельца и получателя. `sendMessageToGroup` через `resolveBotGroupId` проверяет служебную bot group; при отсутствии cached ID эта проверка сама вызывает `createGroup(ZT)` и может создать дополнительный DM с FBuddy bot. Затем запускается `announceTyping` **без await** и POST сообщения: порядок обработки typing и сообщения платформой не гарантирован, результат typing не проверяется. Это две дополнительные mutations, которые нельзя скрывать внутри команды отправки Hub. Для Project Browser typing нужен как явно управляемое действие, с отдельным результатом; служебный диалог FBuddy переносить не требуется. Cache/pending map не дают распределённой однократности. [Группа][group-create], [bot resolver][bot-group], [send][send].

**Mass DM** — последовательный клиентский обход получателей, персонализация, создание DM-группы, подготовка вложений, POST сообщения, затем сохранение receipt на FBuddy. Сервер хранит job/revId, recipients и messageId; `runningJobId` и cursors живут в JS. Заново загруженный незавершённый job отображается paused, discovery начинается заново с дедупликацией по сохранённым recipients. Это полезный образец записи индивидуального результата, но не готовая модель возобновления Hub. [Mapping state][mass-state], [send loop][mass-loop].

Сохранились два существенных failure-path: обычные вложения при ошибке подготовки могут стать `ready` с пустым массивом и уйти только текстом; после успешного Fansly send сохранение receipt пробуется до 12 раз, а возвращённый после исчерпания `false` caller не проверяет. Это статические окна частичной доставки и повторного send, не наблюдавшиеся инциденты. Project Browser должен останавливать отправку при неполном наборе обязательных вложений и сохранять неопределённость результата. [Fallback][mass-fallback], [receipt][mass-receipt], [caller][mass-loop].

**Native broadcast в 2026.927.830 уже имеет реальный caller и интерфейс копирования рассылки.** Аудитория передаётся Fansly через group flags: followers, subscribers с/без renewal, expired, исключение creators/offline; списки и явные исключения кодируются отдельно. Caller валидирует аудиторию и модели media, создаёт broadcast group, создаёт account media/bundles и отправляет одну broadcast-команду. Проверки 180 дней вперёд и 100 scheduled broadcasts теперь исполняются кодом; это клиентские границы, не независимое подтверждение серверных лимитов. [Контракт/валидация][broadcast-contract], [orchestrator][broadcast], [UI integration][broadcast-ui].

Оба broadcast POST имеют `retry:false`. UI фиксирует `broadcastAttempted` **до** отправки, запрещает повтор в этом экземпляре и при ошибке предупреждает, что Fansly мог принять запрос. Это полезная семантика для Hub, однако флаг находится в памяти UI, а подготовленные group/media могут остаться после частичного сбоя. Durable outbox и восстановление должны оставаться в Hub. [API][broadcast-api], [UI guard][broadcast-send]. Важно также задавать единицы полей явно: [broadcast caller][broadcast] строит `createdAt` в секундах, [обычный Mass DM][mass-payload] — в миллисекундах; слепое переиспользование payload недопустимо.

## Посты, Bulk и Auto Posts

Bulk Posts в открытом UI готовит account media и bundles, последовательно создаёт посты, считает успешные `postId` и позволяет остановиться между элементами. Нулевое число подготовленных attachments пропускает элемент; уже созданные посты остаются. Локальная константа режима заполнения — [200][bulk-limit]. Это образец частичного batch, но в данном loop нет durable receipt на каждый запланированный элемент. Для Hub нужны отдельные команды/результаты каждого поста и проверка полноты медиа. [Bulk подготовка и loop][bulk], [payload][bulk-send].

Auto Posts сохраняет content bank, последовательный cursor либо shuffle bag, settings и operational state на FBuddy. Schema ограничивает bank 500 элементами, target — 1–200, weekly slots — 336. Браузер раз в минуту читает scheduled posts, считает активные `status:1`, создаёт максимум пять за проход и сохраняет состояние с `expectedUpdatedAt`. Уже созданное расписание передано Fansly; следующее пополнение требует работающего клиента. Weekly rules вычисляются через локальные `Date.getDay/setHours`, то есть timezone браузера существенен. Для шести профилей Project Browser timezone и clock должны быть частью контракта. [Schema][auto-schema], [планирование][auto-time], [предел batch][auto-plan], [create/persist][auto-loop], [runner/recovery][auto-runner].

Успешный POST и сохранение operational state не атомарны; повторный scheduled-list reconciliation помогает сверить количество, но не заменяет связь command→postId. Ошибка чтения scheduled posts возвращает `null` и останавливает создание; последующее успешное чтение снимает соответствующий hold. Это полезное различение ошибки и пустого списка. `expiresAt` строится как время публикации плюс заданная длительность, независимо от срока media URL. [Payload/CAS][auto-payload], [recovery][auto-runner]. Story Scheduler показывает похожую цепочку `posting`→media→Fansly story→`posted` с optimistic concurrency; окно между platform success и записью результата остаётся. [Story][story].

Отмена расписания — отдельный POST `/post/scheduled/{postId}/cancel`. Batch caller вызывает его для каждого выбранного поста и считает успехи/ошибки, но при хотя бы одном успехе удаляет из локального списка **все** выбранные посты, включая неудавшиеся отмены. Исчезновение элемента из такого UI не подтверждает отмену на Fansly. В Hub нужны отдельный результат каждого `postId` и read-only сверка неопределённых исходов через scheduled list; локальное состояние должно сохранять неотменённые и неизвестные элементы. [Метод отмены][post-cancel], [batch caller][post-cancel-loop].

## Единицы полей

Это единицы конкретных builders и readers пакета; одинаковое имя поля в другом endpoint не даёт права переносить единицу автоматически.

| Поле и контекст | Единица и смысл | Доказательство |
|---|---|---|
| `createdAt` в POST native broadcast / обычном Mass DM | Секунды Unix / миллисекунды Unix соответственно | [Broadcast][broadcast], [Mass DM][mass-payload] |
| `scheduledFor` broadcast и поста | Абсолютные ms Unix; `0` в broadcast означает отправку без расписания | [Ввод broadcast через Date.parse][broadcast-send], [post builder][auto-payload] |
| `expiresAt` в content bank / POST поста | В bank — длительность в ms; в POST — `scheduledFor + длительность`, абсолютные ms Unix; `0` без срока | [Auto builder][auto-payload], [Bulk builder][bulk-send] |
| `beforeDate,afterDate,period` в `/it/amoie/stats` и `/it/moie/statsnew` | Границы — абсолютные ms Unix; `period` — длительность ms | [Account][account-stats], [media][media-stats], [Hub][hub-adapter] |
| `createdAt` поста в timeline | Секунды Unix; reader умножает на 1000 для сравнения с ms | [Timeline][timeline] |
| `permissions.permissionFlags[].price` | Mills: 1000 единиц на доллар; редактор умножает долларовый ввод на 1000, вывод делит на 1000 | [Редактор][price-input], [вывод][price-output] |
| `validAfter,validBefore` в permission entry | Временные границы в ms; сериализация FBuddy переименовывает их в `validAfterMs,validBeforeMs` без пересчёта | [Преобразования][permission-time] |

## Media: от файла до вложения

1. Upload create возвращает `id,partSize,parts[index,uploadUrl]`. Клиент последовательно режет File, делает PUT, требует ETag; затем передаёт complete `id,type,partSize,status,parts[index,eTag],waitForComplete:0`.
2. Клиент проверяет `status >= Completed` и наличие `media.id`; между проверками ждёт 2 секунды. После ответа status-запроса проверяется порог ожидания 5 минут, поэтому это не жёсткий deadline всей загрузки. Timeout не доказывает отказ платформы. Progress/cancel и parts находятся в памяти этого вызова: автоматическое возобновление upload после restart здесь не показано.
3. Полученный `mediaId` можно добавить в Vault album. Для сообщения/поста создаётся **другой объект**: `accountMediaId` либо bundle; в attachments передаётся `{contentId,contentType,pos}`, где типы account media/bundle — 1/2. [Upload][upload], [XHR][upload-xhr], [Vault][vault], [account-media][account-media], [attach][attach].

Для Project Browser полезен поэтапный результат с сохранением upload ID, принятых parts/ETags, media ID, offer ID и attachment. Подтверждённые стадии нужно сверять после restart; нельзя заново вызывать весь pipeline из-за одного потерянного ответа. Размер parts и destination URL задаёт ответ Fansly, поэтому статический список upload-hosts недостаточен.

`AbortSignal` прерывает активный XHR PUT либо останавливает локальную последовательность между стадиями; HTTP create/complete/status не получают этот signal. В цепочке нет серверного abort/cleanup. Отмена ожидания потому не доказывает отмену обработки на Fansly, а уже созданные объекты требуют сверки. Если обычный XHR PUT завершился исключением и доступен альтернативный page-context constructor, `uploadPartToS3` повторяет **тот же PUT** через него. Исключение возможно и после принятого PUT, например при недоступном ETag. Этот fallback байтовой части нужно учитывать отдельно от повторов create/complete/публикации; он не является гарантией безопасного повторного запуска pipeline. [Границы signal][upload], [XHR и ETag][upload-xhr], [alternate PUT][upload-put-fallback].

Повторное использование media не требует повторной загрузки байтов: существующий `mediaId` превращается в новый offer с нужными правами и preview. Но **media ID, URL доступа, offer, permissions и срок поста — разные сущности**. Cache TTL ограничивается сроками URL/cookies; refresh запрашивает `/media?ids=...` и сверяет исходные token/account. Это не гарантия вечного существования media. [TTL][media-ttl], [refresh][media-refresh].

Платность/аудитория содержатся в `permissions.permissionFlags`: Price, Follow, SubscriptionTier, List, metadata и `validAfter/validBefore`; внешний `price:0` не доказывает бесплатность. Preview — отдельный `previewId`. В некоторых builders переносится только `permissionFlags`, поэтому сохранность `accountPermissionFlags` нельзя подразумевать. Для Hub необходимо нормализовать и валидировать весь выбранный permission model, цену в явных единицах и полноту preview до отправки. [Permissions][media-permissions], [broadcast builder][broadcast-contract], [attachment builder][attach].

Локальный media processor умеет HLS→файл, извлечение MP3, mux, clipping и canvas-эффекты; персональный скрытый watermark **удалённый**. Клиент получает signed URL, отправляет image/audio bytes и `mediaId,fanAccountId`; `credentials:omit` не делает обработку локальной. Для видео он извлекает аудио, удалённо маркирует его, локально соединяет с видео и заново загружает результат в Fansly. DASH-only/no-HLS и отсутствие аудио имеют отдельные ошибки. Полезно как отдельный processing stage; его стоимость, память, серверная устойчивость watermark и retention из CRX не установлены. [Remote contract][watermark], [video chain][watermark-video], [processor][processor].

## Граница переноса в Hub

Общий `fanslyRequest` допускает до шести попыток, включая mutations без `retry:false`, а адаптивный limiter подбирает частоту по ответам. Эти значения описывают FBuddy, а не безопасные лимиты Fansly. **В Hub нельзя переносить POST retries: одна попытка команды, неопределённый send не повторяется автоматически.** Полезны точные operation contracts, предварительная валидация, account/token pinning, отдельная фиксация подготовленного медиа, cursor progress и platform receipts; leader/cache/browser profile сами по себе их не заменяют. [Request policy][request], [limiter defaults][limiter].

[groups]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:33235
[read]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:32605
[ack]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:32559
[group-create]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:33259
[send]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:33424
[broadcast]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:115832
[broadcast-api]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:33469
[broadcast-history]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:119285
[post]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:33977
[post-edit]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:32479
[upload]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:34113
[upload-xhr]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:34028
[account-media]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:33566
[attach]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:104509
[vault]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:33889
[delete-message]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:34398
[story]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:41783
[read-loop]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:113115
[followers]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:33343
[audience-loop]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:128204
[wallet]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:32545
[stats-routes]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:31074
[wallet-loader]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:32793
[mass-state]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:127685
[mass-loop]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:128943
[mass-payload]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:128845
[mass-fallback]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:128891
[mass-receipt]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:128461
[broadcast-contract]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:115660
[broadcast-ui]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:119400
[broadcast-send]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:117717
[bulk]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:103638
[bulk-limit]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:103089
[bulk-send]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:103849
[auto-schema]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:23721
[auto-time]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:40332
[auto-plan]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:40532
[auto-loop]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:40664
[auto-runner]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:40946
[auto-payload]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:40551
[media-ttl]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:30744
[media-refresh]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:34201
[media-permissions]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:30769
[watermark]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:25086
[watermark-video]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:28545
[processor]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/media-processor.js:32396
[request]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:31466
[limiter]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:11777
[hub-adapter]: ../../../../packages/fansly/src/adapter.ts
[timeline]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:32411
[timeline-page]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:32456
[posts-by-id]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:32513
[account-stats]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:31909
[media-stats]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:32525
[account-stats-loader]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:32301
[media-stats-loader]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:32364
[stats-stitch]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:32058
[stats-result]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:32250
[bot-group]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:33415
[post-cancel]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:34009
[post-cancel-loop]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:227844
[price-input]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:96217
[price-output]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:30844
[permission-time]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:41366
[upload-put-fallback]: /Users/dmitriy/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:34086
