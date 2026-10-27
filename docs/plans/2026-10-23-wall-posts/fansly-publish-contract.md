# Fansly: контракт публикации (этап 0)

Снято 2026-10-24 с самого сайта, на тестовой модели агентства. Инструмент — `pnpm see:session --bare`
из chat-extension (Firefox без окна, вход из `FANSLY_TEST_MODEL_*`, все запросы страницы с телами).
Посты делались руками через обычную форму сайта. Каждый пост — отложенный на +30 дней и сразу снятый.
Сториз — только подписчикам, удалена через минуту. Наружу ничего не вышло, отложенных постов нет.
Позже, с «да» владельца, — два настоящих поста (закрыты подпиской): один сразу и один отложенный на 10 минут,
чтобы увидеть ответ поста сразу и выход отложенного. Оба удалены (12 и 2 минуты на ленте).
Тестовые файлы (однотонные фото с сеткой, тестовое видео 45 МБ) остались в медиатеке модели.

Отличия от стенда (сессия 0.2): Firefox вместо Chrome браузера страницы и IP Мака вместо тестового
прокси. На пути, тела и ID это не влияет. Сопутствующие запросы Chrome могут отличаться. Проверка
самого стенда в режиме записи остаётся за сессией 0.2.

## 1. Общее

- Хосты: `apiv3.fansly.com/api/v1/…` — вложения, пост, расписание, сториз;
  `mediav2.fansly.com/api/v1/media/upload/…` — загрузка; S3
  `fansly-upload.s3.eu-central-1.amazonaws.com/<accountId>/<uploadId>` — части файла.
- Запросы к `apiv3` и `mediav2` — с `?ngsw-bypass=true` и заголовком `authorization: <токен сессии>`,
  тело — JSON. Ответ — `{"success": true, "response": …}`.
- Деньги — тысячные доли доллара (`7500` = $7.50), как деньги в Hub.
- Время — миллисекунды UTC (`scheduledFor`, `expiresAt`).
- Сайт шлёт загрузку параллельно (все `create` разом, части S3 разом). Hub шлёт по одному запросу
  с паузой (spec §5): порядок шагов от этого не меняется.
- В сокет `wsv3.fansly.com` при публикации сайт ничего не пишет (только пинг `p` и вход `t:1`).

## 2. Загрузка файла

| Шаг | Запрос | Тело | Ответ |
|---|---|---|---|
| 1 | `POST mediav2…/media/upload/create` | `{fileSize, mimeType, fileName, uploadFormData: {formInputs: [{type:1001,value:"false"}, {type:1002,value:"false"}, {type:1003,value:""}, {type:1004,value:""}, {type:1005,value:"\"\""}]}}` | `{id: <uploadId>, type: 1 фото / 2 видео, partSize: 20971520, status: 2, parts: [{index, uploadUrl}]}` |
| 2 | `PUT <uploadUrl>` на каждую часть | байты части | 200, нужен заголовок `ETag` |
| 3 | `POST mediav2…/media/upload/complete` | `{id, type, partSize, status: 0, parts: [{index, eTag}], waitForComplete: 0}` | `status: 3`, `mediaId: null` |
| 4 | `GET mediav2…/media/upload/<uploadId>` — опрос | — | `status` 4 → 5 → 6; на 6 есть `mediaId` и объект `media` |

- `formInputs` одинаковы для фото, видео, превью и сториз. Смысл полей не виден, Hub повторяет как есть.
- Части по 20 МиБ: видео 45 МБ = 3 части. `uploadUrl` — подписанный адрес S3 на 24 ч
  (`X-Amz-Expires=86400`). Его не журналить, как подписи CDN.
- Время до `status: 6` после `complete`: фото — 2–6 с, видео 45 МБ / 40 с — 20 с. Сайт опрашивает
  раз в 2–3 с. Картинка приходит обратно как JPEG (`test-card.png` → `test-card.jpeg`).
- **Повторная загрузка того же файла** даёт новый `uploadId`, но на `status: 6` возвращает **старый
  `mediaId`**: Fansly узнаёт файл по содержимому, дубликата в медиатеке нет. Для Hub это значит:
  загрузку с потерянным ответом можно сверить по `uploadId` (spec §7), а повтор того же файла не
  плодит медиа.
- Превью загружается так же, отдельным файлом. Его `mediaId` идёт в `previewId` медиа (§3).
- «Upload to Vault» (загрузка прямо в медиатеку, без поста) идёт тем же путём; отличие одно —
  `uploadFormData: null` вместо `formInputs`.
- `POST mediav2…/media` (старая загрузка одним запросом: `FormData` с `metadata` и `file`) в коде
  сайта есть (`uploadMedia`, `processAccountMediaCreateModel2`), но ни форма поста, ни сториз, ни
  «Upload to Vault» ею не пользуются. Hub её не повторяет.

**Заголовки и preflight** (журнал сети браузера, «Upload to Vault», 2026-10-24):

