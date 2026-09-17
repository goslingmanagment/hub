# 03 — Capture storage: две подтверждённые возможности

Дата: 2026-09-13. Scope: raw/CAS capture, codec, payload reader, удержание тел при восстановлении. Анализ и локальные probes; продуктовые файлы, БД, конфигурация и production не изменялись.

| Приоритет | Возможность | Подтверждённый выигрыш | Граница вывода |
|---|---|---|---|
| P2, сначала | CAP03-1: встроенный string encoder внутри frozen canonical codec | На Mac/Node 26 синтетический DM codec 0,449 → 0,114 мс; catalog 2,553 → 1,286 мс. 86 807 byte-parity cases и 11 invalid-type cases | Это CPU/allocations отдельной функции. Скорость всего worker и Node 22 не измерены |
| P2 | CAP03-2: после классификации purchase capture хранить только descriptor, затем читать через ограниченное окно | 1 009 reachable raw bodies → 0 в возвращённом индексе; его сериализованный размер 4 548 662 → 348 121 байт, контрольный результат одинаков | Это углубление известного lifetime reread. Только первый шаг уже проверен probe; bounded reader пока дизайн |

Не включены в экономию: уже развёрнутый webhook batch reader, обычный CAS dedup и pointer-only, смена компрессии, потенциальный перенос equality в PostgreSQL без DB-профиля.

## Проверенная база и достижимость

HEAD: `b48f173d93e3693550e2db139de3b11107d44ce2`. Предоставленный root снимок трёх production containers указывает `74aac5093cfc`, а не старую `4310680d`. Перед завершением файл перечитан. Подтверждение исходников через `git show` и SHA-256 находится в [revision-evidence.txt](./revision-evidence.txt).

`capture-payload-codec.ts`, `capture-cas-dual-write.ts`, `sync/shared.ts` и `sync/fansly-purchase-history.ts` побайтно одинаковы на HEAD и production. В `payload-reader.ts`, `capture-payloads.ts`, `sync.ts`, `executor-handlers.ts` есть другие production-изменения; исследованные пути сверены отдельно. Номера ниже относятся к HEAD, если явно не указано production.

Изучены `CLAUDE.md`, quick reference решений #215–#223, Stage 7 observation journal, Stage 28 erasure и предыдущий sync audit. Старые storage-измерения использованы только как указатель на известные ловушки: WAL ≠ занятое место, pointer-only ≠ прекращение роста. Их численные значения не используются как текущие доказательства.

## CAP03-1. Убрать посимвольную сборку строк, сохранив каждый байт codec v1

**Реальный путь:** `persistRawPayload` → `putCaptureCasPayloads` → `putPayloadObject` → `prepareCapturePayload` → `canonicalizeCaptureJson`. При совпадении digest вызывается `bodyMatches`: тело читается из JSONB и снова канонизируется целиком. В режиме shadow read seam канонизирует обе копии ещё раз. Поэтому одна и та же ручная строковая петля платится несколько раз в разных местах; CAS экономит хранение, но не эту работу.

Точные места:

- `apps/runtime/src/services/sync/shared.ts:111`: вход CAS до envelope inserts; `:184` — отдельный observation hash; `:216` — ещё один stringify для byte telemetry.
- `apps/runtime/src/services/capture-cas-dual-write.ts:320`: canary gate; `:327`: put; `:339`: одна обычная ссылка object уже переиспользуется между raw и observation. Повторный put для этой пары не предлагается устранять: его уже нет.
- `packages/db/src/repositories/capture-payloads.ts:340`: canonicalize incoming; `:365`: identity candidates; `:368` и `:480`: полный read/compare сохранённого тела; `:493` — повторная canonicalization.
- `packages/db/src/capture-payload-codec.ts:86`: массив parts → join → UTF-8 Buffer; `:225`: `encodeString` с `charCodeAt` и `out +=` на каждый code unit.
- `apps/runtime/src/services/payload-reader.ts:399`: shadow comparison; `:410`, `:417`: обе полные canonicalizations. В production те же ветви на `:406`, `:417`, `:424` соответственно.

