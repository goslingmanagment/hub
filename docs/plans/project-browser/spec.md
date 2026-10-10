# Project Browser: спецификация (этап 0)

**Статус: черновик от 2026-10-11.** Спецификация этапа 0 к плану [`plan.md`](plan.md) (ревизия 8, §5). Код — на коммите `2260ef73`; ссылки — `путь:строка`, пути `engine/…` и `fansly/…` — от `apps/runtime/src/sync/`.

## 1. Статус и как читать

- План описывает механизмы. Спецификация фиксирует то, что зависит от сайта, замеров и решений владельца (план §5, «Этап 0»). Механизмы она не повторяет, а ссылается: «план §4.2».
- Требования — [`context.md`](context.md) вместе с изменением PR #559 (вход через форму Hub). Если план или спецификация расходятся с требованиями, правы требования.
- Метки:
  - **зафиксировано** — действует для PR этапа 3;
  - **№3** — предложение по решению владельца №3, утверждается сейчас;
  - **п. N** — значение снимает прототип, пункт N этапа 1 (план §5); до его отчёта в строке заглушка.
- Номера решений владельца — из плана §8. Сейчас владелец утверждает режимы трафика сайта и пороги (разделы 3 и 4, №3; список — раздел 11). После прототипа: карта операций и операции входа (№2), потолки буфера (№6), повторы Chrome (№1б), рубеж отправки при обрыве CDP (№10), отмена по сроку допуска (№16). Отчёт этапа 1 заполняет строки «п. N»; разделы 7 и 9 переписываются по его цифрам.

## 2. Карта операций (черновик)

Карта — одна таблица в `apps/page-browser/src/policy/operations.ts` (план §4.6): хост, метод, шаблон пути, режим, маршрут движка, «с данными платформы». Из неё при сборке образа получаются правила расширения (§2.7), оператор берёт из неё свою таблицу решений (план §4.3). Здесь таблица разбита на части для чтения.

Режимы строки: «автоматика», «ручной вход», «оба»; «никогда» — запрещено всегда, в том числе на втором этапе; «закрыто» — запрещено на первом этапе. Чего нет в карте, то запрещено.

### 2.1 Хосты

| Хост | Что | Режим | Как пропускается | Статус |
|---|---|---|---|---|
| `fansly.com` | страница сайта (план §4.1, шаг 8), скрипты, стили, шрифты | оба | сразу, без пейсинга; журнал: хост, путь, объём, время | зафиксировано; другие хосты статики — п. 10 |
| `apiv3.fansly.com` | API, пути от `/api/v1` (`packages/shared/src/config.ts:91`) | по §2.2–2.5 | допуск движка: запрос Hub — `send` и `check`, запрос сайта — `siteAdmit` | зафиксировано |
| `wsv3.fansly.com` | сокет сайта `wss://wsv3.fansly.com/?v=3` (`apps/runtime/src/services/egress/fansly-receiver-socket.ts:62`) | автоматика | `wsAdmit`, §2.3 | зафиксировано |
| `cdn*.fansly.com` (`apps/runtime/src/services/egress/media-download.ts:29`); на проде `cdn3.fansly.com` (`fansly/lib/cdn-tokens.ts:113`) | медиа: запросы Hub `cdn.media`, картинки и превью сайта | оба | Hub — под допуском (§2.3); сайт — без пейсинга, журнал без параметров подписи | хосты CDN сайта — п. 10 |
| `chatws.fansly.com` | второй сокет сайта, живые чаты | закрыто | правило расширения 3 и отказ `wsAdmit` | зафиксировано (план §3.2) |
| `mediav2.fansly.com` | API загрузки медиа (`fbuddy/02-operations-and-media.md:9`) | закрыто | правило расширения 3 | второй этап |
| служебные хосты Chrome | обновления компонентов, Safe Browsing | — | без перехвата `Fetch`: через прокси, журнал соединений | список — п. 10 |
| любой другой | — | — | отказ `BlockedByClient`, журнал | список разрешённых — п. 10, утверждает владелец (№2) |

### 2.2 API: маршруты каталога движка

Во всех строках: хост `apiv3.fansly.com`, метод GET, режим «автоматика», данные платформы — да. Вместе с §2.3 это весь каталог `FANSLY_ROUTES` (`fansly/routes.ts:204`): здесь 52 маршрута API из спецификаций (`packages/fansly/src/wire/specs.ts:266-1007`) и 7 маршрутов только для учёта (†, `fansly/routes.ts:31-39`); `ws.upgrade` и `cdn.media` — в §2.3.

- Маршрут ищется по методу и пути, посегментно: `:id` и `{id}` — ровно один сегмент, литерал сильнее параметра. Параметры запроса маршрут не меняют (`fansly/routes.ts:14-16`); `ngsw-bypass=true` — тоже параметр.
- † — маршрут есть в каталоге, но движок его не запрашивает (`wire: null`). Запрос сайта к нему идёт в бюджет этого маршрута; вид наблюдения — `fansly.site.<маршрут>` (план §3.2).
- Бюджеты — в коде (`fansly/routes.ts:107-129`): маршрут 15 в минуту, если не указано иное; семейство — сверх бюджетов своих маршрутов. Тест PR 6 сверяет строки API карты с каталогом: одно множество (метод, шаблон, маршрут).

