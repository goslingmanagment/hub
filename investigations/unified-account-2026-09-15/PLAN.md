# Единый аккаунт чаттера и регистрация по приглашению — план v3

Дата: 2026-09-15. Репозитории: хаб `b48f173`, расширение `3fced7f` (2.2.2), десктоп `df7b452` (v0.1.54).
Статус: план утверждён владельцем к реализации одной волной (см. §11). Ревью: Fable-критик (25 замечаний) и codex (второе мнение) — диспозиция в Приложении B.

Читать перед стройкой: `CLAUDE.md`, `docs/decisions.md` (#12, #13, #14, #116, #117, #126, #143, #145), `docs/error-handling.md`, `docs/generated/15-auth-config-and-access.md` (снимок 2026-07-15, часть утверждений устарела — см. §1).

---

## 0. Резюме

**Единый аккаунт уже существует.** `users` платформо-нейтральна, назначения страниц не знают платформы, оба клиента входят по одному логину и паролю и чеканят себе device-токены, права считаются сервером по одному принципалу независимо от клиента. Гриша (#17) — живое доказательство: один пользователь, токены расширения и десктопа, страницы Fansly и OnlyFans.

**Сломана церемония, а не модель:**
1. Регистрации нет. Владелец создаёт логин тремя неатомарными вызовами, придумывает пароль сам и диктует его в Telegram. Нет приглашений, сброса, смены пароля со стороны чаттера.
2. Два протокола входа. Расширение: cookie-login → мгновенный выпуск токена → logout, при этом затирает cookie дашборда в том же профиле Firefox. Десктоп: raw-login с ручным перехватом `set-cookie` → reserve → activate → logout. Ни один клиент не может войти без cookie-сессии.
3. Расширение требует вручную ввести адрес хаба и разрешить optional-origin. Десктоп открывается пустым, вход спрятан в Settings → Agency Hub.
4. Ошибки говорят про «API-ключ», 401 без причины, клиенты не самоисцеляются: красная строка «HUB AUTH» требует ручного Sign out → Sign in (триггер D19).
5. Legacy API-ключ двойным путём принимается в обоих клиентах; гейт удаления #116c не исполнен.
6. В админке нет списка устройств, отзыва по устройству, честного «выйти отовсюду», привязки harvest.
7. Роли: `content_manager` мёртв, чаттер может залогиниться в дашборд и получить 403 на каждой странице.
8. Гонка в `loginWithPassword`: пароль проверен до транзакции, сессия создаётся без блокировки и повторной сверки хеша (подтверждено, `apps/runtime/src/services/auth.ts:1064+`).

**Целевая картина.** Одна история для любого чаттера: получил ссылку-приглашение в Telegram → придумал пароль → вошёл в расширение и приложение одним логином и паролем. Один протокол входа без cookie. Кабинет `/account` на хабе: устройства, смена пароля, свои AI-траты. Вкладка «Команда» у владельца: пригласить, сбросить ссылкой, устройства, завершить входы. **Интерфейсы и код делаются заново и без legacy: ни одного поля «API-ключ», ни одной кнопки «Issue Key»; fallback на legacy-ключ, custody-слоты ключа, cookie-церемонии входа и их тесты вычищаются из клиентов в тех же релизах, а не «через один». На хабе `api_keys`-лейн (люди и роботы), cookie-роуты выпуска токенов и замороженный `must_change_password` удаляются в PR-4, как только флот перешёл на новые клиенты (§10). Данные не удаляются никогда: таблицы остаются как факты.**

---

## 1. Факты, на которых стоит план (проверены по коду 2026-09-15)

### Хаб
- Миграции: последняя `0181`, следующая `0182`. Раннер применяет миграции в транзакции; для `CREATE INDEX CONCURRENTLY` есть маркеры `-- agency-hub:no-transaction` + `-- agency-hub:statement` (`packages/db/src/migrate-runner.ts:14-16, 176-217`, образец `0096`). Миграции forward-only, `assertContiguousAppliedPrefix` не даёт «откатить одну».
- **Автоотката деплоя при схемной миграции нет:** `scripts/deploy-production.sh:656-676, 826-833` пропускает откат, если `schema_migrations` изменился не из `ROLLBACK_COMPATIBLE_MIGRATIONS`. Ручной откат образа при аддитивных миграциях совместим.
- `users`: `username` UNIQUE, регистрозависимый (`findUserByUsername` = `eq`, `packages/db/src/repositories/auth.ts:55-59`); бэкофф логина уже lowercase (`auth.ts:995-999`). Нет email, нет display name. `password_hash` nullable, `must_change_password`, `disabled_at`, `device_token_epoch`.
- `device_tokens`: `label` свободный текст, нет колонки клиента; `last_used_at` пишется на каждом запросе; `x-client-version` приходит с каждым запросом, но не хранится. Активированный токен сохраняет префикс `agency_hub_pending_device_` (защита отката 0092, `auth.ts:1318-1321`).
- Роуты: `login/logout` public, `me` any, `authChangePassword`/`authIssueDeviceToken`/`authReserveDeviceToken` any-session (cookie), `authActivateDeviceToken` pending-device-token, `authRevokeCurrentDeviceToken` device-token; всё админское owner-session. `any` = session, device_token **и api_key** (`auth-policy.ts:128-131`); `roles` в `RouteAuthPolicy` не использует ни один роут.
- `AUTH_POLICY_ENFORCEMENT=enforce` на проде (#143), легаси-гарды в хендлерах дублируют политику намеренно.
- Создание чаттера: `POST /admin/users` отказывает пароль для chatter (`auth.ts:432`); дашборд `provisionChatter` = три вызова с ретраем.
- `setUserPassword` (сброс владельцем) двигает epoch, отзывает сессии и pending, **не отзывает device-токены**. `revokeDeviceTokensForUsername` отзывает device-токены и pending, **не отзывает сессии и API-ключи**. `deactivateUser` отзывает всё; `account_links` в него автоматически не попадут.
- `recordAudit` дублирует каждое событие в `observations` (`source=operator`, `producer=api:admin`, 100 лет ретеншна). Реестра event_type нет.
- Fastify логирует `req.url` каждого запроса; API за хостовым nginx с access-log. Токен в path попадает в оба лога.
- `request.auth` мемоизируется как `null` при провале (`request-auth.ts:139-152`), enforce-ветка бросает голый `UnauthorizedError()` (`server.ts:379-381`). Структурные расширения тела ошибки — по образцу `OfapiCollectionRefusedError` (`server.ts:498-512`); SDK отдаёт тело как `KernelApiError.body` на typed/raw пути (`sdk-runtime.ts:221-236`), SSE-путь (`:478+`) проверить.
- `must_change_password`-гейт действует только на `authMethod === "session"` (`server.ts:366-376`).
- Global `errorResponseBuilder` для 429 пишет «Too many login attempts» (`server.ts:206-220`).
- Бюджет `platform ===` = 155, считает `apps` (включая `apps/dashboard`), `packages`, `tests` (`scripts/check-platform-branches.mjs:23`); `UsersTab.tsx:107,112` уже содержат два сравнения.
- Пины: `contracts-auth-declarations`, `authorization-policy-table`, `contracts-generation-gate`, `contracts-route-security`, `retention-deleters` (allowlist файлов; `services/auth.ts` и `repositories/auth.ts` в нём), `auth-policy.*`, `device-token-lifecycle.integration`, `identity-grants.integration`, `users-tab.test.ts`, `dashboard-users-loading`, `dashboard-sdk-ban` (api-слой дашборда обязан идти через `./sdk.js`), `sdk-runtime-auth-hooks`, `vendor-sdk-staging`. `pnpm contracts:generate` пишет `reference/agency-hub.openapi.json`, `contract-hash.ts`, `packages/sdk`, `docs/generated/authorization-policy.md`.
- Wire-enum'ы `authMethod` и `role` закрыты в клиентах: добавление значения ломает `/auth/me` у не перевендоренных; добавление полей безопасно (`$strip`).
- SSE перепроверяет авторизацию раз в 60 с (`modules/events/index.ts:86`).
- AI-леджер: `ai_usage_events` по `user_id` с `cost_micro_usd`, фичей, исходом gateway; `listChatterUsageSummary` (`packages/db/src/repositories/ai-usage.ts:478`) агрегирует по чаттерам за диапазон дат для owner-роута `adminChatterUsage`.
- Rate limit: `/auth/login` 20/мин/IP (`TRUST_PROXY=1`); бэкофф по аккаунту in-memory per-process (один API-процесс на проде).
- CORS-плагина нет; дашборд same-origin; cookie `agency_hub_core_session` Lax, без Domain, 30 дней.
- Decision #117: «никакой identity-работы не ждёт чаттерского веб-сервиса… если владелец позже не закажет» — владелец заказал (§11), решение частично отменяется новой записью.

### Расширение (`~/code/goose/fansly-ext`)
- Вход только на options-странице, пане «Agency Hub»: адрес хаба вручную (default `''`), «Разрешить доступ» (optional host permission), логин+пароль → `src/background/device-token.ts:35-86`: SDK cookie-mode `login` → `authIssueDeviceToken({label:'chatgoose-extension firefox'})` → `logout`. Reserve/activate не используется.
- Custody: ключи `agencyHubDeviceToken`, `agencyHubApiKey` (E19, v13), мета `chatgoose:deviceTokenMeta`; `STORAGE_SCHEMA_VERSION=16`; правило «пустые строки, ключи не удалять» до удаления v12-fallback; `storage.local` читаем content-script'ами (признано в E10/E19 как future hardening).
- `resolveHubBearer` = device token, иначе legacy-ключ (`agency-hub-client.ts:89-95`) — про мету не знает.
- 401/403 → `hub_invalid_api_key` (CG-HUB-03), токен не стирается. Заняты коды CG-HUB-01…16; следующий свободный **CG-HUB-17**.
- Защита от двойного клика «Войти» есть (`options/index.ts:2135, 2195`).
- Страница хаба резолвится по username Fansly на каждой операции через `GET /pages` с фильтром `platform==='fansly'`.
- Релиз: `scripts/deploy.sh` (AMO unlisted, одноэлементный `updates.json`, гейт «хеш контракта прода == вендоренный»); флот обновляется на цикле Firefox; вендоренный хеш `c587d1eb…` уже отстаёт от прода `52984c9d…`.
- **Firefox MV3:** `host_permissions` показываются и выдаются в промпте **установки** (127+; `strict_min_version` 142), но при **обновлении** расширения новые host_permissions не показываются и не выдаются (bug 1893232). Runtime `permissions.request` по user gesture остаётся обязательным для существующих установок.
- `check-ai-cutover.mjs:41-45` запрещает в README/guide слова `Claude|Введите API-ключи|…`.

### Десктоп (`~/code/goose/of-desktop`)
- Гейта первого запуска нет: пустой workspace, «+» с тултипом «Аккаунты подключает ваш админ». Вход в Settings → Agency Hub (`HubSettings.tsx:175-224`); URL по умолчанию `https://gosling-agency.ru`, валидатор пускает только его и loopback.
- `main/hub/device-token.ts:171-283`: raw `POST /auth/login` → ручной `set-cookie` → `authReserveDeviceToken({label: hostname()})` → staged в keychain + журнал → `authActivateDeviceToken` → `logout`. 56 кейсов в `tests/hub/device-token.test.ts`. Токен только в main (safeStorage), рендерер видит `tokenLast4`.
- `hubDeviceTokenStatus()` (`hubSettingsLogic.ts:22`) даёт `unset` и на установке с рабочим legacy-ключом; `isHubConfigured()` там true. `legacyKeyState()` различает `working-fallback` / `isolated`.
- 401 → `CG-HUB-01`, `isHubAuthFailure` смотрит только код (`main/index.ts:207-213`); токен не удаляется (fail closed); wipe без сети — путь «abandon» (пин `device-token.test.ts:1323`).
- `/auth/me` только в «Test connection», считает страницы обеих платформ. Ноль OF-страниц → пустое приложение без объяснения; локальные назначения кешируются (`db/queries/accounts.ts:97`).
- Harvest: `harvest.install_id` per install; привязка только owner-API, UI нет; в проде harvest никогда не использовался.
- Legacy-ключ скомпилирован: `resolveHubCredential`, `hubApiKey` в `SettingsPatch`, `CHATGOOSE_HUB_API_KEY` сидится и в packaged-сборках (`main/index.ts:1296-1306`).
- i18n: `packages/shared/src/i18n/catalog.ts`, пин `packages/shared/tests/i18n.test.ts`. `documentation-cutover.test.ts:22-24` требует в WINDOWS-GUIDE `/Agency Hub/` и `/device token/i`.
- Релиз: тег `v*` → windows-build; публикация только если прод `/health.contractHash == vendored` и capability `desktop-lifecycle-v2` (статична в `public-capabilities.ts:8-10`). Откат запрещён (D8/D11). Вендоренный хеш `9560b366…` отстаёт от прода.

### Прод (перепись 2026-09-15 по журналу `observations`; живые таблицы `users/*tokens*` роли `read_only` не видны — см. Приложение A)
- Люди: `admin`(1, владелец, дашборд), `Dmitriy`(2, расширение + desktop-токен с harvest, единственный доказуемый legacy-ключ), `Nikita`(3, расширение; есть desktop-токен `MacBook-Air.local`), `Maxim`(6, десктоп), `Grisha`(17, оба клиента, страницы обеих платформ), `Ivan`(5, деактивирован), `probe-ops`(16, живой тест без кредов), #4 — никогда не действовал. 19 тест-пользователей деактивированы; #22 держит гранты `lora-of`/`lora-vip-of`.
- Онбординг реальный: 1 новый человек за 70 дней, 5 активаций device-токена всего; Гриша выпустил 3 токена расширения за 10 минут (три осознанных входа после пугающего текста про ключ).
- Конфиг: `AUTH_POLICY_ENFORCEMENT=enforce`, `REVENUE_ROUTE_ROLE_ENFORCEMENT=enforce`, `SESSION_TTL_DAYS=30`, `TRUST_PROXY=1`, `ACCESS_GRANTS_READ_ENABLED` не задан (=false: гранты на модель в проде мертвы). Образ = `origin/main`.
- Брутфорс-всплеск 07-27 (20 fail/мин, неизвестные логины) — лимит выдержал.

---

## 2. Целевой опыт

### Чаттер
1. Получает в Telegram от владельца ссылку `https://gosling-agency.ru/join#<токен>` (7 дней, одноразовая) с коротким текстом.
2. Открывает (с ПК или телефона): «Привет, grisha! Придумай пароль для ChatGoose» → пароль ×2 (≥12 символов, не из чёрного списка) → «Готово. Логин: grisha. Этим логином и паролем входи в…» + кнопки только для платформ, на которых у него есть страницы: «Установить расширение для Fansly», «Скачать приложение для OnlyFans», и ссылка на единую страницу «Как начать».
3. Расширение: адрес хаба уже подставлен; экран «Вход в ChatGoose»: логин, пароль → «Войти» → готово. Промпт разрешения Firefox — один раз, по клику «Войти» (для новых установок — при установке).
4. Приложение: при первом запуске сразу экран «Вход в ChatGoose» → «Войти» → workspace.
5. В каждом клиенте маленькая секция: «Вы вошли как grisha · чаттер · страницы: …», кнопки «Аккаунт» (открывает `/account`), «Выйти».
6. Забыл пароль → пишет владельцу → получает ссылку сброса → задаёт новый; все прежние входы завершаются.
7. Кабинет `/account`: кто я и мои страницы, устройства (отозвать, «выйти на всех устройствах»), смена пароля, мои AI-траты (сегодня / 30 дней / по дням / по фичам).
8. Если токен отозван или истёк — клиент сам стирает его и показывает экран входа с понятной причиной.

### Владелец
1. Настройки → «Команда» → «Пригласить»: логин, страницы (мультивыбор, группировка по платформе), кнопка. Роль (chatter по умолчанию) и срок ссылки (7 дней) — под «Дополнительно». Одна атомарная операция → модалка с готовой ссылкой, кнопкой «Скопировать» и шаблоном сообщения для Telegram.
2. Карточка человека: Устройства (метка, версия клиента, последняя активность; «Отозвать вход» по одному; «Отозвать все устройства»; «Завершить все входы»), Ссылки (приглашения и сбросы с состоянием; «Сбросить пароль ссылкой»), Страницы, Деактивировать/Реактивировать.
3. «Техническое» (отдельный раздел в «Доступ»): агентские ключи (есть), привязка harvest по machineId.
4. Никаких API-ключей ни у кого: staff (team_lead) тоже приглашается ссылкой; аккаунты owner создаются только CLI.

### Словарь для пользователя (обязателен для всех экранов, гайдов и ошибок)
Device-токен — внутренняя механика, как cookie сессии. Пользователь знает только **логин, пароль и устройства**.
- Слова «токен», «device token», «ключ», «API», «bearer», «активация», «резервация», «префикс» в пользовательских текстах **не встречаются** (пин: grep-тест по каталогам копи обоих клиентов, join/account-страницам, гайдам и шаблону Telegram).
- Модель: «Вход на этом устройстве» / «Вы вошли как grisha» / «Выйти с этого устройства» / «Ваши устройства: Firefox на Windows · вход 3 дня назад» / «Выйти на всех устройствах». Метаданные токена (префикс, дата выпуска, срок, «продлевается при использовании») пользователю не показываются; в кабинете и карточке владельца — только метка устройства, версия клиента, последняя активность.
- Истечение и отзыв: «Сессия на этом устройстве завершена, войдите снова» (без причины в терминах токенов); владельцу в карточке — «Завершить вход на устройстве».
- Технические детали (last4, id токена, machineId) остаются только в «Диагностике» десктопа и в «Техническом» разделе дашборда.
- Гейты доков клиентов переписываются под словарь: `documentation-cutover.test.ts` десктопа сегодня **требует** фразу «device token» в WINDOWS-GUIDE — регекс инвертируется (запрещает), то же для `release-pages`/`check-ai-cutover` расширения.

---

## 3. Ключевые решения

| № | Решение | Почему / альтернатива |
|---|---|---|
| Р1 | Регистрация = приглашение по одноразовой ссылке на хабе; сброс пароля тем же механизмом (`kind=password_reset`). Открытой саморегистрации нет. | Закрытое агентство, канал доставки — Telegram владельца (вручную, v1). Одна реализация для обоих клиентов. Код приглашения внутри клиента = две UI-реализации и нет сброса. Email/SMS не вводим. |
| Р2 | Единый протокол входа клиентов: логин+пароль → device-токен **без cookie**, новый публичный роут с режимом `active` (расширение) / `pending` (десктоп, далее существующая активация). | Убирает затирание cookie в Firefox и парсинг `set-cookie` в Electron. Расширению reserve→activate не нужен: его custody — один атомарный `storage.local.set`, а pending-токен в боевом ключе давал бы 401 без причины всё окно резервации. |
| Р3 | Структурный `reason` в 401 для предъявленного device-токена, нашедшего строку: `token_revoked` \| `token_expired`. Клиенты самоисцеляются с двумя предохранителями (§6.4). | `user_disabled` недостижим: деактивация отзывает токены. Неизвестный digest — без `reason` (нет перебора). |
| Р4 | Логин нормализуется: **уникальный индекс по `lower(username)`**, поиск по `lower`, одна функция нормализации в приглашении, старом создании и логине. | Без индекса два конкурентных приглашения дают двух пользователей, поиск по `lower` становится неоднозначным. Риск падения миграции снимается переписью (Приложение A, запрос 2) и маркером `no-transaction`. |
| Р5 | Кабинет `/account` на хабе — в v1, по заказу владельца (частично отменяет #117). | Чаттер уже session-capable; нужны только self-service роуты. Кабинет и есть «один аккаунт» глазами чаттера. |
| Р6 | Три операции отзыва с честными именами: «Отозвать вход» (один device-токен), «Отозвать все устройства» (device-токены + pending), «Завершить все входы» (device-токены + pending + сессии + API-ключи + epoch). Сброс по ссылке **всегда** = «Завершить все входы». | Сегодняшний revoke-all не трогает сессии и ключи; называть это «выйти отовсюду» нельзя. Без чекбокса проще и безопаснее. |
| Р7 | Метка токена по конвенции: расширение `Firefox · <ОС>`, десктоп `Desktop · <hostname>`; колонка `last_client_version` пишется тем же UPDATE, что `last_used_at`. | Колонка `client` — самоутверждение клиента ради отчёта; версия клиента полезнее (поддержка, гейт #116c) и бесплатна. |
| Р8 | `api_keys` выводятся **целиком** — и у людей, и у роботов: роуты, auth-лейн, дашборд, CLI (PR-4). Таблица остаётся как факт. Роботам (пробы, скрипты) — device-токен робот-пользователя через `mode=active` или агентский ключ (#195) для чтения. | В проде ни один робот ключами не пользуется: ключи выдавались только тест-пользователям (деактивированы) и Dmitriy. Отменяет хвост #116(c) «Issue Key survives — for automation» по решению владельца 2026-09-15. |
| Р9 | Одна волна: ядро аддитивно первым (один деплой), затем один релиз расширения и один релиз десктопа, затем чистка. Клиентские ветки стартуют параллельно с ядром. | Гейты хеша контракта не пропустят иной порядок публикации. |
| Р10 | Два аккаунта владельца (`admin`, `Dmitriy`) остаются раздельными. | Device-токен owner в браузере = доступ ко всем страницам и всем `any`-роутам; ранбук break-glass запрещает owner-креды на чаттерских машинах; чаттерский аккаунт даёт наименьшие права и отдельную атрибуцию. |
| Р11 | Матрица прав — отдельный проверяемый результат (§7) + ранбук увольнения с честными границами. | «Общий пользователь» ≠ «согласованные права»: роль, способ входа, назначения, права устройства и локальный кеш клиентов — разные оси. |
| Р12 | Не делаем: вход через браузер (PKCE/SSO), автоотправку в Telegram, флип `ACCESS_GRANTS_READ_ENABLED`, новые роли, `roles` в декларациях политики, переименование policy-kind `apiKey`, атрибуцию заработка чаттера. | Каждое — отдельное решение; §12. |

---

## 4. Контракты поведения (фиксируются до кода, пинятся тестами)

### 4.1 Жизненный цикл ссылок (`account_links`)
1. Токен: 32 случайных байта (`randomToken(32)`), хранится только sha256-digest + 10-символьный префикс; сырой токен возвращается один раз в ответе на создание и **никогда** не пишется в аудит, observations, логи и URL-path.
2. Ссылка передаётся во фрагменте URL (`/join#<токен>`) и уходит на сервер только телом POST.
3. Срок: по умолчанию 7 дней, максимум 30. Одноразовая: `used_at` ставится в той же транзакции, что и пароль.
4. `invite` завершает только незавершённую регистрацию (у пользователя `password_hash IS NULL` **или** пользователь ещё ни разу не погашал invite). Для пользователя с паролем повторный `invite` не создаётся — только `password_reset`.
5. Новая ссылка любого вида аннулирует все прежние активные ссылки того же пользователя (`revoked_reason = superseded`). **Каждый писатель ссылок сначала берёт user-lock** (`FOR UPDATE` на `users`, тот же порядок «пользователь → ссылка», что у device-токенов, см. комментарий `repositories/auth.ts:310`) и под ним перепроверяет право на вид ссылки; на уровне БД инвариант «не более одной активной ссылки на пользователя» держит частичный **уникальный** индекс (§5.1). Тесты: параллельные create/create и create/сброс пароля.
6. Успешное погашение любой ссылки, а также `authChangePassword` и `adminSetPassword`, аннулируют все активные ссылки пользователя (`revoked_reason = password_set`).
7. `deactivateUser` отзывает активные ссылки (`user_deactivated`); реактивация их не оживляет — владелец создаёт новую.
8. `password_reset` разрешён только для `chatter` и `team_lead`; для `owner` — 400 (владелец меняет пароль через `authChangePassword`).
9. При погашении все проверки (состояние ссылки, `disabled_at`, роль, срок) повторяются под `SELECT … FOR UPDATE` пользователя и ссылки.
10. Потерянный ответ при создании: владелец видит пользователя в «Команде» со статусом «ждёт регистрации» и создаёт новую ссылку (п.5 аннулирует потерянную).
11. `inspect` для активной ссылки возвращает `{state:'active', kind, username, expiresAt, platforms: ('fansly'|'onlyfans')[]}` (платформы из назначенных страниц — экран «Готово» показывает только нужные клиенты); для истёкшей/использованной/отозванной — только `{state}`; неизвестный digest — 404 `not_found`.
12. Состояние регистрации видно владельцу: `adminUserSchema` получает аддитивное поле `registrationState: 'invited' | 'active'` (`invited` = `password_hash IS NULL`); в `toAdminUser` (`auth.ts:290`) сегодня признака пароля нет. Для `invited` в карточке — кнопка «Отправить приглашение заново» (`adminCreateAccountLink(kind=invite)`, п.5 аннулирует потерянную).
13. Ничего не удаляется: истёкшие и использованные ссылки остаются как факты (ретеншн-пин не трогаем).

### 4.2 Пароли
- На `redeem`: 12–256 символов, не входит в чёрный список (top-1000, файл в `packages/shared`), argon2id с текущими параметрами.
- `login`, `adminSetPassword`, `authChangePassword` — без изменений (min 8), чтобы не ломать существующих.
- `must_change_password` остаётся замороженным (#116b); ссылки его не ставят. Новый вход по паролю при поднятом флаге отвечает 403 `password_change_required`, чтобы флаг не терял смысла.

### 4.3 Единое ядро проверки пароля (закрывает гонку логина)
`verifyPasswordAndLockUser({username, password})`:
1. `assertLoginNotBackedOff` (общий бэкофф для `login` и нового входа).
2. `findUserByUsernameInsensitive`; для неизвестного/деактивированного/без хеша/не session-capable — dummy-verify + бэкофф + аудит `auth.login_failed` + 401 (как сегодня).
3. `argon2.verify`.
4. **Внутри транзакции**: `lockUserForDeviceTokenMutation` (FOR UPDATE), повторная сверка `password_hash` (равен прочитанному), `disabled_at IS NULL`, `device_token_epoch` равен прочитанному; расхождение → 401 без утечки причины.
5. Только затем создание сессии (login) или токена (новый вход) в той же транзакции.
`loginWithPassword` переводится на это ядро в PR-1A.

### 4.4 Семантика отзыва
| Операция | Что делает | Где |
|---|---|---|
| Отозвать вход | один device-токен по id (`revoked_reason = revoked_by_owner` / `self_revoked`) | карточка владельца, кабинет |
| Отозвать все устройства | все device-токены + pending, epoch++ (сессии и ключи не трогает) | карточка владельца |
| Выйти на всех устройствах | все device-токены + pending + все сессии, **кроме текущей**, epoch++ | кабинет (self) |
| Завершить все входы | device-токены + pending + все сессии + API-ключи + активные ссылки, epoch++ | карточка владельца; автоматически при сбросе по ссылке и при деактивации |

### 4.5 Причины 401 и самоисцеление
- Сервер: `authenticateDeviceToken` возвращает `{principal} | {failure}`; провал кладётся в `request.authFailure` (не в мемоизированный `request.auth`), `UnauthorizedError` получает сериализуемое поле `reason` по образцу `OfapiCollectionRefusedError`; документируется в `docs/error-handling.md` (строка `unauthorized` + структурное расширение `reason`).
- Клиент стирает custody только если: (а) `reason ∈ {token_revoked, token_expired}`, (б) bearer, получивший 401, совпадает с текущим сохранённым (сравнение digest), (в) операция выполняется внутри custody FIFO. Безпричинный 401 — fail closed, как сегодня.
- Расширение при стирании токена стирает и legacy-ключ (иначе `resolveHubBearer` молча подхватит его). Десктоп идёт путём «abandon без сети».

---

## 5. Ядро (хаб) — PR-1A

### 5.1 Миграции
**`0182_account_links.sql`** (в транзакции):
```sql
create table account_links (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  kind text not null check (kind in ('invite','password_reset')),
  token_digest text not null unique,
  key_prefix text not null,
  created_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  metadata jsonb not null default '{}'::jsonb
);
create index account_links_user_idx on account_links(user_id);
create unique index account_links_one_active_uidx on account_links(user_id) where used_at is null and revoked_at is null;
alter table device_tokens add column last_client_version text;
```
**`0183_users_username_lower_uidx.sql`** — обычная транзакционная миграция, **без** `concurrently`:
```sql
create unique index users_username_lower_uidx on users (lower(username));
```
Таблица на ~30 строк, блокировка мгновенная; транзакция даёт restart-safety. Вариант с `no-transaction` + `concurrently` отвергнут: раннер сначала выполняет SQL и лишь потом пишет ledger (`migrate-runner.ts:168`), так что безопасен на повтор только идемпотентный SQL с `if not exists` и уборкой invalid-индекса, как в `0096:19` — ради 30 строк это лишняя механика. Предусловие: запрос 2 Приложения A вернул 0 строк. Если вернул коллизии — сначала переименовать под `admin`-пользователем по решению владельца.

Drizzle: `packages/db/src/schema.ts` (обе таблицы), репозитории `packages/db/src/repositories/auth.ts`: `createAccountLink`, `findAccountLinkByDigestForUpdate`, `revokeActiveAccountLinks(userId, reason)`, `markAccountLinkUsed`, `listAccountLinks(userId)`, `findUserByUsernameInsensitive`, `listActiveDeviceTokensForUser`, `revokeDeviceTokenById`, `revokeAuthSessionsForUserExcept(sessionId)`, `touchDeviceToken(id, clientVersion)`.

### 5.2 Сервисы (`apps/runtime/src/services/auth.ts`, при росте — `services/account-links.ts`)
- `verifyPasswordAndLockUser` (§4.3); `loginWithPassword` на нём.
- `createInvite({username, role, pageLabels, expiresInHours, actor})` — **одна транзакция**: нормализация логина, коллизия по `lower` → 400, `createUserAccount` без пароля (для `team_lead` тоже без пароля при инвайте — снять требование пароля в этом пути), гранты страниц через tx-aware ядро `assignPageToUserTx` (выделить из `assignPageToUser`, который сегодня открывает свою транзакцию), `account_links(kind=invite)`. Аудит: `user.created`, `user.page_assigned`×N, `account_link.created {linkId, kind, keyPrefix, expiresAt}`.
- `createAccountLink({username, kind, expiresInHours, actor})` — §4.1 п.4–8; аннулирует прежние.
- `inspectAccountLink(token)`, `redeemAccountLink({token, password})` — §4.1 п.9, §4.2, §4.4 («Завершить все входы» при `password_reset`; при `invite` — только пароль). Аудит `user.password_set_via_link {linkId, kind}`.
- `issueDeviceTokenWithPassword({username, password, label, mode, clientVersion})` — на ядре §4.3; `mode='active'` → `createDeviceToken` (90 д, как `issueDeviceToken`), `mode='pending'` → `pending_device_tokens` (10 мин, как `reservePendingDeviceToken`); `must_change_password` → 403 `password_change_required`; аудит `device_token.issued|reserved {via:'password', label}`.
- `revokeOwnDevice`, `revokeAllOwnDevices(principal)` (§4.4 «Выйти на всех устройствах»), `terminateAllAccess(username, actor)` (§4.4 «Завершить все входы»); `deactivateUser` дополняется `revokeActiveAccountLinks`.
- `authenticateDeviceToken` → `{principal}|{failure}`; `touchDeviceToken` пишет `last_client_version` из `x-client-version`.
- `getOwnUsageReport(principal, range)` — **новый** репозиторный запрос `listUserUsageReport(db, {userId, from, toExclusive, timeZone})`: итог за диапазон + разбивка по фичам + дневные корзины по `completed_at` в таймзоне отчёта, по всем страницам пользователя, без фильтра по роли. Существующие помощники не подходят: `listChatterUsageSummary` жёстко фильтрует `role = 'chatter'` (`repositories/ai-usage.ts:483`, кабинет team_lead/owner был бы пуст), а `getAiGatewayDailyUsageTotals` принимает страницу, возвращает один агрегат и обслуживает квоту (`ai-gateway.ts:199`) — его семантику не трогать.
- `findUserByUsername` → регистронезависимо; `createUserAccount` — коллизия по `lower`.
- Конфиг: `ACCOUNT_LINKS_ENABLED` (boolean, default true, editable, live) в `config.ts` + `config-registry.ts` + оба `.env*.example`; при false публичные `inspect`/`redeem` отвечают 404.

### 5.3 Контракты (`packages/contracts/src/routes.ts`; затем `pnpm contracts:generate`)

| key | метод и путь | auth | тело → ответ |
|---|---|---|---|
| `adminCreateInvite` | `POST /api/v1/admin/invites` | owner-session | `{username, role?: chatter\|team_lead (chatter), pageLabels: string[], expiresInHours?: 1..720 (168)}` → `{user, link:{id, kind, keyPrefix, token, expiresAt}}` |
| `adminCreateAccountLink` | `POST /api/v1/admin/users/:username/links` | owner-session | `{kind, expiresInHours?}` → `link` (с токеном) |
| `adminListAccountLinks` | `GET /api/v1/admin/users/:username/links` | owner-session | → `[{id, kind, keyPrefix, state, expiresAt, usedAt, revokedAt, revokedReason, createdAt, createdBy}]` |
| `adminRevokeAccountLink` | `POST /api/v1/admin/users/:username/links/:linkId/revoke` | owner-session | → item |
| `adminRevokeDeviceToken` | `DELETE /api/v1/admin/users/:username/device-tokens/:tokenId` | owner-session | → `{revoked: true}` |
| `adminTerminateAllAccess` | `POST /api/v1/admin/users/:username/terminate-access` | owner-session | → `{deviceTokens, sessions, apiKeys, links}`; цель `owner` → 400 (как `deactivateUser`, `auth.ts:549-551`): владелец не может выбить сам себя из консоли |
| `authInspectAccountLink` | `POST /api/v1/auth/links/inspect` (30/мин/IP) | public | `{token}` → §4.1 п.11 |
| `authRedeemAccountLink` | `POST /api/v1/auth/links/redeem` (10/мин/IP) | public | `{token, password}` → `{username}`; 409 `conflict` с `reason: used\|expired\|revoked` |
| `authIssueDeviceTokenWithPassword` | `POST /api/v1/auth/device-tokens/password` (20/мин/IP) | public | `{username, password, label(1..120), mode: active\|pending}` → `{mode, token, keyPrefix, label, expiresAt?, reservationId?, reservationExpiresAt?}` |
| `authListDevices` | `GET /api/v1/auth/devices` | any-session | → `[{id, label, keyPrefix, lastClientVersion, expiresAt, lastUsedAt, createdAt}]` |
| `authRevokeDevice` | `DELETE /api/v1/auth/devices/:deviceId` | any-session | → `{revoked: true}` (чужой id → 404) |
| `authRevokeAllDevices` | `POST /api/v1/auth/devices/revoke-all` | any-session | → `{deviceTokens, sessions}` (§4.4 self) |
| `authMyUsage` | `GET /api/v1/auth/usage?from&to` | any-session | → `{range, row: adminChatterUsageRowSchema-без-userId, daily:[{date, requestCount, costMicroUsd}]}` |
| `me`, `adminListDeviceTokens`, `adminListUsers` | без изменений пути | как есть | + `lastClientVersion` в item устройства, + `registrationState` в `adminUserSchema` (аддитивно) |
| `adminCreateUser`, `adminSetPassword` | без изменений | owner-session | остаются до PR-4 только ради совместимости старого дашборда в окне между деплоями; в PR-1B UI их не вызывает; удаляются в PR-4 (§10 п.3) |

Кабинетные роуты — `any-session` (cookie), **не** `any`: `any` пускает legacy API-ключи. Новых `kind` политики нет. `contracts-auth-declarations.test.ts` — добавить новые ключи в ожидаемые списки (page-scope не нужен). Регенерируются `authorization-policy.md`, OpenAPI, `contract-hash.ts`, `packages/sdk` (+ bump `KERNEL_SDK_VERSION`).

### 5.4 Модуль и инфраструктура
- `apps/runtime/src/modules/identity/index.ts`: хендлеры с легаси-гардами по образцу существующих (`requirePrincipal` + `requireOwner`/`requireSessionUser`); `rateLimit` на трёх публичных роутах; текст 429 в `errorResponseBuilder` сделать нейтральным («Too many attempts»).
- `request-auth.ts`: слот `request.authFailure`; `auth-policy.ts`/`server.ts`: `UnauthorizedError` с `reason` в enforce-ветке; сериализация в `server.ts` рядом с `OfapiCollectionRefusedError`.
- `docs/error-handling.md`: `unauthorized` + `reason`; `password_change_required` 403.
- `docs/decisions.md`: одна запись «Единый аккаунт и регистрация по приглашению» с Р1–Р12 и контрактами §4; помечает #117 частично отменённым по заказу владельца.
- `docs/generated/`: регенерировать 02, 03, 04, 05, 15, 20 (или пометить drift-баннером до регенерации).

### 5.5 Тесты PR-1A (root `tests/`, Testcontainers)
- `account-links.integration.test.ts`: атомарность инвайта (падение на гранте → нет пользователя и ссылки); одноразовость; истечение; отзыв; аннулирование прежних новой ссылкой; аннулирование при смене пароля и деактивации; `invite` не выдаётся пользователю с паролем; `password_reset` для owner → 400; `redeem` при reset завершает все входы; 404/409; observation-payload не содержит токена и пароля; `ACCOUNT_LINKS_ENABLED=false` → 404.
- `auth-login-linearization.integration.test.ts`: логин, проверивший старый пароль до сброса, **не** создаёт сессию после сброса (гонка §4.3); то же для входа по паролю; epoch-гонка.
- `device-token-password.integration.test.ts`: `mode=active` и `mode=pending`→activate; неверный пароль → 401 + `auth.login_failed` + общий бэкофф с login; деактивированный / `content_manager` → 401; `must_change_password` → 403; `last_client_version` пишется.
- `auth-devices.integration.test.ts`: список своих; чужой id → 404; `revoke-all` self сохраняет текущую сессию; `adminTerminateAllAccess` отзывает токены, сессии, ключи, ссылки.
- `auth-unauthorized-reason.test.ts`: отозванный/истёкший → `reason`; неизвестный digest → без `reason`; api-key на `any-session` кабинетных роутах → 403.
- `auth-my-usage.integration.test.ts`: только свои события; диапазоны как у admin-отчёта.
- `auth-username-normalization.test.ts`: логин `GRISHA`/`grisha`; создание `Grisha` при существующем `grisha` → 400; индекс держит гонку.
- Обновить: `contracts-auth-declarations`, `authorization-policy-table`, `retention-deleters` (новых удалятелей нет — проверить, что allowlist не расширяется), `auth-login.test.ts`, `device-token-lifecycle.integration`, `user-deactivation.integration` (ссылки), `sdk-runtime-auth-hooks` (тело 401 с `reason` на typed/raw/SSE).

---

## 6. Дашборд — PR-1B («Команда») и PR-1C (`/join`, `/account`)

### 6.1 PR-1B «Команда» (`apps/dashboard/src/pages/settings/team/`)
- `TeamTab.tsx` заменяет `UsersTab.tsx` (1246 строк): список людей с ролью, статусом («ждёт регистрации» = нет `password_hash`; «активен»; «деактивирован»), последней активностью по устройствам.
- `InviteModal.tsx`: логин, страницы (мультивыбор, группировка по платформе через `Map`/groupBy — **не** `platform ===`, бюджет считает `apps/dashboard`), кнопка «Создать приглашение»; под «Дополнительно» — роль, срок. Один вызов `adminCreateInvite`; `provisionChatter` и `AddChatterModal` удаляются.
- `LinkRevealModal.tsx`: ссылка `${window.location.origin}/join#${token}`, «Скопировать», шаблон текста для Telegram («Привет! Твой аккаунт ChatGoose: <ссылка>. Открой, придумай пароль. Логин: grisha. Как начать: <страница>»). Показывается один раз.
- `UserDetailModal.tsx` с секциями: `DevicesSection` (`adminListDeviceTokens`: метка, `lastClientVersion`, `lastUsedAt`, «Отозвать вход» → `adminRevokeDeviceToken`, «Отозвать все устройства» → `adminRevokeDeviceTokens`, «Завершить все входы» → `adminTerminateAllAccess` с confirm), `LinksSection` (история; «Сбросить пароль ссылкой» → `adminCreateAccountLink(kind=password_reset)` → `LinkRevealModal`; «Отозвать ссылку»), `PagesSection` (как сегодня), деактивация/реактивация. Список устройств показывается честно: несколько записей на одном ноутбуке возможны.
- **Удаляются без замены:** `AddChatterModal`, `provisionChatter`, `CreateUserModal`, `IssueKeyButton`, `NewKeyModal`, `KeyRevealModal`, Key History, хук `useIssueApiKey`/`useRevokeApiKeys`, вся копия про «ключ». Staff (team_lead) приглашается той же модалкой с ролью под «Дополнительно»; owner — только CLI.
- «Техническое» (`TechnicalTab.tsx` в группе «Доступ»): агентские ключи (перенос `agentKeys`), привязка harvest (`adminSetDeviceTokenHarvestCapability` по выбранному устройству + поле machineId с подсказкой «из Диагностики приложения»).
- `LoginPage`: после логина при роли `chatter` → `navigate('/account')`; `ProtectedLayout`: chatter → `/account`.
- `api/adminUsers.ts` + хуки: `useCreateInvite`, `useUserLinks`, `useCreateAccountLink`, `useRevokeLink`, `useUserDevices`, `useRevokeDevice`, `useRevokeAllDevices`, `useTerminateAccess`, `useSetHarvestCapability`. Всё через `./sdk.js` (`dashboard-sdk-ban`).
- Тесты: `tests/team-tab.test.ts` (вместо `users-tab.test.ts`, переписать, не подгонять), `dashboard-users-loading.test.ts`, `technical-tab.test.ts`.

### 6.2 PR-1C `/join` и `/account`
- `pages/account/JoinPage.tsx` (роут `/join` вне `ProtectedLayout`): токен из `location.hash`; `inspect` → состояния (active → форма пароля ×2 с проверкой длины и чёрного списка на клиенте и сервере; expired/used/revoked → «Ссылка недействительна. Попроси новую у владельца»); `redeem` → экран «Готово»: логин крупно, кнопки только для платформ из `assignedPages` активной ссылки (inspect отдаёт `platforms`), ссылка на «Как начать». Адаптивная вёрстка (открытие с телефона). Русский по умолчанию.
- `pages/account/AccountPage.tsx` (роут `/account` под `ChatterLayout`: минимальная шапка, без сайдбара владельца; owner/team_lead тоже могут открыть): «Кто я» (`me`: логин, роль, страницы по платформам), «Устройства» (`authListDevices`, «Отозвать», «Выйти на всех устройствах»), «Сменить пароль» (`authChangePassword`, с текущим паролем), «Мои AI-траты» (`authMyUsage`: сегодня, 30 дней, дневной ряд, разбивка по фичам; суммы из micro-USD форматируются конструкторами `packages/shared`, без ручной арифметики), ссылки «Как начать».
- Единая страница «Как начать» — статическая на `ext.gosling-agency.ru/start.html`, заменяет разрозненные инструкции: две вкладки Fansly/OnlyFans; на неё ведут экран «Готово», шаблон Telegram и кнопки в клиентах. **Публикуется до PR-1B/1C**, иначе первые приглашённые получат битую ссылку: `scripts/deploy.sh` расширения загружает явный список файлов (`deploy.sh:11-14, 533+`) — добавить `start.html` (и `whats-new-3.html`) в список и в проверку публичных URL, завести режим `--pages-only` для выкладки страниц без подписи XPI.
- `api/account.ts` через `./sdk.js`. Тесты: `tests/join-page.test.ts`, `tests/account-page.test.ts` (мок api-слоя; `@tanstack/react-query` из root-тестов не резолвится).

---

## 7. Матрица прав (результат: `docs/identity-rights-matrix.md` + `tests/rights-matrix.integration.test.ts`)

| Событие | Ожидание | Проверка |
|---|---|---|
| Назначили Fansly-страницу | `GET /pages` и `me` для device-токена расширения содержат её на следующем запросе; feature-lane принимает `pageLabel` | integration + ручная в расширении |
| Назначили OF-страницу | `GET /ofapi/read/accounts` для device-токена десктопа содержит `acct_…`; появляется в rail после rebaseline/рестарта | integration + ручная |
| Сняли назначение | новые операции по странице → 403/404; SSE перепроверит ≤60 с; локальный кеш десктопа остаётся до purge (документировано) | integration |
| Отозвали один вход | второй токен того же пользователя работает; отозванный → 401 `token_revoked` | integration |
| Отозвали все устройства | все токены → 401; cookie-сессия жива | integration |
| Завершили все входы | прежние токены, сессии, ключи, ссылки → 401/404; **свежий `login` по действующему паролю проходит** (пользователь не отключён, пароль не менялся) | integration |
| Сбросили пароль ссылкой | старый пароль → 401, новый → 200; прежние токены и сессии → 401 | integration |
| Деактивировали | всё прежнее → 401/404 и `login` → 401 без оракула | integration (расширяет `user-deactivation`) |
| Вошёл другой человек на том же ПК | принципал и `assignedPageIds` — нового пользователя; локальные данные прежнего скрыты, но остаются на диске (D23, #145) | ручная + документ |
| Нет страниц данной платформы | расширение: CG-HUB-05 с понятным текстом; десктоп: EmptyState «нет страниц OnlyFans», без бесконечного переподключения | unit в клиентах |
| Роли | owner: все страницы, owner-session роуты по cookie, device-токен **не** даёт owner-session; team_lead: дашборд без owner-роутов, клиенты по назначениям; chatter: клиенты + `/account`; `content_manager`: не может войти нигде | `auth-policy.integration` расширить |

Ранбук `docs/runbooks/chatter-offboarding.md`: «Завершить все входы» → деактивировать → **вручную**: выйти из аккаунта Fansly в Firefox чаттера (хаб не управляет сессией Fansly), сменить пароли платформ, если нужно; ожидать до 60 с на закрытие SSE; локальный кеш десктопа стирается только purge на машине.

---

## 8. Расширение Fansly — PR-E1 (один релиз, 2.3.0)

1. Перевендорить SDK (`node scripts/vendor-sdk.mjs ../fansly-ext/vendor/kernel-sdk`), отдельный коммит.
2. `DEFAULT_SETTINGS.agencyHubBaseUrl = 'https://gosling-agency.ru'`; storage v17: нормализатор подставляет default при пустой строке; поле редактируемое под «Дополнительно».
3. `manifest.json`: `https://gosling-agency.ru/*` в `host_permissions` — для **новых** установок (промпт при установке). Для существующих runtime `permissions.request` остаётся, вызывается по клику «Войти»; `permissions.contains` в `runtime.onInstalled` для статуса.
4. `src/background/device-token.ts`: `authIssueDeviceTokenWithPassword({username, password, label: 'Firefox · <ОС>', mode:'active'})` в bearer-less SDK-режиме → один `storage.local.set` (токен + мета `chatgoose:deviceTokenMeta` в существующей форме `version:1` — поля не меняются, bump не нужен) внутри custody FIFO. Cookie-режим SDK и `logout` — удалить. Никакого pending-состояния.
5. Ошибки: неверный пароль → новый код **CG-HUB-17** «Неверный логин или пароль» (вместо `hub_invalid_api_key`); `password_change_required` → CG-HUB-18 «Владелец должен сбросить пароль»; текст CG-HUB-03 без слова «API-ключ». Самоисцеление §4.5 в `toHubError` (`agency-hub-client.ts`) и `kernel-feature-gateway.ts`: при `reason` и совпадении bearer — локальный wipe токена **и** legacy-ключа через FIFO, тост «Сессия устройства завершена: <причина>. Войди заново в Настройках» + deep-link.
6. Options: пане «Аккаунт ChatGoose» вместо «Agency Hub»: экран входа (логин, пароль, «Войти»; «Дополнительно» — адрес хаба); статус «Вы вошли как grisha · чаттер · страницы Fansly: lora-1, lora-2», кнопки «Аккаунт» (`${baseUrl}/account`), «Выйти», «Нужна помощь со входом» (страница «Как начать»). Чеклист онбординга: 1) Открой ссылку-приглашение и задай пароль 2) Войди 3) Открой Fansly. **Legacy-ключ удаляется целиком в этом же релизе, из UI и из кода:** `agencyHubApiKey` из `Settings`, `DEFAULT_SETTINGS`, `NORMALIZED_STORAGE_STATE_KEYS`, repair-predicate, `stripSecretSettings`/`serializePersistedState`, двойной wipe в `signOutAgencyHub`, fallback в `resolveHubBearer`, копи «запасной путь», ветка `agencyHubApiKey` в v12-blob fallback read (`migrations.ts:83-88`); storage v17 удаляет ключ `agencyHubApiKey` из `storage.local` (правило E19 «ключи не удалять» тумбстонится для ключа: его fallback-чтение уходит тем же релизом). **Ветка device-токена в том же fallback (`migrations.ts:89-94`) остаётся как одноразовая версионная миграция:** фид отдаёт только последнюю версию, и установка ≤1.8.0 (до v13) прыгнет прямо в v17 — без переноса токена из блоба в custody она потеряла бы рабочий вход; выделенный слот всегда побеждает блоб. Тест: прямой v12→v17. Код `hub_invalid_api_key` переименовывается в `hub_unauthorized`. Установка только с ключом (в проде таких нет) попадает на экран входа. ~12 точек в коде перечислены в отчёте исследователя расширения (§6 п.9 там).
7. Попап: пилюля «Войдите в ChatGoose» вместо «Agency Hub не настроен».
8. `install.html`, `guide.html`, `whats-new-3.html`, `README.md`: новая история, ссылки на «Как начать»; `check-ai-cutover` слова не нарушать.
9. Тесты: `device-token.test.ts` (новый роут, без cookie), `storage-v13-token-custody` + v17, `options-hub-pane` (копи, 401-reason сценарии, совпадение bearer, wipe legacy), `release-pages`, `protocol`. `pnpm check` + `pnpm gates`.
10. `docs/decisions.md` E-запись. Релиз `scripts/deploy.sh` (гейт: прод-хеш == вендоренный → только после деплоя PR-1A).

---

## 9. Десктоп OnlyFans — PR-D1 (один релиз)

1. Перевендорить SDK (`node scripts/vendor-sdk.mjs ../of-desktop/packages/kernel-sdk`), отдельный коммит.
2. `main/hub/device-token.ts:171-283`: raw `login` + перехват `set-cookie` + `authReserveDeviceToken` → один вызов `authIssueDeviceTokenWithPassword({username, password, label: 'Desktop · <hostname>', mode:'pending'})`; всё от staging до `authActivateDeviceToken` и журнал — без изменений; `logout` убрать. Ошибки main → коды (CG-HUB-20 неверные креды, CG-HUB-21 сеть/таймаут, CG-HUB-22 активация, CG-HUB-23 `password_change_required`) с локализацией в `packages/shared/src/i18n/catalog.ts` (RU/EN, пин `i18n.test.ts`).
3. Экран первого запуска `features/auth/SignInScreen.tsx`. Гейт в `AppShell.tsx`: показывать **только** при `hubDeviceTokenStatus === 'unset'` — после выпила legacy-ключа (п.6) `isHubConfigured` сводится к bound-токену, и одного предиката хватает (без выпила гейт ложно срабатывал бы на key-only установке — замечание codex). Состояния и что видит пользователь:
   - новая установка без учётных данных → SignInScreen;
   - `configured` → workspace;
   - `activation`/`revocation` transition → workspace + баннер «завершаем вход/выход», кнопки заблокированы;
   - `attention` (custody не bound: unbound/mismatch/unreadable) → существующий карантин в Hub-секции, SignInScreen не показывать;
   - истёк/отозван (`reason`) → wipe (§4.5) → SignInScreen с баннером причины;
   - хаб недоступен → workspace + существующий статус «HUB», без экрана входа.
   SignInScreen переиспользует `useHubDeviceTokenIssue`/`hubSettingsLogic`; «Дополнительно» — адрес хаба; ссылка «Нужна помощь со входом».
4. Самоисцеление: причина извлекается из тела 401 на **всех трёх** транспортах, а не только в SDK: (а) `KernelApiError` → CG-HUB-01; (б) OFAPI read-gateway — `createOfApiClient` бьёт хаб напрямую и превращает 401 в `OfApiError` со сниппетом текста (`main/ofapi/client.ts:545`, `mapOfApiHttpError`), поэтому холодный старт с отозванным токеном застревает в «HUB AUTH» без единого SDK-запроса; (в) `test-connection.ts:64` выбрасывает CG-HUB-01 только со статусом. Для hub-origin все три кладут `reason` в `CgError.detail`, а один диспетчер восстановления (сверка bearer с текущим, wipe через путь «abandon без сети», пин `device-token.test.ts:1323`) вызывается из одного места. Тест: холодный старт с отозванным токеном и без успешного SDK-запроса приводит на экран входа. Кейсы `unbound/mismatch → Forget locally` не ломать.
5. Ноль OF-страниц: после `reconcileGrants` пустой список → `EmptyState` «У аккаунта нет страниц OnlyFans — напиши владельцу» вместо «No chats yet». «Test connection» считает только OF-страницы.
6. Hub-секция → «Аккаунт»: «Вы вошли как …», кнопки «Аккаунт» (`shell.openExternal(hub + '/account')`), «Выйти с этого устройства», «Нужна помощь со входом». **Legacy-ключ удаляется целиком в этом же релизе (D19 фаза 2 без паузы):** fallback в `resolveHubCredential`, секретные слоты `hubApiKey`/`hubApiKeyStaged` (одноразовое удаление файлов при загрузке, как уже делается для `ofapiKey`), журнал `hubApiKeyBinding.v1`, `legacyKeyState`, `hubApiKey` из `SettingsPatch` и `SettingsVM`, env-сид `CHATGOOSE_HUB_API_KEY`, копи «chatter-key fallback» в ошибках sign-out, тесты key-fallback в `device-token.test.ts` и `hub-settings-logic.test.ts`. Установка только с ключом (в проде таких нет) попадает на экран входа.
7. `docs/WINDOWS-GUIDE.html`: «при первом запуске — экран входа, логин и пароль»; `documentation-cutover.test.ts` переписать под словарь §2: гайд **не должен** содержать «device token», «API key», «токен», «ключ»; проверка «Agency Hub» заменяется на «ChatGoose»/«аккаунт».
8. Тесты: `tests/hub/device-token.test.ts` (матрица: один вызов вместо login+reserve; 56 кейсов правятся в одной точке), `hub-settings-logic` (гейт по состояниям), `test-connection`, новые `sign-in-screen`, `auth-reason-self-heal`, `grants-identity-binding` (п.9). `pnpm check`, тег → windows-build (гейт: прод-хеш == вендоренный) **и** `apps/desktop/scripts/publish-mac.sh`: macOS не автообновляется (unsigned, Squirrel), DMG публикуется вручную на `ext.gosling-agency.ru/desktop/`; в проде есть Mac-установки (`MacBook-Air.local`, `MPB16m4-2.local`). Гейт PR-4 (§10) считает и их.
9. **Кеш привязывается к личности, а не к наличию custody.** Сегодня `query:accounts.list` отдаёт `data.accounts.listGranted()` из локальной БД без проверки принципала (`main/ipc/handlers.ts:485`), гранты меняются только после успешного `listAccounts` (`main/index.ts:998`), а токен становится durable до активации рантайма и сохраняется при её провале (`runtime-activation.ts:505-517`). Итог: A вышел, B вошёл, `listAccounts` у B упал (сеть) — экран `configured` открывает B кешированный workspace A. Фикс: снимок грантов хранит `username` владельца (из `hubDeviceIdentity.v1`); при несовпадении с текущей личностью — или при её отсутствии — granted-строки скрываются и query-state рендерера сбрасывается до первого успешного reconcile под новой личностью; БД не удаляется (D23, #145). Тест на этот путь провала обязателен.

---

## 10. Выпил legacy на хабе — PR-4 (сразу после выхода обоих клиентов)

Гейт входа один: у всех активных device-токенов `last_client_version` ≥ 2.3.0 (расширение) / новой версии десктопа, включая Mac-установки (запрос 4 Приложения A + колонка). Для пяти человек это тот же день: владелец говорит всем обновиться, проверяет запросом, мержит. Никакого календарного окна: единственное, что ломает PR-4 у старого клиента, — новый вход по cookie-роутам, а действующие токены живут.

1. **`api_keys`-лейн целиком.** Отозвать ключ `Dmitriy`. Удалить: роуты `adminListApiKeys`/`adminIssueApiKey`/`adminRevokeApiKeys`, `authenticateApiKeyToken` и else-ветку диспетчера префиксов (неизвестный префикс → 401), `roleCanUseApiKey`, `issueChatterApiKey`/`revokeUserApiKeys`, репозиторные функции, CLI-группу `apikey`, `authMethod` enum → `session | device_token`, `apiKeyItemSchema`/`issuedApiKeyResponseSchema`; политика `any` = session + device_token. Тесты: удалить `auth-api-key-rotation.test.ts`; обновить `auth-policy.integration` («owner-session routes refuse chatter keys» → device-токены), `agent-key-authentication` (маршрутизация префиксов), `identity-grants.integration` (dual-credential), `user-deactivation.integration`, `contracts-auth-declarations`, `authorization-policy.md`, OpenAPI. Таблица `api_keys` остаётся (факты); `deactivateUser`/`terminateAllAccess` перестают её трогать. Роботам — device-токен робот-пользователя (`mode=active`) или агентский ключ.
2. **Cookie-роуты выпуска токенов.** Удалить `authIssueDeviceToken` и `authReserveDeviceToken` (any-session) вместе с сервисными `issueDeviceToken(sessionId)`/`reservePendingDeviceToken(sessionId)` — остаётся только ядро §4.3 с паролем; `adminIssueDeviceToken` (owner выпускает токен за человека) — удалить, владелец приглашает ссылкой. Кейсы «session revalidated after lock» в `device-token-lifecycle.integration` переезжают на пароль/epoch.
3. **`must_change_password`.** При 0 флагнутых (Приложение A, запрос 1): удалить гейт `MUST_CHANGE_PASSWORD_ALLOWED_ROUTES` в `server.ts`, поле `mustChangePassword` из `adminSetPasswordBodySchema`, HTTP-роуты `adminSetPassword` и `adminCreateUser` (owner создаётся только CLI `user create`; сервисы `createUserAccount`/`setUserPassword` остаются для CLI), ветку 403 `password_change_required` из входа по паролю. **Поле `mustChangePassword` в `authUserSchema` остаётся на wire навсегда как константа `false` с пометкой deprecated:** в вендоренных SDK обоих клиентов оно `z.boolean()` обязательное (`fansly-ext/vendor/kernel-sdk/dist/contracts/routes.js:69`, `of-desktop/packages/kernel-sdk/dist/contracts/routes.js:76`), `$strip` терпит лишние поля, но не отсутствующие — удаление превратило бы `me()` в `response_validation_failed`, а расширение показало бы «недоступен». CLI `user set-password` переводится на тот же примитив сброса, что и ссылка (§4.4): сегодня `setUserPassword` не отзывает device-токены (`auth.ts:478-535`, вызов `cli.ts:2964`). Колонка остаётся (forward-only). Тумбстон #116(b) в decisions.
4. **Роли.** При 0 строк `content_manager` (запрос 3) убрать из `userRoles`/enum контракта (DB-enum оставить); `creatableUserRoles` = owner (CLI) | team_lead | chatter; матрица ролей — `docs/identity-rights-matrix.md`.
5. **Сироты.** Деактивировать `probe-ops`; снять гранты с #22; проверить #4.
6. **Копи и имена.** Все упоминания «API key»/«chatter key»/«ключ» в хабе (дашборд, CLI help, ранбук `desktop-hub-outage-break-glass.md`, `docs/chatgoose-custody-go-live.md`) — переписать или пометить историческими.
7. Переименование policy-kind `apiKey` и дублирующие легаси-гарды в хендлерах (#143 «removal deferred») — вне этого трека (§12).
8. **Ранбуки и доки.** `docs/runbooks/chatter-onboarding.md` (пригласить / сбросить / отозвать / завершить входы), `chatter-offboarding.md` (§7); `docs/generated/15-auth-config-and-access.md` регенерировать; в decisions отметить, что гранты на модель мертвы до флипа `ACCESS_GRANTS_READ_ENABLED` (отдельный ритуал #70).

---

## 11. Порядок выкладки, совместимость, верификация

**Решения владельца (2026-09-15):** одна волна; сброс всегда завершает все входы; доставка ссылок вручную через Telegram; два аккаунта владельца остаются; кабинет `/account` с AI-тратами — в v1; legacy вычищается и из интерфейсов, и из кода в тех же релизах, `api_keys` выводятся целиком (отменяет хвост #116c).

**Порядок:**
0. Владелец прогоняет Приложение A; коллизии логинов и строки `content_manager` разбираются до PR-1A.
1. PR-1A → деплой (owner-gated) → окно верификации: старое расширение 2.2.2 и десктоп 0.1.54 входят как раньше (`login`, `authIssueDeviceToken`, `authReserveDeviceToken`, `activate` не менялись); `/health` отдаёт новый contractHash; мусорный токен на `inspect` → 404; `curl` на `password` с неверным паролем → 401 и запись `auth.login_failed`.
2. PR-1B + PR-1C → деплой → верификация: пробное приглашение тестовому пользователю → `/join` → пароль → вход старым расширением новым паролем; кабинет открывается чаттером; «Завершить все входы» роняет его токен с `reason`.
3. PR-E1 и PR-D1 разрабатываются параллельно с шагами 1–2 в worktree, выпускаются после шага 2 в любом порядке.
4. Все пять человек обновили клиенты (проверка по `last_client_version`) → PR-4 в тот же день.

**Совместимость:**

| Комбинация | Ожидание |
|---|---|
| Старый клиент + новое ядро | работает: старые роуты не меняются, лишние поля SDK отбрасывает, 401 с `reason` — лишнее поле |
| Новый клиент + новое ядро | работает |
| Новый клиент + откатившееся ядро (после публикации клиента) | существующий вход продолжает работать (токены живы, роуты чтения не менялись); новый вход даёт понятную ошибку CG-HUB-21/«хаб недоступен», не тихий сбой |
| Откат образа ядра после PR-1A | вручную, совместим: аддитивные таблица/колонка/индекс, старый код их не читает; автоотката деплой-скрипт не делает |
| Ответ активации потерян (десктоп) | как сегодня: журнал + идемпотентная активация |
| Ответ выпуска потерян (расширение, `mode=active`) | токен-сирота на хабе; виден владельцу в «Команде», отзывается; чаттер входит ещё раз |

Существующие device-токены **не инвалидируются**, перелогин никому не нужен; harvest-привязка Dmitriy сохраняется.

---

## 12. Что не делаем в этом треке
Вход через браузер (Authorization Code + PKCE) — только если захотим убрать ввод пароля из клиентов, отдельное решение. Автоотправка приглашений в Telegram. Флип `ACCESS_GRANTS_READ_ENABLED`. Новые роли и `roles` в декларациях политики. Переименование policy-kind `apiKey` → `bearer` (после выпила ключей имя врёт, но правка чисто косметическая и трогает сотни деклараций — отдельно, если вообще). Слияние аккаунтов владельца. Атрибуция заработка чаттера (хаб считает деньги по страницам). Перенос hub-кредов расширения из `storage.local` (E10/E19 future hardening).

---

## 13. Оценка (ориентир; пересчитать после спецификации PR-1A)

| Кусок | Дни исполнителя |
|---|---|
| PR-1A ядро (миграции, ядро пароля, ссылки, вход по паролю, отзывы, `reason`, usage, 7 integration-файлов, docs) | 7–8 |
| PR-1B «Команда» + «Техническое» | 3–4 |
| PR-1C `/join`, `/account`, «Как начать» | 2–3 |
| Матрица прав: документ + integration-тесты | 1.5 |
| PR-E1 расширение (с выпилом legacy-ключа) | 4.5 |
| PR-D1 десктоп (с выпилом legacy-ключа) | 5.5 |
| PR-4 выпил legacy на хабе + роли, сироты, ранбуки | 3 |

Календарно 5–6 недель с окнами верификации. Исполнители — Opus по брифам из этого файла; ревью — Fable малым числом.

---

## Приложение A. Перепись прода (под app-пользователем psql, база `agency_hub_core`; роль `read_only` этих таблиц не видит)

```sql
-- 1. пользователи
select id, username, role, disabled_at, must_change_password, device_token_epoch, created_at
from users order by id;

-- 2. коллизии для регистронезависимого логина (должно быть 0 строк до миграции 0183)
select lower(username), count(*) from users group by 1 having count(*) > 1;

-- 3. мёртвая роль
select count(*) from users where role = 'content_manager';

-- 4. device-токены
select user_id, id, label, harvest_machine_id is not null as harvest,
       expires_at, last_used_at, created_at, revoked_at
from device_tokens order by user_id, created_at;

-- 5. незавершённые резервации
select user_id, label, expires_at from pending_device_tokens where expires_at > now();

-- 6. у кого ещё legacy-ключи
select user_id, count(*) filter (where revoked_at is null) as active_keys, max(last_used_at)
from api_keys group by 1;

-- 7. назначения (живой путь чтения)
select u.username, p.platform, p.label
from user_page_assignments a
join users u on u.id = a.user_id
join pages p on p.id = a.platform_account_id
order by 1, 2, 3;

-- 8. гранты (dual-write, не читаются)
select u.username, g.scope_type, g.scope_id
from access_grants g join users u on u.id = g.user_id
where g.revoked_at is null order by 1;

-- 9. живые сессии
select user_id, count(*) from auth_sessions
where revoked_at is null and expires_at > now() group by 1;
```

## Приложение B. Диспозиция ревью

**Fable-критик (25 находок, 0×P1, 7×P2)** — принято: автоотката нет (§1, §11); токен ссылки во фрагменте, `inspect` без username для неактивных (§4.1); сброс не для owner (§4.1 п.8); metadata аудита без секретов (§4.1 п.1); Firefox 127+/обновления (§1, §8 п.3); pending-токен не в боевом ключе расширения → режим `active` (Р2); экран первого запуска десктопа не ждёт ядра (§11 п.3); механика `reason` через `request.authFailure` (§4.5); линеаризация входа по паролю (§4.3); `assignPageToUser` не компонуется — tx-aware ядро (§5.2); CG-HUB-17 (§8 п.5); бюджет платформ в дашборде (§6.1); список регенерации `docs/generated`, `dashboard-sdk-ban`, cutover-гейты, kill-switch `ACCOUNT_LINKS_ENABLED`; оценки ×1.7. Вырезано по его аргументам: `capabilities` в `/auth/me`, колонка `client`, ночная чистка `auth_sessions`, reserve→activate в расширении. **Отклонено/пересмотрено:** удаление `/account` (владелец заказал кабинет, Р5); отказ от уникального индекса `lower(username)` (см. codex).

**codex (второе мнение)** — подтверждено кодом и принято: гонка `loginWithPassword` (§4.3, `auth.ts:1064+`); уникальный индекс по `lower(username)` с подготовкой (Р4, §5.1); контракт жизненного цикла ссылок (§4.1); три операции отзыва и сброс = «Завершить все входы» (§4.4, Р6); предохранители самоисцеления (§4.5); гейт десктопа `hubDeviceTokenStatus==='unset'` ложно срабатывает на legacy-ключе → гейт по `isHubConfigured` + модель состояний (§9 п.3); матрица совместимости «новый клиент + откатившееся ядро» (§11); матрица прав и ранбук увольнения с границами Fansly-сессии/SSE 60 с/локального кеша (§7); UX-дефолты владельца, экран «Готово» по фактическим платформам, harvest в «Техническое» (§2, §6.1). **Отклонено владельцем:** «не удалять управление API-ключами роботов» — ключи выводятся целиком (Р8, §10 п.1). **Не применимо/совпадает:** PKCE/SSO (Р12), «сначала поведение, потом UI» (= §4), обязательность единого входа (одна волна), раздельные аккаунты владельца (Р10), пересмотр #117 (Р5).

**codex, раунд 2 по v3 (xhigh, 13 находок, все проверены по коду и приняты):** P1 — обязательное `mustChangePassword` в вендоренных SDK: поле остаётся на wire константой (§10 п.3); P1 — десктоп показывает кеш предыдущего чаттера при провале `listAccounts` у нового: снимок грантов привязывается к личности (§9 п.9); самоисцеление обязано покрыть OFAPI-транспорт и test-connection (§9 п.4); CLI `set-password` не отзывал device-токены — единый примитив сброса (§10 п.3); user-lock при создании ссылок + частичный уникальный индекс (§4.1 п.5, §5.1); `0183` — транзакционный индекс вместо `concurrently` (§5.1); HTTP `adminCreateUser` удаляется, owner только CLI (§10 п.3); `registrationState` в `adminUserSchema` и `platforms` в `inspect` (§4.1 п.11, 13); отчёт трат — новый запрос без фильтра роли (§5.2); macOS-канал десктопа в ритуале релиза и гейте PR-4 (§9 п.8); ветка device-токена в v12-fallback расширения остаётся как одноразовая миграция (§8 п.6); `start.html` в список деплоя и публикация до PR-1B/1C (§6.2); строка «завершили все входы» в матрице прав разделена (§7). Срезано по его совету: переименование policy-kind, bump версии меты, противоречие Р12/§12 про `api_keys`-роуты.

**Владелец (2026-09-15)** — принятые улучшения: `last_client_version` (Р7); три полосы параллельно (§11); чаттер из дашборда → `/account`; пароль ≥12 + чёрный список на `redeem` (§4.2); единая страница «Как начать» (§6.2); UI **и код** без legacy: клиентские fallback'и на ключ, cookie-церемонии, `api_keys`-лейн, `must_change_password` (§0, §8 п.6, §9 п.6, §10). Отклонено: репетиция на локальном стенде.
