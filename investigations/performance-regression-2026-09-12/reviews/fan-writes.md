# Ревью условных записей fans / page_fans

Проверен diff `c0cd21c3..c76c6db0` в изолированном checkout
`/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912`.
Ревью началось с чтения реализации, вызывающего кода, схемы и контрактов;
предыдущий общий прогон тестов не использовался как доказательство корректности.

**Результат: одна подтверждённая регрессия P2 — новый порядок записей истории
username создаёт deadlock для пересекающихся вызовов без внешней транзакции.**
Других новых ошибок бизнес-полей в четырёх проверяемых writer-функциях не найдено.

## P2: сохранять устойчивый порядок строк перед записью fan_username_aliases

Место: `packages/db/src/repositories/fans.ts:189–213`, особенно добавление
прочитанных строк в `rows` на строке 199 и построение `aliasValues` на строке 202.

`upsertFans` после оптимизации сначала получает только изменившиеся строки из
`INSERT … ON CONFLICT DO UPDATE … WHERE … RETURNING`, затем дописывает неизменившиеся
строки из отдельного `SELECT` в конец того же массива. Этот промежуточный массив
используется для `INSERT INTO fan_username_aliases` до восстановления исходного
порядка возвращаемого результата.

Поэтому даже одинаковый порядок идентификаторов в двух вызовах больше не означает
одинаковый порядок блокировок alias-строк:

| Шаг | Вызов 1 | Вызов 2 |
|---|---|---|
| Входной порядок | `[A, B]` | `[A, B]` |
| Изменение | displayName меняется только у A | после записи первого вызова displayName меняется только у B |
| Alias VALUES до оптимизации | `[A, B]` | `[A, B]` |
| Alias VALUES после оптимизации | `[A, B]` | `[B, A]` |
| Возможное пересечение | держит alias A, ждёт alias B | держит alias B, ждёт alias A |

Вызовы без внешней транзакции уже отпустили блокировки строк `fans`, когда начинают
запись aliases. PostgreSQL прерывает один alias INSERT с `40P01` (`deadlock_detected`).
Предварительная запись в `fans` к этому моменту уже закоммичена, но `upsertFans`
отклоняется: вызывающий код не доходит до следующей записи membership/checkpoint.
Практический эффект — прерванный sync/backfill и задержка обработки, а не доказанная
необратимая потеря исходных фактов.

### Воспроизведение и граница доказательства

Fixture: `tests/audit-fan-alias-concurrency.integration.test.ts` в audit checkout;
сохранена [копия рядом с отчётом](./audit-fan-alias-concurrency.integration.test.ts).
Он вызывает **реальные** старую и новую `upsertFans`, использует два PostgreSQL
соединения с autocommit и одинаковым порядком идентификаторов/присутствия полей.
Payload второго вызова отличается только необходимым изменением displayName B;
это не утверждение об идентичности двух payload.

Инструментация только останавливает выполнение перед alias-запросами и перед
второй строкой каждого INSERT. Тестовый `BEFORE INSERT` trigger не меняет строки,
query text или список VALUES. Перед второй строкой он ждёт временный shared
advisory lock; контроллер отпускает gate, а trigger отпускает shared lock **до**
попытки взять вторую alias-блокировку. Сам цикл после снятия gate состоит из
обычных блокировок `fan_username_aliases`, а не из тестовых advisory locks.

Root выполнил fixture последовательно, без параллельного Testcontainers:

```sh
pnpm exec vitest run tests/audit-fan-alias-concurrency.integration.test.ts --maxWorkers=1 --no-file-parallelism
```

Проверенные assertions:

- Старая реализация: оба alias INSERT имеют `[A, B]`; оба вызова завершаются успешно.
- Новая реализация: alias INSERT имеют `[A, B]` и `[B, A]`; ровно один вызов получает
  `40P01`, второй завершается успешно.
- Успешные вызовы в обеих версиях возвращают `[A, B]`; публичный порядок результата
  восстановлен корректно и не является отдельной ошибкой.

Receipt: [fan-alias-concurrency.log](./fan-alias-concurrency.log), `2/2` assertions
tests passed; повторный receipt с JSON trace — 4.86 секунды. Здесь «passed» означает, что воспроизвелись ожидаемый
успех старой версии **и ожидаемый deadlock новой**, а не отсутствие ошибки в новом коде.
Reviewer прочитал receipt; тест запускал root.

### Достижимые вызовы и ограничения