| Группа | Шаблон → маршрут |
|---|---|
| Семейство messaging, 15/мин | `/messaging/groups` → `messaging.groups` (12/мин); `/group/:groupId` → `group.detail`; `/message` → `messages.page` |
| Семейство earnings, 17/мин | `/account/wallets/earnings` → `earnings.overview` †; `/account/wallets/earnings/transactions` → `transactions.page`; `/account/wallets/earnings/transactions/accounts` → `earnings.transactions_account`; `/account/wallets/earnings/accounts` → `earnings.accounts`; `/account/wallets/earnings/stats` → `earnings.stats_window`; `/account/wallets/earnings/stats/accounts` → `earnings.stats_accounts`; `/account/wallets/earnings/monthlystats` → `earnings.monthly`; `/account/wallets/earnings/monthlystats/accounts` → `earnings.monthly_accounts` |
| Семейство creator_stats, 5/мин; шаблоны от `/account/stats` | `/summary` → `stats.summary`; `/series` → `stats.series`; `/media` → `stats.media`; `/media/top` → `stats.media_top`; `/media/benchmarks` → `stats.media_benchmarks`; `/media/shown` → `stats.media_shown`; `/geo` → `stats.geo`; `/activehours` → `stats.active_hours`; `/tags` → `stats.tags`; `/posts` → `stats.posts`; `/fans` → `stats.fan`; `/fans/top` → `stats.fans_top` |
| Аккаунт и аудитория | `/account/me` → `account.me`; `/account` → `accounts.by_ids`; `/account/walls` → `account.walls`; `/account/:accountId/followersnew` → `followers.page`; `/subscribers` → `subscribers.page`; `/subscriptions/tiers` → `subscriptions.tiers`; `/subscriptions/giftcodes` → `subscriptions.giftcodes`; `/notifications` → `notifications.page`; `/lists/account` → `lists.account` †; `/lists/itemsnew` → `lists.items` † |
| Сообщения и рассылки | `/message/automated` → `message.automated`; `/message/broadcast/stats` → `broadcast.stats`; `/message/broadcast/stats/deleted` → `broadcast.stats_deleted`; `/message/broadcast/scheduled` → `broadcast.scheduled` |
| Посты | `/timelinenew/:accountId` → `posts.timeline`; `/post` → `posts.by_ids`; `/post/{postId}/replies` → `post.replies`; `/tips` → `posts.tips`; `/tips/account` → `tips.account` †; `/polls` → `polls`; `/mediastory/views` → `mediastory.views` † |
| Медиа и Vault | `/media/vaultnew` → `vault.media`; `/vault/albumsnew` → `vault.albums`; `/uservault/albumsnew` → `uservault.albums`; `/account/media` → `account.media_by_ids`; `/account/media/bundle` → `account.bundles_by_ids`; `/account/media/orders` → `account.media_orders` †; `/media/orderhistory` → `media.order_history`; `/groups/mediaoffers` → `groups.mediaoffers` †; `/contentdiscovery/media/suggestionsnew` → `discovery.suggestions` |
| Деньги и статистика вне семейств | `/payments/payoutmethods` → `payouts.methods`; `/payments/payout/requests` → `payouts.requests`; `/it/moie/statsnew` → `media.offer_stats` (5/мин); `/it/amoie/stats` → `account.stats`; `/trackinglinks` → `trackinglinks`; `/recapstats` → `recapstats` |

### 2.3 Сокет и медиа

| Хост | Метод | Путь | Режим | Маршрут | Данные платформы |
|---|---|---|---|---|---|
| `wsv3.fansly.com` | GET, Upgrade | `/?v=3` | автоматика | `ws.upgrade` | ответ Upgrade — нет (`capture: "none"`, `packages/fansly/src/wire/specs.ts:987`); кадры — да, через буфер (план §4.4) |
| `cdn*.fansly.com` | GET | подписанный адрес из работы | автоматика | `cdn.media` | нет: байты идут описателю через `sync_media_handoff` (`packages/fansly/src/wire/types.ts:237-243`) |

- Подключение сокета сайта допускается как сегодняшняя работа `ws.connect`: класс urgent (`fansly/registry.ts:192`), маршрут `ws.upgrade`; лестницу переподключений движок держит отказами в допуске (план §3.2). Сообщения — `wsAdmit`, `wsAdmitResult`, `wsDone` (§6).

### 2.4 Пути вне каталога, вход и записи

| Хост | Метод | Путь | Режим | Маршрут | Данные платформы | Статус |
|---|---|---|---|---|---|---|
| `apiv3` | GET | путь, которого нет в §2.2 | автоматика | `site.other`, семейство `site` | да | №3 (бюджет — §3) |
| `apiv3` | GET | пути сайта, найденные п. 10 | автоматика | свой маршрут в каталоге, как †; бюджет по умолчанию | да; ответы с секретами — нет | п. 10 |
| `apiv3` | OPTIONS | любой | оба | маршрут своего запроса | нет | решено, №1 |
| `apiv3` | п. 12 | вход: логин и пароль | ручной вход | `auth.login` | нет: секреты | п. 12 |
| `apiv3` | п. 12 | вход: код 2FA | ручной вход | `auth.twofa` | нет: секреты | п. 12 |
| `apiv3` | GET | чтения экранов входа | ручной вход | по §2.2, иначе `site.other` | да | п. 12 |
| `apiv3`, `mediav2` | POST, PUT, PATCH, DELETE | всё, кроме операций входа | закрыто | — | — | зафиксировано |

- Правило первого этапа: любые `POST`, `PUT`, `PATCH`, `DELETE` к API запрещены, кроме операций входа (план §4.6). Им закрыты `POST /group` (создаёт диалог), `POST /notes` и `/notes/edit` (заметки CRM) и записи второго этапа из разбора FBuddy: `POST /message`, `/message/broadcast`, `/message/delete`, `/post`, `/wall/postedit`, `/post/{id}/delete`, `/post/scheduled/{id}/cancel`, `/account/media`, `/account/media/bundle`, `/account/media/permissions`, `/vault/albums/media`, `/mediastories`, загрузка на `mediav2.fansly.com` (`fbuddy/02-operations-and-media.md:15-26`).
- Маршруты `auth.*` — POST, с бюджетом маршрута по умолчанию и вне семейства `site`: вход не ждёт неизвестных путей. Каталог сегодня знает только GET (`fansly/routes.ts:50-51`); POST добавляет PR 8.
- В режиме «ручной вход» проходят только его строки, остальные запросы сайта получают отказ `mode`. Строка §2.2, которую п. 12 найдёт среди чтений экранов входа, получает режим «оба».

### 2.5 «Никогда»

| Операция | Метод и путь (от `/api/v1`) | Откуда |
|---|---|---|
| Прочтение | `POST /message/ack` | план §4.6; тело `{messageIds, type: 2}` — `fbuddy/03-background-and-recovery.md:19` |
| Typing | `POST /message/typing` | план §4.6; `fbuddy/03-background-and-recovery.md:25` |
| Смена статуса | `POST /status` | план §4.6; `fbuddy/03-background-and-recovery.md:25` |
| Отметки просмотра | снимает прототип, п. 9 | требования: «не отправляет typing, просмотров и любых отметок» (`context.md:53`) |
| Выплаты и вывод средств | записи — снимает прототип, п. 12/9; чтения `/payments/payoutmethods` и `/payments/payout/requests` — маршруты движка, разрешены | план §4.6 |
| Реквизиты, почта, удаление аккаунта | снимает прототип, п. 12/9 | план §4.6 |
| Смена пароля, настройки 2FA | снимает прототип, п. 12; ввод пароля и кода при входе — операции входа | план §4.6 |

