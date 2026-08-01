# Backlog — подтверждённые открытые задачи

Проверено по `main` на `56537085` (2026-07-20). Здесь остаются только
воспроизводимые дефекты и конкретный release-safety debt. История PPV-инцидента
живёт в Decision #155; здесь — только незакрытая работа.

## P1

### UV-001 — Password reset не линеаризован с login

- **Сбой:** login может проверить старый hash, затем reset закоммитит новый
  пароль и отзовёт текущие сессии, после чего login создаст новую валидную
  сессию со старым паролем.
- **Код:** `apps/runtime/src/services/auth.ts:417-455,998-1048`.
- **Закрыть:** общий user-lock или authentication epoch при создании сессии и
  детерминированный concurrent regression.

### UV-003 — Bounded snapshot может checkpoint-нуть уже стёртые данные

- **Сбой:** клиент применяет первую страницу, fan-erasure удаляет её thread,
  continuation молча пропускает исчезнувший thread и возвращает terminal cursor;
  объединённое клиентское состояние всё ещё содержит стёртый текст.
- **Код:** `apps/runtime/src/services/ofapi-sync-snapshot-cursor.ts:23-37`,
  `apps/runtime/src/services/ofapi-sync-snapshot.ts:393-421,504-515`,
  `tests/ofapi-sync-snapshot.integration.test.ts:989-1089`.
- **Закрыть:** связать `stateCursor` с erasure/topology generation, отвечать
  `409 restart-required` при изменении и тестировать объединённый результат.

### UV-004 — Production build не проверяет свежесть contract artifacts

- **Сбой:** `routes.ts` можно изменить без regeneration; прямой Docker или
  dist-only build пройдёт, а `/health.contractHash`, OpenAPI и SDK останутся
  от старой схемы. Сейчас freshness проверяет только CI.
- **Код:** `package.json:19`, `scripts/build-production.mjs:95-138`,
  `Dockerfile:44`, `scripts/deploy-production.sh:1113-1119`,
  `.github/workflows/ci.yml:37-47`.
- **Закрыть:** non-mutating `contracts:check` внутри `build:production` и
  regression с намеренно рассинхронизированным `routes.ts`.

### INC-001 / UV-010 — Завершить remediation PPV poison-loop

- **Исправлено:** новые `message.ppv_unlocked` получают правильные refs и
  fail-closed mapping (`ofapi-payloads.ts:77-82`,
  `canonicalize/ofapi-webhook.ts:143-180`).
- **Открытый сбой:** suppressed PPV продвигает только in-memory watermark; если
  следующим идёт erased hole и обычного frame нет, Core закрывает stream без
  нового cursor, а клиент бесконечно возвращается со старого cursor.
- **Код:** `apps/runtime/src/modules/events/index.ts:95-104,655-677,914-954`;
  happy-path тест с последующим frame —
  `tests/domain-events-v2.integration.test.ts:1169-1201`.
- **Остаток:** cursor-bearing ignored checkpoint перед close; append-only repair
  70 исторических rows; явная quarantine/parse semantics; PPV snapshot coverage;
  автоматический read stop-loss; production/fleet acceptance; только затем снять
  `SUPPRESSED_V2_FRAME_TYPES`. Decision #155 — каноническая история инцидента.

## P1 перед отдельным one-way gate

### UV-011 — Lifecycle verifier принимает неполный preservation receipt

- **Gate:** исправить до первого `desktop-lifecycle-v2` enable. Если enable уже
  состоялся — отдельно проверить сохранённые receipts.
- **Сбой:** Extension проверяется в основном по counts/content length, Desktop —
  по counts; id-only personas и невалидная структура mappings могут разрешить
  необратимый cutover.
- **Код:** `scripts/verify-desktop-lifecycle-v2-evidence.mjs:583-703`,
  `tests/desktop-lifecycle-v2-artifact-verifier.test.ts:318-333`,
  `docs/runbooks/desktop-lifecycle-v2-cutover.md:88`.
- **Закрыть:** валидировать точные обе snapshot schemas, timestamps, persona
  id/name/content и mapping keys/targets; добавить negative и real-artifact tests.

## P2

### UV-005 — Owner не может прочитать persona prompt в dashboard

- **Сбой:** API возвращает `systemBlock`, но read-only таблица показывает только
  key/name/version/status; prompt находится лишь в отключённом edit modal.
