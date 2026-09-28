# FBuddy: сессия и транспорт для Project Browser

Проверено 27 сентября 2026 года по CRX **2026.927.830**, SHA-256 `3fd413555f9d8a4b8754e7ee198f22f1d0d885367e59331c9d1d39c118b8ecce`. Источник — неизменённый `extracted`; `layout/readable` — форматированная проекция собранного JavaScript, не исходный проект. Для 14 важных методов и функций отдельно сравнены AST обеих версий: совпадают токен, заголовки, общий запрос, GET-дедупликация, отправки, HLS-проверки, backend proxy и management-session. Сетевые операции с Fansly и аккаунтами не выполнялись. [Manifest](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/extracted/manifest.json:3), [проверка CRX](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/indexes/crx-verification.json:1).

Сверены `refreshAuthTokenFromLocalStorage`, `fanslyRequest`, `setClientHeaders`, `getMe`, `sendMessageToGroup`, `createBroadcastGroup`, `sendBroadcastMessage`, `createHlsMediaAccess`, `assertHlsSession`, `refreshHlsMedia`, `ORe`, `aLe`, `F0`, `Sat`. Метод проверки: Acorn (`ecmaVersion: latest`, `sourceType: module`), выбор FunctionDeclaration/MethodDefinition по имени, сравнение JSON AST без `start`, `end`, `raw`, `loc`; результат **14/14 equal**. В raw bundle эти узлы расположены на строках 154, 167, 169 и 355. Проверка подтверждает сохранность структуры при форматировании, не runtime-работоспособность.

**Полезная модель FBuddy — использовать действующую браузерную сессию, наблюдать заголовки сайта и выполнять запросы в браузере.** Готового доказательства постоянного серверного профиля, SOCKS-маршрутизации, ручного 2FA и восстановления работы Hub этот пакет не даёт. Следующие выводы относятся к видимому коду расширения.

## 1. Разные значения «сессии»

| Объект | Источник и использование | Значение для Project Browser |
|---|---|---|
| Авторизация Fansly | `session_active_session.token` из `localStorage`; затем `authorization` собственного запроса | Живая сессия профиля должна быть источником авторизации. Это не генератор и не процедура продления токена. |
| Клиентский контекст Fansly | `fansly-client-check`, `fansly-client-id`, `fansly-client-ts`, `fansly-session-id` из наблюдаемых запросов сайта | Нужны все наблюдаемые поля, их происхождение и свежесть; один сохранённый основной токен не воспроизводит этот механизм. |
| Пользователь FBuddy | Cookie `fbuddy_session_token`, `/api/auth/get-session` на `api.fbuddy.net`, scoped snapshot с `fanslyAccountId` | Авторизация стороннего продукта, не состояние входа в Fansly. |
| Management session | Введённый пользователем `managementSessionUrl`, передаваемый FBuddy backend вместе с `platformAccountId` и `organizationId` | Отдельный передаваемый доступ. Клиентский код не раскрывает, как сервер его использует. |

Основной токен читается при создании клиента и при отсутствии кешированного значения. `getAuthToken()` обычно возвращает уже сохранённый токен. `setClientHeaders()` только объединяет непустые значения: отсутствующие поля не удаляются, срок действия не проверяется. Расширение не вычисляет `fansly-client-check` и не обновляет `fansly-client-ts` на каждый свой запрос. Поэтому «добавить четыре заголовка однажды» не равно воспроизвести жизненный цикл сессии. [Токен и merge заголовков](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:31390), [построение headers](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:31452), [исходный bundle](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/extracted/content-scripts/main.js:167).

Есть ветка Electron: при соответствующем `userAgent` вместо токена передаётся строка `relayed`. Это свидетельство предусмотренной интеграции с хостом. Подмена авторизации, сетевой маршрут и безопасность такого хоста из этой строки не следуют. [Создание реального клиента `Jt`](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:36332).

## 2. Точная цепочка наблюдения и исполнения

