# Аудит хранения и записи данных

Дата: 2026-10-16. Ревизия кода: `1e7e752` + изменения ветки `claude/great-turing-v9k1yx`.

Цель владельца: сократить и оптимизировать то, что хранится и пишется сейчас, найти
лишнее и неоптимальное, и подготовить место под будущий рост: хранить каждое
сообщение спендеров, больше аналитики, больше телеметрии.

Как проверялось. Пять параллельных обзоров кода (capture, телеметрия, сообщения и
аналитика, хост и Postgres, индексы и лишние записи). Затем выборочная перепроверка
утверждений по коду. Итоговая схема собрана на локальном PostgreSQL 16 из всех 276
миграций: 317 таблиц вместе с партициями и 948 индексов. Изменения ветки проверены
интеграционными тестами на этой же схеме. Доступа к production у аудита не было:
объёмы в §3 — оценки по коду и по census от 2026-08-11. Read-only скрипт замера —
[`docs/runbooks/storage-census.sql`](../docs/runbooks/storage-census.sql) (§7). Владелец
снял им production и параллельно получил два независимых аудита. Их сводные цифры —
в §1.1; сырой вывод в этот отчёт ещё не перенесён.

## 1. Вывод

1. **Кризиса места нет, но рост продолжается.** Прод переехал на `agency-de`
   (диск 314 ГБ). На прежнем сервере 10 октября прирост был около 1,2 ГБ/сутки
   ([context](../docs/plans/project-browser/context.md)). Главные августовские
   источники роста закрыты: O(N²) копирование checkpoint в телеметрию и
   подробный stdout. Логи Hub ограничены.
2. **Крупнейший найденный источник лишней записи сейчас — повторные события
   сообщений.** Каждое чтение «головы» чата Fansly возвращает 25 последних
   сообщений. Для каждого из них в `domain_events` дописывалось новое событие
   `message.material_observed` с полным текстом, рядом — checkpoint, а строка
   `message_archive` перезаписывалась вместе со всеми её индексами, включая
   полнотекстовый. Причина: время чтения входило в отпечаток (fingerprint),
   поэтому ключ дедупликации был новым при каждом чтении. В тесте с одним новым
   сообщением в чате из пяти получилось 11 событий вместо 6. **Исправлено в этой
   ветке для Fansly** (§4.1). Для OFAPI тот же шаблон остаётся (§3.1).
3. **Агрегаты пересобирались через DELETE + INSERT всего окна** после каждой
   страницы транзакций, каждого обхода подписчиков и фолловеров, даже когда
   ничего не изменилось. **Исправлено**: теперь записывается только разница
   (§4.2).
4. **Content-addressed хранилище тел (CAS) построено, но выключено**, и
   движок Fansly его не использует. Все новые наблюдения Fansly (pull,
   WebSocket, `browser_site`) пишут тело inline. Тело каждого вебхука OFAPI
   хранится в четырёх формах. Это главный резерв экономии на будущих объёмах
   (§3.2).
5. **Таблицы, которые всё ещё держат августовский объём.** Легаси `sync_runs`,
   `sync_run_events` и `sync_http_attempts` после перехода Fansly на новый движок
   пишутся только для OnlyFans. Но удаление строк (`DELETE`) место файловой
   системе не возвращает. В августе там было около 14 ГБ. После 2026-11-05,
   когда истечёт 30-дневное окно для строк Fansly, их можно физически ужать
   (§3.3, решение владельца).
6. **Под «каждое сообщение спендера» сейчас неудобна сама модель.** У сообщения
   Fansly 6–7 полных копий текста, у OnlyFans — 8. На одно сообщение
   приходится 0,5–1,3 КБ строки при тексте около 60 байт. Нужна одна
   авторитетная проекция `message_archive` и компактная строка (§5).
7. **Самая тяжёлая пустая запись на проде — обновление `page_fans` в конце
   обходов подписчиков и фолловеров.** Оно переписывало `last_seen_at` почти у
   всех строк страницы, включая фанов, которых обход не видел. **Исправлено**
   (§4.6).

### 1.1. Production, 2026-10-16 (сводки владельца)

Цифры из двух независимых аудитов и прогона `storage-census.sql`, как их
пересказал владелец. Сырой вывод (901 строка) здесь не разобран.

- Свободно 222–240 ГиБ. База — 49–52,6 ГБ. `message_archive` — 0,74 ГиБ,
  около 0,88 ГБ на миллион сообщений вместе с индексами.
- Сырые тела ответов — 19,4 ГБ. На выборке из 825 объектов сжатие уменьшало
  их примерно вдвое: нужен пилот на целом разделе.
