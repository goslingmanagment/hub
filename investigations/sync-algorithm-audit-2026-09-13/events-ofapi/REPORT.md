# OFAPI and event-pipeline audit

Дата: 2026-09-13. Проверен checkout `b48f173d93e3693550e2db139de3b11107d44ce2`. Root сообщил production revision `4310680dc2f923955295f85491eb6cf43d9bb82a`; выполнено сравнение исходников этих ревизий. Production DB и vendor API этим ревьюером не вызывались. Product code не изменён, Vitest не запускался.

## Вывод и область применимости

В проверенном современном пути OFAPI capture → strict parse → material events → archive → certified read подтверждён правильный базовый порядок записи и несколько важных защит. **В этой части аудита не воспроизведён новый дефект P1 текущего mirror.** Это ограниченный результат проверки, а не доказательство отсутствия ошибок во всех комбинациях сбоев.

Найдены актуальные расхождения смежных путей: устаревший subscriber snapshot может перезаписать более новое lifecycle-событие; действующие list collectors не полностью соблюдают capture-before-parse; старый pull-parser при replay расходится с operational-parser по направлению DM. Отдельно установлен воспроизводимый дефект давно отключённого crawler: он **не включается в число live bugs**.

## Достижимость путей

| Путь | Статус в исходниках | Где доказано |
|---|---|---|
| Современный OFAPI `ofapi_capture` | Intent-driven jobs; включение отдельно регулируется политикой/flags | `apps/runtime/src/services/ofapi-capture-jobs.ts:1444-1512` |
| Legacy `executeOfapiDmMessagesChunk` | Выведен из runtime dispatcher; символ остался для тестов | `apps/runtime/src/services/sync/executor-handlers.ts:2617-2630` |
| Legacy `dm_conversations` | Остался условно доступен при OFAPI mapping/flag; planner дополнительно регулирует polling | `apps/runtime/src/services/sync/executor-handlers.ts:2595-2608`, `apps/runtime/src/services/sync/planner.ts:58-67` |
| OFAPI subscribers/audience | Действующий handler, eligibility gate | `apps/runtime/src/services/sync/executor-handlers.ts:1368-1378` |
| OFAPI transaction REST backfill | Ручная CLI-операция, не фоновый transactions stream | `apps/runtime/src/cli.ts:2501`, `apps/runtime/src/services/sync/executor-handlers.ts:1356` |
| `sync-pull` OnlyFans DM parser | Действующий canonicalizer для сохранённых `source=pull, kind=dm_messages` | `apps/runtime/src/services/canonicalize/index.ts:187-198`, `apps/runtime/src/services/canonicalize/sync-pull.ts:227-238` |

Фактические production flags для конкретных страниц этим ревьюером не проверены.

## Актуальные замечания

### O1 — P2: audience snapshot может откатить lifecycle-состояние подписки

**Уверенность:** подтверждено чтением полного write path; SQL/concurrency reproduction не выполнен.

`executeOfapiAudienceChunk` получает страницу до транзакции, затем формирует `canonicalStatus: active` и `sourceUpdatedAt: fan.renewedAt ?? fan.subscribeAt` (`apps/runtime/src/services/sync/ofapi-audience-sync.ts:396-407,456-470,548-576`). `upsertPageSubscriptions` без условного time-fence перезаписывает `canonicalStatus`, `sourceUpdatedAt`, `isCurrent` (`packages/db/src/repositories/fans.ts:977-1018`).

Встречный webhook writer уже проверяет более новое существующее состояние и передаёт `lifecycleEvidenceAt` (`apps/runtime/src/services/ofapi-subscription-projection.ts:190-224`). Получается асимметрия: stale webhook отвергается, stale REST page принимается.

Контрпример: REST запрос начат, получил ещё active; пока ответ обрабатывается, `subscriptions.expired` записал expired с новым provider timestamp. Затем audience transaction вставляет старый active с датой старого subscribe/renew. Блокировка строки лишь последовательно выполняет обе операции, но не сравнивает свежесть источников. Subscriber state/count показывают active до следующей исправляющей сверки.

**Исправление:** сохранять время получения REST-ответа и сравнивать его с lifecycle clock; при конфликте не откатывать lifecycle поля, но разрешать безопасное обновление generation/presence. Нельзя просто сравнить renewedAt с expiredAt для всех snapshot-полей: дата обновления lifecycle и момент наблюдения snapshot имеют разные значения. Нужен явный контракт precedence и field ownership.

**Проверка:** блокировать fake REST response, применить expiry webhook, отпустить старую страницу, проверить `is_current=false`, nondecreasing lifecycle clock и неизменный subscriber count; зеркальный тест для renewal и arrival-order permutation.

### O2 — P2: capture-first не охватывает все действующие list/read collectors

**Уверенность:** подтверждено write/control-path; не утверждается потеря конкретных production ответов.