«Никогда» действует в обоих режимах, при ручном доступе и без оператора (план §4.6). Пока путей нет, эти операции на первом этапе закрывает правило записей (§2.4). Точные пути нужны до второго этапа: там правило записей заменит список разрешённых записей, а «никогда» останется.

### 2.6 Исходящие сообщения сокета

| Сообщение | Проверка в обёртке сокета | Откуда | Статус |
|---|---|---|---|
| Авторизация `{"t":1,"d":"{\"token\":\"…\",\"v\":3}"}` | `t` = 1; `d` — JSON ровно с полями `token` (строка) и `v` = 3; значение токена не сверяется | `apps/runtime/src/services/fansly-ws/connection.ts:149-154` | зафиксировано |
| Ping `"p"` | строка ровно `p` | `connection.ts:91-94`; у Hub раз в 20 с (`connection.ts:41`) | зафиксировано; интервал сайта — п. 9 |
| Прочие сообщения сайта в `wsv3` | — | п. 9 | до прототипа запрещены |
| `chatws.fansly.com`, например `t:46001` (подписка на комнату чата) | — | `fbuddy/03-background-and-recovery.md:13` | закрыто вместе с хостом |

Неизвестное сообщение не уходит: тревога `unknown_ws_message`, выход закрывается, страница стоит (план §4.3).

### 2.7 Правила расширения и тест одинаковости

| Уровень | Приоритет DNR | Правило | Действие |
|---|---|---|---|
| 1 | 400 | «никогда» (§2.5): метод и путь, например `\|\|apiv3.fansly.com/api/v1/message/ack` с `requestMethods: ["post"]`; пути с параметрами — `regexFilter` | `block` |
| 2 | 300 | операции входа (§2.4): метод и точный путь | `allow` |
| 3 | 200 | `post`, `put`, `patch`, `delete` к `apiv3.fansly.com` и `mediav2.fansly.com`; сокет к `chatws.fansly.com` | `block` |
| 4 | 100 | `localhost` и частные адреса — по адресу в запросе | `block` |

- При равном приоритете DNR предпочитает `allow`, а не `block`, поэтому приоритеты строго разные: строка входа не откроет «никогда». `OPTIONS` в правиле 3 нет: preflight строит сетевая служба Chrome (план §4.6).
- Тест одинаковости (PR 6) собирает `rules.json` из `operations.ts` и проверяет:
  - правила уровня 1 и строки «никогда» таблицы оператора — одно множество (метод, хост, шаблон);
  - ни одно правило уровня 2 не совпадает со строкой «никогда»;
  - у каждой строки «никогда» есть пример адреса, и его отменяют оба рубежа в обоих режимах.

## 3. Собственный трафик сайта — режимы (решение №3)

Таблица плана §4.3 в числах. Всё в разделе — **№3**.

| Трафик | Режим | Число |
|---|---|---|
| API сайта | класс работ `site`: один слот в каждом цикле планировщика, пока у движка есть работа, и любой слот, который движок оставил пустым | цикл `U R U R U R U R U P S` |
| | потолок на страницу — скользящий час по `sync_attempts` с `origin` `site` и `login` | 300 в час, ≈ 23 % потолка при S = 2,5 с; заменит замер п. 10 |
| | ожидание допуска, затем `Failed` | 60 с |
| | допущенный запрос занимает единственное место «в полёте»; дольше предела — оператор рвёт туннель к API, исход «после отправки» | 20 с, как запрос Hub; кандидат, п. 2 |
| | бюджеты общие с движком: маршрут по §2.2 и его семейство; путь вне каталога — `site.other`, семейство `site` | `site` — 6 в минуту |
| CORS-preflight | одна операция с запросом под одним допуском | решено, №1 |
| Страница, статика, картинки и превью CDN | без пейсинга, журнал | — |
| Подключение сокета | по допуску, как работа `ws.connect` класса urgent (§2.3); в потолок сайта не входит | ожидание — те же 60 с |
| Служебный трафик Chrome | через прокси, журнал соединений | — |

Как работает класс `site`:
- Внутри класса запросы идут по времени паузы `Fetch`. Запрос, чей маршрут закрыт бюджетом, пропускается, как ключ при выборе работ (`apps/runtime/src/sync/README.md:1020-1021`).
- Отказ сразу, не дожидаясь 60 с: пауза страницы (кроме операций входа в «ручном входе», план §3.2), удержание страницы или маршрута дольше остатка ожидания, операция не из текущего режима, потолок часа, полный буфер.
- Пауза пейсера отсчитывается от фактической отправки самого запроса (`siteDone`); следующая операция со своим preflight начинается не раньше паузы. Так «одна операция» решения №1 выглядит в журнале.
- Попытка сайта пишется с маршрутом, и часы маршрутов считают её своему маршруту; отправку без маршрута движок считал бы на все маршруты (`apps/runtime/src/sync/README.md:1016-1019`). Ответ сайта движок разбирает как свой (`engine/errors.ts`): 429 держит только маршрут, 401 и 403 — остановка страницы по учётным данным.

**Доли слотов.** В цикле 11 позиций: U на 0, 2, 4, 6, 8; R на 1, 3, 5, 7; P на 9; S на 10. Как сегодня, класс без работы пропускается без ожидания и не копит долг (`engine/scheduler.ts:9-16`).

| Работа есть у | U | R | P | S |
|---|---|---|---|---|
| всех | 5/11 ≈ 45 % | 4/11 ≈ 36 % | 1/11 ≈ 9 % | 1/11 ≈ 9 % |
| R, P, S | — | 4/6 ≈ 67 % | 1/6 ≈ 17 % | 1/6 ≈ 17 % |
| U, P, S | 5/7 ≈ 71 % | — | 1/7 ≈ 14 % | 1/7 ≈ 14 % |
| U, R, S | 5/10 = 50 % | 4/10 = 40 % | — | 1/10 = 10 % |
| S и один класс | U, S: 5/6 ≈ 83 % | R, S: 4/5 = 80 % | P, S: 1/2 = 50 % | 1/6, 1/5 или 1/2 |
| только S | — | — | — | все слоты, до потолка часа |
| нет у S | как сегодня: 50 / 40 / 10 %, без срочной 80 / 20 % (`engine/scheduler.ts:13-16`) | | | |