- `message.material_observed` за сутки: 52 734 полных состояния при 6 589
  различных. 85% выбранных событий повторяли предыдущее состояние и отличались
  только временем получения. Это подтверждает M1 (§3.1).
- Обновление не-подписчиков в `page_fans`: около 8 млн строк и 2,22 ГБ WAL с
  10 октября. В другом замере — 39% всего WAL за 70 секунд. Это P7 (§3.4).
- Часть телеметрии записывает два одинаковых значения: это T11 (§3.3).
- Образы и кэши сборки прибавили около 2,2 ГиБ за время аудита, база — 7 МиБ.
  Нужен бюджет сборочного хранения (H6, H8).
- `/app/lake` в рантайм-контейнерах отсутствует, каталога `data/log` у
  Postgres нет.
- **Отдельная задача полноты:** из 2 160 известных диалогов Fansly с
  положительным spend полная история подтверждена только у 6. Потери это не
  доказывает, но для цели «каждое сообщение спендера» догрузку истории нужно
  обеспечить отдельно, по-разному для Fansly и OnlyFans.

## 2. Что из плана 2026-08-11 сделано

| Пункт плана | Состояние |
|---|---|
| S1: ограниченная checkpoint-телеметрия | Сделано (`services/sync/observability.ts`) |
| S1: лимит логов Docker и тихий stdout | Сделано для Hub; браузеры страниц — в этой ветке |
| S1: очистка образов и build cache при деплое | Сделано (решение #371); у сборки Chrome на хосте build cache не чистится |
| S1: телеметрия наклона диска | Сделано (`db-disk-alert.ts`, days-to-full); история по таблицам — в этой ветке |
| S2: членство через `last_seen_generation` | Сделано в движке (`dm-conversations.ts`, `page-dm.ts`) |
| S3: CAS каталог, тела, ссылки, read seam, parity, erasure | Сделано (0123–0128) |
| S4: pointer-only запись | Только для пяти pull-путей OFAPI через `persistRawPayload`, выключено по умолчанию |
| S5: инструменты переписи старых данных | Есть (`capture:backfill/verify/reclaim`), запуск только вручную; что прошло на проде, из репозитория не видно |
| Двухшаговый протокол записи с intent | Не сделано |
| Вынести `parse_version` из `observations` (§6.5) | Не сделано; индекс 0144 добавил ещё одну зависимость |
| Ссылки CAS у вебхуков, запись `exact_bytes` | Не сделано |
| Фиксированные ключи дедупликации (§9.3) | Не сделано |
| Удаление индексов §9.6 | Частично в этой ветке (`sync_raw_payloads_retain_idx`, `ofapi_commands_payload_redaction_idx`) |
| Партиционирование телеметрии | Не сделано |
| S6: холодный tiering | Не сделано; текущий tiering по-прежнему увеличивает объём и несовместим с CAS |

## 3. Находки

Класс исправления: **(a)** только код, безопасно сейчас; **(b)** аддитивная
forward-only миграция; **(c)** решение владельца или операция на проде.
**Сделано** — изменение есть в этой ветке.

### 3.1. Сообщения и события

| # | Находка | Где | Эффект | Класс |
|---|---|---|---|---|
| M1 | `message.material_observed` с новым ключом при каждом чтении, плюс checkpoint и перезапись строки архива | `canonicalize/sync-pull.ts` (Fansly) | До 25 событий по ~1,3 КБ на одно новое сообщение в активном чате | **Сделано** для Fansly |
| M2 | То же для OFAPI | `services/ofapi-message-material.ts:124` | По событию на каждое чтение через REST (capture, snapshot, serving) | (a) с решением владельца: проверено, что union транскрипта и serving не меняют вывод (часы `dm_message_archive` тоже двигаются только при изменении). Остаётся узкий A→B→A: `isNew` «отметить непрочитанным» без смены `changedAt` оставит архив в B. Если делать — хэшировать `createdAt` вместе с материалом. Сначала стоит узнать долю OFAPI в дублях (раздел 11 замера) |
| M3 | Повторное применение того же события перезаписывало строку архива и reply-поля | `repositories/message-archive.ts` | Лишний tuple и записи во все 7 индексов, включая GIN | **Сделано** |
| M4 | Три обслуживающих хранилища OnlyFans: `page_dm_messages`, `dm_message_archive` (пишется и читается, комментарий «frozen» устарел), `message_archive` | `ofapi-dm-archive.ts`, `ofapi-dm-readthrough.ts`, `ai-transcript-union.ts`, `conversation-feed.ts`, `agent-transcript.ts` | ~0,47 + 1,35 + 0,53 КБ на одно сообщение | (b) → (c): проецировать OFAPI в `message_archive` при settle, отпечатки reconciler'а вынести в узкую таблицу, затем вывести две таблицы из записи |
| M5 | `text_html` дублирует `text_plain` почти во всех строках Fansly | `message-archive.ts` | Вторая копия текста в каждой строке | (a): хранить `text_html` только если он отличается; читателям `coalesce` |
| M6 | `dm_live_messages.content` не очищается после подтверждения архивом | `sync/live-messages.ts` | ~0,1–0,15 МБ/сутки | **Не делать**: читатели показывают оверлей, пока *их* хранилище не получило сообщение (match против `page_dm_messages` ≠ есть в `message_archive`); `sync check live-hour` считает SLO по `attachments`; выгода мала |
| M7 | Числовые id как text (`conversation_ref`, `message_ref`, `fan_native_id`), повторяющиеся текстовые enum | `message_archive` | ~20 Б вместо 8 на поле | (b) для новых колонок |
| M8 | GIN-индекс полнотекстового поиска обслуживает только агентский поиск; `agentReadPlaneMode` по умолчанию `off`, поиск дашборда идёт через `ILIKE` | `0059_message_archive.sql:46` | Самый дорогой индекс при росте сообщений | (c): проверить `idx_scan`; сделать частичным или удалить |
| M9 | Ключи, привязанные к наблюдению: каталог и членство в альбомах (`:obs:<id>`), `rawmedia`, earnings — неизменённое состояние пишется на каждом просмотре | `canonicalize/fansly-catalog.ts`, `raw-media.ts:60`, `fansly-earnings.ts:146` | Членство в альбомах: ~2,5–17 МБ/сутки на страницу (столько же `rawmedia`); каталог и earnings — десятые МБ | **Не минимальная правка**: на «событие на каждый просмотр» опираются `last_observed_at`, отметки «пропал», дневные строки gift-кодов, аудит earnings C2a и тесты J12. Content-only ключ возвращает баг A→B→A; сравнение с проекцией ломает детерминизм реплея. Нужен редизайн: события по содержимому + компактное событие «видел» на просмотр. `statstop`/`mediatag` — не дубли (ключ по окну) |
| M10 | `ai_generation_content.prompt_blocks` хранит статичные блоки и транскрипт целиком при каждом вызове | `ai-gateway.ts:563` | Растёт как «генерации × длина транскрипта» | (b): content-addressed блоки, транскрипт дневными кусками |
| M11 | `dm_message_archive_retain_until_idx` и ежедневная «очистка» при сроке 36 500 дней не удаляют ничего | `ofapi-events.ts:572` | Индекс и ежедневный проход впустую | (a) + (b) |

### 3.2. Сырые данные (capture plane)

| # | Находка | Где | Эффект | Класс |
|---|---|---|---|---|
| C1 | CAS (`captureCasDualWritePages`, `captureCasPointerOnlyPages`) по умолчанию выключен; при dual-write без pointer-only тело OFAPI хранится трижды | `config-registry.ts:286-288`, `services/sync/shared.ts` | Пара raw+observation у OFAPI pull | (c): постраничное включение dual-write → `serve` → pointer-only |
| C2 | Движок Fansly, WebSocket, `browser_site`, вебхуки и `ofapi_capture` пишут тела в обход CAS | `sync/engine/commit.ts:1144`, `repositories/fansly-ws.ts`, `sync/fansly/browser-site-capture.ts`, `ofapi-capture.ts:2211` | Повторяющиеся снимки (список чатов каждые 30 с при упавшем сокете, insurance-обход транзакций каждые 15 мин, уведомления каждые 30 мин) хранятся каждый раз целиком | (a): колонки ссылок уже есть (0124); подключить за тем же флагом и canary |
| C3 | `browser_site` журналирует каждый GET браузера, включая повторы из кэша и service worker | `browser-site-capture.ts:136-195` | Новый неограниченный поток | (a) + решение владельца: CAS или envelope со ссылкой |
| C4 | Вебхук OFAPI в четырёх формах: `raw_body`, `payload`, `observations.payload`, `sync_event`; до 6 версий строки за жизнь, почти все non-HOT; base64-копия в malformed-путях | `repositories/ofapi.ts:96-345`, `ofapi-webhook-capture.ts` | ~6–10 КБ heap+WAL на доставку | (b): типизированные колонки для полей, которые читают из JSON; затем не писать parsed-копию; статусы — в узкую таблицу |
| C5 | `observations.parse_version` обновляется после записи, а колонка входит в два индекса: каждый штамп — non-HOT update, а повышение версии семейства переписывает всю его историю | `domain-events.ts:1313`, индексы 0054 и 0144 | Вторая копия каждой строки журнала, ГБ WAL на каждое повышение версии | (b): состояние разбора — в узкую таблицу или водяной знак семейства; затем удалить `observations_parse_idx` |
| C6 | Ключи дедупликации `domain_event_keys` — длинный text (30–140 Б) и хранятся дважды | 0057 | Индекс в 2–3 раза больше, чем при `sha256` | (b): dual-write фиксированного ключа, backfill, переключение |
| C7 | Четыре читателя берут `observations.payload` напрямую, минуя payload reader; на переписанном месяце они сломаются | `fansly-ws.ts:342`, `fansly-public-lookup.ts:340`, `ofapi-export-controls.ts:90`, `ofapi-webhook-event-catalog.ts:38` | Блокер исторической переписи | (a): перевести на reader и добавить статический тест-запрет |
| C8 | Tiering увеличивает объём (DETACH без DROP), `LAKE_DIR` относительный и не на volume, экспортирует только envelope (несовместим с pointer-only); CLI `tiering:run` без защиты | `services/tiering/index.ts`, `config.ts:99`, `cli.ts:938` | Риск записать до ~10 ГБ во writable layer контейнера | (a): CLI отказывает без абсолютного смонтированного `LAKE_DIR` |
| C9 | `ofapi_webhook_events_w2_lineage_snapshot` (~159 МБ) не создан миграцией, читатель переносит его отсутствие | `dm-corrections-lineage-intake.ts:43` | Разовый возврат места | (c) |

### 3.3. Телеметрия

| # | Находка | Где | Эффект | Класс |
|---|---|---|---|---|
| T1 | Легаси `sync_runs`/`sync_run_events`/`sync_http_attempts` держат августовский объём (~14 ГБ); строки Fansly истекут к ~2026-11-05 | `services/sync/executor.ts`, `repositories/sync.ts:969` | Самый крупный разовый возврат места | (c): после 11-05 census, затем `VACUUM FULL` или pg_repack по одной таблице |
| T2 | `sync_attempts` с `evidence = true` не удаляются никогда — это как раз обходы истории DM | `repositories/sync/retention.ts:105` | До ~50 ГБ/год при полной загрузке истории (оценка) | (b): параметры запроса журналировать вместе с наблюдением; затем `sync_attempts` — чистая 30-дневная телеметрия с партициями по `admitted_at` |
| T3 | На один HTTP-запрос движка: INSERT + 3 non-HOT UPDATE `sync_attempts` (6 индексов), 3 non-HOT UPDATE `sync_work`, 2 UPDATE `sync_pages` | `sync/engine/attempts.ts`, `work.ts` | ~8 КБ WAL на запрос (оценка) | (b) после EXPLAIN: убрать предикатные индексы по меняющимся колонкам, fillfactor 80 и autovacuum 0,02 |
| T4 | Heartbeat `runtime_instances` каждую минуту переписывал снимок конфигурации (~6–8 КБ) non-HOT update'ом из-за индекса по `last_seen_at` | `runtime-instances.ts` | ~7 тыс. перезаписей в сутки | **Сделано** |
| T5 | События `worker_heartbeat` каждые 30 с на каждый идущий run дублируют heartbeat аренды | `executor.ts:65,509` | Строки в `sync_run_events` | (a) |
| T6 | Третий UPDATE на попытку OFAPI и повторный `JSON.stringify` ответа только чтобы посчитать байты | `services/sync/shared.ts:247`, `sync.ts:823` | Лишний tuple на запрос | (a) |
| T7 | `sync_attempts.request` хранит `query` (повтор `params`), `spec` (повтор `operation`), `credentialsGeneration` в каждой строке | `commit.ts:357` | Около четверти JSON строки | (a) |
| T8 | Удаление FK по истекшему `sync_runs` обнуляет `sync_raw_payloads.sync_run_id`, то есть UPDATE строк захваченных фактов | FK 0012 | Лишняя запись и потеря связи raw → run | (b), решение владельца |
| T9 | Нет партиционирования ни у одной таблицы телеметрии; все очистки — построчный `DELETE` | `retention.ts`, `sync.ts`, `golden-signals.ts` | Bloat и никакого возврата места | (b): дневные или месячные партиции + DROP PARTITION |
| T10 | `fansly_ws_decode_receipts.nodes` никто не читает, а это `decodeFanslyWsCapture(frame)` сохранённого кадра | `fansly-ws.ts:308`, `sync/live-messages.ts:429` | ~130–530 Б на кадр, плюс столько же WAL | **Сделано** |
| T11 | «Датчики» (одно значение: возраст, счётчик, размер) писались дважды, как одинаковые p50 и p95: ~15 в минуту у golden signals и ~20 раз в 5 минут у метрик движка | `golden-signals.ts`, `sync/engine/metrics.ts`, `ofapi-delivery-history-signal.ts` | Половина строк этих серий — копии | **Сделано** |

### 3.4. Агрегаты и проекции

| # | Находка | Где | Эффект | Класс |
|---|---|---|---|---|
| P1 | `fan_spend_daily`, `fan_spend_lifetime`, `revenue_daily`, `daily_followers`, `daily_subscribers` и `page_fans.total_creator_net_mills` пересобирались через DELETE + INSERT окна | `spenders.ts`, `transactions.ts` | Все строки окна заново, на каждой странице обхода | **Сделано** |
| P2 | Строка транзакции Fansly переписывается при каждом повторном чтении (меняется `source_observation_id`) | `fansly-transaction-dirty.ts:44`, `transactions.ts:81` | non-HOT update во все 8 индексов `transactions` | (c): решение, нужна ли ссылка на последнее наблюдение; scan token должен остаться |
| P3 | Generation-обходы (подписчики раз в час, фолловеры и чаты раз в сутки) штампуют каждую строку, а `last_seen_generation` стоит в индексе: каждый штамп — non-HOT | `page_follows/page_subscriptions/page_dm_threads_generation_idx` | Копия строки во все индексы на каждом обходе | (c) → (b): проверить планы; удалить индексы, fillfactor 85 |
| P4 | Upsert'ы без `IS DISTINCT FROM`: `page_sync_cursors`, presence в `page_fans`, `upsertPageDmMessages`, архивная ветка подписок, `fansly-stats` (newerWins в SET, а не в WHERE) | см. §3.4 отчёта индексов | Пустые версии строк | (a), кроме `last_seen_at` чатов — там нужно решение |
| P5 | `page_link_stat_snapshots`: полная строка на ссылку на каждом проходе, `name`/`url`/`tags` повторяются, `revenue_gross_mills` = `revenue_net_mills` | `ofapi.ts:3292` | Единственная история счётчиков — только решение владельца | (c) |
| P6 | `client_health_receipts`: строка на клиента каждые 15 минут навсегда, нужна только для окна повторной отправки | — | Медленный рост | (a) |
| P7 | `refreshFanPageFollowerState` и `refreshFanPageSubscriberState` в конце обходов переписывали `last_seen_at` у каждой строки `page_fans`, у которой он старше минуты, без изменений. Это почти вся страница, включая фанов, которых обход не видел | `repositories/fans.ts` | Прод: ~8 млн строк и 2,22 ГБ WAL за 6 дней | **Сделано** |

### 3.5. Индексы

Удалены в этой ветке (миграция 0283): девять индексов. Шесть из них — ведущий
префикс другого индекса той же таблицы с тем же предикатом. Три не читаются
никем: `sync_raw_payloads_retain_idx`, `ofapi_commands_payload_redaction_idx`,
`runtime_instances_last_seen_idx`.

Требуют `idx_scan` с прода, прежде чем трогать (§7, раздел 6 скрипта):

- `observations_parse_idx` — кажется избыточным рядом с индексом 0144, но это
  партиционированная таблица: удалять только с `lock_timeout`-циклом, как в 0265.
- `transactions_source_idx` — 5 значений, все читатели фильтруют ещё и по аккаунту.
- `creator_posts_engagement_observed_idx`, `creator_posts_account_observed_idx` —
  читателя не нашлось, ключи меняются на каждом обновлении.
- `page_dm_threads_visible_unread_idx`, `page_dm_threads_backfill_idx`,
  `page_dm_messages_account_conversation_created_idx`.
- `ofapi_webhook_events_status_idx` → заменить частичным `(id) where status = 'pending'`.
- `fans_deleted_detected_idx` → частичный `where deleted_detected_at is not null`.
- `message_archive_text_search_idx` (GIN) — см. M8.
- B-tree, которые служат только очистке (`sync_run_events_emitted_idx`,
  `sync_http_attempts_retention_idx`, `sync_runs_started_idx`,
  `ops_metric_samples_sampled_at_idx`) → BRIN с `autosummarize`.
- Пары одиночного и составного FK на `sync_runs` и `page_dm_threads`: составной
  включает одиночный, на каждую вставку идут две проверки.

### 3.6. Хост и Postgres

| # | Находка | Где | Класс |
|---|---|---|---|
| H1 | У браузеров страниц нет лимита логов (оператор пишет строку на каждый запрос сайта, туда же stderr Chrome и KasmVNC) | `docker-compose.page-browser.yml` | **Сделано**: `local` 10m × 3; действует после `page.sh up` |
| H2 | Postgres почти без настроек в репозитории: тюнинг лежит в `postgresql.auto.conf` внутри volume, `shm_size` не задан (64 МБ) | `docker-compose.production.yml` | (c): §6 |
| H3 | `statement_timeout`/`idle_in_transaction_session_timeout` только у пула `sync` | `bootstrap.ts:152` | (a) или (c) на уровне сервера |
| H4 | `SYNC_HTTP_TRACE_FILE` при включении пишет без ротации во writable layer | `observability.ts:212` | (a): запретить в production |
| H5 | Fastify логирует две строки на каждый API-запрос (дашборд опрашивает каждые 10 с) | `api/server.ts:220` | (a): `disableRequestLogging` + строка для ошибок и медленных |
| H6 | Ежедневная сборка Chrome на хосте не чистит build cache | `page-browser-update.sh:2270` | **Сделано**: `docker builder prune --filter until=168h`, как в деплое Hub |
| H7 | HTTP-кэш Chrome в профиле без лимита | `s6-rc.d/chrome/run` | (a), после проверки на заметность для сайтов |
| H8 | Playwright Chromium ставится после `node_modules`: каждое изменение зависимостей пересобирает слой ~300–500 МБ ради одной PNG в день | `Dockerfile:92` | (a) |
| H9 | Размер БД не сохранялся во времени, истории по таблицам не было | `db-disk-alert.ts` | **Сделано**: §4.4 |

## 4. Что сделано в этой ветке

### 4.1. Повторные события сообщений Fansly

- `canonicalize/sync-pull.ts`: отпечаток материала считается без
  `materialObservedAt`. Повторное чтение неизменённого сообщения
  дедуплицируется, и вместе с ним не пишется checkpoint. Реальное изменение
  (медиа, цена, reply, маркеры, текст) по-прежнему даёт новое событие. В голове
  события остаётся время первого чтения этого материала: это часы приоритета
  архива (у голов Fansly нет времени изменения от вендора).
- `repositories/message-archive.ts`: повторное применение события, которое
  последним записало строку, ничего не пишет. Reply-поля не перезаписываются,
  если значения и их часы не меняются.
- Следствие для повторного разбора: наблюдения, прочитанные до изменения,
  при повторном разборе дадут не больше одного нового события на пару
  «сообщение, материал». Их часы старше архивных и проигрывают. Версию
  семейства не повышаем, чтобы не запускать массовый повторный разбор.
- Проверка: `tests/canonicalize-media-plane.test.ts` (два чтения — один ключ,
  изменённый текст — новый ключ) и `tests/sync-dm-head.integration.test.ts`
  (второе чтение головы добавляет события только для нового сообщения, строки
  архива пяти перечитанных сообщений не получают новой версии). На старом коде
  оба теста падают: 11 событий вместо 6.

### 4.2. Агрегаты «по разнице»

Пересборка `fan_spend_daily`, `fan_spend_lifetime`, `revenue_daily`,
`daily_followers`, `daily_subscribers` и `page_fans.total_creator_net_mills`
теперь одним выражением на таблицу: upsert с `IS DISTINCT FROM` плюс удаление
строк, которых окно больше не даёт. Итоговые строки те же. `updated_at` двигается
только у изменённых строк; читателей у него нет, часы пересборки — в
`projection_watermarks`. Касается и OFAPI (backfill, ingest,
chargebacks), и Fansly.

Проверка: `tests/rollup-diff-apply.integration.test.ts`. Пересборка без
изменений не меняет `xmin` ни одной строки. После изменений результат совпадает
с пересборкой с нуля. На старом коде тест падает. Прогнаны 108 файлов
интеграционных тестов, касающихся транзакций и спендеров.

### 4.3. Миграция 0283 и heartbeat

- Удалены девять индексов (§3.5), `DROP INDEX CONCURRENTLY`.
- `fans` и `page_fans`: `fillfactor = 90`. Большинство их обновлений не трогает
  индексированные колонки и может быть HOT, если на странице есть место (0145:
  57,8 млн обновлений на 67 тыс. строк раздули heap в 30–64 раза).
- `runtime_instances`: снимок конфигурации сохраняется прежним, если не
  изменился, а без индекса по `last_seen_at` heartbeat стал HOT-обновлением.
- Проверка: `tests/storage-write-hygiene.integration.test.ts` проверяет, что
  индексов нет, покрывающие на месте, fillfactor стоит, а heartbeat — HOT
  (`pg_stat_xact_user_tables`).

### 4.4. Телеметрия хранения

- Миграция 0284: `storage_relation_daily` — одна строка на таблицу в сутки:
  heap, TOAST, индексы, живые и мёртвые строки, накопительные счётчики
  insert/update/HOT/delete. Партиции сворачиваются в корень, припаркованные
  таблицы видны с именем схемы. Около 200 узких строк в сутки.
- Пишется ежечасной проверкой диска один раз за UTC-сутки, только из каталога и
  `pg_stat`, без сканирования таблиц. Там же почасовая метрика
  `disk_pg_database_bytes` в `ops_metric_samples` (имя `disk_*` не влияет на
  deadman сэмплера).
- Запросы для чтения — §8.

### 4.5. Логи браузеров страниц

`docker-compose.page-browser.yml`: `logging: local, 10m × 3`. Применяется при
следующем пересоздании контейнера страницы.

### 4.6. Пустые обновления `page_fans`

`refreshFanPageFollowerState` и `refreshFanPageSubscriberState` пишут строку
только при изменении полей фолловера или подписчика; `last_seen_at`
проставляется вместе с изменением. Фанов, которых обход видел, по-прежнему
освежает upsert самого обхода (`upsertFanPages`) с тем же окном в минуту.
Единственный читатель `page_fans.last_seen_at` — набор данных агентского API.
Проверка: `tests/fan-churn.integration.test.ts` и 92 файла тестов, где
участвуют `page_fans`, подписчики и фолловеры.

### 4.7. Один «датчик» — одна строка

Gauge-метрики golden signals, движка синхронизации и возраста истории
доставки вебхуков пишут одно значение в слот p95 — его читают алерты, тесты и
отчёт `/api/v1/ops/metrics`. Настоящие распределения (capture, canonicalize,
projection, `dm_visible_lag`, `money_lag` и другие) сохраняют оба квантиля.

### 4.8. Ещё два безопасных исправления

- Ежедневное обновление браузеров страниц чистит build cache старше недели
  (`scripts/page-browser-update.sh`); сбой — предупреждение, не ошибка.
- Квитанция разбора кадра сокета больше не хранит разобранные узлы
  (`fansly_ws_decode_receipts.nodes` — NULL для новых строк).

Проверены и **отвергнуты** как несущие риск регрессий (подробности в §3):
M6 (текст живых сообщений), M9 (события по просмотру), upsert'ы статистики с
`newerWins` в WHERE (меняют `first_observed_at` и счётчики `applied`),
guard на `page_dm_messages` (от `synced_at` зависит очистка), третий UPDATE
попыток OFAPI (намеренный замер, выигрыш мал). M2 ждёт решения (§3.1).

## 5. Модель под «каждое сообщение спендера»

1. **Авторитет.** Сырые `observations` остаются захваченным фактом,
   `domain_events` — источником для перестройки: ровно одно событие материала
   на каждую различную версию сообщения (M1 для Fansly сделан, M2 — следующий).
   `message_archive` — единственная обслуживающая проекция для обеих платформ.
   `page_dm_messages` и текст в `dm_message_archive` выводятся из записи после
   provenance-проверки (M4).
2. **Строка.** Id как `bigint`, короткие коды для `platform`, `sender_role`,
   `origin_class`. Без дублирующего `text_html`. Деньги в `bigint` mills.
   `fillfactor = 90`, чтобы обновления `is_opened`/`updated_at` были HOT.
3. **Индексы.** Уникальный `(account, message)` и `(account, conversation,
   occurred_at)`. BRIN по времени записи. Полнотекстовый поиск — только если
   есть функция, которой он нужен, и тогда частичный (например, только
   сообщения фанов).
4. **Объём.** При росте в 10–100 раз (≈3,5–35 млн строк по ~0,5 КБ, 2–19 ГБ)
   одна компактная таблица справляется. Дальше — hash-партиции по
   `account_id`, а не по `occurred_at`: бэкфилл истории идёт по времени
   провайдера, а чтение — по переписке.
5. **Меньше чтений → меньше сырья.** Меньшая страница «головы», когда цепочка
   ждёт одно-два сообщения. Решает владелец логики цепочек движка.
6. **Сырьё под этот поток** — через CAS (C1/C2): повторяющиеся страницы
   хранятся один раз.

## 6. Настройки Postgres (рекомендация, применяет владелец)

Сервер 8 vCPU, 15 ГиБ RAM (часть уйдёт браузерам страниц), диск 314 ГБ.
Применять `ALTER SYSTEM` + `select pg_reload_conf()`; помеченное «restart» —
в окно перезапуска. Сначала снять текущие значения (§7, раздел 2), потому что
часть тюнинга уже лежит в `postgresql.auto.conf`.

```sql
-- Объём WAL: меньше full-page images и сжатие тех, что остались.
alter system set wal_compression = 'lz4';
alter system set max_wal_size = '4GB';        -- capture-rewrite резервирует 4×max_wal_size: 16 ГБ при 314 ГБ — допустимо
alter system set min_wal_size = '1GB';
alter system set checkpoint_timeout = '15min';
-- Вакуум под нагрузку «в основном вставки».
alter system set autovacuum_vacuum_cost_limit = 1500;
alter system set autovacuum_vacuum_scale_factor = 0.05;
alter system set autovacuum_analyze_scale_factor = 0.05;
alter system set autovacuum_vacuum_insert_scale_factor = 0.05;
alter system set log_autovacuum_min_duration = '30s';
-- Защита и видимость.
alter system set temp_file_limit = '10GB';
alter system set idle_in_transaction_session_timeout = '10min';
alter system set log_temp_files = '100MB';
alter system set log_lock_waits = on;
alter system set track_io_timing = on;
-- restart:
alter system set shared_buffers = '2GB';
alter system set autovacuum_max_workers = 5;
alter system set shared_preload_libraries = 'pg_stat_statements';  -- wal_bytes по запросам: прямой способ найти тяжёлых писателей
```

Плюс в compose: `shm_size: 1g` у `postgres` (параллельные hash join используют
`/dev/shm`). `default_toast_compression = lz4` экономит CPU, а не место; zstd для
TOAST в PG16/17 нет.

## 7. Замер production (read-only)

[`docs/runbooks/storage-census.sql`](../docs/runbooks/storage-census.sql) читает
только каталог, счётчики `pg_stat`, эффективные флаги и 24-часовые срезы по
индексированным колонкам времени. Транзакция read only, `statement_timeout`
60 с, данных фанов в выводе нет. Запуск — в шапке файла. Что он покажет:

- реальные размеры таблиц, TOAST и индексов, партиции, припаркованные таблицы;
- `idx_scan` всех индексов больше 1 МБ — это закрывает список §3.5;
- долю HOT-обновлений по таблицам (P3, T3);
- эффективные значения флагов CAS, tiering, trace file по процессам;
- какие шаги исторической переписи уже прошли;
- `domain_events` за сутки по типам и число событий материала на одно сообщение
  (масштаб M1/M2 до и после деплоя);
- наблюдения за сутки по источникам, долю pointer-only, попытки движка и вебхуки.

## 8. Как проверить эффект после деплоя

```sql
-- Прирост по таблицам за сутки (размер и записи).
select d.relation,
       pg_size_pretty(d.total_bytes - p.total_bytes) as grew,
       d.inserts - p.inserts as ins, d.updates - p.updates as upd,
       round(100.0 * (d.hot_updates - p.hot_updates) / nullif(d.updates - p.updates, 0), 1) as hot_pct
from storage_relation_daily d
join storage_relation_daily p on p.relation = d.relation and p.sampled_on = d.sampled_on - 1
where d.sampled_on = current_date
order by d.total_bytes - p.total_bytes desc
limit 30;

-- Наклон размера БД по часам.
select sampled_at, pg_size_pretty(value_ms) from ops_metric_samples
where metric = 'disk_pg_database_bytes' order by sampled_at desc limit 48;
```

Ожидаемые сигналы: число `message.material_observed` на одно сообщение за сутки
близко к 1 (раздел 11 скрипта); у `fan_spend_daily`, `revenue_daily`,
`daily_followers` и `daily_subscribers` счётчик `updates` за сутки падает до числа
реально изменённых дней; у `runtime_instances` и `page_fans` растёт доля HOT.

## 9. Следующие шаги

Порядок выбран по отношению эффекта к риску.

1. **Разобрать сырой вывод замера** (§7, §1.1): по нему решаются §3.5, P3,
   T3 и выбор между C2 и C3.
2. **Решения и редизайн:** M2 (OFAPI, узкий A→B→A), M9 (события «видел» вместо
   полного состояния на просмотр — самый крупный оставшийся поток событий).
   Мелочи (a) с малым выигрышем: M5, C7, C8, T5, T7, P4, H4, H5.
3. **Сжатое хранение сырья:** пилот на одном закрытом месяце (сжатие ~2× на
   выборке, §1.1) вместе с включением CAS — оба меняют физическое
   представление тел и проверяются одной процедурой паритета.
4. **Полнота истории спендеров** (§1.1) — отдельная задача сбора, не хранения.
5. **Миграции (b):** C5 (состояние разбора вне `observations`), T2 + T9
   (evidence в журнал, партиции `sync_attempts`), C4 (колонки вебхуков), C6
   (ключи `sha256`), индексы из §3.5 по результатам замера, fillfactor и
   autovacuum для `sync_attempts`/`sync_work`.
6. **Решения владельца (c):**
   - после 2026-11-05: census и `VACUUM FULL`/pg_repack легаси `sync_*` (T1);
   - постраничное включение CAS: dual-write → `captureCasReadMode = serve` →
     pointer-only (C1), затем помесячная историческая перепись;
   - удаление `ofapi_webhook_events_w2_lineage_snapshot` (C9);
   - вывод `page_dm_messages`/`dm_message_archive` из записи (M4);
   - настройки Postgres (§6);
   - P2, P5, решение по `browser_site` (C3).