| Запрос | Заголовки запроса | Preflight | Ответ |
|---|---|---|---|
| `POST/GET mediav2…` | как у `apiv3`: `authorization`, `fansly-client-id`, `fansly-client-ts`, `fansly-session-id`, `fansly-client-check` (свой у каждого запроса), `Content-Type: application/json`, `Origin`/`Referer: https://fansly.com` | `OPTIONS` → 204, `access-control-allow-origin: https://fansly.com`, `allow-credentials: true` | JSON через CloudFront |
| `PUT` части на S3 | **без авторизации и без `Content-Type`**: тело — сырые байты, `Content-Length`, заголовок `ngsw-bypass: true`, `Origin`/`Referer` | `OPTIONS` (из-за `ngsw-bypass`) → 200, `Access-Control-Allow-Origin: *`, `Allow-Methods: GET, POST, PUT`, `Allow-Headers: ngsw-bypass`, `Expose-Headers: Etag` | 200, пустое тело, `ETag: "<md5>"` — его и кладут в `complete` |

Для PR 8: часть файла — простой PUT по подписанному адресу. Секретов в нём нет, подпись — в самом
адресе. `ETag` браузер отдаёт скрипту, потому что S3 открывает его через `Expose-Headers`.

## 3. Вложение: кто видит и цена

**Один файл** — `POST apiv3…/account/media`, тело — массив:

```json
[{ "mediaId": "<mediaId>", "previewId": null, "permissionFlags": 0, "price": 0,
   "whitelist": [], "permissions": { "permissionFlags": [ … ] }, "tags": [] }]
```

Ответ — массив `accountMedia`. Его `id` — это `contentId` поста с `contentType: 1`.

**Несколько файлов** (сайт сам делает пачку, если файлов больше одного) —
`POST apiv3…/account/media/bundle`:

```json
{ "previewId": null, "permissionFlags": 0, "price": 0,
  "accountMediaModels": [
    { "mediaId": "<m1>", "previewId": "<превью m1>", "permissionFlags": 0, "price": 0, "whitelist": [] },
    { "mediaId": "<m2>", "previewId": null, "permissionFlags": 0, "price": 0, "whitelist": [] } ],
  "whitelist": [], "permissions": { "permissionFlags": [ … ] }, "tags": [] }
```

Ответ — `accountMediaBundles[0].id` (это `contentId` с `contentType: 2`) и `accountMedia` по
каждому файлу. Файлы пачки получают тот же флаг (`flags: 1`), но цена у них только в `metadata`,
`price: 0` — цена у пачки.

**Кто видит** — `permissions.permissionFlags`. Верхние `permissionFlags` и `price` всегда 0, цена
живёт только в правах:

| Кто видит | `permissionFlags` |
|---|---|
| Все | `[]` |
| Подписчики любого уровня (по умолчанию в форме) | `[{"flags": 4}]` |
| Подписчики одного уровня | `[{"type": 0, "flags": 4, "metadata": "{\"4\":\"{\\\"subscriptionTierId\\\":\\\"<tierId>\\\",\\\"subscriptionTierName\\\":\\\"<имя>\\\",\\\"before\\\":0,\\\"after\\\":0}\"}"}]` |
| За цену, без подписки | `[{"type": 0, "flags": 1, "metadata": "{\"1\":\"{\\\"price\\\":7500}\"}", "price": 7500}]` |

В ответе у каждого флага появляются `id`, `accountMediaId`, `verificationFlags` (равен `flags`),
`validAfter`/`validBefore: null`. Уровни подписки — `GET /subscriptions/tiers` (у тестовой модели
4 уровня по 5000).

**Несколько способов доступа** (снято 2026-10-25 на тестовой модели: отложенный пост на +30 дней, сразу
отменён, список отложенных после этого пуст). В окне Upload это «Advanced Permissions»: группы условий
через «OR», в группе условия через «И» (цена, «Following», «Subscribed», «Subscribed (More Options)» —
уровень и срок подписки, «Limited Time», «Private List»). Каждая группа — одна запись массива, зритель
проходит по любой. В простом режиме уровень выбирается только один.

| Кто видит | `permissionFlags` |
|---|---|
| Подписчики уровня A или уровня B | две записи, как «одного уровня» выше: `[{"type":0,"flags":4,"metadata":…A…}, {"type":0,"flags":4,"metadata":…B…}]` |
| Подписчики любого уровня бесплатно, остальные за цену | `[{"type":0,"flags":4,"metadata":"{\"4\":\"{\\\"subscriptionTierId\\\":\\\"\\\",\\\"subscriptionTierName\\\":\\\"\\\",\\\"before\\\":0,\\\"after\\\":0}\"}"}, {"type":0,"flags":1,"metadata":"{\"1\":\"{\\\"price\\\":5000}\"}","price":5000}]` |

- «Любой уровень» в расширенном режиме — запись `flags: 4` с пустыми `subscriptionTierId` и
  `subscriptionTierName` (простой режим шлёт `{"flags": 4}`). Fansly ответил на неё
  `verificationFlags: 4`, то есть признал условие.