**Что это значит при S = 2,5 с.**
- Пауза в среднем 2,75 с: S × (1 + u), u от 0 до 0,2 (`engine/pacer.ts:30`, `:208`). Потолок — ≈ 1 309 отправок в час на страницу.
- При полной занятости движку — 10 слотов из 11 (≈ 1 190 в час), сайту — 1 из 11 (≈ 119 в час, примерно запрос в 30 с).
- Обычный час: движок занимает 5–9 % потолка (`context.md:111`), сайт ограничен только своим потолком. Вместе — не больше ≈ 32 %.
- Пиковый час: движок — до ≈ 1 000 запросов (≈ 77 %). Свободно ≈ 309 слотов, сайт может взять 300: страница работает у самого потолка, без запаса. Свой объём движок успевает (≥ 1 190 > 1 000), но любая добавочная работа, например заявка на историю, ждёт дольше.
- Срочная работа: когда у сайта есть запрос, между U на позициях 8 и 0 стоят два слота, P и S. Худшее ожидание — три паузы вместо двух: до ≈ 9 с вместо ≈ 6 с. SLO срочных работ в `sync check live-hour` — 12 с (`apps/runtime/src/sync/checks/live-hour-rules.ts:68-69`); пилот проверяет их вместе с трафиком сайта.
- Заявки на историю при полной занятости получают 36 % слотов вместо 40 %.
- Сайт при загрузке: за 60 с ожидания проходит около 21 его запроса при свободном движке и около 2 при занятом, из них путей вне каталога — не больше 6. Если п. 10 покажет больше, известные пути сайта получат свои маршруты (§2.4), а при занятом движке часть запросов сайта всё равно получит `Failed`. Какие фоновые функции сайта тогда пускать, решает владелец (план §7).

## 4. Пороги нагрузки и приёмки

Пороги проверяет общий нагрузочный тест этапа 2 (план §5): семь профилей одновременно, 2 часа у потолка, всплески событий, 15 минут без Hub, затем выгрузка буфера. Fansly на стенде изображает сервер стенда. Пилот (план §5, этап 4) повторяет пороги 4 и 6 на проде.

| № | Что | Порог | Как меряем | Кто утверждает |
|---|---|---|---|---|
| 1 | Страниц одновременно | 7: шесть и ari-2 (`context.md:5`) | все пороги — при семи профилях сразу | №3 |
| 2 | Запросов в час на страницу | у потолка — не меньше 95 % от 3600 / (1,1 × S): при S = 2,5 с ≥ 1 240. Запас — тот же прогон при S = 2,0 с, минимуме кода (`packages/shared/src/fansly-pause.ts:10`): ≥ 1 550. Сегодня в среднем 5–9 % потолка, в пике ≈ 77 % (`context.md:111`) | журнал сервера стенда: операций в час на страницу, трафик сайта включён | №3 |
| 3 | События сокета | вдвое выше замеров (`context.md:112`): всплески — 492 в минуту на страницу и 1 062 на все; фон — 38 тыс. в сутки на все | сервер стенда шлёт кадры размеров из реального трафика: фон и три всплеска по 5 минут | №3 |
| 4 | Сообщение фана видно в Hub | p95 ≤ 5 с | стенд: от кадра на сервере стенда до `dm_live_messages.first_visible_at`. Пилот: `slo_visible` в `sync check live-hour` — `first_visible_at − created_at` (`apps/runtime/src/sync/checks/live-hour.ts:292`) | требования (`context.md:104`) |
| 5 | Добавка браузера к запросу | p95 ≤ 300 мс | от `send` до `result` у движка минус время операции (preflight и запрос) в журнале сервера стенда | №3 |
| 6 | Добавка браузера к событию | p95 ≤ 500 мс; возраст буфера p95 < 2 с | от `Network.webSocketFrameReceived` до получения кадра движком; возраст — метрика буфера (план §4.11) | №3 |
| 7 | 15 минут без Hub | буфер выгружается без потерь и дублей не дольше 10 минут после возврата Hub, пока идут новые события | каждый ID кадра сервера стенда — ровно одна строка в Postgres | №3 |
| 8 | Ресурсы контейнера | в предварительных лимитах плана §3.1 — 2 ГиБ, 1 CPU, `/dev/shm` 1 ГиБ — пороги 2–7 выполняются; ни одного OOM; пик памяти ≤ 90 % лимита | счётчики cgroup раз в 5 с | №3; размер сервера — по итогу этапа 2 (план §4.12) |
| 9 | Hub и Postgres | среднее время десяти самых частых запросов Hub — не больше 1,1 × базового | `pg_stat_statements` на стенде; базовый замер — тот же сценарий без браузеров | №3 |

## 5. Буфер оператора

Значения предварительные (план §4.4). Окончательные — после замеров этапа 1, решение владельца №6.

| Что | Значение | Статус |
|---|---|---|
| Потолок объёма | 2 ГиБ на страницу | №6 после п. 10, 13, 17 |
| Потолок возраста | 72 ч: выходные без Hub | №6 |
| Тревоги | 50 % и 80 % любого из потолков | №6 |
| Что входит | кадры сокета, метки пропуска, ответы сайта для `observations`, исходы попыток до `resultAck`. Журналы — отдельно, 30 дней (план §4.11) | зафиксировано |

При исчерпании объёма, возраста или диска (план §4.3, §4.4, п. 8):
1. Новые запросы сайта получают отказ `buffer_full`.
2. Страница останавливается: движок ставит паузу, оператор закрывает выход. Сокет сайта рвётся вместе с туннелями (план §4.5).
3. Оператор ставит метку `gap` от последнего сохранённого события. Записанное в буфере не удаляется до `ack`.
4. Место освободилось — запуск заново по плану §4.1, движок догружает пропуск.

Оценка до замеров:
- Без Hub допусков нет, поэтому за простой копятся только кадры сокета и метки пропуска. Самая активная страница, ari-1, — ≈ 9,6 тыс. кадров в сутки (`context.md:112`), за 72 ч ≈ 29 тыс. Объём кадра снимает п. 13.
- На семь страниц нужно до 14 ГиБ диска под буферы. Это входит в расчёт диска сервера (`context.md:71`).

## 6. Протокол движок ↔ оператор

