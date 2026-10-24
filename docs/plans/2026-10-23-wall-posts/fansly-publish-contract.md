# Fansly: контракт публикации (этап 0)

Снято 2026-10-24 с самого сайта, на тестовой модели агентства. Инструмент — `pnpm see:session --bare`
из chat-extension (Firefox без окна, вход из `FANSLY_TEST_MODEL_*`, все запросы страницы с телами).
Посты делались руками через обычную форму сайта. Каждый пост — отложенный на +30 дней и сразу снятый.
Сториз — только подписчикам, удалена через минуту. Наружу ничего не вышло, отложенных постов нет.
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
- Ответ: `{postId, accountId, postTemplate: "<тело поста JSON-строкой, с id = postId>",
  scheduledFor, attachments: [], …}`.
- После каждой операции сайт заново читает `GET /post/scheduled`.

## 5. Расписание

- **Чтение**: `GET /post/scheduled` → `{scheduledPosts: [{postId, accountId, status, postTemplate,
  scheduledFor, …}], aggregationData}`. `status`: 1 — ждёт выхода, 3 — снят.
- **Правка**: `POST /post/<postId>/edit` с полным телом: `id, accountId, content, fypFlags,
  attachments` (с `postId`), `postReplyPermissionFlags, expiresAt, pinned, wallIds, pinWallIds,
  scheduledFor`. `scheduledFor` в правке сайт округлил до секунд. Дату выхода форма правки менять
  не даёт, срок жизни даёт. Ответ — тот же вид, `status: 1`.
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

- **Сохраняет ли отложенный пост свой ID при выходе** — не снято: нужен пост, который выйдет на
  ленту, а это только с «да» владельца. Косвенно: `postId` у отложенного уже есть, и `postTemplate`
  хранит его как `id`.
- **Может ли тестовый аккаунт делать платные посты** — да. Платная пачка ($7.50, с превью) и платный
  одиночный файл ($3) созданы и встали в расписание. Покупку не проверяли.
- **Значения `fypFlags`** — §6. Описание spec («FYP — 0, остальные — 4») верно, плюс 2 для `#fyp`.
- **Предел отложенных постов** — не проверяли.
- **Трафик прокси на видео** — загрузка равна размеру файла (45 МБ видео — 45 МБ вверх) плюс опрос
  статуса (единицы КБ).

## 10. Не снято

- Пост сразу (`scheduledFor: 0`) и выход отложенного поста на ленту — это публикация, только с «да»
  владельца.
- «Lock Replies»: кнопка стала активной, но `postReplyPermissionFlags` остался `[]` — видимо, нужно
  ещё выбрать, кто может отвечать.
- Видео-превью и сториз с видео.
- Повторы частей (до 10) и `complete` (до 5) — логика сайта по коду; живьём сбоев не было.