**Минимальное изменение:** только тело `encodeString(value: string)` заменить на `return JSON.stringify(value)`. Сортировка ключей, обход массивов, запрет runtime wrappers/non-finite/cycles, правила undefined, digest prefix, версия и representations остаются прежними. Нельзя заменить весь canonicalizer на `JSON.stringify(object)`: порядок ключей и валидация перестанут соответствовать frozen v1.

Здесь предлагается эквивалентная реализация v1, а не новая каноническая форма. Если хотя бы один вход даст другие байты на целевом runtime, такой вариант нельзя выпускать под codec v1. На больших объектах сборка `parts` всё ещё существует: этот патч не обещает constant-memory serialization.

**Proof:** [codec-probe.mjs](./codec-probe.mjs) загружает фактический файл после проверки равенства production source, а второй модуль получает замену ровно одной функции. Проверены все 65 536 одиночных UTF-16 code units, valid/invalid surrogate contexts, 10 000 детерминированных вложенных объектов с Unicode keys/values, числа и undefined. Всего 86 807 byte cases; для 11 недопустимых входов совпали имя и текст ошибки. SHA-256 каждого benchmark output также одинаков.

Mac arm64, **Node v26.7.0**, 3 warmups, 15 замеров на вариант, отдельный процесс на fixture/вариант; [сырые результаты](./codec-probe-results.json):

| Синтетическое тело | Canonical bytes | Median до → после | Ratio | CPU за 15 вызовов до → после |
|---|---:|---:|---:|---:|
| 25 DM, текст и media URLs | 54 757 | 0,449 → 0,114 мс | 3,95× | 7,579 → 3,044 мс |
| 500 catalog entries, Unicode | 196 188 | 2,553 → 1,286 мс | 1,99× | 45,157 → 27,237 мс |
| Одна ASCII string, стрессовый случай | 1 125 011 | 22,751 → 0,210 мс | 108,38× | 460,095 → 4,272 мс |

Третий случай показывает форму деградации ручного concatenation; это не доказательство наличия таких тел в production. Process `maxRSS` в этом случае — 364 944 → 111 472 KiB; в catalog — 130 976 → 111 392 KiB. Это high-water всего отдельного процесса, включая загрузку модулей и warmup, а не точное количество аллокаций функции. 15 замеров недостаточно для стабильного production p95.

**Модель:** обозначим стоимость старого codec `C(B,K,S)` через объём, число ключей и суммарную длину строк; новый `C'`. Capture, создавший новый CAS object, экономит примерно `C−C'`. Обычный dedup hit дополнительно канонизирует сохранённую JSONB-копию и экономит примерно `2(C−C')`. Shadow read с двумя копиями тоже экономит до двух codec-вызовов. Число таких операций следует считать по реальным режимам; нельзя сложить их как будто каждый capture немедленно делает shadow read.

Если codec занимал долю `f` процессорного времени, whole-process bound — `1 / ((1−f)+f/s)`, где `s` — измеренное ускорение codec на подходящем распределении тел. При условных `f=0,1`, `s=4` это лишь 1,081×. Число SQL/HTTP, сетевые байты, TOAST объём, WAL и durable storage не меняются. RSS может снизиться из-за меньшего числа промежуточных строк; системный размер выигрыша не измерен.

**Режимы и инварианты:**

- CAS write выключен для страницы: на этом capture-path codec не вызывается, экономия от CAP03-1 здесь нулевая. Read seam использует название `inline`, не `off`.
- Dual-write/pointer-only активен: оптимизируется write codec независимо от read mode. `inline` для старой dual-copy строки не делает catalog compare.
- `shadow`: прежний octet comparison и прежние per-row counters; только более дешёвый encoder. `serve`: чтение JSONB обычно не канонизирует; не следует обещать ускорение обычного serve read от этого патча.
- Pointer-only всегда читает единственную CAS-копию даже при `inline`; этот закон не меняется.
- Сохраняются raw-before-parse, identity tuple/access class/account/month, collision ordinals и full-content compare, оба `FOR KEY SHARE` при envelope stamping (`capture-payloads.ts:597`, `observations.ts:206`, `sync.ts:913`) и erasure `FOR UPDATE` с отдельным свежим reference verdict (`capture-payload-erasure.ts:348`). Никаких изменений leases, account ordering, money, cursor, provider backoff или manual flags.