Транспорт — план §4.13: одно WebSocket-соединение `sync` → `ws://page-browser-<страница>:7700/rpc`, сообщения JSON, тела — двоичными кадрами. API подключается туда же со своим токеном и шлёт только `login.*`.

### 6.1 Типы

```ts
// MonoMs — CLOCK_MONOTONIC ядра, мс, общие для процессов сервера (план §4.2, шаг 5); WallMs — эпоха Unix, мс.
// Сроки — абсолютные моменты, не остатки. ID переживают перезапуски: повтор с тем же ID не исполняется дважды.
type MonoMs = number; type WallMs = number; type Sha256Hex = string;
type AttemptId = number;      // sync_attempts.id: попытка Hub, сайта, входа или сокета
type SiteRequestId = string;  // UUID; оператор пишет его в буфер до siteAdmit
type ConnectionId = string;   // UUID подключения сокета сайта; в буфер до wsAdmit
type CommandId = string; type BufferId = string; type BodyId = string;  // UUID
// Тело — двоичные кадры: 16 байт bodyId | 4 байта номер части | 1 байт «последняя» | до 1 МиБ данных.
interface BodyRef { bodyId: BodyId; decodedBytes: number; sha256: Sha256Hex }  // части приходят раньше JSON
type Mode = "automation" | "manual_login";  // «автоматика», «ручной вход»
type Step = "exit_closed" | "env_applied" | "chrome_started" | "control_attached" | "selftest_passed"
  | "exit_ip_verified" | "exit_open" | "site_loaded" | "session_confirmed" | "ready";  // план §4.1
type StopReason = "selftest_failed" | "exit_ip_changed" | "proxy_unavailable" | "proxy_auth" | "cdp_lost"
  | "holder_overflow" | "buffer_full" | "disk_full" | "chrome_crashed" | "unknown_ws_message"
  | "header_mismatch" | "login_required" | "owner_stop";
type ResponseSource = "network" | "revalidated_304" | "service_worker" | "cache_unconfirmed";
type Refusal = "lease_inactive" | "lease_used" | "send_deadline_passed" | "pace" | "takeover_floor"
  | "generation_stale" | "session_mismatch";  // первые пять — packages/fansly/src/send-guard.ts:126-131
type Admit = { admit: true; deadlineMono: MonoMs };
interface FromEngine { ownerGeneration: number }  // в каждом сообщении движка; меньше текущего — отказ
interface OperatorParams {  // значения — §8.2
  pingMs: number; linkLossMs: number; cancelMarginMs: number; siteAdmitWaitMs: number; siteRequestLimitMs: number;
  bufferBatchMs: number; eventBatch: { maxEvents: number; maxBytes: number }; exitIpCheckMs: number;
  bufferCap: { bytes: number; ageMs: number; alarmPercents: number[] }; selfTestMaxMs: number; screenshotMs: number;
  chromeBodyBuffer: { totalBytes: number; perResponseBytes: number }; restartBackoffMs: number[] }
// ── соединение ──
interface Hello extends FromEngine {
  type: "hello"; protocol: { majors: number[]; minor: number }; token: string;  // токен RPC страницы
  pageId: number; expectedAccountId: string; pinnedExitIp: string; params: OperatorParams;
  socks5: { ip: string; port: number; username: string; password: string };
  env: { timeZone: string; languages: string[]; geolocation: { latitude: number; longitude: number; accuracyM: number } };
}
type HelloResult = { type: "helloResult" } & (
  | { ok: true; protocol: { major: number; minor: number }; bufferId: BufferId; state: State }
  | { ok: false; reason: "token" | "protocol_major" | "generation_stale"; supportedMajors: number[] });
/** После hello нового поколения: прежнее завершено или отменено; от lastSendMono — пауза передачи. */
interface Quiesced { type: "quiesced"; previousGeneration: number; lastSendMono: MonoMs | null; lastSendWall: WallMs | null }
interface State {
  type: "state"; step: Step; stopReason: StopReason | null; retryAtWall: WallMs | null; exitOpen: boolean;
  mode: Mode; sessionFingerprint: Sha256Hex | null; accountId: string | null; exitIp: string | null;
  chromeVersion: string; operatorVersion: string; buffer: { bytes: number; oldestAgeMs: number };
  selfTest: { ok: boolean; atWall: WallMs; failed: "dnr_never" | "dnr_write" | "proxy_closed" | "os_rules" | "policies" | null } | null;
}
interface PingPong { type: "ping" | "pong"; n: number }  // раз в 1 с; нет ответа 5 с — связь потеряна
// ── запрос Hub (план §4.2) ──
interface Send extends FromEngine {
  type: "send"; attemptId: AttemptId; route: string;  // wire id: сверка заголовков с сайтом (план §4.7)
  credentialsGeneration: Sha256Hex; sessionFingerprint: Sha256Hex;  // живая сессия другая — не уходит
  method: "GET"; url: string; headers: Record<string, string>;  // без браузерных и сессионных (план §3.2)
  kind: "api" | "image" | "video"; maxBodyBytes: number;  // API 32 МиБ, медиа 5 МиБ
  sendDeadlineMono: MonoMs; requestDeadlineMono: MonoMs;  // выдача + 15 с; выдача + 20 с (медиа 10 с)
}
interface Check { type: "check"; attemptId: AttemptId; pausedMono: MonoMs; liveSessionFingerprint: Sha256Hex }
type CheckResult = FromEngine & { type: "checkResult"; attemptId: AttemptId } & (Admit | { admit: false; reason: Refusal });
interface Sent { type: "sent"; attemptId: AttemptId; sentMono: MonoMs; sentWall: WallMs; connectionReused: boolean }
interface Result {
  type: "result"; attemptId: AttemptId; sessionFingerprint: Sha256Hex; outcome:
    | { kind: "response"; status: number; headers: Record<string, string>; body: BodyRef; encodedBytes: number;
        source: ResponseSource; sentMono: MonoMs | null; sendMark: "transport_reported" | "completion_fallback";
        bodyOverflow?: boolean }  // заголовки — имена в нижнем регистре, повторы через ", "
    | { kind: "transport_error" | "timeout"; sent: boolean; message: string }
    | { kind: "aborted_before_send"; refusal: Refusal };
}
/** Исход любой попытки — result, siteDone, wsDone — записан; до этого он лежит в буфере. */
interface ResultAck extends FromEngine { type: "resultAck"; attemptId: AttemptId }
/** При старте движка, до закрытия незавершённых попыток (план §3.2); сначала оператор повторяет исходы. */
interface Recover extends FromEngine { type: "recover"; attemptIds: AttemptId[] }
interface RecoverResult { type: "recoverResult"; attempts: { attemptId: AttemptId; state: "outcome_resent" | "not_sent" | "unknown" }[] }
// ── запросы сайта (план §4.3) ──
interface SiteAdmit {
  type: "siteAdmit"; siteRequestId: SiteRequestId; method: string; host: string; path: string; query: string;
  resourceType: string; route: string; operation: "read" | "login";  // путь вне каталога — "site.other"
  sessionFingerprint: Sha256Hex | null; pausedMono: MonoMs; waitDeadlineMono: MonoMs;  // пауза Fetch + 60 с
}
type SiteAdmitResult = FromEngine & { type: "siteAdmitResult"; siteRequestId: SiteRequestId } & (
  | (Admit & { attemptId: AttemptId })
  | { admit: false; reason: "paused" | "held" | "mode" | "route_hold" | "site_hour_cap" | "buffer_full"
      | "session_mismatch" | "wait_expired" });
interface SiteDone {
  type: "siteDone"; siteRequestId: SiteRequestId; attemptId: AttemptId; sent: boolean; sentMono: MonoMs | null;
  sentWall: WallMs | null; connectionReused: boolean | null; status: number | null; retryAfter: string | null;
  error: { afterSendStart: boolean; message: string } | null;
  body: "buffered" | "not_platform_data" | "incomplete";  // incomplete — отметка и догрузка (план §4.3)
}
// ── сокет сайта ──
interface WsAdmit { type: "wsAdmit"; connectionId: ConnectionId; url: string; context: "page" | "frame" | "worker";
  sessionFingerprint: Sha256Hex | null; requestedMono: MonoMs; waitDeadlineMono: MonoMs }
type WsAdmitResult = FromEngine & { type: "wsAdmitResult"; connectionId: ConnectionId }
  & ((Admit & { attemptId: AttemptId }) | { admit: false; reason: string; retryNotBeforeWall: WallMs | null });
/** Исход Upgrade: 101 — открыт; 401/403 — остановка страницы auth; 429 — удержание ws.upgrade. */
interface WsDone { type: "wsDone"; connectionId: ConnectionId; attemptId: AttemptId; sent: boolean;
  sentMono: MonoMs | null; status: number | null; error: string | null }
// ── поток событий (план §4.4) ──
interface EventsSubscribe extends FromEngine { type: "events.subscribe"; bufferId: BufferId; afterSeq: number }
interface Events { type: "events"; bufferId: BufferId; events: BufferEvent[] }  // ≤ 500 событий или 1 МБ
/** Только непрерывная зафиксированная часть; чужой bufferId оператор отвергает. */
interface Ack extends FromEngine { type: "ack"; bufferId: BufferId; uptoSeq: number }
type BufferEvent = { seq: number; atMono: MonoMs; atWall: WallMs } & (
  | { kind: "ws.open"; connectionId: ConnectionId; attemptId: AttemptId; sessionFingerprint: Sha256Hex }
  | { kind: "ws.in"; connectionId: ConnectionId; frame: string }  // текстовый кадр как есть
  | { kind: "ws.close"; connectionId: ConnectionId; code: number | null; reason: string | null }
  | { kind: "gap"; fromSeq: number | null; fromWall: WallMs | null;
      reason: "ws_reconnect" | "operator_start" | "chrome_restart" | "buffer_full" | "disk_full" }
  | { kind: "site.response"; siteRequestId: SiteRequestId; attemptId: AttemptId; route: string; method: string;
      path: string; query: string; status: number; headers: Record<string, string>; body: BodyRef;
      complete: boolean; source: ResponseSource; sessionFingerprint: Sha256Hex });
// ── управление ──
interface Command extends FromEngine {
  type: "command"; commandId: CommandId; notAfterMono: MonoMs;  // просроченная не исполняется
  command: { kind: "closeExit" | "openExit" | "stopPage" | "restartBrowser" | "selfTest" | "profileSnapshot" }
    | { kind: "setMode"; mode: Mode };
}
interface CommandResult { type: "commandResult"; commandId: CommandId; ok: boolean; detail: string | null }
interface Alarm { type: "alarm"; atWall: WallMs; detail: Record<string, string | number | boolean>;  // без секретов
  kind: "unknown_ws_message" | "header_mismatch" | "selftest_failed" | "overflow" | "cdp_lost"
    | "fallback_release" | "late_send" }  // два последних — только при запасных правилах №10 и №16
// ── форма входа: API → оператор, свой токен API (план §4.8) ──
type LoginScreen = "login" | "code" | "error" | "success" | "unknown";
type LoginRequest = { callId: string; token: string } & ({ type: "login.state" } | { type: "login.screenshot" }
  | { type: "login.submit"; login: string; password: string } | { type: "login.code"; code: string });
type LoginReply = { callId: string } & (
  | { type: "login.stateResult"; screen: LoginScreen; screenVersion: string;
      fields: ("login" | "password" | "code")[]; siteError: string | null }
  | { type: "login.screenshotResult"; jpeg: BodyRef }
  | { type: "login.refused"; reason: "token" | "not_manual_login" | "screen_changed" | "busy" });
type EngineToOperator = Hello | (PingPong & FromEngine) | Send | CheckResult | ResultAck | Recover
  | SiteAdmitResult | WsAdmitResult | EventsSubscribe | Ack | Command;
type OperatorToEngine = HelloResult | Quiesced | State | PingPong | Check | Sent | Result | RecoverResult
  | SiteAdmit | SiteDone | WsAdmit | WsDone | Events | CommandResult | Alarm;
```