`observedListRequest` сначала читает response text (`apps/runtime/src/services/ofapi.ts:1041`), парсит JSON (`:1084-1089`) и вызывает `toListPage` (`:1165`); только после успешного возврата вызывающий audience сохраняет raw/observation (`ofapi-audience-sync.ts:456-478`). На 200 response с новой/ошибочной list-shape mapper бросает ошибку до capture. Сохраняется телеметрия/финансовое receipt, но полный payload ответа не предоставляется sync-capture. `OfapiCreditSpendObservation` несёт accounting evidence, а не список транзакций/фанов (`ofapi.ts:920-935`).

Ручной `fetchBackfillRows` ещё уже: `listTransactions` → normalize в памяти → `writeBackfillRows`; на этом пути вообще нет вызова `persistRawPayload` или insertObservation (`apps/runtime/src/services/ofapi-transactions-backfill.ts:507-552,645-778`). Нормализованные строки и неизвестные/пропущенные поля не заменяют сохранённый ответ. Это важно при исправлении mapper и расхождениях финансов.

Современный mirror этого дефекта не имеет: `captureOfapiAttemptResponse` сохраняет bytes до `parseOfapiJsonBytes` (`ofapi-capture-jobs.ts:1497-1534`).

**Исправление:** провести оставшиеся list collectors через тот же raw receipt/capture seam до shape parsing; raw envelope должен включать body bytes, headers/status, account binding и request cursor. Normalize и projection должны ссылаться на observation id. Сначала перенос транспорта/capture, затем replay/adoption, без повторной оплаты уже сохранённых ответов.

**Проверка:** валидный 200 с неизвестной shape, non-JSON 200, valid page с unparseable item, сбой после capture и до parse, ручной transaction backfill с неизвестным type; во всех случаях response восстановим из journal без нового HTTP.

### O3 — P2, retained-history/replay: два OFAPI DM parser дают разные идентичности

**Уверенность:** воспроизведено исполнением настоящих parser-функций, `reproduction.json`.

При `isSentByMe` отсутствует, `fromUser.id=999`, известный fan/chat `42`:

- operational `parseOfapiRestMessage(item,'42')` определяет `senderRole=model` (`apps/runtime/src/services/sync/ofapi-dm-sync.ts:461-469`);
- действующий canonicalizer трактует тот же item как `message.received`, `conversationRef=999` (`apps/runtime/src/services/canonicalize/sync-pull.ts:143-160`);
- при явном `isSentByMe=true` canonicalizer записывает `conversationRef=null`, хотя исходный raw `requestParams` содержал conversationId (`ofapi-dm-sync.ts:1148-1153`). Observation payload сохраняет только `{items}`, request context теряется до canonicalizer.

Первая запись владеет `msg:<direction>:<id>` dedup key. Просто bump parser не исправит существующий event с таким же ключом. Cold/archive corrections могут помочь конкретным material heads, но это не универсальная гарантия: для first-event reconciler dedup outcome он отмечает fingerprint эмитированным без проверки равенства уже существующего event его материалу (`apps/runtime/src/services/dm-corrections-reconciler.ts:244-252`).

**Область:** legacy retained `pull/dm_messages`; новый mirror использует strict parser и обязательный boolean direction, а chat берётся из captured request. Нельзя переносить finding на новые mirror pages.

**Исправление:** отдельный scoped repair сохранённых наблюдений с доступным request lineage; material/superseding event для исправления существующей проекции, без изменения immutable canonical keys. В общем parser contract unknown direction нельзя приравнивать к received. Для потерянной lineage — честный unresolved status.

**Проверка:** REST-first/webhook-first permutations, отсутствующий `isSentByMe`, sent-only история без webhook, повторный replay, late material correction. Проверить не только количество событий, но и conversation/fan refs и получившийся transcript.

## Что проверено как корректное в современном mirror

1. **Capture до parse.** Сырые bytes передаются `captureOfapiAttemptResponse` с attempt/fence identity; DB capture retry повторяет только commit уже полученных bytes, затем идёт parsing (`ofapi-capture-jobs.ts:1497-1534`). Это не новая отправка vendor request.
2. **Malformed item не объявляет EOF.** `parseStrictOfapiMessagePage` требует явной pagination, boolean direction и даты; любой invalid item отклоняет всю страницу. `hasNextPage` без progress тоже отклоняется (`ofapi-capture-contract.ts:343-359,369-428,466-474`). Положительная проверка есть в reproduction.
3. **Cursor semantics не предполагаются навсегда inclusive.** По captured page определяется inclusive/exclusive, изменение внутри цепи блокируется; для exclusive проверяется, что id меньше boundary (`ofapi-capture-contract.ts:430-463`).
4. **Материал до progress/coverage.** Job сначала append'ит message material и stamp, потом settle'ит progress/terminal proof; на append failure становится parser_failed (`ofapi-capture-jobs.ts:995-1033,1105-1144,1165-1191`). Повтор commit после crash защищён dedup.
5. **Anchor — это доказанный предыдущий диапазон.** Нельзя завершить на произвольном совпавшем id: запрашивается composable coverage proof и оно связано с terminal settlement (`ofapi-capture-jobs.ts:1059-1087,1118-1126`).
6. **Proof не означает готовность serving.** Проверяются актуальный head, proof policy, requested range и archive watermark (`packages/db/src/repositories/ofapi-message-coverage.ts:634-664`). Certified read выполняется в repeatable-read snapshot, требует существующий boundary, убирает его из exclusive ответа, проверяет material и не выдаёт media без live source; false EOF проверяется отдельно (`packages/db/src/repositories/ofapi-certified-history.ts:83-99,155-205,225-243`).
7. **Seq/dedup атомарны.** Per-account counter lock, claim и insert находятся в транзакции. Mixed batches пишут deliverables → hidden block → checkpoint; конфликт checkpoint при новых hidden events вызывает rollback (`packages/db/src/repositories/domain-events.ts:281-296,366-417,424-454`). Crash между append и parse stamp приводит к повторному чтению и dedup, а не к пропущенному событию.
8. **Observation key содержит syncRunId.** Подозрение на collision из-за reset fetchSeq между chunks снято: key включает runId (`apps/runtime/src/services/sync/shared.ts:185-190`). Достаточность уникальности runId проверяет root в executor.

