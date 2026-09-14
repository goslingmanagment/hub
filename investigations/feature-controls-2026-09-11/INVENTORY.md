# Перечень возможностей и настроек

Срез от 11 сентября 2026 года; основания и ограничения — в [REPORT.md](REPORT.md). Таблица отражает прочитанные разрешающие значения, не измеряет выполнение или бизнес-эффект. Пустая строка обозначена как `""`; непрочитанное значение не заменяется default.

32 группы охватывают 90 различных параметров из 164. Остальные параметры — полный технический раздел, персональные/серверные настройки и управление страницами; новые карточки не удаляют их.

| Возможность | Рекомендация | Разрешающие значения в срезе |
|---|---|---|
| AI и агенты: Показ полного запроса AI | Держать выключенным | `chatMuseAiPromptDebugEchoEnabled=true` |
| Fansly: Статистика каждого фото и видео | По потребности | `fanslyMediaStatsSyncEnabled=true`; `fanslyMediaStatsPageAllowlist="ari-1,lilly-1,lilly-2,lora-1,lora-2,lora-3"` |
| Fansly: История уведомлений | По потребности | `fanslyNotificationsSyncEnabled=true`; `fanslyNotificationsPageAllowlist="ari-1,lilly-1,lilly-2,lora-1,lora-2,lora-3"` |
| Fansly: Комментарии к постам | По потребности | `fanslyPostRepliesSyncEnabled=true`; `fanslyPostRepliesPageAllowlist="ari-1,lilly-1,lilly-2,lora-1,lora-2,lora-3"` |
| Fansly: Почасовая статистика | По потребности | `fanslyStatsHourlyEnabled=true`; `fanslyStatsSnapshotSyncEnabled=true`; `fanslyStatsSnapshotPageAllowlist="ari-1,lilly-1,lilly-2,lora-1,lora-2,lora-3"` |
| AI и агенты: Голосовые сообщения | По потребности | `voiceNotesEnabled=true`; `voiceNotesPageAllowlist="lora-1"` |
| AI и агенты: Досье фана в ответах AI | По потребности | `chatMuseAiFanProfileContextFeatures="fast-reply"` |
| Fansly: Траты фанов | Оставить | `fanslyFanEarningsSyncEnabled=true`; `fanslyNewStreamPageAllowlist=""` |
| Fansly: Покупки платного контента | Оставить | `fanslyPurchaseHistorySyncEnabled=true`; `fanslyNewStreamPageAllowlist=""` |
| Fansly: Статистика аккаунта | Оставить | `fanslyStatsSnapshotSyncEnabled=true`; `fanslyStatsSnapshotPageAllowlist="ari-1,lilly-1,lilly-2,lora-1,lora-2,lora-3"` |
| Fansly: Каталог контента | Оставить | `fanslyCatalogSyncEnabled=true`; `fanslyCatalogPageAllowlist="ari-1,lilly-1,lilly-2,lora-1,lora-2,lora-3"` |
| Fansly: История выводов денег | Оставить | `fanslyPayoutsSyncEnabled=true`; `fanslyPayoutsPageAllowlist="ari-1,lilly-1,lilly-2,lora-1,lora-2,lora-3"` |
| Fansly: Свежие показатели постов | По потребности | `fanslyPostEngagementRefreshEnabled=true` |
| AI и агенты: AI для сотрудников | Оставить | `chatMuseAiGatewayEnabled=true` |
| AI и агенты: Свежая переписка для AI | Оставить | `aiTranscriptFreshUnionMode="serve"` |
| AI и агенты: Поиск и исследования по архиву | Оставить | `agentReadPlaneMode="full"` |
| AI и агенты: Дозагрузка по запросу агента | По потребности | `agentHydrationMode="dispatch"`; `agentReadPlaneMode="full"` |
| OnlyFans: Переписка OnlyFans | Оставить | `ofapiDmProjectionEnabled=true`; `ofapiDmSyncEnabled=true`; `ofapiDmColdArchiveEnabled=true` |
| OnlyFans: Транзакции и контроль кредитов | Оставить | `ofapiCreditLedgerEnabled=true`; `ofapiSpendProjectionShadowEnabled=true`; `ofapiSpendTransactionIngestEnabled=true` |
| OnlyFans: Работа клиента OnlyFans | Оставить | `ofapiDesktopReadGatewayEnabled=true`; `ofapiDesktopCommandOutboxEnabled=true`; `ofapiDesktopCommandExecutionEnabled=true` |
| OnlyFans: Аудитория и спендеры OnlyFans | Оставить | `ofapiAudienceSyncEnabled=true`; `ofapiPresenceProjectionEnabled=true`; `onlyFansTopSpendersEnabled=true` |
| OnlyFans: Сохранение чтений клиента | Оставить | `ofapiMirrorInteractiveCaptureEnabled=true`; `ofapiMirrorBackgroundCaptureEnabled=true`; `ofapiMessageHistoryShadowEnabled=true`; `ofapiMessageHistoryDbFallbackEnabled=true` |
| OnlyFans: Статистика ссылок OnlyFans | По потребности | `ofapiLinkStatsReconcileEnabled=true` |
| Fansly: Проверка ускорения чатов | На время проверки | `fanslyDmShadowPageAllowlist="ari-1,lilly-1,lilly-2,lora-1,lora-2,lora-3"` |
| Fansly: Проверка обновления трат | На время проверки | `fanslyFanEarningsShadowPageAllowlist="none"` |
| Fansly: Докачка последних сообщений | На время проверки | `fanslyDmHeadCatchupPageAllowlist="none"` |
| Fansly: Массовая загрузка старых чатов | Держать выключенным | `fanslyDmDeepBackfillEnabled=false` |
| Fansly: Повторная обработка архива | Держать выключенным | `fanslyReplayMode="off"` |
| Система: Общее хранилище ответов | Оставить | `captureCasDualWritePages="*"` |
| Система: Перенос старых периодов из базы | Держать выключенным | `retentionTieringEnabled=false` |
| OnlyFans: Прежний опрос чатов OnlyFans | Держать выключенным | `onlyFansDmPollingEnabled=false` |
| AI и агенты: AI-оценка закрытия диалога | По потребности | `wbClosingLlmEnabled=false` |