- `apps/runtime/src/services/sync/ofapi-fan-identities.ts:98` передаёт `app.db`
  напрямую, затем на строке 100 пишет memberships. Это рабочий путь
  tracking/trial-link sync, который маршрутизируется через
  `sync/executor-handlers.ts:1255–1284`.
- `sync/executor.ts:1318` создаёт несколько page executors по конфигурации;
  они могут обрабатывать разные страницы с общими глобальными fan identities.
  Дефолт concurrency — 4 (`packages/shared/src/config-registry.ts:167`).
- OFAPI fan-identities sync по умолчанию выключен
  (`packages/shared/src/config-registry.ts:298`); его **текущее production-состояние
  reviewer не проверял**. Факт воспроизведения не означает, что именно этот
  сценарий уже произошёл на production.
- Есть ещё bulk-вызов без внешней транзакции:
  `apps/runtime/src/services/fansly-page-alias-backfill.ts:98` →
  `upsertHydratedFansForPageDetailed(app.db)`. Это независимая точка входа,
  не берущая page-sync lock. Его пересечение с другим writer требует обычного
  параллельного выполнения; отдельный mixed transaction/autocommit fixture не запускался.
- Обычные audience/DM/spend bulk writers используют внешние транзакции и удерживают
  конфликтные блокировки `fans` до завершения aliases. Поэтому утверждение не
  распространяется на любое пересечение двух транзакционных вызовов.
- Разный исходный порядок fan-входов мог создавать deadlock и до изменения.
  Новое доказательство сильнее этого старого риска: исходный порядок в обеих
  операциях одинаков, а перестановка появляется внутри оптимизированного writer.

Рекомендуемое исправление: формировать alias INSERT в каноническом порядке
`fanId`/`username`, независимо от разделения на изменённые и пропущенные строки.
Не скрывать нарушение порядка автоматическим retry. Runtime-код в рамках ревью
не изменялся.

## Проверенная поверхность

### Условные записи и бизнес-семантика

| Функция | Что проверено |
|---|---|
| `upsertFans` (`fans.ts:97`) | Dedupe по platform/user ID, присутствие полей, explicit NULL, omitted fields, порядок результата, полнота read-back, username/displayName/createdAtExternal/metadata, оба CASE для deleted timestamps, история aliases |
| `upsertFanPages` (`fans.ts:303`) | Частичные memberships, follower/subscriber timestamps, expiry, nullable autoRenew, CASE autoRenewOffDetectedAt, четыре pageAlias-поля, вставка отсутствующей membership |
| `refreshFanPageFollowerState` (`fans.ts:847`) | active follow minimum, false/null clearing, совпадение каждого SET с change predicate, непересечение с generation/full-sweep retirement |
| `refreshFanPageSubscriberState` (`fans.ts:1178`) | active aggregate, null autoRenew, очистка всех полей у отсутствующей current subscription, два последовательных UPDATE и внешние транзакции |

У каждого изменяемого бизнес-поля обнаружен соответствующий `IS DISTINCT FROM`
или равнозначный predicate очистки. CASE-выражения в SET и WHERE используют одно
SQL-выражение, поэтому NULL/false и даты отключения автопродления не расходятся.
Для mandatory booleans/last_seen/alias timestamps схема объявляет `NOT NULL`.

Существовавшее до оптимизации группирование `hasPresentIdentity(template)` по
значению первого элемента группы не объявлялось новой регрессией: эта логика
байт-в-байт присутствует в baseline. Аналогично, реплеи со старым payload могли
перезаписать имя и ранее; эта оптимизация не добавила ordering guard и не убрала его.

### Вызывающий код и внешние транзакции

Прочитаны прямые вызовы и использование возвращённых строк:

- OFAPI subscription/DM projections — идентификаторы для subscription/conversation,
  внешняя транзакция; DM дополнительно удерживает erasure fence.
- OFAPI spend ingest, transactions backfill, chargebacks — fan ID maps;
  `withOfapiSpendTransactionPageLock` действительно создаёт DB-транзакцию.
- OFAPI audience и DM sync — fan ID maps и memberships внутри
  `withOwnedPageSyncTransaction`.
- Fansly subscribers/followers/reconcile/DM/transactions — hydration и записи
  memberships внутри тех же внешних транзакций; follow/subscription generation
  сохраняется в специализированных source tables.
- `projections/fan-earnings.ts:61` — одиночный autocommit fan ID для earnings row.
- `fan-profiles.ts:131` — создание отсутствующей identity для OnlyFans; следующий
  read проверяет page membership/deleted-state заново.
- OFAPI fan identities и Fansly alias backfill — перечисленные выше bulk-вызовы
  без внешней транзакции.