**Размер и выпуск:** S. Предложить exact codec golden/parity corpus на production Node 22, включая corpus исторических канонических digest, unpaired surrogates, C0, numeric edge cases, accessor/prototype rejection. Перед выпуском отдельно проверить, что transport/runtime не monkey-patch `JSON.stringify`. Canary: codec CPU/bytes и event-loop lag на единицу captured bytes, одинаковые digests/object hit rate, неизменные `codecRefused`, collision/parity/vanished counters. Production fast-path savings пока не замерены.

**Малый соседний резерв, без отдельной оценки:** `shared.ts:184` и `:216` stringify обычный один и тот же response object дважды даже при pointer-only. Можно один локально сериализованный snapshot использовать для observation hash и telemetry byte count; при quarantine payload они могут различаться. Не менять hash на CAS digest: у них разные контракты. Эта правка держит строку через await и может увеличить время её жизни, поэтому её не следует автоматически смешивать с CAP03-1.

## CAP03-2. Purchase recovery удерживает исторические тела после того, как они уже не нужны

**Связь с baseline:** не новая заявка «убрать lifetime scan». Предыдущий audit уже указал перечитывание истории и F4 — отсутствие refresh старого target. Новый результат здесь — доказанное удержание всех payload в конечном control index и минимальная граница shared reader, чтобы устранить burst без изменения истины о завершённости.

**Достижимость:** handler зарегистрирован в `apps/runtime/src/platforms/registry.ts:123`; выполняется на Fansly при `fanslyPurchaseHistorySyncEnabled` и page allowlist (`executor-handlers.ts:3336–3345`). Ручной scope `all` намеренно не запускает этот bulk lane (`registry.ts:66`). Значения текущих production flags агент не измерял. При выключенном lane системная экономия от этой идеи нулевая.

**Точный путь на HEAD / production:**

| Место | HEAD | Production 74aac |
|---|---:|---:|
| `packages/db/src/repositories/sync.ts`, список всех `purchase_history` captures страницы, без LIMIT | 595 | 611 |
| `apps/runtime/src/services/sync/executor-handlers.ts`, `Promise.all` + resolve каждого тела | 3407 | 3445 |
| `apps/runtime/src/services/sync/fansly-purchase-history.ts`, classification type включает исходный capture | 73 | 73 |
| Там же, возвраты `...capture`, сохраняя `responsePayload` | 509, 526, 544, 557 | те же |
| Там же, map всех классификаций и `captures: classified` | 735, 806 | те же |
| Там же, вычисление цепочек читает только descriptor fields | 635–723 | те же |
| `executor-handlers.ts`, error builder читает outcome/cursor/count, не тело | 196 | 196 |

`captureIndex` при возврате содержит все body objects через `captures` и `blockedCapture`; само поле `captures` handler не использует. Последний явный consumer индекса — построение cursor sets до основного provider loop. Будет ли V8 продолжать удерживать его через последующие awaits, без heap profile не установлено; scope переменной не доказывает время её жизни. Простое ограничение `Promise.all` по concurrency не исправляет последующее удержание всех результатов. CAS dedup также не убирает его: каждый JSONB query способен декодировать тот же ref в отдельный JS object.

**Модель исходного пути:** `H` — lifetime capture rows страницы, `R` — строки, потребовавшие CAS resolution, `Bᵢ` — декодированное тело, `d` — descriptor. На каждый chunk — один неограниченный envelope SELECT, до `R` catalog SELECT, `R` поставленных Promise и возвращённый index с `O(ΣBᵢ + H·d)` reachable content. Длительность фактического удержания после последнего consumer не измерена. Pool ограничивает выполняемые SQL, но не размер очереди Promise и не накопленный result array. При `C` chunks lifetime replay work остаётся `O(C·H)` до отдельного исправления алгоритма истории.