- **Код:** `apps/runtime/src/modules/ai/index.ts:61-75,230-236`,
  `apps/dashboard/src/pages/settings/AiPersonasTab.tsx:22,77-145,240-280`,
  Decision #151.
- **Закрыть:** всегда доступный View/details modal для active и archived persona;
  mutation controls оставить выключенными.

### UV-006 — Deliberate 503 отсутствуют в API contract

- **Сбой:** оба SSE readiness path и v2 snapshot во время незавершённого erasure
  реально отвечают `503`, но OpenAPI/SDK эти ответы не описывают.
- **Код:** `apps/runtime/src/modules/events/index.ts:184-193,609-615,1134-1142`,
  `packages/contracts/src/routes.ts:4834-4925`.
- **Закрыть:** добавить `503: errorResponseSchema` для `eventsStream`,
  `eventsV2Stream`, `eventsV2Snapshot`, регенерировать artifacts и pin-тест.

### UV-012 — Final lifecycle inventory failure не восстанавливает release files

- **Gate:** только первый lifecycle enable.
- **Сбой:** финальная inventory-проверка идёт после sync release-файлов, но её
  внутренний error вызывает обычный `fail`, а не `fail_after_release_sync`;
  старые containers остаются рядом с candidate-файлами.
- **Код:** `scripts/deploy-production.sh:62-80,1244-1270,1360-1368`.
- **Закрыть:** вернуть ошибку вызывающему коду и использовать post-sync restore
  path; добавить executable failure-path harness.

### UV-013 — Обычный deploy безусловно требует first-enable tooling

- **Сбой:** `gh` и `unzip` проверяются до определения capability transition,
  поэтому absent→absent и present→present deploy могут упасть, хотя evidence
  pipeline не запускается.
- **Код:** `scripts/deploy-production.sh:1194-1221,1299-1310`.
- **Закрыть:** требовать эти утилиты только внутри first-enable ветки; покрыть
  четыре capability transitions.

### UV-014 — ZIP разбирается до authentication и без size bounds

- **Gate:** только первый lifecycle enable.
- **Сбой:** artifact скачивается без byte cap и попадает в `unzip` до сравнения
  digest; неправильный или огромный архив может исчерпать память/диск либо
  атаковать parser до отказа по hash.
- **Код:** `scripts/verify-desktop-lifecycle-v2-evidence.mjs:807-918,1148-1158`.
- **Закрыть:** bounded streaming download, digest до ZIP parsing, затем limits
  на entries и суммарный uncompressed size; real pipeline tests.

### BL-C1 — Адресная догрузка треда не паркует страницу при auth-ошибке

- **Сбой:** при 401/403 от Fansly адресный прогон (слайс C′) только логирует и
  падает; в отличие от штатного исполнителя он не ставит `blocker_kind='auth'`,
  не паркует остальные потоки страницы (`pausePageSyncForAuth`) и не открывает
  auth-инцидент, поэтому страница продолжает жечь квоту мёртвой сессией до
  ближайшего штатного чанка.
- **Код:** `apps/runtime/src/services/sync/targeted-thread-backfill.ts`
  (`isFanslyAuthError`), эталон — `apps/runtime/src/services/sync/executor.ts:664-736`.
- **Закрыть:** вынести auth-ветку исполнителя в вызываемую функцию и
  переиспользовать её здесь (сейчас она inline ~60 строк).

### UV-015 — SSE-стрим отдаёт owner device-token'у все события без клампа

- **Сбой:** owner-принципал через device-token получает полный event-стрим
  (`apps/runtime/src/modules/events/index.ts`) — тот же класс дыры, что закрытые
  в #43 spenders/pageFanDetail, но здесь кламп сломает of-desktop, который
  живёт на этом поведении.
- **Ruling (owner 2026-08-01):** в проекте Agent Read Plane НЕ чинится; agent-ключи
  SSE не получают вовсе (read-only plane). Чинить отдельно, координированно
  с релизом of-desktop: clamp для не-session принципалов + обновление клиента.
- **Код:** `apps/runtime/src/modules/events/index.ts`, `pageScopeFor`
  (`apps/runtime/src/api/request-auth.ts`).

## P3 / срок до соответствующего cutover

### UV-007 — Legacy harvest dedup не видит detached partition

- **Срок:** до первого реального detach `observations` partition.
- **Сбой:** compatibility lookup читает только attached parent; повтор старого
  principal-keyed machine event после tiering создаст второй raw observation.
  Domain message dedup смягчает downstream impact, но raw/reconciliation duplicate
  остаётся.
