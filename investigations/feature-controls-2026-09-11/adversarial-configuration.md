# Независимый adversarial review настроек

Проверенный диапазон: `c0cd21c3..d08d969c`, включая `2f55b035`. Дата: 2026-09-12.

## Подтверждённый finding

### P2 — смена охвата конфигурации уничтожает черновики и подтверждения записи

**Классификация:** новая регрессия в `2f55b035`.

**Место на проверенном head:** `apps/dashboard/src/pages/settings/ConfigurationTab.tsx:642`; вход в сценарий — `apps/dashboard/src/pages/SettingsPage.tsx:69–78`.

1. Открыть `/settings?tab=configuration&feature=voice`.
2. Изменить дневной лимит голоса, не сохраняя его.
3. Нажать уже активный раздел «Работа Hub» в навигации настроек. Он сохраняет `tab=configuration`, но удаляет `feature`.
4. `key={feature?.id ?? "all"}` меняется с `voice` на `all`. React размонтирует весь `ConfigurationView`, включая keyed строки и их `ConfigEditor`.

Несохранённый ввод и версия, которую владелец проверил, исчезают без предупреждения. То же относится к `ConfigWriteReceipt`: переход во время запроса удаляет mutation observer и его per-call callback, а переход после успешной записи с неудачным readback теряет серверный receipt. Это потеря локального контекста проверки; удаления захваченных фактов или серверных секретов в этом сценарии нет. Смена только поискового query/hash до этого изменения компонент не размонтировала.

Исправление: сохранить экземпляр `ConfigurationView` при смене `feature`/полного списка, отдельно сбрасывать только фильтры. Сохранить стабильную ссылку для возврата фокуса открытого staged-диалога.

**После независимого подтверждения координатором исправлено в рабочем дереве:** удалён ключ, зависящий от `feature`; смена возможности сбрасывает только фильтры и старый anchor. `ConfigEditor`, его version/receipt и открытый staged modal сохраняют экземпляры. Ссылка возврата фокуса у modal остаётся той же, а её текущая цель обновляется на видимый поиск либо ссылку возврата. `SettingsPage.tsx` менять не потребовалось.

Добавлен `tests/adversarial-configuration-state.test.ts`: он проверяет actual React type/key через полный список → возможность → другая возможность → полный список, переход через активное «Работа Hub» и query/hash-переход к prerequisite. Это pin жизненного цикла формы; он не выдаётся за mounted DOM тест сохранения во время запроса. Существующие editor tests отдельно проверяют frozen versions и receipts. Для новых файлов выполнены синтаксическая транспиляция и `git diff --check`; ESLint нового теста прошёл. `ConfigurationTab.tsx` исключён существующей конфигурацией ESLint. Suites и UI не запускались; mounted pending-save/focus сценарий остаётся для общей проверки координатора.

## Сверенные пути

- `ConfigChoiceField`/`configurationChoices` сопоставлены с `packages/shared/src/config-registry.ts`, `validateConfigOverride` и реальным `fansly-stream-gate.ts`. Пустой общий список earnings/purchases означает все страницы; остальные capture/voice списки — ни одной. Пустую строку UI не может сохранить: это существующий серверный запрет, а не новая регрессия. Сброс override наследует environment.
- Все предложенные enum-значения есть в серверном registry. Шаги `off → shadow → serve` и `inline → shadow → serve` дополнительно проверяются сервером; выбор конечного режима сам по себе не обходит этот gate.
- Voice ограничен Fansly и в runtime (`modules/ai/features/index.ts`, `services/voice-profiles.ts`). Отфильтровать OnlyFans из этого селектора корректно. Неизвестные/старые явные labels конфигурационный селектор сохраняет.
- Focused view передаёт в staged-редактор полный `itemMap` и все boot flags; transitive prerequisites и atomic dependent disable не обрезаются списком feature keys. Серверная валидация staged writes, ack и expectedVersion остаётся прежней.
- Applied/desired в `featuresView.ts` проверены против `app-config-service.ts`: pending, missing api/worker, дополнительные observed roles, drift и unknown не становятся подтверждённым running value. Рекомендации не запускают записи; режимы shadow/read_only/request_only обозначаются отдельно. Зелёная карточка не подтверждает успешный сбор или полноту архива.
- `ConfigurationEditors.tsx` продолжает сохранять snapshot/version до явного пересмотра и использует returned value/version для reconciliation. Новый дефект выше возникает на уровне жизненного цикла контейнера, а не в payload PATCH.
- Changes в Models/Pages/Credentials/CreatePage, team assignments и agent keys сверены с существующими API. Границы owner/page scope и запись секретов не расширены; лимиты выдачи agent keys соответствуют настоящему 365-дневному ограничению repository, несмотря на более широкий sanity cap контракта.
- Изменения Notifications сохраняют загруженный срез при failed refresh и блокируют запись с ошибочным чтением. Очистка Telegram credentials снимает DB override, после чего возможен environment fallback; новый текст этому соответствует. `Save & Send Test` раскрывает уже существовавшую отправку тестового сообщения.
- Изменения Sync — раскладка; Collection сохраняет существующие version-bound preview/apply и сохранённый локальный draft. `OfapiWebhookRecovery` исключён из этой области по распределению ревью.

## Границы проверки

Предыдущие page-review отчёты не использовались. Проверка основана на diff, текущих компонентах, SDK/контрактах и серверных read/write путях. Suites, UI и production-операции не запускались. Кроме описанной регрессии, подтверждённого нового удаления данных, расширения доступа или повреждения секретов в проверенной области не найдено; это не доказательство отсутствия любых возможных регрессий.