**Шаг A, минимальное практическое изменение:** разделить тип captured input и classification descriptor. Классификатор читает `responsePayload`, но отдаёт только `id`, `targetKey`, `requestBefore`, `statusCode` и вычисленные `contentId/validatedPage/terminal/blocked/orderRows/nextBefore/outcome`. Chain builder получает descriptors; сохранять raw ref или observation/raw id для отложенной диагностики вместо тела. `blockedChainCapture` строит такой же descriptor. Не менять current conflict/last-valid/terminal-empty/missing/cycle rules.

[purchase-retention-probe.mjs](./purchase-retention-probe.mjs) исполняет фактические classifier/chain functions и их pure dependencies, извлечённые из source. В варианте B одна map отбрасывает только `responsePayload` перед остальным неизменённым chain builder. Корпус: 500 complete targets, malformed body, resumable tail, conflicting pages, cursor cycle, namespace conflict, 404. Результат после удаления тел из контрольного output побайтно одинаков: 501 complete, 5 blocked. Все 1 009 raw body references из возвращённого индекса исчезают. Сериализованный размер индекса уменьшается на 92,35%; это **не** измерение heap/RSS или экономия БД. [Результаты](./purchase-retention-results.json).

После A возвращённый index удерживает `O(H·d)`, но peak при исходном `Promise.all` ещё `O(ΣBᵢ)`. SQL, bytes и parsing unchanged; raw body можно освободить раньше, влияние на GC требует heap profile.

**Шаг B, shared bounded read seam, без persistent cache:**

1. Читать envelope metadata keyset по `(pageId, endpoint='purchase_history', id)` небольшими страницами, с фиксированным верхним `id`, выбранным в начале этой попытки. Сохранять все IDs, status и request cursor; последовательность прихода capture facts не меняется. Для legacy inline body загружать одну строку при её классификации. Нельзя сначала SELECT всех inline bodies, а затем лишь разбить полученный массив.
2. Для pointer-only metadata использовать существующий production envelope-authorized batch primitive максимум на 8 refs, при `logical_bytes ≤512 KiB`; большие тела — по одному. Ограничить всю попытку одним активным окном. У duplicate refs внутри окна допускается одна физическая загрузка с fan-out результата, но каждый envelope проходит свою проверку и counters; запрещён bare-ref public reader.
3. Сразу после разрешения вызвать прежний classifier, сохранить только descriptor и освободить raw. Отдельный pure `buildIndexFromDescriptors` переиспользует существующий chain builder; иначе попытка прогнать descriptors через старый full-input classifier снова потребует тело.
4. `inline`/`shadow`/`serve` и fallback остаются per envelope: inline-only без CAS I/O; dual-copy `inline` отдаёт inline; shadow считает каждое сравнение и никогда не меняет ответ; pointer-only missing бросает `CapturePayloadUnavailableError`, не «пусто/complete». При failed batch вернуть per-row read/error semantics. Никаких negative results/ref bodies между страницами/запусками.
5. Результат чтения не является erasure-liveness proof. Нельзя на его основании переносить существующий материализующий writer за пределы своего page erasure fence или создавать cached `alreadyCaptured=true` после erasure. Не публиковать resolved bodies, не удерживать account-wide snapshot/locks на весь H. Если изменился envelope ref, заново проходить seam по текущей строке; material writes по-прежнему проверяют leases/fences.

**Что это даёт:** при all-pointer small-body cohort round trips `H → ceil(H/8)` на CAS-часть плюс metadata pages; обычные bytes/parsing остаются примерно прежними. Только repeated refs внутри одного окна уменьшают body bytes/parsing с `b` тел до `u` distinct refs. Peak logical batch bound — 4 MiB для этих CAS windows, отдельно один large/inline body; JS memory дополнительно зависит от inflate factor и `H·d`. При условных `H=10 000`, среднем retained body 20 KiB, старый путь удерживает около 195 MiB лишь logical body contents; это сценарий, не измерение сервера. Отбрасывание descriptor body не уменьшает durable storage/WAL/HTTP и не исправляет F4 refresh самостоятельно.

**Не продавать повторно production работу:** `capture-payloads.ts:796–849` и `payload-reader.ts:607–663` на 74aac уже имеют batch ≤8/512 KiB для разрешённых unmapped webhook binding waits. Наш purchase caller этой функцией не пользуется и всё ещё делает `Promise.all`. Предлагается аккуратный reuse/extension именно там, где не появляется post-erasure append race, а не повторная реализация общей идеи batching.