- **Код:** `packages/db/src/repositories/observations.ts:137-156`,
  `apps/runtime/src/services/tiering/index.ts:400-404`,
  `packages/db/migrations/0096_observations_harvest_lookup_concurrently.sql:61-67`.
- **Закрыть:** backfill machine-key aliases в существующий unpartitioned
  `observation_keys`; новая таблица не нужна.

### UV-008 — Testcontainers дублирует production migration parser

- **Сбой:** обычные integration migrations не исполняют production parser;
  две реализации marker/generator semantics могут разойтись.
- **Код:** `packages/db/src/migrate-runner.ts:17-28,169-188`,
  `tests/helpers/db.ts:179-200`.
- **Закрыть:** один общий parser/executor seam для production и test setup.

### UV-009 — Persona mutation switch продублирован в API и dashboard

- **Срок:** до owner-write cutover; сейчас обе константы `false`, что корректно
  по Decision #151.
- **Сбой:** одностороннее изменение покажет всегда падающие controls либо скроет
  уже writable API.
- **Код:** `apps/runtime/src/modules/ai/index.ts:51-59,239-288`,
  `apps/dashboard/src/pages/settings/AiPersonasTab.tsx:22,64-145`.
- **Закрыть:** общий browser-safe constant и pin-тест; отдельный capability
  protocol пока не нужен.

## BLOCKS ANY FUTURE ERASURE EXECUTION

### ER-001 — Fan erasure остаётся неполным

Decision #129 запрещает реальные erasure runs, поэтому это не блокер 2.0. Если
политика изменится, сначала нужно закрыть известные W6 stores из #129 и эти gaps:

- `threadPred` не учитывает `partner_platform_user_id`; Fansly thread с
  `fan_id=NULL` переживает erasure вместе с сообщениями
  (`apps/runtime/src/services/erasure/index.ts:539-592`,
  `apps/runtime/src/services/sync/executor-handlers.ts:2888`).
- `fanGroupIds` снимается до transaction-level exclusive fence; concurrent
  identity resolution может оставить legacy group-only restricted generation
  (`erasure/index.ts:546-553,1142-1184`).
- group-only restricted generation, которую нельзя связать ни по fan, ни по
  partner identity, остаётся без residual warning, а run сообщает успех
  (`erasure/index.ts:539-553,1197-1215`).

Исправленный старый пункт удалён: Fansly groupId теперь входит в
`generationPred`, а target/bystander generation и acceptance закреплены тестом
(`fe3a2886`, `tests/erasure.integration.test.ts:1225-1341`).