### 6.2 Что добавлено к таблице плана §4.13

- `helloResult` — ответ на `hello`: версия, ID буфера и состояние или отказ. `commandResult` — исход команды; `command.notAfterMono` — срок: просроченная команда не исполняется (`context.md:130`).
- `recover` и `recoverResult` — сверка незавершённых попыток с буфером при старте движка. План описывает её в §3.2 («Приём буфера и восстановление»), но сообщения для неё в §4.13 нет.
- `wsDone` — исход Upgrade сайта. Без него движок не закроет попытку `ws.connect`, а в полёте может быть только одна.
- `resultAck` подтверждает исход любой попытки: `result`, `siteDone`, `wsDone`. Неподтверждённые исходы оператор повторяет после переподключения.

### 6.3 Совместимость версий

1. Версия — пара `major.minor`, начальная 1.0. Движок шлёт в `hello` все major, которые умеет, и свой minor. Оператор выбирает старший общий major и возвращает выбранную версию в `helloResult`.
2. Внутри major — только добавления. Новое поле — необязательное, незнакомые поля получатель пропускает. Новый тип сообщения, вид команды или значение перечисления — это следующий minor; отправитель шлёт их, только если minor другой стороны их знает.
3. Неизвестный тип или значение внутри major — ошибка протокола: получатель закрывает соединение, движок открывает тревогу `browser_down` с причиной `protocol_error`.
4. Поле, от которого зависит безопасность — срок, поколение, допуск, отпечаток сессии, — вводится или меняет смысл только с новым major: старый получатель пропустил бы его молча.
5. Соседние версии работают вместе. Движок выкатывается с Hub, оператор — с образом браузера, порознь: движок релиза R работает с оператором релиза R−1, и наоборот. Смена major — в три шага: движок учится новому major, не забывая старый; операторы переходят по одной странице; следующий релиз движка убирает старый.
6. Общего major нет — `helloResult` с отказом `protocol_major` и списком `supportedMajors`, соединение закрывается; форма этого отказа не меняется ни в одной версии. Оператор остаётся на шаге 1 плана §4.1, выход закрыт. Движок пишет причину `protocol_version` в состояние страницы (`page_browsers`), открывает тревогу `browser_down` и не выдаёт допусков: страница стоит. Те же правила действуют для API и `login.*`.