## Где меняется каждая возможность

`live` — без перезапуска; `boot` — staged, после перезапуска; `none` — текущий API не меняет параметр. Для boot-флагов действуют полные серверные зависимости, в том числе между карточками. Одинаковый ключ в двух группах — общая настройка, её изменение влияет на обе.

### Показ полного запроса AI

Путь: `/settings?tab=configuration&feature=prompt-debug`.

- `chatMuseAiPromptDebugEchoEnabled` — `live`.

### Статистика каждого фото и видео

Путь: `/settings?tab=configuration&feature=media-stats`.

- `fanslyMediaStatsSyncEnabled` — `live`.
- `fanslyMediaStatsPageAllowlist` — `live`.
- `fanslyMediaStatsDailyCallBudget` — `live`.
- `fanslyMediaStatsLongTailCycleDays` — `live`.

### История уведомлений

Путь: `/settings?tab=configuration&feature=notifications`.

- `fanslyNotificationsSyncEnabled` — `live`.
- `fanslyNotificationsPageAllowlist` — `live`.
- `fanslyNotificationsDailyCallBudget` — `live`.

### Комментарии к постам

Путь: `/settings?tab=configuration&feature=comments`.

- `fanslyPostRepliesSyncEnabled` — `live`.
- `fanslyPostRepliesPageAllowlist` — `live`.
- `fanslyRepliesDailyCallBudget` — `live`.
- `fanslyRepliesRewalkCycleDays` — `live`.

### Почасовая статистика

Путь: `/settings?tab=configuration&feature=hourly`.

