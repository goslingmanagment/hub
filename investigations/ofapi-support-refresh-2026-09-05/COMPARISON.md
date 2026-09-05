# Сравнение двух отчётов по OFAPI

Последующая проверка Fable plan: [FABLE-REVIEW.md](../../investigations/ofapi-support-refresh-2026-09-05/FABLE-REVIEW.md). Единый текущий [план реализации](../../docs/plans/2026-09-05-ofapi-coverage-refresh.md); ниже сохранено первое сравнение.

Проверка: 5 сентября 2026. Hub `582ef1cf8a2de52eba6639ef775ddbe3e15ba74c`; desktop `df7b452778e8a9da2cbb0b85eeeef3d329dcfccc`. Fansly вне области работы.

**Последующее уточнение владельца:** production остановился из-за смены аккаунта и ключа OFAPI; передан новый актуальный ключ. Ниже сохранена оценка доказательств, доступных на момент сравнения. Вывод «общая причина простоя неизвестна» больше не является текущим: S0 в PLAN.md изменён на завершение перехода. Конкретные live-числа второго отчёта и доступность нового ключа этим сообщением отдельно не проверены. Значение ключа не сохраняется в артефактах.

Сравниваются наш [PLAN.md](../../investigations/ofapi-support-refresh-2026-09-05/PLAN.md) с матрицей 294 операций и [второй отчёт, предоставленный пользователем](/Users/dmitriy/.codex/attachments/243911d5-ab2a-49b1-b260-cd1ef1ff8a76/pasted-text.txt). Итог ниже относится к содержанию отчётов, а не к качеству моделей вообще.

## Вывод

**Для реализации лучше взять наш отчёт за основу, но обязательно добавить находки второго.** Наш сильнее в проверке контрактов, границах восстановления и учёте существующей архитектуры. Второй лучше переводит обновление API в конкретные задачи для чаттера и нашёл два реальных дефекта, пропущенных первым аудитом.

Первый аудит не был безошибочным: `tracking spenders` был отмечен как partial главным образом из-за параметров, хотя документированная форма вообще не проходит identity mapper. Audience sweep был изучен недостаточно глубоко: явное игнорирование next-page cursor не попало в план. Оба пункта теперь включены в S1, а матрица исправлена.

| Критерий | Наш первый отчёт | Второй отчёт |
|---|---|---|
| Полнота инвентаризации | Проверяемая строка на каждый method/path, параметры, источники, baseline diff | Удобная сводка семейств, но грубые числа и меньше воспроизводимых деталей |
| Совместимость существующих операций | Нашёл gallery enum, reserved routes, pinned/lightweight/view, дробный PPV | Нашёл spender mapping и audience offset, которые мы пропустили |
| Приоритеты для чаттера | Composer/media описаны хорошо; маленькие CRM-команды спрятаны в поздний широкий этап | Конкретно выделяет custom name, реакции, pin/unread, upload с диска |
| Восстановление/повторные запросы | Учитывает ordering, старые bindings, delivery retention, неизвестный send outcome | Несколько предлагаемых исправлений создают новый риск: body-hash typing, автоматический re-POST, полная замена polling |
| Кредиты | Разделены vendor totals, local attribution, scopes, бесплатные исключения | Полезные cost/tags и бюджеты; общее утверждение о неучтённых ошибках неверно |
| Проверка production | Есть ограниченный read-only срез, явно не установлена причина 404 | Заявлены удачные проверки ключа, но доказательства в приложении отсутствуют; принадлежность другой команде выведена недостаточно строго |
| Удобство чтения | Длинный технический справочник; короткую рабочую очередь приходится выделять отдельно | Лучше как первоначальная компактная очередь работ; S/M/L без оценки объёма не обещание срока |

## Что проверено и принято из второго отчёта

### 1. Tracking spenders: настоящий пропущенный баг