## 7. Экраны входа

Распознавание — план §4.8. Оператор читает DOM из изолированного мира: адрес страницы, поля логина, пароля и кода, текст ошибки, загруженный аккаунт. Признаки лежат в коде оператора с версией (`screenVersion`, §6). Совпали не все признаки — экран незнакомый. Перед каждым нажатием экран распознаётся заново.

| Экран | Признаки | Что видит владелец в форме | Что делает оператор |
|---|---|---|---|
| Логин | п. 12 | поля «логин» и «пароль», снимок экрана | `login.submit`: фокус, `Input.insertText`, нажатие «Войти» |
| Код 2FA | п. 12 | поле «код» | `login.code`, так же |
| Ошибка | п. 12: текст ошибки сайта | текст ошибки | ничего не нажимает |
| Успех | п. 12: загруженный аккаунт | «вход выполнен» | сообщает движку; проверки плана §4.8, шаг 5, затем режим «автоматика» |
| Незнакомый: капча, подтверждение по почте, новое соглашение, изменённая форма | не совпал ни один экран | «откройте экран» и ссылка на KasmVNC | ничего не нажимает |

Отчёт п. 12 заполнит признаки, пути операций входа (§2.4), список экранов, которые Fansly показывает новому устройству, и отзывчивость KasmVNC.

## 8. Политики Chrome и параметры

### 8.1 `policies/hub.json`

```json
{
  "ProxySettings": { "ProxyMode": "fixed_servers", "ProxyServer": "127.0.0.1:3128" },
  "QuicAllowed": false, "WebRtcIPHandling": "disable_non_proxied_udp", "NetworkPredictionOptions": 2,
  "PasswordManagerEnabled": false, "PasswordLeakDetectionEnabled": false,
  "AutofillAddressEnabled": false, "AutofillCreditCardEnabled": false,
  "BrowserSignin": 0, "SyncDisabled": true, "BackgroundModeEnabled": false, "TranslateEnabled": false,
  "DefaultNotificationsSetting": 2, "DownloadRestrictions": 3,
  "RestoreOnStartup": 4, "RestoreOnStartupURLs": ["about:blank"],
  "RemoteDebuggingAllowed": true, "DeveloperToolsAvailability": 1,
  "ExtensionSettings": {
    "*": { "installation_mode": "blocked" },
    "<ID расширения>": { "installation_mode": "force_installed",
                         "update_url": "http://127.0.0.1:3128/pb-extension/update.xml" }
  }
}
```

- Сверх плана §3.1 добавлено:
  - `AutofillAddressEnabled` и `AutofillCreditCardEnabled` — так в политиках выражается «автозаполнение выключено»;
  - `RestoreOnStartup` и `RestoreOnStartupURLs` — Chrome всегда стартует на `about:blank` (план §4.1, шаг 3) и не открывает прошлых вкладок до подключения контроля;
  - `RemoteDebuggingAllowed` и `DeveloperToolsAvailability` — явно разрешены, чтобы порт CDP не зависел от значений по умолчанию (план §3.1);
  - `update_url` — на порту прокси. Правила ОС пускают Chrome только на `127.0.0.1:3128` (план §4.5), поэтому CRX и манифест обновления оператор раздаёт там же. К loopback Chrome ходит мимо прокси, и запрос приходит оператору обычным `GET`.
- `<ID расширения>` — постоянный ID нашего ключа подписи (план §4.6), появится в PR 6.
- Самопроверка сверяет применённые политики с этим файлом (план §3.1). Как их читать из Chrome, снимает прототип.

### 8.2 Параметры

