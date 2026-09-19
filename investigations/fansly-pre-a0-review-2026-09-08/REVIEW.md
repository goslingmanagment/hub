# Проверка подготовительного рефакторинга Fansly — PR #153

Проверено 8 сентября 2026. Диапазон: `d575cfa84d4c908d4e5db0bbf50a49e8981b4d12` → `130150aca808ce3e3aeb953a532fe977c372d17a`. [PR #153](https://github.com/goslingmanagment/core/pull/153) уже объединён; дерево его source head `cbd593653e72399c90ca78e6c8e25019c25bf5ff` совпадает с деревом merge commit. Соседнее изменение настроек ChatGoose в эту проверку не входило.

**Вердикт: подготовительный рефакторинг проверку прошёл; внесённых им ошибок текущего поведения не обнаружено. Исправление известных ошибок и готовность A0 этим PR не закрыты.**

Проверка включала собственное чтение diff и исходного/нового пути, три независимых направления review и локальные тесты. Production, сессии и Fansly-трафик в этой проверке не затрагивались. Подтверждения, что проверенный commit уже развёрнут на production, здесь нет.

## Что стало лучше и сохранилось

- Обработчик `dm_conversations` вынесен из общего executor; внешняя регистрация и вызывающий код обновлены. По прямому сравнению тел функций порядок HTTP, захвата raw, записи строк и checkpoint сохранился.
- Типизированы состояния активного и завершённого обхода; четыре места записи checkpoint используют один writer. Persisted JSON совместим с непосредственным предыдущим кодом; progress не стал означать success, транзакционная запись не вышла за прежние границы.
- Удалена действительно неиспользуемая advisory-lock обёртка. Реальные lease, owned transaction и erasure fence остаются на месте.
- Разделены allowlist helpers с разной семантикой пустого списка. Перенос не поменял доступность потоков. Account probe сохранил классификацию результата и ошибку при сбое capture.
- Добавлены полезные request-level characterization tests: они фиксируют фактические вызовы, checkpoint, membership и follow-up. Сохранение нежелательного поведения явно отмечено в тестах.

## Что нужно учесть перед A0

### 1. Новый comparator пока не проверяет все записываемые поля

В [fansly-dm-head-diff.ts:39](/Users/dmitriy/code/goose/hub/apps/runtime/src/services/sync/fansly-dm-head-diff.ts:39) нет preview и sender role, хотя writer их обновляет в [fansly-dm-conversations.ts:779](/Users/dmitriy/code/goose/hub/apps/runtime/src/services/sync/fansly-dm-conversations.ts:779). Если ID, время и отправитель остались прежними, а preview изменился, `changed` будет `false`. Чистый probe это воспроизводит. Также этого нормализованного snapshot недостаточно, чтобы зафиксировать противоречие ID в списке и embedded head либо отсутствие исходного поля, скрытое fallback.

Сейчас это не меняет polling: caller берёт только прежние причины через `breaksLegacyUnchangedPage`. Но использовать результат как единственный полный сигнал A0 нельзя. Нужно определить полный контракт сравнения, дополнить поля/причины и отдельно сохранять неоднозначности исходного ответа; проверить сборку snapshot на preview-only, sparse head, exhausted repair budget и несовпадении IDs.

### 2. Подсказка в коде противоречит границе A0

[fansly-dm-head-diff.ts:65](/Users/dmitriy/code/goose/hub/apps/runtime/src/services/sync/fansly-dm-head-diff.ts:65) и [fansly-dm-conversations.ts:752](/Users/dmitriy/code/goose/hub/apps/runtime/src/services/sync/fansly-dm-conversations.ts:752) предлагают на A0 переключить действующий streak на полный diff. [Общий план:124](/Users/dmitriy/code/goose/hub/docs/research/fansly-events-migration-plan-2026-09-07.md:124) требует отдельного диагностического состояния при неизменных настоящем cursor и поведении обхода.

Следующий PR должен вести shadow-сравнение отдельно и сравнивать состояние до применения ответа. Эти комментарии следует уточнить, чтобы они не стали ошибочной инструкцией к реализации. В текущем PR переключения нет.

## Старые ошибки: теперь воспроизводятся тестами, но не исправлены

| Проблема | Подтверждение и эффект | Что делать |
|---|---|---|
| Один пустой ответ с `total: 0` скрывает ранее видимые диалоги | [Тест:528](/Users/dmitriy/code/goose/hub/tests/fansly-dm-conversations-sweep.integration.test.ts:528) проходит: `0 === 0` сертифицирует membership, [finalizer:925](/Users/dmitriy/code/goose/hub/apps/runtime/src/services/sync/fansly-dm-conversations.ts:925) скрывает старые строки и отмечает полный обход успешным. Физического удаления истории здесь нет | Отдельный correctness PR: защита от неожиданного обнуления при прежней непустой базе и явный путь подтверждения действительно пустого списка. Приоритет выше оптимизации запросов |
| Repair удалённого последнего сообщения оставляет несогласованные поля | [Тест:1021](/Users/dmitriy/code/goose/hub/tests/fansly-dm-conversations-sweep.integration.test.ts:1021): ID становится null, preview/time описывают более старое сообщение; при пустом repair остаются прежние preview/time. Для старого surviving head follow-up может не запрашиваться | Отдельно определить согласованное обновление head и восстановление архива при удалении. Проверить repaired, empty, sparse и delayed repair. До сокращения сверок эту проблему закрыть |
| Изменение только flags / unread pointer / tier считается «неизменившейся страницей» | [Тест:1120](/Users/dmitriy/code/goose/hub/tests/fansly-dm-conversations-sweep.integration.test.ts:1120). Сами поля записываются; текущий full scan по streak не останавливается | Для A0 считать правильный shadow-сигнал отдельно; не выдавать сохранение legacy predicate за исправление критерия |

Эти ветви проверены и в parent commit: это не регрессии, появившиеся из-за переноса. Сценарии тестов не доказывают, что соответствующие сбои происходили на production. Другие ветки общего плана, включая earnings snapshot A→B→A, данный PR не изменяет.

## Проверка

Локально выполнено на merge commit:

```sh
pnpm exec vitest run --no-file-parallelism \
  tests/dm-conversation-cursor-state.test.ts \
  tests/fansly-dm-head-diff.test.ts \
  tests/fansly-capture-allowlist.test.ts \
  tests/sync-handlers.test.ts \
  tests/fansly-dm-conversations-sweep.integration.test.ts \
  tests/fansly-dm-generation-membership.integration.test.ts
```

**6 файлов, 189 тестов прошли, 8.86 s; без пропусков.** Включены две интеграционные suites с PostgreSQL. `git diff --check HEAD^ HEAD` прошёл. Все пять CI checks PR — SUCCESS; [CI run](https://github.com/goslingmanagment/core/actions/runs/34161468169). Полный `pnpm check` локально повторно не запускался.

Независимые pure probes дополнительно сравнили 269 cursor inputs, 4 completed round trips, 5256 комбинаций прежнего head predicate; различий в проверяемом поведении не нашли. Shared helpers проверены AST-сравнением пяти переносов, 6 probe-сценариями и 28 allowlist cases. Это ограниченные проверки, не доказательство отсутствия всех дефектов.

Подробные независимые отчёты: [runtime](runtime-review.md), [cursor/head](state-and-head-review.md), [общие функции и вызывающий код](shared-seams-review.md).

## Следующий шаг

Сохранить этот рефакторинг как завершённую подготовку. Первым correctness PR закрыть неожиданное обнуление списка; перед A0 уточнить comparator и его отдельное диагностическое состояние. Repair удалённого head вести отдельным исправлением и закрыть до A1. A0 остаётся измерением на прежних полных обходах, а сокращение запросов начинается только после его критериев проверки.
