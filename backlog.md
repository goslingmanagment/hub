# Backlog — только живая работа

Здесь нет истории и уже закрытых задач: подробности живут в Git и релевантных
decisions.

## P1

- **UV-001 — reset/login race.** Login может проверить старый hash и создать
  сессию после reset. Закрыть общим user-lock/epoch и concurrent regression.
- **UV-003 — erasure между страницами snapshot.** Исчезнувший thread молча
  пропускается, поэтому клиент может сохранить уже стёртый текст. Закрыть
  topology/erasure generation и `409 restart-required` с end-to-end тестом.
- **UV-004 — contract freshness не входит в production build.** Прямой Docker
  или dist-only build принимает устаревшие OpenAPI/SDK/hash. Закрыть
  non-mutating `contracts:check` внутри `build:production`.
- **INC-001 / UV-010 — PPV poison-loop.** Suppressed PPV двигает только
  in-memory watermark; перед close может не уйти новый cursor. Нужны ignored
  checkpoint, historical repair, snapshot coverage и fleet acceptance перед
  снятием `SUPPRESSED_V2_FRAME_TYPES` (история: #155).

## Перед необратимыми или отдельными gates

- **UV-011 — lifecycle receipt schema.** До первого `desktop-lifecycle-v2`
  enable проверять не counts, а полные Extension/Desktop schemas, timestamps,
  persona id/name/content и mapping keys/targets; добавить negative fixtures.
- **UV-012 — lifecycle restore path.** Ошибка final inventory после sync
  release-файлов должна идти через `fail_after_release_sync`; нужен executable
  failure-path test.
- **UV-013 — first-enable tooling.** `gh`/`unzip` требуются безусловно; перенести
  проверки внутрь absent→present ветки и покрыть четыре transitions.
- **UV-014 — lifecycle ZIP.** Ограничить download, проверить digest до parsing,
  затем ограничить число entries и общий uncompressed size.
- **UV-007 — detached observation dedup.** До первого detach перенести старые
  machine-key aliases в `observation_keys`, иначе raw observation дублируется.
- **UV-009 — persona mutation switch.** До owner-write cutover убрать две
  независимые константы API/dashboard или закрепить их единым capability pin.
- **ER-001 — fan erasure.** Любой будущий execute остаётся запрещён до закрытия
  #129/W6 и трёх gaps: `partner_platform_user_id`, identity-resolution race и
  residual warning для несвязуемых restricted generations.

## P2

- **UV-005 — persona prompt view.** Owner видит `systemBlock` только в
  выключенном edit modal; нужен всегда доступный read-only details view.
- **UV-006 — незадекларированные 503.** Добавить `503: errorResponseSchema` к
  `eventsStream`, `eventsV2Stream`, `eventsV2Snapshot` и регенерировать contract.
- **UV-015 — owner device-token SSE scope.** Отдельно от Agent Read Plane:
  clamp non-session principals одновременно с совместимым релизом of-desktop.
- **UV-008 — два migration parsers.** Testcontainers и production должны
  использовать один parser/executor seam.
- **SDK v2 control lane.** Когда появится второй SDK consumer, типизировать
  `event: control`/`replay_completed` и добавить recovery disconnect test.
- **LINK-001 — duplicate OFAPI link discovery.** `fan_identities` повторно
  обходит tracking/trial lists, уже сохранённые link-stats reconcile. Перейти на
  последний complete run после определения допустимой staleness.
- **COACH-001 — history eviction audit.** Prompt builder считает вытесненные
  coach exchanges, но restricted generation не сохраняет этот итог в
  `contextManifest`; добавить post-budget manifest field.

## Fansly: реальные пробелы данных

- **FEAT-004 — Fansly chargebacks.** Refund lane отсутствует; транзакции могут
  навсегда остаться `posted`. Нужны capture-first lane, projection и money tests.
- **BL-D-2 — история подписок.** `subscription.observed` есть только в ledger;
  для интервалов нужна отдельная historical projection, не live generation.
- **Daily identity totals.** `account_me` totals есть в `domain_events`, но дни
  без новых followers не представлены; нужна `page_identity_daily`.
- **Capture debt.** `dm_conversations.content` и полнота `followers` режутся до
  журнала в `sync/shared.ts`; capture-first надо восстановить в writer seam.

## Agent Read Plane — bounded fixes

- **BL-A1:** outbound archive rows получают fan id в `sender_hint`.
- **BL-A2:** cross-store tombstone без своего timestamp выглядит как 1970.
- **BL-A3:** transcript count probe зажат внутренним лимитом 1500 вместо 5001.
- **BL-A4:** contract принимает secondary sort, reader использует только primary.
- **BL-A5:** dataset filters сравнивают значения через `::text` без type coercion.
- **BL-A6:** page-scoped одинаковые aliases схлопываются через `distinct on`.
- **BL-A7:** `subscription.ended` датируется creation, а не `ends_at`.
- **BL-A9:** server может выпустить cursor длиннее собственного лимита 2048.
- **BL-A12:** coverage делает correlated floor lookup до keyset/limit.
- **BL-A13:** journal floor сортирует по неиндексируемому `to_char(payload)` и
  может уронить весь ответ вместо деградации источника.

- **BL-A-1:** thread summaries синтезируют visibility/breaker/retention из
  непрочитанного spend state.
- **BL-A-2:** `follow.ended` датируется `followed_at`, а не деактивацией.
- **BL-A-3:** transcript direction buckets пересекаются на unknown/system rows.
- **BL-A-4:** все planned datasets объявлены `captured_unparsed`, даже когда
  факты не захватываются.
- **BL-A-5:** cursor `resource` ограничен 200 при валидном ref до 500.
- **BL-A-6:** response-level field states не учитывают effective platform filter.
- **BL-A-7:** resolver cap общий для всех inputs, а не per-input.
- **BL-A-8:** snippet центрируется по сырому query, а не найденной лексеме.
- **BL-A-9:** media reader игнорирует канонический `durationSeconds`.

### Hydration

- **BL-C1:** approval queue честно сообщает cap, но не имеет keyset pagination.
- **BL-C2:** fixed-prefix reconciliation scans могут навсегда не дойти до более
  поздней terminal/expirable строки; нужен приоритет или cursor walk.