- 2026-07-22 (PR #21 follow-up): the v2 stream's `event: control` lane is
  documented in routes.ts/OpenAPI but has no typed SDK surface —
  `subscribeDomainEvents` silently skips non-domain events. When a second
  SDK consumer needs the replay boundary, add a control-frame schema plus an
  `onReplayCompleted` callback and regenerate SDK artifacts (desktop parses
  the lane with its own SSE parser today). Also from review: a route-level
  regression test for the snapshot-recovery path with a connection that dies
  during the completion awaits (the guards exist; the unit harness cannot
  yet mint a recovery-mode cursor cheaply).

## FEAT — не захваченные плоскости данных Fansly/OF (owner 2026-07-31)

Не дефекты: этих данных в хабе **нет вообще ни в каком виде** — ни таблицы, ни
стрима, ни канонизатора. Владелец 2026-07-31 постановил добавить позже.
Контекст и требования к форме — `investigations/agent-read-api-design-2026-07-31.md`
(реестр датасетов §10: такие плоскости обязаны быть видимы в каталоге как
`planned` с честным состоянием захвата, а не отсутствовать молча).

Общий рецепт для каждой (из §10 спеки): захват через резолвер егресса и прокси
страницы → журналирование полного ответа ДО парсинга → версионированный
канонизатор + реплей-тест → типизированная перестраиваемая проекция → один
дескриптор реестра датасетов → честные field-states и покрытие. Число
HTTP-операций и команд CLI при этом **не меняется**.

### FEAT-001 — Посты / лента

- **Нет:** таблицы, стрима, канонизатора. Fansly-адаптер не зовёт ни один
  post-эндпоинт (`packages/fansly/src/adapter.ts` — 11 путей, постов среди них
  нет); расширение тоже не трогает (`/api/v1/post` — ноль совпадений).
- **Зачем:** контент-план и атрибуция продаж к посту; сейчас пост как сущность
  системе неизвестен.
- **Спека OF-зеркала** держит посты вне охвата сознательно (§2) — то есть это
  новая работа, а не хвост зеркала.

### FEAT-002 — Тиры подписок как сущности

- **Нет:** таблицы тиров. `page_subscriptions` хранит имя/цвет/цену тира
  **строкой на подписке**, самой сущности тира нет.
- **Частично захвачено:** `account_me` несёт `subscriptionTiers` и `walls`, они
  сваливаются в `pages.metadata` jsonb и никогда не моделируются
  (`apps/runtime/src/services/fansly.ts:31-32`). Типы
  `FanslySubscriptionTier`/`FanslySubscriptionPlan` объявлены в расширении и
  **всегда передаются null** — продюсера нет.
- **Дёшево:** данные уже в БД, нужен канонизатор + проекция, вендор не нужен.

### FEAT-003 — Выплаты (payouts) / кошелёк

- **Нет:** таблицы выплат. Есть только `pages.earnings_balance_mills` —
  моментальный баланс из `account_me`, без истории движения.
- **Зачем:** сверка «заработано → выведено», сегодня закрывается вручную.
- **Требует** нового вендор-эндпоинта (в 11 путях адаптера выплат нет).

### FEAT-004 — Чарджбеки Fansly

- **Нет:** у OF чарджбеки есть (`ofapi-chargebacks-sync.ts`, миграция 0107,
  инцидент-контур), у **Fansly — ничего**.
- **Зачем:** асимметрия прямо бьёт по деньгам — возврат по Fansly сегодня
  невидим, `transactions` остаётся с `posted` навсегда.
- **Смежный известный долг:** OF-чарджбеки страдают от отсутствия `endDate`
  (P1 из прод-мониторинга 2026-07-15).

Приоритет между четырьмя владельцем не задан. Оценка автора: FEAT-002 самый
дешёвый (данные уже захвачены), FEAT-004 самый ценный (деньги и асимметрия с OF).

## BL-A — Agent Read Plane slice A, review round 1 (deferred, each one bounded)

- **BL-A1 outbound `sender_hint`.** The transcript union projects
  `message_archive.fan_native_id` as the sender hint on every row, so an OUTBOUND
  message labels the fan as its sender. Needs a per-arm sender expression.
- **BL-A2 cross-store tombstone timestamps.** Tombstone dominance marks a row
  deleted from another store but has no timestamp there, so `deletedAt` falls back
  to the epoch and reads as 1970. Carry the dominating store's timestamp.
- **BL-A3 transcript count probe clamp.** `countAgentTranscript` reuses the union,
  whose internal ceiling is 1500, so `matchedInScope` cannot report the 5001 probe
  boundary on a very large thread.
- **BL-A4 dataset SECONDARY sort.** Only the first sort entry is honoured; the
  contract accepts two. The second needs its own rendered key in the keyset.
- **BL-A5 dataset filter type coercion.** `eq`/`neq`/`in` compare `::text`, so
  `1` and `"1"` match and a timestamp compares lexically. Coerce per registry kind.
- **BL-A6 resolver `distinct on` and page-scoped aliases.** Alias rows are keyed by
  (fan, kind, value); a fan aliased identically on two granted pages still collapses
  to one candidate row.
- **BL-A7 subscription `ended` timestamp.** The timeline stamps a
  `subscription.ended` event at creation time, not at `ends_at`, so an ended
  subscription lands on the wrong day.
- **BL-A8 5001-probe off-by-one.** The probe returns `probeMax + 1` as the reported
  value; the contract describes 5001 as "at least 5001", which is the same number
  by luck rather than by construction.
- **BL-A9 emitted cursor length.** A cursor carrying a large normalized query can
  exceed the 2048-character decode ceiling, which would refuse a cursor this
  server itself minted. Needs either a shorter encoding or a params cap.
- **BL-A10 `domain_events_smoke_checkpoint`.** Now excluded from the detached
  partition check by an anchored name pattern; the underlying helper table should
  move out of the `domain_events_` namespace so the pattern is not load-bearing.
- **BL-A11 transcript witness floors.** `listAgentTranscript` attributes the
  `message_archive` floor to all four planes it returns witnesses for, including
  `page_dm_messages` and `page_dm_threads`, whose own floors nobody computed.
  Each arm should carry its own floor or report `unknown`.
- **BL-A12 #8 correlated lateral.** `listAgentCoverageScopes` runs a
  `lateral min(ma.occurred_at)` per CANDIDATE row before the keyset and limit
  apply — the same class of cost as the `count(domain_events)` removed in round 1.
  Push the floor lookup after the page is chosen, or index for it.
- **BL-A13 `ORDER BY to_char(...)` is unindexable** on `observations`, and it
  detoasts each payload before sorting. Needs an expression index or a numeric
  sort key. Related: `readAgentJournalFloor` runs through the THROWING timeout
  wrapper inside #8, so a slow journal can kill a response whose main source was
  deliberately allowed to degrade through `tryAgentTimeout`.

## FEAT-005 — остаток Fansly-реплея: три вида + `accountMedia`/`tips` (слайс D run-1, 2026-08-01)

Не дефект и не забытое: **сознательно отложено** решением R-010 плана
(`.agentic/agent-read-plane/PLAN.md` §8). Спека §13 перечисляет семь
Fansly-видов на `parse_version 0` плюс разбор `accountMedia`/`tips` внутри
страниц `dm_messages`; run-1 слайса D выпустил **четыре** — ровно те, что
двигают уже существующие плоскости чтения (`followers`, `subscribers`,
`dm_conversations`, `account_me` → `fans` / `page_fans` / `page_follows` /
`daily_followers`). Остальные требуют новых проекций, то есть новой работы, а
не дописывания канонизатора, и записаны здесь честным «запланировано», а не
молча выброшены.

Инфраструктура уже стоит и переиспользуется: семейство канонизаторов вне
`CANONICALIZER_FAMILIES`, preflight по `pg_inherits`, флаг `fanslyReplayMode`,
`fansly:replay` в owner-CLI. Каждый пункт ниже = канонизатор + проекция + свои
golden-фикстуры; вендор и кредиты не нужны — байты уже в журнале.

### Что осталось от семи видов

- **`account_lookup`** (`/account?ids=` — батч профилей фанов). Плоскость
  идентичности: имена/аватары/`createdAt` фанов на исторические даты. Сегодня
  живой путь гидратирует их в `fans`, но только для тех, кто попал в текущий
  снапшот; реплей достаёт профили тех, кого текущие снапшоты уже не показывают.
- **`group_detail`** (`/messaging/groups/:id`). Полный состав участников треда и
  его флаги — то, чего нет в постранично тримленном `dm_conversations`.
  Проекция — `page_dm_threads`, а её generation/visibility-машинерия делится с
  живым синком; трогать её нужно отдельным слайсом, не хвостом реплея.
- **`earnings_accounts`** (`/earnings/accounts`). Денежная плоскость: суммы по
  фанам. Требует того же аккуратного обращения с mills, что и семейство
  `fan_earnings_*`, и сверки с `transactions` — деньги отдельным заходом.

### `accountMedia` / `accountMediaBundles` / `tips` внутри `dm_messages`

Спека §10 называет это «главной дырой Fansly (вложения)»: страницы
`dm_messages` уже лежат в журнале вербатим вместе с `accountMedia`,
`accountMediaBundles`, `tips`, `tipGoals`, `stories`, `storyOrders`, а
канонизатор `dm_messages` (sync-pull v4) читает из них только `messages` и
историю покупок. Реплей вложений = отдельная проекция медиа, которой сейчас нет
ни в каком виде; пересекается с FEAT-001.

### Историческая серия follower-тоталов (обнаружено ревью слайса D)

`daily_followers.known_total_followers` реплей заполняет ТОЛЬКО те дни, где
строка уже есть (то есть где в тот день реально были новые фолловы). Дню, у
которого есть снапшот `account_me`, но нет фолловов, строку не создаём: колонка
`new_followers` — NOT NULL и суммируется в отчётах, поэтому «0 новых» вместо
«не знаем» было бы ложью. Полная посуточная серия тоталов лежит в
`domain_events` (`page.identity_observed`, по свидетелю на UTC-день) и ждёт
собственной плоскости `page_identity_daily` — отдельный слайс, не хвост
реплея.

### Чего реплеем не вернуть (не задача, а долг захвата)

`content` у `dm_conversations` и полнота `followers` выброшены **до** журнала
(`redactFanslyMessageLike` / `trimFanslyFollowerPayload` в
`apps/runtime/src/services/sync/shared.ts`). Это нарушения capture-first в
самом захвате; чинится там, а не реплеем. Слайс D run-1 сознательно читает
только тримленную форму.