**Размер и проверки:** A — S, B — M. Нужны regression на mixed inline/pointer/JSON-null, missing object/body, duplicate ref, size boundary, ref repair между metadata/read, failed batch fallback, erasure между prefetch и consume, те же blocked/cursor_conflict/namespace/last-valid semantics и restart mid-window. Canary: maximum outstanding catalog reads, worker heap после index build/после chunk, bytes/rows/SQL на recovery и equality derived decisions; HTTP/skip/complete не должны меняться от storage-патча. Fixed-upper-id поведение сверить с прежней single-SELECT snapshot semantics; новые captures должны попасть в следующую попытку.

## Отвергнутые и условные гипотезы

- **Повторный config SQL на каждый payload:** не найден. `payload-reader.ts:263,460` читает module-local mode, `capture-cas-dual-write.ts:100,105,320` — local CSV. `runtime-heartbeat.ts:105,115–127` публикует из существующего heartbeat config read. Purchase handler делает один `loadEffectiveConfig` на входе (`executor-handlers.ts:3340`), не H раз. Добавлять snapshot/cache сюда ради этой гипотезы бессмысленно.
- **CAS dedup по одному hash:** отвергнут. Совпадение digest только сужает candidates; полноценное equality и collision ordinal — инвариант. Process cache ref без liveness fence может оживить erased material или сослаться на удалённый единственный body.
- **Вернуть equality boolean из PostgreSQL вместо body:** конкретный возможный путь — объединить identity lookup с full `jb.body = incomingCanonical::jsonb` и вернуть candidate id/ordinal/verdict, сохранив ordered collision fallback. Это может убрать отдельный SELECT и JS decode/canonicalize, но начинает отправлять B байт incoming в DB вместо возврата B байт stored. Network не исчезает, DB получает JSONB parse/equality; equivalence frozen codec против JSONB numeric/string semantics и выигрыши на том же PG16 ещё не проверены. Не включено в surviving savings; сначала DB experiment, особенно после CAP03-1.
- **Новая zstd/gzip/LZ4 компрессия как готовая оптимизация:** live substrate читает PostgreSQL JSONB/TOAST; на исследованном normal read нет собственного JS decompress stage. Без распределения TOAST methods, body sizes и PG CPU нельзя обещать выигрыши. New compression representation также затронет queryable fields, erasure matcher и exact parity. Не рекомендовано в этом отчёте.
- **Объединить CAS и capture transaction без savepoint:** неприемлемо: CAS failure не должен отменить inline fallback. **Удалить raw/observation envelopes**, scheduled retention или старые CAS objects: меняет fact/provenance/erasure contract, экономией выполнения не является.
- **Сделать общий unlimited `Promise.all` для всех replay readers:** увеличивает burst и расширяет время между body load и erasure-sensitive append. Уже развёрнутый batch намеренно ограничен безопасными binding waits.

## Воспроизводимость и ограничения

Из корня repo:

```sh
node --disable-warning=ExperimentalWarning investigations/sync-optimization-swarm-2026-09-13/03-capture-storage/codec-probe.mjs
node --disable-warning=ExperimentalWarning investigations/sync-optimization-swarm-2026-09-13/03-capture-storage/purchase-retention-probe.mjs
```

Probes требуют установленный Node с `node:module.stripTypeScriptTypes` и проверяют совпадение основного исследованного source с 74aac. Они пишут только свои results JSON. Ни Vitest, ни Testcontainers, ни production/provider calls, ни установки пакетов не выполнялись. Исследовательские варианты существуют только внутри загруженной копии модуля, product code не изменён. Saved artifacts не содержат реальных capture bodies.

Current production flags, payload size distribution, PG16 CPU/WAL/network, heap snapshots сервера и скорость на Node22 не измерялись. Поэтому localcodec ratio и serialized-index reduction не превращены в обещание снижения общего CPU на столько же процентов. Первое практическое действие — small codec parity/benchmark на целевом Node22; следом descriptor-only purchase classification с уже сохранённым witness.