1. Content script стартует на `https://fansly.com/*` при `document_start`. `iV()` последовательно внедряет `window-bridge.js` и `fbuddy-network-hook.js` в страницу, передавая marker и направления сообщений. [Manifest](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/extracted/manifest.json:3), [инъекция](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:20301).
2. Page hook оборачивает `window.fetch` и `XMLHttpRequest`. Он наблюдает `/api/` на Fansly-доменах, исключает три CDN-хоста; у CDN отдельно добавляет `ngsw-bypass=true`. Из request headers выбирает только четыре поля выше. `authorization` через этот наблюдатель не добывается. [Фильтр и fetch](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/extracted/injections/fbuddy-network-hook.js:56), [XHR](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/extracted/injections/fbuddy-network-hook.js:270).
3. После ответа hook публикует `fbuddy:network-event`: метод, URL, HTTP status, выбранные headers и response body. Request body захватывается для `POST /api/v1/message` и `/message/broadcast`. Для fetch используется clone ответа, однако возврат оригинального response ждёт чтения клона. `type: success` означает полученный ответ, включая HTTP-ошибки, а не успешную бизнес-операцию. [Извлечение и событие](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/extracted/injections/fbuddy-network-hook.js:198).
4. `window.postMessage` передаёт событие; content-подписка `aLe()` валидирует форму headers и вызывает `Jt.setClientHeaders()`. Внедрение, publisher, subscriber и реальный limiter соединены вызовом `LRe(...)` перед созданием клиента. Это проверенные callers, а не набор неиспользуемых функций. [Bridge](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/extracted/injections/window-bridge.js:20), [подписка](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:34476), [сборка зависимостей](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:36314).
5. Собственная операция идёт через `Jt.fanslyRequest()` → content-context `fetch`, обычно с GET-дедупликацией `ORe`; используются `credentials: include`, CORS, referrer Fansly и сохранённые headers. Собственный результат вручную публикуется тем же подписчикам. **Network hook здесь наблюдает страницу; он не является универсальным page-fetch RPC для всех запросов расширения.** [Исполнение](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:31466), [publisher](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:33509).

Для Hub полезно сохранить различие «наблюдал» и «исполнил»: origin события, идентификатор операции и сырые наблюдения должны существовать до парсинга. Marker bridge и проверка направления маршрутизируют сообщения; они не заменяют доверенный канал команд Hub. Гарантий полноты перехвата service worker, WebSocket, раннего трафика до установки hook и всего браузерного стека эта обёртка не даёт.

## 3. Backend и management-session

`F0()` формирует `PROXY_FETCH` и отправляет его service worker. Для FBuddy-доменов при credentials, отличных от `omit`, добавляется `X-Fansly-Account-Id`; worker выполняет собственный `fetch`. Это другой транспорт, чем прямой Fansly-клиент. Слово proxy здесь означает посредничество worker, **не SOCKS-прокси страницы**. [Content wrapper](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:37548), [worker caller](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/background.js:14552).

Management UI действительно вызывает `Ew.saveOrUpdateFanslySession()`. `Sat()` реализует GET/POST/DELETE `/api/accounts/session`, а связка `Ew` направляет их на `api.fbuddy.net` через `F0`. POST передаёт ссылку и идентификаторы страницы/организации. Это подтверждает передачу доступа backend, но не наличие браузера на сервере, способ claim ссылки или выполнение сервером Fansly-запросов. [UI caller](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:73883), [контракт и wiring](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:71974).

FBuddy-auth worker хранит по аккаунту `{generation, inFlightRefresh, snapshot}`; snapshot содержит revision, время проверки, статус и пользователя. TTL — 30 секунд, refresh объединяется, generation защищает от устаревшего результата. Вызов `/api/auth/get-session` использует cookie credentials; после окончательного 401 получается unauthenticated. Прочие транспортные сбои возвращают `session_unavailable`, сохраняя различие «вход потерян» и «проверка недоступна». Cookie events и backend 401 обновляют состояние. Это полезная модель состояний, но уведомление UI «session expired» относится именно к FBuddy-auth. [Worker auth](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/background.js:13738), [cookie/401 callers](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/background.js:14506), [UI scope и сообщение](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:39245).

## 4. Изоляция страницы и кеши