## Оптимизация

### Первоочередно: ограничить одну projection, а не только весь registry

В HEAD `runProjectionTick` проверяет wall time только между projection callbacks (`apps/runtime/src/services/projections/registry.ts:635-649`). `runMessageArchiveProjection` может неограниченно читать pages по всем accounts (`apps/runtime/src/services/projections/message-archive.ts:85-131`). Один большой backlog съедает timeout прежде, чем registry сможет сменить очередь. Rotation сохранена в process memory; перезапуск возвращает к началу.

Передавать общий deadline в каждый projector, проверять его между event pages, сохранять continuation/account rotation в DB; ключевой критерий — ни один большой account не лишает остальных одного bounded шага. Root измеряет актуальные production durations отдельно.

### Снизить scan amplification

Каждый projector перечитывает все event types и фильтрует в JS (`message-archive.ts:100-107`; событие с полным JSON материализуется даже если тип чужой). Registry уже объявляет `eventTypes`; использовать их для SQL read с high-water snapshot и watermark advancement по проверенному диапазону. Нельзя просто перейти на filtered MAX(seq) и потерять доказательство gap topology. Оценивать rows read/applied и bytes read/applied, а не только wall time.

### Уменьшить число round trips для event batches

`appendDomainEvents` выполняет allocation + key claim + insert по одному event; duplicates добавляют lookup (`domain-events.ts:366-415`). Сохранить тот же per-account lock/ordering, но резервировать IDs и claim keys пачкой, назначать seq только принятым keys. Требуются те же concurrent overlap/crash proofs; результат обязан сохранить per-input outcome и atomic checkpoint.

### Не повторять исправления, уже находящиеся в production revision

Сравнение `4310680d → b48f173d` показало, что production вариант `canonicalize-driver.ts` уже содержит: parse-once; bounded batch payload read для unmapped webhook rows; `atLeastParseVersion>=1` для replay half-pass; возврат unused page allowance первому pass. В checkout эти изменения отсутствуют. По этим пунктам правильное действие — проверить lineage веток и вернуть/согласовать существующий patch, а не заводить дублирующее исправление. Новый mirror material/capture/serving файлы между указанными ревизиями не отличаются.

## Dormant appendix: воспроизведённый дефект старого crawler

`executeOfapiDmMessagesChunk` при странице `hasNextPage=true`, valid message id и invalid createdAt:

1. Сохраняет raw page.
2. Пропускает непарсящийся item (`ofapi-dm-sync.ts:1170-1179`).
3. Из пустого `pageMessageIds` получает `!oldestMessageId`, объявляет `providerHistoryExhausted` (`:1212-1218`).
4. Финализирует `complete`, записав 0 messages, и возвращает `satisfied=true` (`:496-497,1224-1246`). После lastMessageSyncAt update candidate predicate больше не предлагает чат (`packages/db/src/repositories/page-dm.ts:1095-1100,1151-1157`).

`reproduce.mjs` исполняет **реальную функцию из checkout**, удаляя только imports перед TypeScript transpile и подставляя fake DB/transport dependencies. Выход: `processedMessages=0`, `completedConversations=1`, `complete`, `satisfied=true`. Никаких DB/HTTP запросов. Это доказательство ошибки dormant implementation, **не неисправности текущего mirror**. Восстанавливать этот crawler в качестве rollback нельзя; предпочтительно удалить его callable surface после проверки внешних consumers.

## Проверки и ограничения

Выполнено: source/decision/stage review; точное сравнение HEAD/сообщённой root production revision; standalone actual-parser и actual-executor fake-dependency reproduction; проверка reachability. Команда: `node --import tsx/esm investigations/sync-algorithm-audit-2026-09-13/events-ofapi/reproduce.mjs`. Exit 0; JSON сохранён рядом.

Не выполнено этим ревьюером: production row census, vendor probes, Testcontainers, full property test state machines, fault injection на реальном Postgres для O1/O2. O1/O2 не выдаются за наблюдавшиеся production инциденты. Ошибки старого crawler не включать в текущий P1 bug count.