- `fanslyStatsHourlyEnabled` — `live`.
- `fanslyStatsSnapshotSyncEnabled` — `live`.
- `fanslyStatsSnapshotPageAllowlist` — `live`.

### Голосовые сообщения

Путь: `/settings?tab=configuration&feature=voice`.

- `voiceNotesEnabled` — `live`.
- `voiceNotesPageAllowlist` — `live`.
- `voiceNotesDailyCharBudget` — `live`.
- `voiceNotesGlobalDailyCharBudget` — `live`.
- `voiceNotesScriptMaxChars` — `live`.
- `voiceNotesMaxConcurrentSyntheses` — `live`.
- `voiceNotesRetrievalEnabled` — `live`.

### Досье фана в ответах AI

Путь: `/settings?tab=configuration&feature=fan-context`.

- `chatMuseAiFanProfileContextFeatures` — `live`.

### Траты фанов

Путь: `/settings?tab=configuration&feature=earnings`.

- `fanslyFanEarningsSyncEnabled` — `live`.
- `fanslyNewStreamPageAllowlist` — `live`.

### Покупки платного контента

Путь: `/settings?tab=configuration&feature=purchases`.

- `fanslyPurchaseHistorySyncEnabled` — `live`.
- `fanslyNewStreamPageAllowlist` — `live`.

### Статистика аккаунта

Путь: `/settings?tab=configuration&feature=account-stats`.

- `fanslyStatsSnapshotSyncEnabled` — `live`.
- `fanslyStatsSnapshotPageAllowlist` — `live`.
- `fanslyStatsSnapshotDailyCallBudget` — `live`.

### Каталог контента

Путь: `/settings?tab=configuration&feature=catalog`.

- `fanslyCatalogSyncEnabled` — `live`.
- `fanslyCatalogPageAllowlist` — `live`.
- `fanslyCatalogDailyCallBudget` — `live`.

### История выводов денег

Путь: `/settings?tab=configuration&feature=payouts`.

- `fanslyPayoutsSyncEnabled` — `live`.
- `fanslyPayoutsPageAllowlist` — `live`.
- `fanslyPayoutsDailyCallBudget` — `live`.

### Свежие показатели постов

Путь: `/settings?tab=configuration&feature=post-reactions`.

- `fanslyPostEngagementRefreshEnabled` — `live`.
- `fanslyPostEngagementDailyCallBudget` — `live`.

### AI для сотрудников

Путь: `/settings?tab=configuration&feature=ai-core`.

- `chatMuseAiGatewayEnabled` — `boot`.
- `chatMuseAiGatewayDailyRequestLimit` — `none`.
- `chatMuseAiGatewayDailyMicroUsdLimit` — `none`.
- `chatMuseAiGatewayFeatureDailyMicroUsdLimits` — `none`.

### Свежая переписка для AI

Путь: `/settings?tab=configuration&feature=fresh-context`.

- `aiTranscriptFreshUnionMode` — `live`.

### Поиск и исследования по архиву

Путь: `/settings?tab=configuration&feature=agent-read`.

- `agentReadPlaneMode` — `live`.
- `agentSearchBackend` — `live`.
- `agentObservationsEnabled` — `live`.

### Дозагрузка по запросу агента

Путь: `/settings?tab=configuration&feature=hydration`.

- `agentHydrationMode` — `live`.
- `agentHydrationAutoApproveMode` — `live`.
- `agentHydrationAutoDailyCallBudget` — `live`.
- `agentReadPlaneMode` — `live`.

### Переписка OnlyFans

Путь: `/settings?tab=configuration&feature=of-messages`.

- `ofapiDmProjectionEnabled` — `boot`.
- `ofapiDmSyncEnabled` — `boot`.
- `ofapiDmColdArchiveEnabled` — `boot`.
- `ofapiDmCorrectionsReconcileEnabled` — `boot`.
- `ofapiDmReadthroughReconcileEnabled` — `boot`.
- `ofapiDmReconcileIntervalMinutes` — `live`.