| Параметр | Значение | Кто меняет |
|---|---|---|
| Пинг движок ↔ оператор; потеря связи | 1 с; 5 с | код |
| Срок допуска; запас до срока для отмены | 15 с (`SEND_WINDOW_MS`, `engine/pacer.ts:39`); 1 с | код |
| Предел запроса Hub | API — 20 с (`REQUEST_TIMEOUT_MS`, `engine/pacer.ts:42`); медиа — 10 с (`MEDIA_DOWNLOAD_TIMEOUT_MS`, `fansly/transport.ts:240`) | код |
| Предел тела ответа Hub | API — 32 МиБ (`packages/fansly/src/wire/send.ts:24`); медиа — 5 МиБ (`apps/runtime/src/services/egress/media-download.ts:24`) | код |
| Пауза при передаче страницы | ≥ 1,2 × S от последней отправки (`TAKEOVER_FACTOR`, `engine/pacer.ts:33`) | код |
| Доля класса `site`; потолок запросов сайта | 1 слот из 11; 300 в час на страницу | владелец, №3; потолок — по замеру п. 10 |
| Бюджет семейства `site` | 6 в минуту | №3; дальше калибровочным PR, как бюджеты маршрутов |
| Ожидание допуска запросом и сокетом сайта | 60 с | спецификация, по замеру п. 10 |
| Допущенный запрос сайта | до 20 с, затем обрыв туннеля к API | код; кандидат, п. 2 |
| Пачка записи буфера; пачка потока событий | ≤ 20 мс; 500 событий или 1 МБ | код, по замеру |
| Потолок буфера; тревоги | 2 ГиБ и 72 ч; 50 % и 80 % | владелец, №6 |
| Буфер тел ответов в Chrome; предел держателя | 100 МБ всего и 20 МБ на ответ; 128 МБ | код |
| Проверка выходного IP; самопроверка | перед открытием выхода и раз в 5 мин; при каждом запуске, не дольше 10 с | код |
| Сторож оператора; нет `state` — тревога `browser_down` | сигнал жизни раз в 1 с, порог 5 с (план §4.9); 2 мин (план §4.11) | код |
| Снимок экрана для формы входа | раз в секунду, пока форма открыта | код |
| Повтор запуска после сбоя | 10 с, 30 с, 2 мин, дальше раз в 5 мин | код |
| Журналы оператора | 30 дней, предварительно | код |
| Окно наблюдения при обновлении и в пилоте | 1 ч | владелец, №7 |

## 9. Рубеж отправки

Заполняется после этапа 1. До его отчёта обязательные условия №1 и №2 плана остаются блокирующими (план §1, §4.1, §4.2).

| Вопрос | Кандидаты плана | Проверка этапа 1 | Если не вышло |
|---|---|---|---|
| Обрыв CDP при живых процессах (условие №1, решение №10) | держатель CDP — только против сбоя оператора; плановая остановка — сначала выход, потом CDP; остановка Chrome годится, только если выход закрывается раньше, чем Chrome отпустит задержанные запросы | п. 1: 50 прогонов, ноль отправок без допуска по журналу сервера стенда | запасное правило плана §4.1 и отдельный PR к `context.md:99` |
| Отправка после срока допуска (условие №2, решение №16) | запрос Hub — `AbortController` в изолированном мире за 1 с до срока, если CDP не показал начала отправки; запрос сайта — прокси обрывает ещё не установленный туннель к API | п. 2: соединение дольше срока (20 с при сроке 15 с), открытый туннель, зависший TLS, повторно используемое соединение HTTP/2, остановленные оператор и процесс страницы | решение №16 |
| Какое событие CDP означает начало отправки | `Network.requestWillBeSentExtraInfo`, `timing.sendStart` | п. 2: расхождение с журналом сервера ≤ 50 мс | момент завершения — верхняя оценка (план §4.2, шаг 5) |
| Повторы самого Chrome (условие №2, решение №1б) | отключить или выдавать на каждый повтор свой допуск | п. 2: 408 на повторно использованном соединении, `REFUSED_STREAM`, `GOAWAY`; на допуск — ровно одна операция | решение №1б |

«Недорогой способ» решения №10 — без расшифровки трафика на проде и без смены архитектуры. После отчёта этапа 1 здесь записываются выбранный механизм, цифры прогонов и что остаётся от запасных правил.

## 10. Проверки при обновлении Chrome

Порядок — план §4.10: снимок профиля, одна страница и окно наблюдения, затем остальные. Любая проверка не прошла — откат этой страницы (прошлый образ и снимок профиля), тревога, раскатка стоит.

| Проверка | Проходит, если |
|---|---|
| Профиль и буфер | снимок до обновления лежит в `/opt/agency-hub/page-browser/snapshots/<профиль>/`; Chrome новой версии открыл профиль; новый оператор прочитал буфер, неподтверждённые события доставлены без дублей |
| Политики, расширение, самопроверка | применённые политики совпадают с `hub.json`; расширение установлено, ID прежний, правил DNR столько же, сколько в `rules.json`; самопроверка плана §4.1, шаг 5, прошла не дольше 10 с |
| Окружение | часовой пояс, `navigator.languages`, геолокация и разрешение экрана равны настройкам страницы (план §4.1, шаг 2) |
| «Устройство» | WebGL-рендерер, шрифты, экран, ядра и память — как до обновления (п. 16); расхождение — в отчёт владельцу |
| Сессия | `account.me` через браузер: ожидаемый account ID, отпечаток сессии прежний, нового входа не было |
| Сайт и заголовки | `https://fansly.com/` загрузился: не экран входа и не «браузер не поддерживается»; сверка запросов Hub и сайта (план §4.7) — ни одного расхождения |
| Сокет | Upgrade — 101, авторизация принята, ping идут, кадры доходят до Hub |
| Окно наблюдения, 1 ч (№7) | как в пилоте (план §5, этап 4, п. 4): ноль 429, 401, 403; `sync check live-hour` проходит; ни одного запроса «никогда» и запрещённого сообщения сокета; p95 сообщения фана ≤ 5 с; возраст буфера p95 < 2 с; память и CPU в лимитах; нет тревог `browser_down`, `protocol_changed`, `selftest_failed` |

## 11. Что утверждает владелец сейчас

Решение №3 — режимы собственного трафика сайта и пороги:
1. Класс `site`: один слот в цикле `U R U R U R U R U P S` и любой пустой слот (§3).
2. Потолок — 300 запросов сайта в час на страницу; после п. 10 его заменит замер.
3. Ожидание допуска — 60 с, затем `Failed`; допущенный запрос — до 20 с.
4. Пути вне каталога — маршрут `site.other`, семейство `site`, 6 в минуту.
5. Страница, статика и картинки CDN — без пейсинга, с журналом. Подключение сокета — по допуску, как `ws.connect`. Служебный трафик Chrome — через прокси, с журналом.
6. Пороги раздела 4: 7 страниц; темп ≥ 95 % потолка (≥ 1 240 в час при S = 2,5 с, ≥ 1 550 при 2,0 с); события вдвое выше замеров; p95 сообщения фана ≤ 5 с; добавка браузера ≤ 300 мс к запросу и ≤ 500 мс к событию; выгрузка после 15 минут без Hub ≤ 10 минут; ресурсы контейнера; Postgres ≤ 1,1 × базового.

После прототипа: карта операций (№2, §2), потолки буфера (№6, §5), рубеж отправки и повторы Chrome (№10, №16, №1б, §9). Статус присутствия (№4) — по замеру этапа 1, окно наблюдения (№7) — к этапу 4.