| Механизм | Подтверждённое поведение | Что перенести или усилить |
|---|---|---|
| Кеш данных | Ключ `account:<id-or-unknown>:<key>`; account может вычисляться функцией в момент операции | Привязывать к фиксированной странице и поколению сессии; при неизвестной странице не пользоваться общим `unknown`. |
| `getMe()` | Ключ дополнен session-id/client-id, TTL 15 секунд; один `pendingMeRequest` | Проверять ожидаемый account после старта/восстановления; общий pending promise не является барьером смены аккаунта. |
| Fansly GET | `ORe`: одновременно выполняющийся запрос объединяется по методу, полному URL и отсортированным headers; каждому caller — clone | Сохранять различие авторизаций. Для Hub добавить явные page/profile/session-generation, не выводить секретные значения ключей в логи. |
| Backend GET | Worker `zs`: ключ по методу/URL/body, без headers | Не копировать: разные `X-Fansly-Account-Id` при одном URL могут разделить один promise. Это статически видимая коллизия ключа, не доказанный инцидент. |
| HLS-refresh | Запоминает token/account, сверяет до и после запроса; pending refresh разделён по ним; использует `forceFresh` | Полезный образец защиты результата от смены сессии; такого общего guard в `fanslyRequest()` нет. |

Источники: [account scope](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:27124), [getMe](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:31778), [Fansly GET](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:27591), [backend GET](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/background.js:8483), [HLS guard](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:34183).

Общего атомарного переключения token → headers → account → pending requests по исследованной цепочке не подтверждено. Для шести постоянных профилей предпочтительно вообще не переключать страницы внутри профиля; после ручного входа всё равно проверять фактический account.

## 5. Ошибки, отмена и запрет повторной отправки

`fanslyRequest()` по умолчанию допускает **шесть попыток независимо от HTTP-метода**, `retry:false` — одну. [Полный цикл](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:31466).

| Ситуация | Фактическая реакция |
|---|---|
| Нет токена | Возвращает undefined; ручной 2FA-flow здесь не запускается. |
| 401 на первой попытке | Если есть следующая попытка: ждёт 100 мс, очищает кеш токена, перечитывает localStorage и повторяет. Это не refresh-протокол Fansly. |
| 429 | Сообщает limiter `rate_limited` и повторяет при оставшемся бюджете. `Retry-After` в этом обработчике не используется. |
| Другая HTTP-ошибка | Возвращает разобранное тело либо undefined; общего повтора всех 5xx здесь нет. |
| Исключение fetch/чтения/обработки | Повторяет с паузой 1 секунда; успешная запись на сервере уже могла произойти. |
| AbortSignal | Проверяется до/после ожидания limiter и передаётся fetch; отмена возвращает undefined. Сам limiter не принимает signal. |
| Deadline | Общего timeout в `fanslyRequest()` нет. Локальные таймеры отдельных workflow не создают сквозного deadline. |

Реальный limiter использует extension storage и BroadcastChannel, нормализованный маршрут и HTTP-метод; число в path заменяется `:id`. В ключе нет account/proxy, а lease 2 секунды — срок координационной записи, не сетевой timeout. Переносимая идея — совместное ограничение запросов; конкретные интервалы не являются доказанными лимитами Fansly. [Policy](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:11777), [acquire](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:20947).

Особенно важно: `sendMessageToGroup()` вызывает typing и POST `/message` **без** `retry:false`. Broadcast create/send явно отключают повторы. Следовательно, даже внутри FBuddy разные отправки имеют разную семантику. [Обычная отправка](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:33424), [broadcast](/Users/dmitriy/code/agency/fbuddy-analysis/snapshots/2026.927.830/layout/readable/content-scripts/main.js:33469).

**Для Hub неизменен outbox: не более одной попытки команды; неопределённую отправку автоматически не повторять.** Потеря ответа, отмена и рестарт не доказывают, что команда не исполнилась. Нужны отдельные состояния «не начата», «результат подтверждён», «результат неизвестен» и read-only reconciliation. Typing тоже должен быть отдельным управляемым действием.

## 6. Граница применимости

Изученный транспорт помогает спроектировать получение контекста и изоляцию запросов. Он не доказывает закрепление резидентского SOCKS, сохранность браузерного профиля после перезапуска, ручной 2FA через удалённый экран, восстановление Hub checkpoints, запрет native read receipts или контроль всего присутствия сайта. Эти условия из [контекста Project Browser](../context.md) потребуют отдельных проверок выбранного browser host. Наличие настоящего браузера и знакомых headers само по себе не доказывает «неподозрительность» клиента для Fansly.
