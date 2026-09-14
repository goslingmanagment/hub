# Сохранность настроек при упрощении интерфейса

Дата: 2026-09-12. Сравнение исходного `c0cd21c3` с `c011b61d` и локальным исправлением повторного применения вебхука. Production не изменялся.

## Вывод

Все **164 из 164 параметров** реестра сохранены: 63 меняются без перезапуска, 24 применяются при запуске процессов, 77 не редактируются через этот API. Сохранились все девять прежних разделов Settings, их адреса и owner-only доступ; добавлены «Возможности». Карточки охватывают 90 параметров, остальные 74 доступны через **Настройки → Работа Hub → Все настройки**. В браузере проверено «Показано 164 из 164».

Прежний adversarial review проверял изменения и рисковые пути, но не содержал полной матрицы каждого прежнего действия. Дополнительная сверка нашла одну новую P2: исчезло повторное применение уже применённой политики вебхука. Исправлено локально и независимо перепроверено; состав настроек при этом не меняется.

## Что сверено

Реестр, env schema, валидатор override, сборщик ответа конфигурации, contracts, фильтры полного списка и русский справочник побайтно совпадают с исходным commit. Настройки не мигрировались, значения по умолчанию и правила editability/runtimeApply не менялись. Машинный перечень всех ключей приведён ниже.

| Прежняя поверхность | Результат сверки |
|---|---|
| Работа Hub | Все 164 строки строятся из полного ответа сервера. Feature scope только скрывает остальные строки; общий itemMap и staged dependencies остаются полными. |
| Подключения | Fansly authorization/client-id/check/session-id/proxy, OFAPI diagnostics и прежние payload сохранены. Прямые OnlyFans token/proxy controls отсутствовали уже в base. |
| Модели | Slug/name, создание, редактирование, порядок и Delete сохранены. |
| Страницы | Platform/model/label, credentials, Verify/Create, Edit и Deactivate сохранены. |
| AI-персоны | Просмотр сохранён. Создание/Edit/Archive отключены уже в base через ADMIN_PERSONA_MUTATIONS_ENABLED=false. |
| Команда | Создание сотрудников, роли/password, назначения страниц, ключи, деактивация/реактивация сохранены. При ошибке каталога назначения приостановлены до успешного чтения. |
| Ключи агентов | Name/capabilities/pages/срок/два бюджета, issue/reveal/copy/revoke сохранены; новый предел срока соответствует прежним серверным 365 дням. |
| Синхронизация | Список, подробности страницы, Sync Now/Pause/Resume/Reset и deep link с page сохранены. |
| Сбор OnlyFans | Общий/постраничный scope, режимы, интервалы, лимиты, detail-запросы, pause/resume, preview/apply, разовые задания, checkpoint и audit сохранены. |
| Уведомления | Telegram credentials/discovery/test/clear, четыре переключателя, час UTC, incidents/resolve и reports/preview/send сохранены. Clear по-прежнему снимает DB override с возможным environment fallback. |
| AI в рабочей странице | Включение/выключение/наследование, дневной лимит и модель сохранены; просмотрено отдельно координатором в AiPageDashboard.tsx. Новая валидация не молча округляет ошибочный лимит. Серверный CAS отсутствует, как и раньше. |
| OFAPI evidence/recovery | Content evidence, stored reads, vendor scope/account IDs/capabilities/visibility и Banned Words остались на прежних местах. Отдельный дефект Apply описан ниже. |
| Навигация | Все девять прежних tab IDs доступны в desktop/mobile меню. /settings без tab по-прежнему открывает credentials, а не configuration. |

Упрощённые controls не исчерпывают произвольный ввод. Семь настоящих enum-наборов полны; для CSV досье показаны четыре пресета. Например, новый `help-me,ping` вводится в полном редакторе. Текущий нестандартный вариант сохранён отдельным option. Page checkboxes сохраняют неизвестные/старые labels; новый произвольный label также вводится в полном редакторе. Пустой общий список earnings/purchases означает все страницы, остальные capture/voice scopes — ни одной. Запрет пустого строкового override и reset к окружению сервера существовали до изменения.

## Найденная и исправленная потеря действия

В `c011b61d` OfapiWebhookRecovery запрещал Apply при `applyState=applied`. Если провайдер после прежнего успеха отключал webhook или менял события, DB оставалась applied. Чтение policy обращается только к DB; прежний Apply мог проверить remote.enabled/events и восстановить расхождение через registerOfapiWebhook. Новый запрет вынуждал создавать фиктивный draft/version для того же набора.