Endpoint возвращает `onlyfans_id`, а [upsertLinkUsers](../../apps/runtime/src/services/sync/ofapi-fan-identities.ts:79) читает только `id`. Транспорт не переименовывает это поле. При локальном исполнении фактической функции с DB-stubs официальный пример дал **3 входные строки → 0 inserts**. Контрольные subscribers с `id` дали **10 → 10**. [Контракт](https://docs.onlyfansapi.com/api-reference/tracking-links/list-tracking-link-spenders).

Берём в S1 отдельный mapper spender/subscriber, счётчик неразобранных строк и видимую ошибку полного отбрасывания ответа. Revenue из spender aggregate не создаёт дополнительную транзакцию. После исправления — ограниченная переработка сохранённого raw, где он действительно есть. Точное число затронутых live-фанов/кредитов этим локальным опытом не установлено.

### 2. Audience pagination: баг подтверждён, предложенный фикс уточнён

В [consumer](../../apps/runtime/src/services/sync/ofapi-audience-sync.ts:509) следующий offset вычисляется по числу items, хотя [transport](../../apps/runtime/src/services/ofapi.ts:585) уже возвращает nextPageUrl. Проба: 19 rows, vendor next offset=20 → checkpoint=19. Для empty+hasMore код объявляет sweep complete и сбрасывает offset; существующий guard при этом предотвращает generation expiry. Нельзя утверждать, что последствием бывают только лишние чтения. [Контракт fans/active](https://docs.onlyfansapi.com/api-reference/fans/list-active-fans).

Берём в S1 переход по проверенному continuation и `hasMore`, сохранение pagination evidence, запрет ложной полноты. Простое `offset += limit` не исправляет empty-ветку и игнорирует явный cursor. `me.subscribersCount` — полезная сверка количества, но не доказательство полного состава изменяющейся аудитории.

### 3. Guard ожидаемой команды OFAPI

Полезная новая конкретизация S5: при принятии/смене ключа сверять upstream `whoami.team.slug` с заранее подтверждённым ожидаемым значением, привязывать результат к credential fingerprint, показывать время проверки и unknown/mismatch отдельно. Не учить expected из того же произвольного нового ключа. [Whoami](https://docs.onlyfansapi.com/api-reference/api-keys/whoami).

Существующий [Hub whoami](../../apps/runtime/src/services/ofapi-read-gateway.ts:401) синтетический. Текущий ключ — [boot configuration](../../packages/shared/src/config-registry.ts:165); проверка должна охватить и [fallback client регистрации](../../apps/runtime/src/services/ofapi-webhooks.ts:198). Совпадение slug не доказывает полноту прав; документация не обещает неизменность slug.

### 4. Cost/tags: дешёвое расширение существующей link-проекции

`cost{}` и `tags` присутствуют в stored tracking/trial. Hub [уже сохраняет raw items](../../apps/runtime/src/services/ofapi-link-stats-sync.ts:246), но [normalizeLinkItem](../../apps/runtime/src/services/ofapi-link-stats-sync.ts:107) не проецирует эти поля. Берём в S9 typed cost/tag projection, источник/единицы и переработку сохранённых данных. Это полезнее, чем ещё один обязательный платный обход. Provider campaign cost не равен подтверждённым фактическим расходам агентства. [Stored tracking contract](https://docs.onlyfansapi.com/api-reference/stored-tracking-links/list-stored-tracking-links).

### 5. Конкретный небольшой desktop-пакет

Подтверждено: [FanPanel](../../../of-desktop/apps/desktop/src/renderer/src/features/fan-panel/FanPanel.tsx:137) только показывает custom name. [TODO](../../../of-desktop/TODO.md:13) связывает его со страной фана. Поэтому переносим custom-name command рядом с send v2, затем like/unlike, pin/unpin, mark-unread. Mute/hide идут отдельным срезом. Страна в свободном тексте не становится надёжной таймзоной.

Также подтверждён неиспользуемый потенциал `users/list`: client/transport есть, рабочих вызовов `getUsersByIds` за ними не найдено. Применять batching стоит там, где enrichment уже нужен; добавлять платные запросы только ради использования API не требуется.

OF-native notes не переносим в обязательный ранний пакет: [исторический PRD](../../../of-desktop/docs/PRD.md:106) фиксирует их исключение из v1. Это исторический источник продуктового решения, не заявление, что весь PRD сейчас нормативен. Нового рабочего сценария заметок в текущем коде не найдено; нужен отдельный opt-in, без смешивания с локальными notes/AI facts.

### 6. Profile Visitors: история экспортом, свежие данные REST

Идея второго отчёта полезна: исторические account-day rows брать экспортом, оперативный короткий период — через `/statistics/reach/profile-visitors`. Добавлено в S8 как вариант с проверкой одинакового дня обоими источниками. REST проще как регулярное чтение, но не обязательно дешевле: два аккаунта × 30 ежедневных reads ≈60 credits; те же 60 account-days в одном batch export — ориентир 3 credits с другой свежестью. Quote/реальные поля проверяются отдельно. [REST](https://docs.onlyfansapi.com/api-reference/statistics/get-profile-visitors), [export granularity/pricing](https://docs.onlyfansapi.com/data-exports).

Разбивки зависят от REST `type`/`filter`; `chart.duration` нельзя без проверки объявить тем же `avg_view_duration`. Длинный REST-диапазон может укрупнять временные корзины, поэтому один большой REST-запрос не заменяет исторический daily export.

### 7. Заголовки и точность credit accounting

Второй отчёт правильно указал отсутствие capture для `X-OFAPI-Redelivery-Of` и `x-ofapi-is-cached`. Добавлена явная проверка allowed headers и обработки body/header metadata во всех транспортных путях. Для send также нужен `Idempotent-Replayed`. Новые SQL-колонки не обязательны там, где достаточно существующего capture envelope; индексируем отдельно только нужные для поиска поля.

## Что во втором отчёте нельзя принимать как готовое решение

| Утверждение/предложение | Проверка | Решение |
|---|---|---|
| Idempotency полностью снимает indeterminate; повтор либо cached, либо первое исполнение | Документация рекламирует безопасный retry, но response cache исключает 5xx/408/429 и живёт 24 часа. Она не устанавливает отсутствие upstream side effect в каждом неясном исходе | Заголовок добавляем; автоматический re-POST после любого indeterminate не обосновываем этим описанием |
| Для ephemeral достаточно sha256(body) | Повторный typing одного фана может иметь идентичное тело в другой момент; постоянный hash схлопнет независимые pulses | Отдельная локальная receipt identity для допустимых ephemeral |
| Старые presence/typing восстановим обычным replay | Quarantine — отдельный envelope; потерянные duplicate receipt times не сохранились, старый typing не текущая активность | Исторический repair по доступному raw; без старой активности в realtime SSE |
| `data_exports.*` заменяют polling | Доставка может потеряться; webhook completion ещё не означает принятие артефакта | Push ускоряет работу, bounded polling/reconciliation остаётся |
| Subscribers/spenders можно брать из бесплатных stored-списков | В схеме есть четыре stored inventories ссылок; related people URLs ведут на обычные endpoints | Бесплатным делаем link discovery/агрегаты, бюджет на individual people сохраняем |
| Ошибочные ответы не учитываются, всем надо estimated=1 кроме 402/429 | Non-2xx с body used уже учитываются; governed path сохраняет estimate и при ошибках. HTTP status сам не доказывает стоимость | Разбирать фактическую body/header metadata, отделять unknown/estimate; не вводить blanket rule |
| Vault Hub только проксирует и не захватывает | Gateway имеет и [capture-first path](../../apps/runtime/src/services/ofapi-read-gateway.ts:499), и legacy [capture tee](../../apps/runtime/src/services/ofapi-read-gateway.ts:529) | Пробел — полный OF inventory/projection/completeness, не полное отсутствие capture |
| Presence никогда не работал | Текущий no-header контракт действительно попадает в quarantine, но история headers, deployment и alternative sources не установлена | Фикс подтверждён; масштаб/историческую формулировку не подтверждаем |
| В документации 33 OF webhook events | Пересчитаны точные заголовки каталога: 32; Hub запрашивает 19 | В документах оставляем 32; live event discovery отдельно может выявить undocumented дополнение |
| Upload `?async=true`, URL до 1 GB для всех | В OpenAPI async — body field; размер URL зависит от subscription configuration | `async` в body; лимит capability с canary, не универсальное обещание |
| Достаточно разблокировать disk upload в desktop | [Transport](../../../of-desktop/apps/desktop/src/main/ofapi/transport.ts:56) отвергает upload; app surface/IPC отсутствуют | Это полноценный Hub+SDK+desktop-сценарий, а не один flag flip |
| Posts/stories/release forms целиком относятся к ContentOps | [Указанный план](../../docs/plans/2026-09-03-contentops-media-identity.md:8) описывает именно готовность Hub; публикации исключены из того среза, OF posts capture входит | Authoring можно отложить по пользе; существующий capture и DM release references остаются задачами Hub |
| Минимальная дата публикации заменяет обход постов | Publish date не является курсором всех правок/удалений старых постов | Incremental discovery дополняет сверку, не доказывает актуальность всей истории |
| У Hub не было daily limits | У провайдера убраны старые daily-rate поля, но [Hub daily budgets/caps](../../packages/shared/src/config-registry.ts:248) существуют | Разделять provider rate limit и локальный расходный лимит |

Документальные основания для первых четырёх пунктов: [Send Message](https://docs.onlyfansapi.com/api-reference/chat-messages/send-message), [Delivery & retries](https://docs.onlyfansapi.com/webhooks/delivery-and-retries), [event catalog](https://docs.onlyfansapi.com/webhooks/available-events). Основание для upload: [endpoint](https://docs.onlyfansapi.com/api-reference/media-vault/upload-media-to-vault). Наш вывод про универсальный indeterminate retry — оценка достаточности гарантии для существующего outbox, а не утверждение, что live-дубли этим ключом уже наблюдались.

### Отдельно о кредите за ошибку

Это не один общий путь. [Локальные пробы resolver](../../investigations/ofapi-support-refresh-2026-09-05/comparison-probes.json) показали:

| Ответ для legacy resolver | Результат сейчас |
|---|---|
| 500/404/429, used=1 | 1 credit, exact |
| 403, used=0 | 0 credits, exact |
| Non-2xx без used/balance | Нет spend row от resolver |
| Non-2xx, только balance | 0 estimated + balance observation |
| 304 без body metadata | Нет spend row от resolver |

А [governed capture](../../packages/db/src/repositories/ofapi-capture.ts:2196) сохраняет reserved estimate независимо от status и [позже корректирует](../../apps/runtime/src/services/ofapi-capture-transport.ts:260) его по body used. Поэтому возможна и завышенная оценка бесплатного отказа. Credit headers уже отбираются транспортом, но accounting читает body. JSON cache flag тоже уже есть. Исправляем конкретную недостающую семантику, а не заявляем полное отсутствие учёта ошибок/cache.

### Отдельно о заявленных live-результатах второго отчёта

Данные о названии команды, дате ключа, одном аккаунте, балансе и RPM **не были независимо подтверждены в этом сравнении**. В приложенном тексте нет сохранённого sanitized response, timestamp или проверки identity настоящего production key. Наши предыдущие прямые запросы получили edge 403/1010; это не опровергает удачный запрос другого исследователя, но и не подтверждает его ответ.

Даже если ответ с одним аккаунтом точен, «у ключа один account, а в Hub две страницы → это другая команда» не следует: [account-restricted keys документированы](https://docs.onlyfansapi.com/onlyfans-ai/mcp#control--safety), а локальные mappings могут быть устаревшими. Для вывода нужны identity обоих ключей и проверенный scope. Новая команда/нулевой webhook count также не превращают подключённого реального creator в безопасную песочницу для произвольных отправок.

На момент сравнения этот пункт оставался неизвестным. Впоследствии владелец объяснил простой сменой аккаунта и ключа OFAPI; это учтено в текущем плане перехода. Guard команды сохраняем как проверку ожидаемой привязки, предусматривая её явное обновление при такой миграции. Название команды, баланс/RPM и остальные конкретные live-числа второго отчёта остаются независимо не проверенными.

## Проверяемость и изменения результата

В этой проверке прочитаны актуальный Hub/desktop source, официальный корпус, повторно открыты ключевые public docs. Три независимых агентских проверки использованы как указатели; критичные выводы сверены основным агентом по коду и локальным исполнениям. Production и authenticated API заново не вызывались; application code/config не изменялись.

Артефакты:

- [comparison-probes.mjs](../../investigations/ofapi-support-refresh-2026-09-05/comparison-probes.mjs) — выполняет текущие mapping/cursor блоки с заглушками DB и настоящий exported credit resolver.
- [comparison-fixtures.json](../../investigations/ofapi-support-refresh-2026-09-05/comparison-fixtures.json) — документационные примеры; не production payloads.
- [comparison-probes.json](../../investigations/ofapi-support-refresh-2026-09-05/comparison-probes.json) — результаты для identities, synthetic cursor cases и credits.
- [Обновлённый план](../../investigations/ofapi-support-refresh-2026-09-05/PLAN.md) и [матрица](../../investigations/ofapi-support-refresh-2026-09-05/endpoint-coverage.csv) — исправлены выводы, а не код приложения.

Запуск из корня Hub: `node --import tsx/esm investigations/ofapi-support-refresh-2026-09-05/comparison-probes.mjs`. Пробы не требуют ключа, сети или базы. Они доказывают поведение текущего кода на заданной форме, не масштаб проблем в production.

Практическая очередь: **S0/S1 с обоими новыми багами → lifecycle/delivery + usage/team guard → send/composer и небольшой desktop-пакет → uploads/visitors/traffic.** Полный список операций остаётся справочником, не обязательством реализовать весь API.
