# PR153 — независимый семантический review runtime extraction

Проверено 8 сентября 2026. Base: `d575cfa84d4c908d4e5db0bbf50a49e8981b4d12`; merge/head: `130150aca808ce3e3aeb953a532fe977c372d17a`. На момент проверки HEAD и origin/main совпадали с merge. Scope: перенос `fanslyDmConversationsChunk` и его helpers; сохранение capture, ownership, checkpoints, membership, retry/pause и побочных эффектов.

**Вердикт: PASS в проверенном scope. Подтверждённых introduced runtime bugs не обнаружено.** Это source-level semantic review, не утверждение об отсутствии всех исходных проблем и не подтверждение production rollout.

## Как проверялось

Прочитан patch и построен прямой unified diff тела прежней функции из `git show 130150ac^1:apps/runtime/src/services/sync/executor-handlers.ts` против тела нового `fansly-dm-conversations.ts`. Проверены реальные consumers вынесенных helpers и все изменившиеся места внутри тела, а не только новые тесты или комментарий «без изменения поведения».

Различия сводятся к tagged in-memory state и serializer, единому checkpoint wrapper, эквивалентному legacy predicate через новый diff, а также omission полей `createdAt`/`notes` с undefined. Последнее не меняет потребителей: hydration проверяет truthiness `createdAt` и `Array.isArray(notes)` в `fan-hydration.ts:26–35,174–178`.

## Сохранённые инварианты с текущими строками

| Проверка | Evidence на merge/head | Результат сравнения с parent |
|---|---|---|
| Request context, budget, egress | `fansly-dm-conversations.ts:211–224,332–339`; `rate-limiter.ts:67–75` | Те же observer/budget и page egress waiter; helper перенесён без изменения аргументов. |
| Capture до downstream writes/contract rejection | List capture `:352–364`, total guard `:366–377`; detail fetch/capture `:546–561`; head fetch/capture/tip context `:624–652` | Порядок прежний. Не появился parse/apply до захвата там, где его не было. |
| Probe capture failure остаётся ошибкой | `fansly-account-probe.ts:21–43` | Catch охватывает только fetch; journal остаётся снаружи. Тело совпадает с прежним helper. |
| Resume/init/restart | `fansly-dm-conversations.ts:244–309`; `cursor-state.ts:526–535` | Продолжается только `in_progress`; completed/malformed открывают новый generation выше checkpoint/row-side high-water, как прежде. Legacy v1 guard сохранён. |
| Persisted checkpoint shape и success | `fansly-dm-conversations.ts:136–170`; `cursor-state.ts:546–585` | In-memory `kind` не пишется. Сохраняются version/mode и прежние поля. `generationSetCount` присутствует только на прежнем progress site; nullable erasureDelta по-прежнему опускается. |
| Page transaction и lease/erasure fence | `fansly-dm-conversations.ts:804–840` | Те же `withOwnedPageSyncTransaction`, fence до row writes и overlap check до upsert. Wrapper принимает прежний `dbTx`, не выходит на app.db. |
| Membership/finalization | `:879–982` | То же равенство generation count/observed count; destructive pass только при present total и certified membership. Withheld не сдвигает lastFullSweepCompletedAt и пишет progress вместо success. |
| Head writes и legacy unchanged streak | `:711–803`; `fansly-dm-head-diff.ts:70–145` | Новый full diff вычисляется до upsert, но streak учитывает ровно прежние шесть reasons. Effective timestamp/sender fallback равны прежним выражениям; новые reasons не изменяют fetch/finalization. |
| Follow-up и backfill wakeup | `fansly-dm-conversations.ts:174–204,874–875,1057–1063` | Predicate и точка запроса `dm_messages` после committed page прежние. Исторический поток и его selection/cursor не менялись. |
| Retry/deferral | `:1004–1029,1136–1183` | Erasure defer 60 s, uncertified membership retry 15 min, request source, satisfaction и budget yield прежние. |
| Pause/dispatch authority | `platforms/registry.ts:31`; неизменённые `sync/executor.ts`, DB page-sync и sync-queue | Registry указывает на вынесенную функцию; не добавлены bypass planner, новая lease loop или новый caller. |

`packages/db/src/repositories/page-dm.ts` изменён только комментарием; repository write/fence SQL прежний. Новая проверка completed-state shape не меняет resume branch: и распознанный completed, и null ведут к тому же fresh-sweep пути, который читает high-water из исходного stored record.

Удаление `sync/locking.ts` не снимает runtime protection: поиск в parent нашёл его symbol references только в самом файле и `tests/sync-locking.test.ts`. Production callers не было. Реальные owned page leases/transactions остались.

Перенос `isPageAllowlisted` сохраняет fail-closed функцию буквально; `voice-notes.ts` её реэкспортирует. Legacy `fanslyNewStreamAllowed` с empty=all не изменён. Новые gates или переключение polling не добавлены.

## Границы проверки

- Vitest/интеграционные suites здесь не запускались: запуск и сбор результатов принадлежат координатору, чтобы не создавать параллельные Testcontainers suites.
- Прочитаны новые characterization/codec/diff tests; их наличие не заменяло сравнение старого и нового production paths.
- Не проверялись исправность текущей сессии, реальные provider ответы или production state. Сетевых Fansly-запросов и runtime/prod mutations не было.
- Исходные особенности full offset traversal, lifecycle dedup и будущая безопасность A0/A1 не объявляются исправленными этим extraction. Положительный verdict относится к отсутствию найденной новой runtime-регрессии в PR153.