Возвращена явная кнопка **«Проверить и восстановить события · платный поток»**. Она использует прежний endpoint и сохранённый expectedVersion; fake draft и изменение версии не нужны. Dirty/error/fetching/busy/applying и неизвестный результат блокируют отправку. Для потерянного ответа повторное чтение той же версии в том же applied/failed состоянии не доказывает исход новой попытки. Действует существующая последовательность GET → признание неизвестного исхода → подготовка нового действия → отдельный явный запуск. Подготовка не вызывает POST. Самостоятельных запросов к провайдеру при просмотре нет.

Агент, обнаруживший дефект, независимо принял исправление после чтения diff и data path. Серверная граница сохраняется: версия идентифицирует политику, а не отдельную попытку применения.

## Проверки и пределы

- `pnpm check`: **305 файлов, 3378 тестов прошли, 9 пропущены**, lint и dashboard tsc/build успешны. Root strictness ratchet: прежние 1897 ошибок в 120 файлах, без увеличения долга.
- Отдельный frontend lint трёх изменённых файлов прошёл. Целевой прогон: 3 файла, 40 тестов.
- Дополнительный изолированный probe без DB: 2 теста. Настоящий assembleConfigView сохраняет все ключи/типы/editability/runtimeApply; фильтр all пропускает их все. Настоящий React SSR содержит каждую строку ровно один раз в полном режиме, при неизвестной feature и во всех 32 focused views. Скрытые строки не выданы за видимые.
- На локальном стенде с реальными компонентами и SDK, искусственными API и без upstream proxy: «Все настройки» показывает 164 из 164. Первый explicit reapply сделал ровно один POST с expectedVersion=7, без save/new version. Второй explicit reapply получил искусственный потерянный ответ; same-v applied сохранил блокировку. GET/ack/подготовка не добавили третьего POST и не поменяли version/groups.
- Артефакты: `output/feature-controls/settings-preservation-parity.json`, `settings-preservation-render.json`, `settings-preservation-test.log`, `settings-reapply-success.json`, `settings-reapply-after-prepare.json`, `settings-preservation-check.log`.

Это сверка сохранности возможностей конфигурирования в проверенном диапазоне, а не гарантия сохранности любых несохранённых черновиков после перезагрузки или фактических production-значений. Все поля не сохранялись по одному в production. PostgreSQL integration suites не запускались. Остальные прежние ограничения восстановления и серверных контрактов перечислены в [общем отчёте](ADVERSARIAL-REVIEW.md).

## Все параметры

У каждого ключа сохранены прежний тип, режим применения и правила редактирования. «Сервер» означает, что этот API и прежде не позволял менять параметр. Наличие карточки — дополнительный путь; полный список доступен для всех ключей.

