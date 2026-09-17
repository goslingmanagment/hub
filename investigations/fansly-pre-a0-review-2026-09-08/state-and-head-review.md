# PR #153: cursor state и сравнение голов диалогов

Дата: 8 сентября 2026. Проверенный диапазон: parent `d575cfa8` → merge `130150aca808ce3e3aeb953a532fe977c372d17a`. Источники прочитаны через `git show` на этих ревизиях. Scope: typed cursor read/write, checkpoint compatibility, head diff, null/unread/deletion и достаточность относящихся к ним тестов. Runtime, production и код не изменялись; Vitest/DB integration в этой ветке не запускались.

## Вердикт

**В проверенном scope не найдено внесённой PR регрессии текущего runtime с обоснованным P1/P2.** Вынесенная функция сохраняет прежнюю политику записи/возобновления. Новый `headDiff.changed` пока не управляет остановкой или дочиткой: действующий caller использует прежний набор причин.

Этот вывод относится к extraction, а не подтверждает готовность `diffConversationHead` быть единственным детектором всех изменений для будущего A0/A1. Одно ограничение нового helper и существующие особенности удаления приведены отдельно ниже.

## Что подтверждено

- `cursor-state.ts:526–533`: in-progress arm делегирует прежнему parser; v1 migration, legacy missing-count guard и отказы сохраняются. `fansly-dm-conversations.ts:244–270` возобновляет только `kind === "in_progress"`; completed по-прежнему открывает новый sweep с `max(checkpoint, row generation)+1`, сохраняя прошлый completion timestamp из raw record.
- `cursor-state.ts:546–577`: в JSON не попадает `kind`; завершённый документ не получает `mode`/offset. `erasureDelta` отсутствует при null, telemetry `generationSetCount` сопровождает только соответствующий progress write. Непосредственно предыдущий binary понимает новые сериализованные in-progress документы и отказывает completed как resumable cursor.
- `fansly-dm-conversations.ts:136–169,272–305,938–1000`: один writer вызывает те же repository functions с теми же аргументами. Fresh/restart остаются progress; withheld completion не штампует success; page writes/checkpoint остаются в прежней transaction. Изменения политики membership/finalization при extraction не обнаружены.
- `fansly-dm-conversations.ts:711–782`: incoming ID остаётся provider ID для сравнения, даже если `preserveHeadForRetry` оставляет stored ID при записи; effective time/sender используют ровно прежние fallback expressions. Legacy reasons в `fansly-dm-head-diff.ts:72–80,141–145` эквивалентны удалённому inline условию. Visibility принудительно true на incoming стороне воспроизводит прежнее `!existing.isVisible`.
- Extracted handler целиком сопоставлен с соответствующей функцией parent. Помимо codec/writer, head diff и optional property spreads у hydrated account, дополнительных семантических изменений в теле не обнаружено. Parent head/fallback код проверен непосредственно, а не признан прежним по комментариям новых тестов.

## Офлайн differential probe

После координации с основным reviewer выполнен отдельный pure Node probe, без Vitest, БД, сети или provider calls. Через `git show` загружались реальные TS-модули обеих ревизий, затем `typescript.transpileModule` и отдельные VM contexts. Это проверка чистых функций, не DB/runtime integration.

```json
{
  "cursorCorpus": 269,
  "resumed": 61,
  "fresh": 208,
  "completedRoundTrips": 4,
  "legacyHeadParityCases": 5256,
  "parity": "pass",
  "database": false,
  "network": false,
  "vitest": false
}
```

Cursor corpus включает v1/v2, completed, telemetry, unknown mode/version, отсутствующие/null/nonfinite/отрицательные/дробные значения полей. Сравнивались фактический parent parser и new parser→serializer, а также parent parser на сериализованном новом документе. Head corpus перебирает ID null/same/new, unread 0/3, visibility, unresolved identity и оба существующих exclusion reasons. Отсутствующая stored row проверяется отдельно в том же переборе. Полного пространства возможных checkpoint JSON этот конечный корпус не доказывает; in-progress parser также сравнен по исходному diff и остался прежним.