- Запись, добавленная кнопкой «New permission» во второй группе, приходит ещё с `"validBefore": null,
  "validAfter": null`. Значения те же, что Fansly и так ставит в ответе. Hub их не шлёт.
- Уровни и цена вместе («уровень A или B, остальные за цену») — те же записи подряд. Отдельно не
  снимали, но это та же форма: каждая группа — своя запись.
- Hub (с 2026-10-25): пост для подписчиков с несколькими уровнями — запись на каждый уровень; пост для
  подписчиков с ценой — подписчики (все или названных уровней) бесплатно, остальные за цену.

**Из медиатеки** (основной путь, spec §7) файл не загружается: тот же `POST /account/media` с уже
существующим `mediaId` создаёт новое `accountMedia` со своими правами. Медиатеку сайт читает через
`GET /vault/albumsnew` и `GET /media/vaultnew`.

## 4. Пост

`POST apiv3…/post`:

```json
{ "content": "текст", "fypFlags": 0, "inReplyTo": null, "quotedPostId": null,
  "attachments": [{ "contentId": "<accountMedia.id или bundle.id>", "contentType": 1, "pos": 0 }],
  "scheduledFor": 1795391018289, "expiresAt": 1795477400646,
  "postReplyPermissionFlags": [], "pinned": 0,
  "wallIds": ["<стена>"], "pinWallIds": [] }
```

- `contentType`: 1 — медиа, 2 — пачка (по коду сайта ещё 8 — цитата поста).
- `scheduledFor`: время выхода. 0 — сразу (по коду сайта, живьём не снято, см. §8).
- `expiresAt`: **абсолютное** время исчезновения, 0 — без срока. В форме это дата, а не «1 день».
  Оно должно быть позже выхода, поэтому Hub считает `scheduledFor + срок`.
- `wallIds`: только выбранные стены. Стену Posts («обязательная, главная лента») сайт в список не
  кладёт, если выбрана другая: сервер добавляет пост в Posts сам («Every post is automatically saved
  to the Posts wall»). Если стен не выбрано, сайт кладёт главную стену. Стены: `GET /account/walls`.
  У стены есть флаг `private` (скрыта с профиля), а главной лентой можно сделать другую стену.
- `fypFlags` — см. §6.
- Ответ **зависит от вида поста** (снято 2026-10-24, настоящая публикация с «да» владельца):
  - отложенный (`scheduledFor > 0`) — `{postId, accountId, postTemplate: "<тело JSON-строкой, с id = postId>",
    scheduledFor, attachments: [], …}`, поля `id` нет;
  - сразу (`scheduledFor: 0`) — сам пост: `{id, accountId, content, fypFlags, attachments: [{contentType,
    contentId, pos, postId}], wallIds, …}`, поля `postId` нет.
- После каждой операции сайт заново читает `GET /post/scheduled`.

## 5. Расписание

- **Чтение**: `GET /post/scheduled` → `{scheduledPosts: [{postId, accountId, status, postTemplate,
  scheduledFor, …}], aggregationData}`. `status`: 1 — ждёт выхода, 3 — снят.
- **Правка**: `POST /post/<postId>/edit` с полным телом: `id, accountId, content, fypFlags,
  attachments` (с `postId`), `postReplyPermissionFlags, expiresAt, pinned, wallIds, pinWallIds,
  scheduledFor`. `scheduledFor` в правке сайт округлил до секунд. Дату выхода форма правки менять
  не даёт, срок жизни даёт. Ответ — тот же вид, `status: 1`.
- **Выход отложенного поста** (снято 2026-10-24): пост вышел через секунду после `scheduledFor` и
  **получил новый ID** (в расписании `…9307017256960`, на ленте `…1879966916608`). Запись из
  `GET /post/scheduled` просто исчезла: статуса «вышел» там нет. Старый `postId` по
  `GET /post?ids=` не читается. Общее у двух записей — вложение: тот же `contentId`
  (`accountMedia.id` или `bundle.id`) и текст. Вышедший пост видно в `GET /post?ids=<новый>` и в
  ленте (`GET /timelinenew/<accountId>?before=0&after=0&wallId=&contentSearch=`). Значит, «вышел ли
  пост» Hub проверяет не по ID отложенного поста, а по вложению в свежих постах ленты.
- **Удаление поста** (вышедшего): `POST /post/<id>/delete`, тела нет → `{success: true, response: null}`;
  после него `GET /post?ids=<id>` возвращает пустой список.
- **Снятие**: `POST /post/scheduled/<postId>/cancel`, тело пустое. Ответ — список отложенных, где
  снятый со `status: 3`. Сайт перед снятием спрашивает «Are you sure you want to cancel this post?».

## 6. FYP

Из кода сайта, подтверждено живыми постами:

| `fypFlags` | Когда | Снято |
|---|---|---|
| 0 | По умолчанию. Пост идёт в FYP, если подходит: есть открытое видео ≥ 3 с или видео-превью, и лента не закрыта | пост A (открытое видео), C, первый захват (`~/code/8-docs/2026-10-24-fansly-post-flow.md`) |
| 2 | В тексте есть `#fyp` (сайт вычисляет из текста сам). Нужно, когда лента закрыта | пост B |
| 4 | «Do not promote this Post» в окне FYP | пост D |

- Фото, даже открытое, в FYP не идёт: кнопка «Post to FYP» неактивна, окно пишет «needs at least one
  unlocked video or a video preview».
- Выбор 4 у сайта переживает публикацию и попал в следующий пост (пост E). Hub ставит `fypFlags`
  явно у каждого поста.
- Перед отправкой поста с FYP сайт показывает окно «FYP Tips» (совет про хэштеги). На запросы оно
  не влияет.

## 7. Сториз

1. Загрузка — как в §2. Права — как в §3 (форма по умолчанию ставит «подписчикам», `[{"flags": 4}]`).
2. `POST apiv3…/mediastories`, тело `{"contentType": 1, "contentId": "<accountMedia.id>"}` → ответ
   `{id: <storyId>, accountId, contentType, contentId}`. Выходит сразу: отложить сториз форма не даёт.
3. Удаление — `POST apiv3…/mediastory/delete`, тело `{"storyId": "<storyId>"}` → ответ
   `{success: true, response: null}`. Список сториз — `GET /mediastoriesnew?accountId=<id>`.

## 8. Сопутствующие запросы сайта

| Запрос | Когда | Hub повторяет? |
|---|---|---|
| `GET /post/scheduled` | после каждой операции, при открытии списка | да — это проверка «встало / снялось» (PR 9b) |
| `GET /account/walls` | открытие выбора стен | нет — стены Hub читает сам (`page_walls`) |
| `GET /subscriptions/tiers` | открытие выбора уровня | нет — уровни приходят из чтений страницы |
| `GET /timeline/permissions` | открытие правки | нет |
| `GET /vault/albumsnew`, `GET /media/vaultnew` | выбор из медиатеки | нет — медиатеку Hub уже собирает |
| `POST metrics.fansly.com/event/track/v1/` | постоянно, тело зашифровано | нет — телеметрия сайта |
| `GET /streaming/followingstreams/online`, `GET /timeline/home` | фон страницы | нет — к публикации не относятся |
| `OPTIONS` к `mediav2` и S3 | перед каждым запросом с нестандартными заголовками | сам браузер — Hub шлёт запрос, preflight делает Chrome |

## 9. Вопросы spec §12

- **Сохраняет ли отложенный пост свой ID при выходе** — **нет** (§5): при выходе новый ID, общее только
  вложение и текст.
- **Может ли тестовый аккаунт делать платные посты** — да. Платная пачка ($7.50, с превью) и платный
  одиночный файл ($3) созданы и встали в расписание. Покупку не проверяли.
- **Значения `fypFlags`** — §6. Описание spec («FYP — 0, остальные — 4») верно, плюс 2 для `#fyp`.
- **Предел отложенных постов** — не проверяли.
- **Трафик прокси на видео** — загрузка равна размеру файла (45 МБ видео — 45 МБ вверх) плюс опрос
  статуса (единицы КБ).

## 10. Не снято

- ~~«Lock Replies»~~ — снято 2026-10-25 (§12.4): без выбора «кто может отвечать» уходит `[]`.
- ~~Видео-превью~~ — снято 2026-10-25 (§12.1). Сториз с видео не снимали: сториз выходит сразу.
- Обложка видео (`mediaCoverId`): в Firefox без окна кадр видео не грузится, обложка зависает (§12.1).
- Закрытый текст и цель чаевых — только по коду (§12.6). Упоминания `@ник` не трогали.
- Повторы частей (до 10) и `complete` (до 5) — логика сайта по коду. Живьём `complete` раз за разом
  отвечал 500 на повторную загрузку тех же байтов (§12.7).

## 11. Расхождения с кодом Hub (main на 2026-10-24)

Сетевые описания публикации (`packages/fansly/src/wire/publish.ts`) пока помечены UNVERIFIED и не
отправляются. По этому контракту их нужно поправить, прежде чем вносить в `FANSLY_VERIFIED_WRITE_ROUTES`.