### Транзакции и контроль кредитов

Путь: `/settings?tab=configuration&feature=of-money`.

- `ofapiCreditLedgerEnabled` — `boot`.
- `ofapiSpendProjectionShadowEnabled` — `boot`.
- `ofapiSpendTransactionIngestEnabled` — `boot`.
- `ofapiChargebacksReconcileEnabled` — `boot`.
- `ofapiBalancePingEnabled` — `boot`.
- `ofapiAccountHealthEnabled` — `boot`.

### Работа клиента OnlyFans

Путь: `/settings?tab=configuration&feature=of-client`.

- `ofapiDesktopReadGatewayEnabled` — `boot`.
- `ofapiDesktopCommandOutboxEnabled` — `boot`.
- `ofapiDesktopCommandExecutionEnabled` — `boot`.
- `ofapiQueuedCommandTtlMs` — `live`.

### Аудитория и спендеры OnlyFans

Путь: `/settings?tab=configuration&feature=of-audience`.

- `ofapiAudienceSyncEnabled` — `boot`.
- `ofapiPresenceProjectionEnabled` — `boot`.
- `onlyFansTopSpendersEnabled` — `boot`.
- `ofapiFanIdentitiesSyncEnabled` — `boot`.
- `ofapiAudienceSweepIntervalMinutes` — `none`.

### Сохранение чтений клиента

Путь: `/settings?tab=configuration&feature=of-history`.

- `ofapiMirrorInteractiveCaptureEnabled` — `boot`.
- `ofapiMirrorBackgroundCaptureEnabled` — `boot`.
- `ofapiMessageHistoryShadowEnabled` — `boot`.
- `ofapiMessageHistoryDbFallbackEnabled` — `boot`.

### Статистика ссылок OnlyFans

Путь: `/settings?tab=configuration&feature=of-marketing`.

- `ofapiLinkStatsReconcileEnabled` — `boot`.
- `ofapiLinkStatsDailyCreditBudget` — `none`.

### Проверка ускорения чатов

Путь: `/settings?tab=configuration&feature=dm-shadow`.

- `fanslyDmShadowPageAllowlist` — `live`.

### Проверка обновления трат

Путь: `/settings?tab=configuration&feature=earnings-shadow`.

- `fanslyFanEarningsShadowPageAllowlist` — `live`.

### Докачка последних сообщений

Путь: `/settings?tab=configuration&feature=head-catchup`.

- `fanslyDmHeadCatchupPageAllowlist` — `live`.

### Массовая загрузка старых чатов

Путь: `/settings?tab=configuration&feature=deep-history`.

- `fanslyDmDeepBackfillEnabled` — `none`.
- `fanslyDeepBackfillIgnoreRetentionLimit` — `live`.
- `fanslyDmDeepBackfillMaxRequestsPerRun` — `none`.

### Повторная обработка архива

Путь: `/settings?tab=configuration&feature=replay`.

- `fanslyReplayMode` — `live`.

### Общее хранилище ответов

Путь: `/settings?tab=configuration&feature=storage`.

- `captureCasDualWritePages` — `live`.
- `captureCasReadMode` — `live`.
- `captureCasPointerOnlyPages` — `live`.

### Перенос старых периодов из базы

Путь: `/settings?tab=configuration&feature=tiering`.

- `retentionTieringEnabled` — `live`.
- `pageDmPruneEnabled` — `none`.

### Прежний опрос чатов OnlyFans

Путь: `/settings?tab=configuration&feature=legacy`.

- `onlyFansDmPollingEnabled` — `none`.

### AI-оценка закрытия диалога

Путь: `/settings?tab=configuration&feature=closing`.

- `wbClosingLlmEnabled` — `none`.
- `wbClosingLlmModel` — `none`.
- `wbClosingLlmDailyCapMin` — `none`.
- `wbClosingLlmDailyCapMax` — `none`.
