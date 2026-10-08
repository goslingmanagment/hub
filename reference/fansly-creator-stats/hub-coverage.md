# Покрытие новой статистики Fansly в Hub

## Граница проверки

Статический аудит выполнен 2026-10-08 для Hub на commit
`f4987f564f9ff73ea79f1a139721dc5f503f9b32`. Документ
сопоставляет найденные в новой UI и бандлах маршруты с фактическими wire specs,
resource registry, observation kinds, канонизаторами и проекциями этой ревизии.
Степень подтверждения каждого нового маршрута живым запросом описывается в
основной карте эндпоинтов; отсутствие в Hub проверено отдельно для всех 12.

**Ни один из 12 новых `/account/stats/*` маршрутов не подключён к штатному
Fansly Sync Engine этой ревизии.** У Hub есть самостоятельное покрытие старых
traffic, media, earnings и audience источников. Совпадающие названия метрик
не доказывают равенства старых и новых данных или их полноты.

Продовая БД в этом аудите не читалась. Выводы ниже описывают код, а не число
сохранённых на проде строк, состояние leases, фактические capture floors или
наличие исторических/вручную загруженных observations. Реализация не менялась.

## Все 12 новых маршрутов

В столбце «нет» одновременно проверены: wire spec, активный resource writer,
новый observation kind с canonicalizer mapping и typed projection новой
формы ответа. Существование универсальной таблицы `observations` само по
себе не является подключением эндпоинта.

| Новый GET-путь | Штатное подключение | Ближайший старый источник | Что нельзя считать уже покрытым |
|---|---|---|---|
| `/account/stats/summary` | Нет | Account traffic, account metadata, revenue mix | Новая summary-форма, её filters и сравнение интервалов |
| `/account/stats/series` | Нет | `/it/amoie/stats`, `/account/wallets/earnings/stats` | Families `views`, `profile`, `follows`, `subscriptions`, `revenue` с новой схемой dimensions |
| `/account/stats/media/top` | Нет | `dataset.topMediaOffers`, `dataset.topFypMediaOffers` | Новый ranking и его query/filter semantics |
| `/account/stats/media` | Нет | `/it/moie/statsnew` | Новая per-media форма и набор доступных измерений |
| `/account/stats/media/benchmarks` | Нет | Прямого аналога в stats family нет | Benchmark-ответ и правила сопоставления |
| `/account/stats/media/shown` | Нет | Media inventory и post attachments | Выдача данного маршрута; catalog membership не заменяет её |
| `/account/stats/geo` | Нет | Прямого аналога в stats family нет | Географические срезы новой статистики |
| `/account/stats/activehours` | Нет | Старые hourly traffic buckets | Новая форма активности аудитории; hourly views не доказывают эквивалентность |
| `/account/stats/tags` | Нет | Account/per-media `topFypTags`, global tag counters | Новые tag-метрики и dimensions |
| `/account/stats/posts` | Нет | Timeline/post engagement и старые media stats | Ответ нового statistics-маршрута; post inventory не заменяет статистику |
| `/account/stats/fans/top` | Нет | `/account/wallets/earnings/accounts` | Новый ranking fans и его filters/метрики |
| `/account/stats/fans` | Нет | Followers/subscribers, fan profiles, per-fan earnings | Новый fan statistics detail/list contract |

Отрицательный результат получен точным `rg -F` для каждого из 12 путей в
`packages/fansly/src`, `apps/runtime/src`, `packages/shared/src`,
`packages/db/src`. Дополнительный поиск общего префикса `/account/stats/`
в тех же деревьях также не дал совпадений. Это проверка implementation
trees; созданная документация не включалась в поиск.

Отсутствие проверено не только строковым поиском:

1. [FANSLY_WIRE_SPECS](../../packages/fansly/src/wire/specs.ts#L227) является
   полной таблицей wire requests; [FANSLY_WIRE_IDS и isFanslyWireId](../../packages/fansly/src/wire/specs.ts#L738)
   строятся из её ключей.
2. [buildCatalogue](../../apps/runtime/src/sync/fansly/routes.ts#L170)
   включает wire specs и отдельные legacy-only пути. Ни среди wire specs,
   ни среди [legacy-only путей](../../apps/runtime/src/sync/fansly/routes.ts#L28)
   новых `/account/stats/*` нет. `routeOfEngineOperation` принимает только
   записи с настоящим wire ID, а не любой известный исторический путь.
3. [Resource registry](../../apps/runtime/src/sync/fansly/registry.ts#L566)
   перечисляет `media.offer_stats`, `account.stats` и wallet operations;
   [stats.daily operations](../../apps/runtime/src/sync/fansly/registry.ts#L139)
   не содержат новых маршрутов.
4. [Observation kinds](../../apps/runtime/src/services/observation-kinds.ts#L83),
   [FanslyObservationKind](../../packages/fansly/src/wire/types.ts#L21) и
   [stats canonicalized kinds](../../apps/runtime/src/services/canonicalize/fansly-stats.ts#L81)
   содержат прежние формы. Parser `account_stats` требует старый `dataset`
   с datapoint arrays: [shape gate](../../apps/runtime/src/services/canonicalize/fansly-stats.ts#L1131).
5. [Stats projector event types/tables](../../apps/runtime/src/services/projections/fansly-stats.ts#L46)
   имеют прежние события; нет reducer, который подключает новую форму через
   динамическое совпадение URL.

## Уже подключённые источники

Все параметры ниже относятся к запросам Hub, а не к возможностям новой UI.
Wire builder добавляет `ngsw-bypass=true` ко всем API requests:
[buildFanslyWireTarget](../../packages/fansly/src/wire/specs.ts#L753).

| Wire ID | GET-путь | Query, задаваемый Hub | Observation kind |
|---|---|---|---|
| `account.stats` | `/it/amoie/stats` | `beforeDate`, `afterDate`, `period`, `year=0` и `month=0` по умолчанию | `account_stats` |
| `media.offer_stats` | `/it/moie/statsnew` | `mediaOfferId`, `beforeDate`, `afterDate`, `period` | `media_offer_stats` |
| `earnings.stats_window` | `/account/wallets/earnings/stats` | `before`, `after`, `limit` | `earnings_stats_snapshot` |
| `earnings.monthly` | `/account/wallets/earnings/monthlystats` | Опциональные `before`, `after` | `earnings_monthlystats_snapshot` |
| `earnings.accounts` | `/account/wallets/earnings/accounts` | `after`, `before` | `earnings_accounts` |
| `earnings.stats_accounts` | `/account/wallets/earnings/stats/accounts` | `correlationAccountId`, `after`, `before` | `fan_earnings_stats` |
| `earnings.monthly_accounts` | `/account/wallets/earnings/monthlystats/accounts` | `correlationAccountId`, `after`, `before` | `fan_earnings_monthly` |
| `transactions.page` | `/account/wallets/earnings/transactions` | `limit`, `offset`; date bounds не отправляются | `earnings_transactions` |
| `trackinglinks` | `/trackinglinks` | Без параметров кроме `ngsw-bypass` | `tracking_links` |
| `subscribers.page` | `/subscribers` | `offset`, `limit=100`, `status` | `subscribers` |
| `followers.page` | `/account/:accountId/followersnew` | `offset`, `limit=100` | `followers` |

Определения: [wallet specs](../../packages/fansly/src/wire/specs.ts#L290),
[audience specs](../../packages/fansly/src/wire/specs.ts#L381),
[stats/tracking specs](../../packages/fansly/src/wire/specs.ts#L573).
Account lookup использует `/account?ids=...` с максимумом 100 ID:
[lookup spec](../../packages/fansly/src/wire/specs.ts#L238).

## Streams, интервалы и полнота

| Legacy stream | Resource ID | Запросы и интервал |
|---|---|---|
| `stats_snapshot` | `stats.daily` | Раз в сутки: account daily trailing 30d, earnings trailing 30d, monthly earnings с 2015-01-01 до now, trackinglinks и прочие stats snapshots |
| `stats_snapshot` | `stats.hourly` | Account hourly trailing 25h; каждые 22h, верхний предел следующего interval 23h |
| `stats_snapshot` | `stats.backfill` | Owner-trigger: account daily по календарным месяцам, earnings окнами по 31d; исторический hourly не запрашивается |
| `media_stats` | `media-stats.walk` | Age до 30d: ежедневно, окно 31d; age до 90d: еженедельно, окно 30d; старше: ежемесячно, окно 90d либо три окна по 31d; везде daily buckets |
| `top_spenders` | `top-spenders.window` | Каждые 6h, trailing 7d |
| `top_spenders` | `top-spenders.bootstrap` | По UTC-месяцам с даты создания аккаунта |
| `fan_earnings` | `fan-earnings.roster` | Dirty, never-read, затем старые subjects; максимальный возраст roster read 156h; оба endpoint с `after=0,before=now` |
| `transactions` | `transactions.head/insurance/rescan/backfill` | WS-trigger head, страховочный poll 5min, rescan 1h, history backfill |
| `subscribers` | `subscribers.poll/history` | Poll 1h плюс WS triggers; history по просьбе владельца |
| `followers` / `followers_reconcile` | `followers.head/reconcile` | Head 1h; полный membership reconcile с минимальным интервалом сутки |

Источники: [stream mapping](../../apps/runtime/src/sync/fansly/registry.ts#L748),
[stats registry](../../apps/runtime/src/sync/fansly/registry.ts#L584),
[daily request builder](../../apps/runtime/src/sync/fansly/resources/stats.ts#L201),
[hourly spacing](../../apps/runtime/src/sync/fansly/resources/stats.ts#L374),
[media tier registry](../../apps/runtime/src/sync/fansly/registry.ts#L566),
[media spans](../../packages/db/src/repositories/fansly-engagement.ts#L856),
[top-spenders](../../apps/runtime/src/sync/fansly/resources/top-spenders.ts#L29),
[fan-earnings roster](../../apps/runtime/src/sync/fansly/resources/fan-earnings.ts#L24),
[transaction registry](../../apps/runtime/src/sync/fansly/registry.ts#L291),
[audience registry](../../apps/runtime/src/sync/fansly/registry.ts#L392).

Эти интервалы являются правилами кода. Overrides, очередь, page holds,
provider errors и owner work state могут менять фактическое время доставки;
таблица не является измерением текущей свежести продовых данных.

### Account history

У старого `/it/amoie/stats` произвольные historical date bounds не дали
ожидаемое окно в ранее зафиксированных измерениях, поэтому runtime запрашивает
историю по `year/month`. Это основание существующего алгоритма, а не повторная
проверка поведения Fansly на дату данного документа:
[stats-rules](../../apps/runtime/src/sync/fansly/lib/stats-rules.ts#L44).

Hourly исторически ограничен trailing 25h. Пропущенные промежутки получают
собственную coverage row с `reasonCode=hourly_capture_gap`, а latest steady
coverage заменяется, чтобы не склеить два раздельных окна:
[hourly apply](../../apps/runtime/src/sync/fansly/resources/stats.ts#L392).
Backfill явно сообщает `hourly_trailing_window_only`:
[backfill decision](../../apps/runtime/src/sync/fansly/resources/stats.ts#L655).

### Media scope

Очередь `media_stats` принимает только собственные media, увиденные через
`post` или `stats_agg`; неизвестный owner допускается. DM-only и vault-only
наблюдение сами по себе media stats не запускают:
[queue origins и owner predicate](../../packages/db/src/repositories/media-plane.ts#L109).

Account topMedia/topFypMedia/topFypTags канонизация ограничивает `slice(0,50)`;
дальнейшего обхода ranking pages в этом коде нет:
[windowTopDrafts](../../apps/runtime/src/services/canonicalize/fansly-stats.ts#L295).
Media history после двух пустых окон использует first-month probe. Код прямо
называет это эвристикой: пустой первый месяц не доказывает, что позже не было
трафика, например при публикации давно созданного vault item:
[mediaBackfillFirstMonthProbe](../../apps/runtime/src/sync/fansly/lib/media-stats-rules.ts#L217).

### Earnings completeness

Общий `/account/wallets/earnings/stats` запрашивается с `limit=100`. При полной
странице Hub делит окно по UTC-дням, не применяет offset, продолжает до
коротких частей и сохраняет pending state. Полный однодневный ответ становится
`saturated_day`, ответ вне заданных bounds - `window_not_honoured`:
[earnings-window](../../apps/runtime/src/sync/fansly/lib/earnings-window.ts#L1).
Оба случая пишут partial coverage:
[daily earnings apply](../../apps/runtime/src/sync/fansly/resources/stats.ts#L290).

Per-fan `/stats/accounts` имеет другое покрытие: runtime делает один запрос
за всё время. Canonicalizer прямо описывает возможное усечение lifetime на
100 строках; board выводит lifetime из monthly rows. Нельзя переносить
гарантии общего window splitter на per-fan route:
[fan request](../../apps/runtime/src/sync/fansly/resources/fan-earnings.ts#L91),
[fan earnings canonicalizer](../../apps/runtime/src/services/canonicalize/fansly-earnings.ts#L26).

`earnings.accounts` делит полные 100-row windows month -> week -> day;
полный день сохраняется как truncated. Его writer напрямую обновляет
`page_fan_identities`, без canonical domain events этого ответа:
[top-spenders writer](../../apps/runtime/src/sync/fansly/resources/top-spenders.ts#L29).
Raw-only в [observation registry](../../apps/runtime/src/services/observation-kinds.ts#L470)
означает отсутствие canonical projection, а не отсутствие любых hot-table
side effects.

## Дополнительные маршруты вкладок

### Audience Discovery и tracking links

`GET /trackinglinks` уже входит в `stats.daily`. Hub сохраняет daily snapshot
каждой ссылки: `clicks`, `claims`, `follows`, `subscriptions`, `totalGross`,
`totalNet` и metadata. `totalNet=0` в старой форме трактуется как
неподтверждённый net counter: typed net становится null, wire value остаётся
в `totalNetServed`:
[trackingLinkDrafts](../../apps/runtime/src/services/canonicalize/fansly-stats.ts#L705).

Новая Discovery UI также вызывает:

| GET-путь | Query, установленный исследованием UI | Hub |
|---|---|---|
| `/trackinglinks/stats` | `trackingLinkId`, `before`, `after` | Wire/resource/kind отсутствуют |
| `/trackinglinks/revenuestats` | `trackingLinkId`, `before`, `after` | Wire/resource/kind отсутствуют |

Точный поиск обоих путей в implementation trees дал ноль совпадений.
Существующий `trackinglinks` spec использует `noQuery`, а typed stats specs
не принимают tracking link selector:
[wire specs](../../packages/fansly/src/wire/specs.ts#L591).
Ежедневные cumulative snapshots ссылки не заменяют provider date-window
series, сравнение current/previous periods и link-scoped revenue breakdown.

### Earnings: wallet и Recent Purchases

UI Recent Purchases использует тот же `/account/wallets/earnings/transactions`,
который Hub собирает через `transactions.page`. Наблюдённая форма UI:
`before=&after=&limit=5&offset=0`. Hub отправляет только `limit` и `offset`:
[transactions spec](../../packages/fansly/src/wire/specs.ts#L290).
Пустые date parameters UI и непустые date bounds нельзя смешивать: комментарий
wire spec запрещает последние, поскольку они нарушали согласованность
`total` и rows. Здесь есть пересечение по endpoint, но не тождество формы запроса.

`GET /account/wallets/earnings` присутствует в route policy только как
`earnings.overview` в `LEGACY_ONLY_ROUTES`. Для него `wire:null`, нет активного
resource и соответствующего writer в observation registry этой ревизии:
[legacy route](../../apps/runtime/src/sync/fansly/routes.ts#L28),
[catalog construction](../../apps/runtime/src/sync/fansly/routes.ts#L170).
Наличие имени в quota/accounting catalogue не означает действующий сбор
wallet overview.

### Earnings: персональная история покупателя

Supporter modal использует дополнительный
`GET /account/wallets/earnings/transactions/accounts`. Его query содержит
`correlationAccountId`, `before`, `after`, `cursor`, `limit` и необязательный
`overwriteAccountId`; ответ имеет `data[]`, `hasMore`, `nextCursor` и
`aggregationData`. В отличие от account-wide Recent Purchases, этот caller
передаёт выбранный диапазон, заканчивая его следующим UTC-днём, и читает
историю cursor-страницами. Живой контракт и две проверенные страницы описаны
в [WX03](endpoints.md#wallet-reads).

Точный поиск полного пути в `apps`, `packages` и прежнем
`reference/fansly_api_spec.md` не дал совпадений. Этот маршрут не включён
в wire catalogue и не имеет собственного resource writer, observation kind
или специализированной проекции в исследованной ревизии. Близкие имена
обозначают другие контракты:

- [transactions.page](../../packages/fansly/src/wire/specs.ts#L290) читает
  общий `/earnings/transactions` через `limit/offset`, без fan selector.
- [earnings.accounts](../../packages/fansly/src/wire/specs.ts#L302) читает
  `/earnings/accounts`, то есть агрегаты покупателей, а не их транзакции.
- [earnings.stats_accounts и earnings.monthly_accounts](../../packages/fansly/src/wire/specs.ts#L312)
  читают per-fan day/month aggregates; они не принимают `cursor` и не
  реализуют новый transaction-detail response.

Уже захваченная общая транзакция может пересекаться с записью WX03, но
это не доказывает покрытие endpoint, его metadata или полноту персональной
истории. Будущее подключение должно сохранять самостоятельное provenance
и проверять согласование transaction IDs с существующим ledger, чтобы
не учитывать одну покупку как второй доход.

## Capture, ledger и typed data

Текущая цепочка stats capture:

```text
resource request -> wire GET через page proxy
  -> tx2: observations + sync_attempts
  -> tx3: resource.apply + canonicalization + cursor/attempt settlement
  -> domain_events
  -> fansly_stats projector
  -> typed Hub read API
```

Tx2 сохраняет `source=pull`, `producer=fansly-sync:<resource>`, kind, payload,
SHA-256 и idempotency по attempt. Tx3 после рестарта повторно читает journal,
а не отправляет HTTP:
[capture](../../apps/runtime/src/sync/engine/commit.ts#L935),
[apply](../../apps/runtime/src/sync/engine/commit.ts#L1518).
Inline canonicalizer и minutely backstop используют один pure mapper:
[canonicalize](../../apps/runtime/src/sync/engine/canonicalize.ts#L1).

Статистические response bodies передаются в journal целиком, за вычетом
подписанных CDN-токенов и нормализации непарных UTF-16 surrogates:
[capture codec](../../apps/runtime/src/sync/fansly/capture.ts#L148).
Новые поля старого ответа могут таким образом сохраниться raw-only. Это не
позволяет захватить ответ нового URL, который никто не запросил.

| Событие | Основные таблицы |
|---|---|
| `traffic.datapoint_observed` | `stats_traffic_buckets` |
| `media_traffic.datapoint_observed` | `stats_traffic_buckets` |
| `stats.window_top_observed` | `stats_top_media`, `stats_top_tags` |
| `media_tag.stats_observed` | `fansly_media_tag_stats` |
| `tag.counters_observed` | `platform_tag_daily` |
| `earnings.breakdown_observed` | `revenue_mix_daily` |
| `earnings.month_observed` | `revenue_month_totals` |
| `fan.earnings_observed` | `fan_earnings_stats` |
| `tracking_link.snapshot_observed` | `page_promo_links` |

Источники: [stats projector](../../apps/runtime/src/services/projections/fansly-stats.ts#L46),
[fan earnings projector](../../apps/runtime/src/services/projections/fan-earnings.ts#L1).
Account aggregation sidecars также создают media, sale-stats и offer-location
events: [accountStatsDrafts](../../apps/runtime/src/services/canonicalize/fansly-stats.ts#L457).

Generic client ingest может сохранить неизвестный kind как
`desktop.unknown:<kind>`, но такой материал не получает доверенную account
statistics projection и не запускает upstream collector:
[ingestKindFor](../../apps/runtime/src/services/ingest-observations.ts#L83),
[client capture family](../../apps/runtime/src/services/canonicalize/client-capture.ts#L29).

## Единицы и измерения

Существующая money model: BIGINT mills, то есть $0.001. Gross и net earnings
сохраняются раздельно, а decimal strings используются в JSON events.
`interactionTime`/`previewInteractionTime` сохраняются как миллисекунды;
`totalVideoPercentWatched` хранится как суммарная fraction, не как готовый
средний процент. Отсутствующая метрика остаётся null. Provider time находится
в `data`, event occurredAt равен receipt time:
[canonicalizer rules](../../apps/runtime/src/services/canonicalize/fansly-stats.ts#L9),
[traffic fields](../../apps/runtime/src/services/canonicalize/fansly-stats.ts#L246),
[earnings fields](../../apps/runtime/src/services/canonicalize/fansly-stats.ts#L610).

Старые media source codes: `0=fyp`, `1=direct`. Старые profile families:
`10000=direct_timeline`, `44000=fyp_promotion`, `44010=suggestions`,
`44030=search`; member 1 означает visits, member 0 означает только
dwell-bearing series. Значение even-member view counters не доказано:
[label map](../../packages/shared/src/fansly-stat-types.ts#L10).

Новая UI использует string families `views/profile/follows/subscriptions/revenue`,
granularity `day/hour`, surfaces `0/1/4` и `-1` в all-detail, а source enums
включают также `2/3`. Это отдельные axes нового API. Их нельзя автоматически
перевести в прежний `source_code` или перенести старые labels только из-за
совпадения целых чисел. Точные значения новых кодов должны браться из
проверенной основной карты, не выводиться из этого Hub-аудита.

Текущий ключ traffic bucket:
`(page_id, subject_kind, subject_ref, period_ms, bucket_start, source_code)`.
Отдельного места в ключе для новых surface, family и других selectors нет:
[traffic upsert](../../packages/db/src/repositories/fansly-stats.ts#L108).
Следовательно, простое повторное использование старого события без явной
модели новых dimensions не доказывает отсутствие collisions.

## Хранение и доступность истории

Captured facts не удаляются по расписанию. Nightly cleanup сохраняет своё
историческое имя, но больше не удаляет raw payloads; retention telemetry
не трогает `observations`:
[worker cleanup](../../apps/runtime/src/worker-services.ts#L295),
[engine telemetry retention](../../packages/db/src/repositories/sync/retention.ts#L14).

Это правило хранения уже захваченных фактов. Оно не обещает, что provider
позволяет получить любую старую granular series, что backfill запущен,
что его эвристические stop laws исчерпали всю историю или что collector
вообще знает новый endpoint.

Coverage planes для прежних данных:
`stats_account_daily`, `stats_account_hourly`, `stats_earnings`, `media_stats`.
Их mapping на Hub panels не описывает новые families/filters автоматически:
[capture coverage](../../packages/shared/src/capture-coverage.ts#L1).

Hub endpoints `/stats/traffic`, `/stats/media`, `/stats/tags`, `/stats/coverage`,
`/content/media`, `/money/revenue-mix` читают projections. Они не стартуют
capture и не устраняют недостающий backfill при чтении:
[insights serving contract](../../apps/runtime/src/modules/insights/index.ts#L70).

## Граница будущего подключения

Для полной интеграции новой статистики требуется отдельно подтвердить и
подключить следующие части; это требования к последующей реализации,
не изменения данного документа:

1. Все 12 `/account/stats/*` плюс два link-scoped stats routes: wire contract,
   resource writer, наблюдаемое окно/subject и честные stop laws.
2. Новые observation kinds и shape gates либо явно доказанная совместимость
   со старой формой. Сырые ответы должны оставаться replayable до парсинга.
3. Ключи фактов с полным набором dimensions, raw enum values, явными единицами
   и provider/receipt time; сверка old/new значений только на одинаковом scope.
4. Coverage по family/surface/filter/window и данным, которые provider реально
   отдал. Малый ответ, top-N и heuristic probe не считать полной историей.
5. Projection/read contracts для тех данных, которых сейчас нет: новые
   summaries, benchmarks, geo, activehours, media/posts/fans response shapes,
   tracking date-window series и wallet overview.

Старая [Fansly API spec](../fansly_api_spec.md#L867) полезна как исторический
справочник, но не является независимым подтверждением новых контрактов.
Например, она всё ещё допускает date bounds для transactions, тогда как
исполняемый [wire spec](../../packages/fansly/src/wire/specs.ts#L297)
намеренно их не отправляет.