- `followers-reconcile-override.ts:389` — refresh внутри SERIALIZABLE transaction,
  paused audience/lease checks и явная обработка `40001` остаются на месте.

Runtime-потребители массива `upsertFans` используют ID, platformUserId или длину,
а не положение строк из SQL RETURNING или свежую копию profile-полей. Публичный
return восстанавливает deduped input order в `fans.ts:229`.

### Freshness и неявные эффекты UPDATE

- Намеренное изменение: `fans.last_seen_at`, `page_fans.last_seen_at` и связанная
  username-alias отметка больше не продвигаются при каждом одинаковом наблюдении.
  Код явно задаёт окно 60 секунд (`fans.ts:69–79`). Реальные изменения полей
  записываются сразу.
- Presence не вычисляется из этих колонок: используются
  `external_presence_at`/`external_presence_observed_at` и provider lastSeen.
- Retirement guards читают `page_follows.last_seen_at` и
  `page_subscriptions.last_seen_at`, которые этим diff не тронуты. То же касается
  исторических subscription rollups и generation bookkeeping.
- Agent membership/alias datasets показывают и фильтруют свои `lastSeenAt`;
  интерфейс наблюдаемого времени теперь имеет указанную погрешность. Не найден
  отдельный sub-minute бизнес-порог, для которого это ломает решение системы.
- Alias search/history и deleted-fan views используют alias values и сортировку
  по их последнему времени. Смена username сама вызывает запись, даже внутри
  окна; прежние username-строки не удаляются.
- Просмотрены все SQL-миграции на `CREATE TRIGGER`/trigger functions. В репозитории
  нет triggers на `fans`, `page_fans`, `fan_username_aliases`, которые пропускались
  бы вместе с UPDATE. На production каталог triggers reviewer не опрашивал.
- Retention/capture не зависят от физического UPDATE этих таблиц: исходные факты
  фиксируются отдельно. `INSERT … ON CONFLICT` по-прежнему расходует sequence ID
  и берёт конфликтные блокировки даже при пропущенном UPDATE; это не новая ошибка.

## Проверенные, но не заявленные как новые дефекты подозрения

1. **Неполный RETURNING при no-op.** Есть отдельный SELECT untouched и восстановление
   deduped map. На обычном READ COMMITTED следующий statement видит committed
   conflict-row; во внешней транзакции строка остаётся заблокирована до commit.
2. **Erasure между no-op upsert и SELECT.** У autocommit-вызова появляется отдельное
   окно, в котором hard-delete способен оставить `undefined` в возвращаемом массиве.
   Но fans удаляются специальным erasure-path, а эти же нетранзакционные вызывающие
   пути до оптимизации уже могли упасть на следующем FK INSERT после конкурентного
   удаления. Новая отдельная потеря/тихий checkpoint advance не доказаны; поэтому
   самостоятельного P2 по этому сценарию нет.
3. **Новый порядок публичного массива.** Не подтверждается; переставлен промежуточный
   массив для alias INSERT, публичный return восстанавливается корректно.
4. **Длинная внешняя транзакция и now().** PostgreSQL transaction time может
   отставать от wall clock; 60-second comment не является строгой гарантией при
   произвольно долгой транзакции/расхождении часов. Новый критичный freshness-consumer
   не найден; обычные page-fetch writes обёрнуты в транзакцию после внешнего fetch.
5. **NULL стирает omitted поля.** Не подтверждается: update sets и predicates
   используют одну и ту же field-presence grouping, а insert defaults не добавляют
   незаказанные conflict SET.
6. **Пропуск implicit DB side effects.** Repository-defined triggers на затронутых
   таблицах отсутствуют; отдельного downstream CDC, читающего каждый физический
   UPDATE, в просмотренном коде не найдено.

## Ограничения и происхождение контекста

Production не читался, изменения не деплоились. Reviewer не запускал Vitest,
Testcontainers или другие DB-процессы; один новый fixture был передан root для
последовательного запуска. Проверка локальных динамических trigger-конфигураций,
не отражённых в миграциях, и статистическая частота deadlock в живой нагрузке
в этот review не входят.

Прочитаны `CLAUDE.md`, quick reference/identity decision из `docs/decisions.md`,
Stage 14 identity contract и Stage 28 erasure contract. Память использована только
для ориентации в исходной задаче оптимизации: `MEMORY.md:249–250`, rollout
`01a091e1-f935-71e1-af7c-edd42fa6405d`. Проверенные выводы выше основаны на текущем
diff/коде/схеме и receipt нового fixture, а не на старых замерах production.