## Ограничение нового helper перед A0 — не runtime regression

`apps/runtime/src/services/sync/fansly-dm-head-diff.ts:36–63` называет snapshot полным mutable head scope, но не включает `lastMessagePreview`, sender role и partner binding. Между тем `fansly-dm-conversations.ts:779–784,848–863` продолжает писать эти поля. При unchanged ID/time/sender и изменении только preview реальный `diffConversationHead` возвращает `{changed:false,reasons:[]}`; это воспроизведено pure probe. Аналогично helper не получает отдельный embedded ID, поэтому не может сам диагностировать конфликт list marker и embedded head.

Сейчас full `changed` не используется для управления данными; `:760` берёт только legacy subset. Поэтому это **не доказанная потеря данных из PR #153**. До использования helper как A0 comparator нужно явно назвать его выбранным подмножеством полей либо дополнить snapshot/reasons и assembly-level cases. Одного снятия legacy filter недостаточно для доказательства всего scope; комментарии `fansly-dm-head-diff.ts:66–70` и caller `:757–759` обещают больше готовности, чем функция обеспечивает.

Кроме того, эти комментарии предлагают A0 переключить действующий streak на полный diff. Это противоречит принятому migration plan (`docs/research/fansly-events-migration-plan-2026-09-07.md:124`): A0 не меняет настоящий cursor/generation/success и ведёт диагностическое состояние отдельно. **Минимальная guidance-правка до A0:** оставить текущий legacy streak, направить расширенные reasons в отдельный shadow comparator/checkpoint и убрать инструкцию «A0 flips the streak». Текущий PR переключение ещё не выполняет, поэтому это pre-A0 caveat, а не внесённая runtime regression.

## Существующее поведение, не внесённое PR

- Удалённая голова с provider `lastMessageId:null` и успешным limit-1 repair получает null ID вместе с time/preview более старого surviving message. При пустом repair сохраняются прежние time/sender/preview с null ID. Это уже было в parent `executor-handlers.ts:3281–3316`, сохранено в новом `fansly-dm-conversations.ts:711–784` и теперь явно характеризуется тестом `tests/fansly-dm-conversations-sweep.integration.test.ts:1021–1049`. При older repaired timestamp follow-up может не запрашиваться по прежнему timestamp predicate. Не приписывать этот дефект extraction.
- Flags, unread pointer и tier-only изменения не сбрасывают legacy streak. Они по-прежнему записываются в thread row; streak не останавливает текущий full scan. Новые тесты корректно фиксируют ограничение прежнего критерия, а не вводят desired behavior.

## Достаточность тестов и пределы проверки

Добавленные request-level fixtures полезны для extraction: они проверяют persisted checkpoint shape, budget resume, total drift, optional total, empty page, hidden rows, head repair, unread-only и flags/tier-only изменения. Codec tests проверяют отсутствие `kind`, completed/resumable boundary, telemetry rider и v1 migration. Самостоятельный differential probe дополнительно проверил совместимость с непосредственным parent; legacy simulation в тестах относится к гораздо более старому G3 rollback.

Для будущего A0 остаются нужны assembly-level случаи: sparse head при exhausted repair budget; list/embedded ID mismatch; preview-only correction; sender-role/partner resolution при неизменном sender ID. Отсутствие этих будущих comparator cases не превращено здесь в blocker поведения текущего PR. Результаты основного test suite и DB integrations сообщает координатор; данный отчёт не утверждает их прохождение.

После завершения самостоятельной проверки координатор сообщил: focused Vitest — 6 files / 189 tests passed, включая 16 integration tests; source tree PR совпадает с merge. Это результат основной ветки review, а не дополнительный параллельный запуск этого reviewer. Pure probe исполнялся однократной локальной stdin-командой; отдельный script не сохранялся, сводный output приведён выше.