| Ключ | Изменение | Карточка возможности |
|---|---|---|
| `databaseUrl` | Сервер | Полный список |
| `encryptionKey` | Сервер | Полный список |
| `encryptionKeyRing` | Сервер | Полный список |
| `encryptionKeyVersion` | Сервер | Полный список |
| `logLevel` | Сервер | Полный список |
| `apiHost` | Сервер | Полный список |
| `apiPort` | Сервер | Полный список |
| `trustProxy` | Сервер | Полный список |
| `sessionTtlDays` | Сервер | Полный список |
| `isProduction` | Сервер | Полный список |
| `fanslyFanEarningsShadowPageAllowlist` | Без перезапуска | Проверка обновления трат |
| `fanslyDmShadowPageAllowlist` | Без перезапуска | Проверка ускорения чатов |
| `fanslyBaseUrl` | Сервер | Полный список |
| `fanslyDefaultDelayMs` | Сервер | Полный список |
| `fanslyGlobalDelayMs` | Сервер | Полный список |
| `fanslyAccountLookupDelayMs` | Сервер | Полный список |
| `followerPageDelayMs` | Сервер | Полный список |
| `fanslyDmConversationsDelayMs` | Сервер | Полный список |
| `fanslyDmMessagesDelayMs` | Сервер | Полный список |
| `fanslyDmHeadCatchupPageAllowlist` | Без перезапуска | Докачка последних сообщений |
| `fanslyDmDeepBackfillEnabled` | Сервер | Массовая загрузка старых чатов |
| `fanslyDmDeepBackfillMaxRequestsPerRun` | Сервер | Массовая загрузка старых чатов |
| `fanslyDmDeepBackfillLiveRequestsPerDeep` | Сервер | Полный список |
| `fanslyDmDeepBackfillContinuationDelayMs` | Сервер | Полный список |
| `fanslyDmDeepBackfillContinuationJitterMs` | Сервер | Полный список |
| `onlyFansDmPollingEnabled` | Сервер | Прежний опрос чатов OnlyFans |
| `syncHttpTraceFile` | Сервер | Полный список |
| `syncHttpAttemptTraceStdout` | Сервер | Полный список |
| `onlyFansDefaultDelayMs` | Сервер | Полный список |
| `syncSharedRateLimitEnabled` | Сервер | Полный список |
| `lakeDir` | Сервер | Полный список |
| `egressPacerMode` | Сервер | Полный список |
| `syncPageExecutorConcurrency` | Сервер | Полный список |
| `transactionLookbackDays` | Без перезапуска | Полный список |
| `transactionRescanCapDays` | Без перезапуска | Полный список |
| `syncObservabilityRetentionDays` | Сервер | Полный список |
| `healthSyncLightMaxAgeMinutes` | Без перезапуска | Полный список |
| `healthSyncFollowerMaxAgeMinutes` | Без перезапуска | Полный список |
| `healthSyncMonitoringToken` | Сервер | Полный список |
| `onlyFansTopSpendersEnabled` | После перезапуска | Аудитория и спендеры OnlyFans |
| `telegramBotToken` | Сервер | Полный список |
| `telegramChatId` | Сервер | Полный список |
| `telegramReportHourUtc` | Сервер | Полный список |
| `telegramProxyPageLabel` | Сервер | Полный список |
| `serviceEgressProxyUrl` | Сервер | Полный список |
| `serviceEgressProxyUsername` | Сервер | Полный список |
| `serviceEgressProxyPassword` | Сервер | Полный список |
| `telegramEnabled` | Сервер | Полный список |
| `ofapiBaseUrl` | Сервер | Полный список |
| `ofapiWebhookManagementScope` | Сервер | Полный список |
| `ofapiExpectedTeamSlug` | Сервер | Полный список |
| `ofapiApiKey` | Сервер | Полный список |
| `ofapiEventRetentionDays` | Сервер | Полный список |
| `ofapiEventWorkerReplicas` | Сервер | Полный список |
| `ofapiDmProjectionEnabled` | После перезапуска | Переписка OnlyFans |
| `ofapiDmSyncEnabled` | После перезапуска | Переписка OnlyFans |
| `ofapiDmColdArchiveEnabled` | После перезапуска | Переписка OnlyFans |
| `ofapiDmColdArchiveRetentionDays` | Сервер | Полный список |
| `fanslyFanEarningsSyncEnabled` | Без перезапуска | Траты фанов |
| `fanslyPurchaseHistorySyncEnabled` | Без перезапуска | Покупки платного контента |
| `fanslyDeepBackfillIgnoreRetentionLimit` | Без перезапуска | Массовая загрузка старых чатов |
| `fanslyNewStreamPageAllowlist` | Без перезапуска | Траты фанов; Покупки платного контента |
| `fanslyStatsSnapshotSyncEnabled` | Без перезапуска | Почасовая статистика; Статистика аккаунта |
| `fanslyStatsSnapshotPageAllowlist` | Без перезапуска | Почасовая статистика; Статистика аккаунта |
| `fanslyStatsSnapshotDailyCallBudget` | Без перезапуска | Статистика аккаунта |
| `fanslyNotificationsSyncEnabled` | Без перезапуска | История уведомлений |
| `fanslyNotificationsPageAllowlist` | Без перезапуска | История уведомлений |
| `fanslyNotificationsDailyCallBudget` | Без перезапуска | История уведомлений |
| `fanslyCatalogSyncEnabled` | Без перезапуска | Каталог контента |
| `fanslyCatalogPageAllowlist` | Без перезапуска | Каталог контента |
| `fanslyCatalogDailyCallBudget` | Без перезапуска | Каталог контента |
| `fanslyPostRepliesSyncEnabled` | Без перезапуска | Комментарии к постам |
| `fanslyPostRepliesPageAllowlist` | Без перезапуска | Комментарии к постам |
| `fanslyRepliesDailyCallBudget` | Без перезапуска | Комментарии к постам |
| `fanslyRepliesRewalkCycleDays` | Без перезапуска | Комментарии к постам |
| `fanslyPayoutsSyncEnabled` | Без перезапуска | История выводов денег |
| `fanslyPayoutsPageAllowlist` | Без перезапуска | История выводов денег |
| `fanslyPayoutsDailyCallBudget` | Без перезапуска | История выводов денег |
| `fanslyMediaStatsSyncEnabled` | Без перезапуска | Статистика каждого фото и видео |
| `fanslyMediaStatsPageAllowlist` | Без перезапуска | Статистика каждого фото и видео |
| `fanslyMediaStatsDailyCallBudget` | Без перезапуска | Статистика каждого фото и видео |
| `fanslyMediaStatsLongTailCycleDays` | Без перезапуска | Статистика каждого фото и видео |
| `fanslyPostEngagementRefreshEnabled` | Без перезапуска | Свежие показатели постов |
| `fanslyPostEngagementDailyCallBudget` | Без перезапуска | Свежие показатели постов |
| `fanslyStatsHourlyEnabled` | Без перезапуска | Почасовая статистика |
| `fanslyStatsHourlyBackfillMaxDays` | Без перезапуска | Полный список |
| `fanslyBackfillContinuationDelayMs` | Без перезапуска | Полный список |
| `ofapiRestDelayMs` | Сервер | Полный список |
| `ofapiDmBootstrapMaxRequestsPerRun` | Сервер | Полный список |
| `ofapiDmDailyCreditBudget` | Сервер | Полный список |
| `ofapiMirrorGlobalDailyCreditBudget` | Сервер | Полный список |
| `ofapiMirrorPrincipalDailyCallCap` | Сервер | Полный список |
| `ofapiMirrorPrincipalDailyCreditCap` | Сервер | Полный список |
| `ofapiCreditFloor` | Сервер | Полный список |
| `ofapiDmReconcileIntervalMinutes` | Без перезапуска | Переписка OnlyFans |
| `ofapiAccountHealthEnabled` | После перезапуска | Транзакции и контроль кредитов |
| `ofapiCreditAlertThreshold` | Без перезапуска | Полный список |
| `ofapiWebhookSilenceThresholdMinutes` | Без перезапуска | Полный список |
| `ofapiCreditLedgerEnabled` | После перезапуска | Транзакции и контроль кредитов |
| `ofapiBurnAlertCreditsPerHour` | Без перезапуска | Полный список |
| `ofapiCreditMicroUsdPrice` | Сервер | Полный список |
| `ofapiBalancePingEnabled` | После перезапуска | Транзакции и контроль кредитов |
| `ofapiAudienceSyncEnabled` | После перезапуска | Аудитория и спендеры OnlyFans |
| `ofapiAudienceMaxRequestsPerRun` | Сервер | Полный список |
| `ofapiAudienceDailyCreditBudget` | Сервер | Полный список |
| `ofapiAudienceSweepIntervalMinutes` | Сервер | Аудитория и спендеры OnlyFans |
| `ofapiBackfillDailyCreditBudget` | Сервер | Полный список |
| `ofapiChargebacksReconcileEnabled` | После перезапуска | Транзакции и контроль кредитов |
| `ofapiLinkStatsReconcileEnabled` | После перезапуска | Статистика ссылок OnlyFans |
| `ofapiLinkStatsDailyCreditBudget` | Сервер | Статистика ссылок OnlyFans |
| `ofapiFanIdentitiesSyncEnabled` | После перезапуска | Аудитория и спендеры OnlyFans |
| `ofapiPresenceProjectionEnabled` | После перезапуска | Аудитория и спендеры OnlyFans |
| `ofapiSpendProjectionShadowEnabled` | После перезапуска | Транзакции и контроль кредитов |
| `ofapiSpendTransactionIngestEnabled` | После перезапуска | Транзакции и контроль кредитов |
| `ofapiDesktopReadGatewayEnabled` | После перезапуска | Работа клиента OnlyFans |
| `ofapiMirrorInteractiveCaptureEnabled` | После перезапуска | Сохранение чтений клиента |
| `ofapiMirrorBackgroundCaptureEnabled` | После перезапуска | Сохранение чтений клиента |
| `ofapiExportArtifactDir` | Сервер | Полный список |
| `ofapiMessageHistoryShadowEnabled` | После перезапуска | Сохранение чтений клиента |
| `ofapiMessageHistoryDbFallbackEnabled` | После перезапуска | Сохранение чтений клиента |
| `ofapiDesktopCommandOutboxEnabled` | После перезапуска | Работа клиента OnlyFans |
| `ofapiDesktopCommandExecutionEnabled` | После перезапуска | Работа клиента OnlyFans |
| `ofapiQueuedCommandTtlMs` | Без перезапуска | Работа клиента OnlyFans |
| `ofapiDmCorrectionsReconcileEnabled` | После перезапуска | Переписка OnlyFans |
| `ofapiDmReadthroughReconcileEnabled` | После перезапуска | Переписка OnlyFans |
| `pageDmPruneEnabled` | Сервер | Перенос старых периодов из базы |
| `diskUsageAlertPercent` | Сервер | Полный список |
| `revenueRouteRoleEnforcement` | Сервер | Полный список |
| `authPolicyEnforcement` | Сервер | Полный список |
| `accessGrantsReadEnabled` | Сервер | Полный список |
| `chatMuseAiGatewayEnabled` | После перезапуска | AI для сотрудников |
| `chatMuseAiGatewayDailyRequestLimit` | Сервер | AI для сотрудников |
| `chatMuseAiGatewayDailyMicroUsdLimit` | Сервер | AI для сотрудников |
| `chatMuseAiGatewayRequestMicroUsdLimit` | Сервер | Полный список |
| `anthropicApiKey` | Сервер | Полный список |
| `openrouterApiKey` | Сервер | Полный список |
| `chatMuseAiGatewayFeatureDailyMicroUsdLimits` | Сервер | AI для сотрудников |
| `aiTranscriptFreshUnionMode` | Без перезапуска | Свежая переписка для AI |
| `chatMuseAiFanProfileContextFeatures` | Без перезапуска | Досье фана в ответах AI |
| `chatMuseAiPromptDebugEchoEnabled` | Без перезапуска | Показ полного запроса AI |
| `elevenLabsApiKey` | Сервер | Полный список |
| `voiceNotesEnabled` | Без перезапуска | Голосовые сообщения |
| `voiceNotesRetrievalEnabled` | Без перезапуска | Голосовые сообщения |
| `voiceNotesPageAllowlist` | Без перезапуска | Голосовые сообщения |
| `voiceNotesDailyCharBudget` | Без перезапуска | Голосовые сообщения |
| `voiceNotesGlobalDailyCharBudget` | Без перезапуска | Голосовые сообщения |
| `voiceNotesScriptMaxChars` | Без перезапуска | Голосовые сообщения |
| `voiceNotesMaxConcurrentSyntheses` | Без перезапуска | Голосовые сообщения |
| `wbClosingLlmEnabled` | Сервер | AI-оценка закрытия диалога |
| `wbClosingLlmModel` | Сервер | AI-оценка закрытия диалога |
| `wbClosingLlmDailyCapMin` | Сервер | AI-оценка закрытия диалога |
| `wbClosingLlmDailyCapMax` | Сервер | AI-оценка закрытия диалога |
| `agentReadPlaneMode` | Без перезапуска | Поиск и исследования по архиву; Дозагрузка по запросу агента |
| `agentObservationsEnabled` | Без перезапуска | Поиск и исследования по архиву |
| `agentSearchBackend` | Без перезапуска | Поиск и исследования по архиву |
| `agentHydrationMode` | Без перезапуска | Дозагрузка по запросу агента |
| `agentHydrationAutoApproveMode` | Без перезапуска | Дозагрузка по запросу агента |
| `agentHydrationAutoDailyCallBudget` | Без перезапуска | Дозагрузка по запросу агента |
| `agentExportPolicyValue` | Без перезапуска | Полный список |
| `fanslyReplayMode` | Без перезапуска | Повторная обработка архива |
| `retentionTieringEnabled` | Без перезапуска | Перенос старых периодов из базы |
| `captureCasDualWritePages` | Без перезапуска | Общее хранилище ответов |
| `captureCasReadMode` | Без перезапуска | Общее хранилище ответов |
| `captureCasPointerOnlyPages` | Без перезапуска | Общее хранилище ответов |