| Где | Сейчас в Hub | На самом деле (§) |
|---|---|---|
| `publish.ts:74`, `:115` права | `type` 1 (уровень) / 2 (цена), `flags: 0`, `metadata` = `{subscriptionTierIds}`, `validAfter/validBefore`, плюс `accountPermissionFlags` | `type: 0`; подписка — `flags: 4` (любой уровень — `[{flags: 4}]`, один уровень — `metadata` `{"4": "{subscriptionTierId, subscriptionTierName, before: 0, after: 0}"}`); цена — `flags: 1`, `metadata` `{"1": "{price}"}` и `price`; всем — `[]`. `accountPermissionFlags` сайт не шлёт (§3) |
| `publish.ts:221` `upload_create` | `{fileSize, mimeType, fileName}` | плюс `uploadFormData`: `{formInputs: [1001…1005]}` (форма поста) или `null` («Upload to Vault») (§2) |
| `publish.ts:239` `upload_complete` | без `status` | сайт шлёт и `status: 0` (§2) |
| `publish.ts:265` `account_media` | `[{mediaId, permissions}]` | `[{mediaId, previewId, permissionFlags: 0, price: 0, whitelist: [], permissions, tags: []}]` — **превью одиночного файла здесь же, в `previewId`** (§3) |
| `publish.ts:282` `account_media_bundle` + `derive.ts:262` | цепочка: сначала `account_media`, потом пачка из `accountMediaIds` | пачка делается **сразу из `mediaId`**: `{previewId: null, permissionFlags: 0, price: 0, accountMediaModels: [{mediaId, previewId, permissionFlags: 0, price: 0, whitelist: []}…], whitelist: [], permissions, tags: []}`, превью у каждого файла свой. `account_media` перед пачкой сайт не вызывает (§3) |
| `derive.ts:290` | платный пост с одним файлом и превью идёт пачкой | сайт делает пачку только из нескольких файлов; один файл с превью — `account_media` с `previewId` (§3) |
| `publish.ts:300` `post` | `{content, fypFlags, attachments, scheduledFor, expiresAt, wallIds, postReplyPermissionFlags}` | сайт шлёт ещё `inReplyTo: null, quotedPostId: null, pinned: 0, pinWallIds: []`. `wallIds` — только выбранные стены, Posts сервер добавляет сам (§4). `fypFlags` 0 / 4 — верно (§6) |
| `publish.ts:345` `post_cancel` | тело `{}` | тела нет вовсе (§5) |
| `answers.ts:68` `post` | id из `response.id` или `response.post.id` | отложенный — `{postId, …}` без `id`, сразу — сам пост с `id` (§4): брать `response.postId ?? response.id`. Сейчас каждый отложенный пост закончился бы `unknown` |
| `answers.ts:64` `account_media_bundle` | `response.id` или `response.accountMediaBundle.id` | `response.accountMediaBundles[0].id` (§3). Сейчас каждая пачка закончилась бы `unknown` |
| `answers.ts` `story`, `account_media`, `upload_*` | — | совпадает |
| `publish.ts:206` факты | всё `false` | `storyStateRead`: сториз читаются `GET /mediastoriesnew?accountId=` (§7); `scheduleListWhole`: `GET /post/scheduled` отдавал весь список (до 3 постов, предел не проверяли); `scheduledPostKeepsId` — **false подтверждено**: при выходе новый ID, проверка «вышел ли» — по вложению (§5) |

## 12. Все пути формы поста (снято 2026-10-25)

Форма поста на `/home` разобрана целиком. Живьём — на тестовой модели: три поста (A — четыре вложения
и почти все опции, B — файлы из медиатеки, C — опрос), каждый отложен на +30 дней и сразу снят;
после этого `GET /post/scheduled` пуст. Остальное — по коду сайта (снимок 2026-10-24,
`~/Documents/Codex/fansly-web-bundle-2026-10-24/pretty/main.*.js`: `app-post-creation`, шаблон
окна Upload, редактор прав). «Снято» — запрос видели живьём, «по коду» — только в коде.
Hub: «да» — делает, «частично» — делает не всё, «нет» — не делает (сравнение с main на 2026-10-25,
включая #846).

### 12.1 Сводка

| Путь в форме | Что шлёт сайт | Снято | Hub |
|---|---|---|---|
| Один файл (фото или видео) | `POST /account/media` (§3) | да | да |
| Несколько файлов в одном окне Upload | одна пачка `POST /account/media/bundle`, права одни на всю пачку (§3) | да | да |
| Фото и видео в одной пачке | та же пачка, тип файла роли не играет | да (пост A) | да |
| **Несколько окон Upload в одном посте** | несколько вложений, у каждого свои права (§12.2) | да (пост A) | да (с 2026-10-25): `extraAttachments` после своего вложения поста, до 4 |
| Из медиатеки (картинка → From Vault) | файлы попадают в то же окно Upload; та же пачка или `account/media` с их `mediaId`, загрузки нет | да (пост B) | да |
| Значок копирования в окне | старое `accountMedia` или пачка идёт вложением как есть (`contentType` 1/2, старый `contentId`), нового `account/media` нет | по коду | нет (не нужно) |
| Порядок (значок стрелок) | порядок `accountMediaModels` в пачке и `pos` вложений | да (пост B: порядок выбора) | да (`position`) |
| Аудио (микрофон, `audio/*`) | загрузка как медиа, дальше как файл | по коду | нет: Hub берёт только фото и видео |
| Превью-картинка к фото | свой upload, `previewId` у файла; перед сохранением редактор Blur / Blur2 / Pixelate | да | да |
| Видео-превью к видео (клип) | то же, `previewId` — медиа клипа | да (пост A) | да |
| Превью только у части файлов пачки | у остальных `previewId: null` | да (посты A, B) | да |
| Превью у поста без цены | сайт даёт «Add Free Preview» любому файлу и шлёт `previewId` | да (пост B) | нет: Hub даёт превью только посту с ценой (строже сайта) |
| Обложка видео (⚙ → Edit Cover) | кадр видео грузится картинкой, у файла `mediaCoverId`, у видео-превью — `previewCoverId` | по коду. Живьём в Firefox без окна кадр не грузится («0:00 / 0:00»), обложка зависает, пост не уходит | нет |
| Карандаш на файле | редактор картинки (рисунок, текст, размытие); результат грузится новым файлом | по коду | нет (файл готовит человек) |
| ⚙ на фото | только «Remove» | да | — |
| Права: «И» в группе, Following, Limited Time, срок подписки, Private List | §12.3 | да (пост A) | частично (с 2026-10-25): «подписчик И цена» — платный пост `subscribersOnly`; остальное нет |
| Простой режим: несколько флажков сразу | одна запись, флаги складываются (§12.3) | да (пост B) | частично: Hub шлёт по одному условию на запись |
| Пресет прав (Save Preset) | настройки аккаунта: категория MEDIA, ключ `PERMISSION_PRESETS`, `{savedPermissionFlags: [{label, permissionFlags}]}`, плюс localStorage | по коду | не нужно: аудиторию хранит сам Hub |
| Переключение простой / расширенный режим | `POST /settings` `{"categoryId":"2000","keyId":"1002","value":1,"metadata":"{\"easyMode\":true}"}` — режим формы запоминается в аккаунте | да | не нужно |
| Post to FYP / `#fyp` | `fypFlags` 0 / 2 / 4 (§6); `#fyp` в тексте → 2 | да (пост B: 2) | да для `fyp_post`, у остальных видов 4 |
| Pin to Walls | `pinWallIds: [<стена>]`; **`pinned` остаётся 0** | да (пост A) | да (с 2026-10-25): `pinWallRefs` — стены поста |
| Post to Walls, несколько стен | `wallIds` — все выбранные, Posts не входит (§4) | да (пост A: две стены) | да |
| Lock Replies | `postReplyPermissionFlags` — записи, кто может отвечать (§12.4) | да (пост A) | да (с 2026-10-25): `replyLock` — подписанные на модель и/или подписчики |
| Срок жизни (календарь с корзиной) | `expiresAt` — абсолютное время (§4) | да (пост A) | да |
| Разметка текста | в `content` как есть (§12.5) | да (пост A) | да: текст уходит как написан |
| Хэштеги, эмодзи | в `content` как есть | да (пост A) | да |
| Упоминание `@ник` | в `content`; сервер разбирает сам (`accountMentions` в ответе) | не трогали: упомянутый — живой человек | да (текст) |
| Опрос | `POST /poll` → вложение `contentType` 42001 (§12.6) | да (пост C) | нет |
| Закрытый текст (Locked Text: значок «текст с долларом») | `POST /stories` `{title: "", description: "", content, permissions}` → вложение `contentType` 32001 | по коду (окно открыли и закрыли) | нет |
| Цель чаевых | `POST /tipgoals` `{goalAmount, hideAmounts, label, description}` → вложение `contentType` 7100 | по коду | нет |
| Цитата поста | `quotedPostId` и вложение `contentType` 8 — из меню поста, не из формы | по коду | нет |
| Чаевые вместе с постом | `POST /tips` до поста — **деньги** | не трогали | нет и не будет |
| Правка отложенного поста | `POST /post/<id>/edit` (§5) | да (2026-10-24) | нет: Hub снимает и ставит заново |
| Стены у вышедшего поста | `POST /wall/postcreate` / `/wall/postedit` `{wallIds, postId}` | по коду | нет |

### 12.2 Несколько вложений с разными правами

Каждое окно Upload — свой «шаблон»: свои файлы, превью и права. При отправке сайт создаёт по шаблонам
`account/media` (один файл) или пачку (несколько) и кладёт их в `attachments` по порядку окон:
`pos` = номер окна. Пост A (четыре окна):

```json
"attachments": [
  { "contentId": "<accountMedia: подписчики>",  "contentType": 1, "pos": 0 },
  { "contentId": "<пачка: 2 фото + видео>",     "contentType": 2, "pos": 1 },
  { "contentId": "<accountMedia: за $3>",       "contentType": 1, "pos": 2 },
  { "contentId": "<accountMedia: всем>",        "contentType": 1, "pos": 3 } ]
```

Так делают «тизер бесплатно + полное за деньги» в одном посте. Один отказ при создании любого
вложения (ошибка `account/media` или пачки) — и пост не создаётся вовсе: сайт показывает ошибку,
`POST /post` не уходит.

### 12.3 Права: все виды условий

Каждая запись `permissionFlags` — группа условий, зритель проходит по **любой** записи («OR»). Внутри
записи условия складываются **битами** `flags` («И»), у каждого свой ключ в `metadata`
(JSON-строка: ключ — номер флага, значение — JSON-строка условия):

| Флаг | Условие | Ключ в `metadata` |
|---|---|---|
| 1 | Цена (Add Price / Require Purchase) | `{"1": "{\"price\": <милли>}"}` и поле `price` записи |
| 2 | Following (подписка на модель) | нет, `metadata: null` |
| 4 | Subscribed: уровень и срок подписки | `{"4": "{\"subscriptionTierId\", \"subscriptionTierName\", \"before\", \"after\"}"}` |
| 128 | Private List (список фанов) | `{"128": "{\"listId\": \"<id списка>\", \"label\": \"<имя>\"}"}` |

Ещё из кода сайта: 8 — Tipped, 16 — Followed by Me, 32 — Media Purchases. В форме прав их нет, они
бывают только в «кто может отвечать» (§12.4).

Снято в посте A (пачка):

```json
[ { "type": 0, "flags": 5, "price": 7000,
    "metadata": "{\"1\":\"{\\\"price\\\":7000}\",\"4\":\"{\\\"subscriptionTierId\\\":\\\"\\\",\\\"subscriptionTierName\\\":\\\"\\\",\\\"before\\\":0,\\\"after\\\":0}\"}" },
  { "type": 0, "flags": 2, "metadata": null, "validBefore": 1796121674721, "validAfter": 1792924873721 },
  { "type": 0, "flags": 4, "validBefore": null, "validAfter": null,
    "metadata": "{\"4\":\"{\\\"subscriptionTierId\\\":\\\"\\\",\\\"subscriptionTierName\\\":\\\"\\\",\\\"before\\\":0,\\\"after\\\":1790332880136}\"}" },
  { "type": 0, "flags": 128, "validBefore": null, "validAfter": null,
    "metadata": "{\"128\":\"{\\\"listId\\\":\\\"727376030649556992\\\",\\\"label\\\":\\\"Молчун\\\"}\"}" } ]
```

- **Подписчик И цена** (`flags: 5`): видят только подписчики и только после покупки — платный пост
  для своих. Этим он отличается от платного поста Hub (только `flags: 1`): тот может купить и не
  подписчик.
- **Limited Time** — срок самой записи: `validAfter` / `validBefore` в мс. Задать можно одно из двух.
- **Срок подписки** (Subscribed (More Options) → Restrict Timeframe) — `after` / `before` в метаданных
  подписки, мс: подписка должна была быть активной в этом окне.
- **Простой режим** — одна запись: флажки складываются. Пост B: Require Subscription + Require Follow →
  `[{"type":0,"flags":6,"metadata":"{\"4\":\"{…пустой уровень…}\"}"}]`. В простом режиме уровень —
  только один, групп «OR» нет.
- Сайт ограничивает цену: «The minimum sale price of Media is $1», «The maximum sale price of Media is
  $500» — то есть 1 000 … 500 000 миллей. Вилка цен страницы в Hub должна быть внутри.

### 12.4 Кто может отвечать (Lock Replies)

`postReplyPermissionFlags` — те же записи, что в §12.3. Выбор — Following (2), Subscribed (4),
Tipped (8), Followed by Me (16), Media Purchases (32) (`allowedFlags: 62`). Пост A, «Subscribed»:

```json
"postReplyPermissionFlags": [ { "type": 0, "flags": 4, "price": 0,
  "metadata": "{\"4\":\"{\\\"subscriptionTierId\\\":\\\"\\\"}\"}" } ]
```

Без выбора кнопка Lock Replies даёт `[]` — ответы открыты (так было 2026-10-24, §10).

Как сайт собирает записи (код редактора прав, `convertToPermissionFlags`): группа — одна запись
`{"type": 0, "flags": <сумма флагов группы>, "price": 0, "metadata": <JSON по флагам или null>}`.
У Following (2) метаданных нет, `metadata: null`. У Subscribed (4) в этом редакторе только
`{"subscriptionTierId": ""}`. Hub (с 2026-10-25) шлёт по записи на каждый выбор: подписанные на модель —
`{"type":0,"flags":2,"price":0,"metadata":null}`, подписчики — как в снятом посте A. Tipped (8),
Followed by Me (16) и Media Purchases (32) Hub не ставит: у 8 и 32 есть сумма `minAmount`, их не снимали.

### 12.5 Разметка текста

Кнопки над полем оборачивают выделенное в разметку, и она уходит в `content` как есть:
`**жирный**`, `*курсив*`, `~~зачёркнутый~~`, `[s:sm|lg|xl]…[/s]` — размер,
`[c:<цвет>]…[/c]` — цвет, `[текст](https://…)` — ссылка. Эмодзи и хэштеги — обычный текст.
Сервер принял всё как есть (пост A).

### 12.6 Опрос, закрытый текст, цель чаевых

Сначала создаётся объект, потом он вкладывается в пост:

| Что | Запрос | Вложение |
|---|---|---|
| Опрос | `POST /poll` `{"title":"…","options":[{"title":"…"},…],"permissions":{"permissionFlags":[]}}` → `{id, options: [{id, title, pollId}], …}` | `{"contentId": "<id опроса>", "contentType": 42001}` |
| Закрытый текст | `POST /stories` `{title: "", description: "", content, permissions}` | `contentType` 32001 |
| Цель чаевых | `POST /tipgoals` `{goalAmount, hideAmounts: 0/1, label, description}` | `contentType` 7100 |

`permissions` опроса — кто может голосовать, те же записи §12.3. Опрос живьём создан и вложен в
отложенный пост C, пост снят. Сам опрос остался в аккаунте модели (`GET /polls`).

### 12.7 Что важно для Hub

- **Повторная загрузка тех же байтов.** Файлы, однажды уже загруженные на аккаунт, загрузились снова
  (`create` 200, части в S3 200, ETag = MD5 файла), но `POST /media/upload/complete` ответил
  **500 `error completing upload`** — на каждую попытку, больше десяти раз. Новый файл через пару минут прошёл (200).
  Hub грузит файл человека: если эти байты уже есть у модели, загрузка падает на `complete`. Такой
  ответ — отказ, а не «неизвестно». Выход — брать файл из медиатеки (`vault`).
  Накануне (2026-10-24) повтор того же файла прошёл и вернул старый `mediaId`, так что правило не
  постоянное.
- **Всё или ничего.** Если хоть одно вложение не создалось, сайт пост не отправляет (§12.2). У Hub
  одно вложение, и правило то же.
- **Закрепление** — только `pinWallIds`; `pinned` у поста с закреплённой стеной остался 0.
- **Цена** — от $1 до $500 (§12.3).

### 12.8 Как снималось

`pnpm see:session --bare` в chat-extension, Firefox без окна, вход тестовой модели. В этот день
провайдер Мака сбрасывал TLS-соединения к адресам CloudFront, на которые указывает `fansly.com`
(`3.164.206.*`, `143.204.238.*`), а API (`apiv3`, `mediav2`) работал. Сайт открывался только через
локальный CONNECT-прокси, который вёл имя `fansly.com` на адрес CloudFront `13.33.235.102`, где сайт
отвечал. На запросы и тела это не влияет. Прокси — только для исследования, в репо его нет.

## 13. Альбомы волта (снято 2026-10-26)

Тестовая модель, `pnpm see:session --bare`. Формы сайта: «Create Vault Album» (плюс у «My Albums» на
`/creator/vault`) и «Upload to Vault» внутри альбома. Тестовый альбом «PPV-900 Тест хаба, удалить» остался у
модели. Фанам альбомы волта не видны.

| Шаг | Запрос | Тело | Ответ |
|---|---|---|---|
| Создать альбом | `POST apiv3…/vault/albums` | `{"id": null, "title": "…", "description": "", "accountId": null, "type": 0}` | `{accountId, title, description, pos, id}` |
| Загрузить в волт | `POST mediav2…/media/upload/create` и дальше §2 | как §2, но `uploadFormData: null` | как §2; файл в медиатеке, имя файла = имя карточки (`t1.jpg` → `t1.jpeg`) |
| Добавить в альбом | `POST apiv3…/vault/albums/media` | `{"albumId": "…", "mediaIds": ["…", …]}` | массив `{id, mediaId, mediaType, albumId, accountId, createdAt}`, по записи на каждый `mediaId`, в порядке запроса |
| Прочитать альбом | `GET apiv3…/media/vaultnew?albumId=…&mediaType=&search=&before=0&after=0` | — | `{albumMedia: [{id, mediaId, albumId, createdAt, customFilename}], media: […]}` |
| Переименовать карточку | `POST apiv3…/vault/albums/media/rename` | `{albumId, mediaId, customFilename}` | запись альбома с новым `customFilename` |

- Сайт после загрузки сам добавляет файлы в открытый альбом одним запросом (через секунду после последнего).
- **Порядок.** Альбом показывает записи от последней добавленной к первой (по `id` записи альбома, не по дате
  файла): t2, t1, t3, видео, добавленные одним запросом в этом порядке, показаны как видео, t3, t1, t2. Страница
  сайта — тот же порядок. Отсюда «дозалил — порядок сломался»: новый файл встаёт первым.
- **Повторное добавление** файла, который уже в альбоме, не дублирует его: старая запись уходит, новая встаёт
  наверх (новый `id`, `customFilename` сохраняется). Поэтому один запрос со всем списком в обратном порядке ставит
  альбом ровно в нужный порядок без перезаливки. Проверено: дозаливка в середину, старый файл (2024-12) в середину.
- Сайт группирует альбом по дню **добавления в альбом**: после такого запроса весь альбом — одна дата.
- Hub (0323): вид публикации `vault_album`, шаги `album_create` (если альбома с таким названием у страницы нет) и
  `album_media` — все файлы одобрения одним запросом, последний первым. Новые файлы идут в волт с
  `uploadFormData: null`. Удалить из альбома (`/vault/albums/media/delete`), переименовать карточку и удалить
  альбом Hub не умеет.
