# Проверка общего плана Hub/Fansly

2026-09-07. Основной артефакт: [общий план](fansly-events-migration-plan-2026-09-07.md). Проверена архитектура и порядок будущих работ; реализация и production не менялись.

Три независимых reviewer проверили готовый документ:

| Направление | Результат |
|---|---|
| Ingestion / scheduler | A0 diagnostic state отделён от рабочих checkpoints и serving writes; сравнение до apply; every-slot full30; сохранение истории и physical baseline. Существенных противоречий нет |
| Протокол / сессия | Семь проверок с результатами и зависимостями; auth отдельно от pong; management scopes остаются неизвестными; proxy, capture, fallback, budgets и repair соблюдены. Существенных замечаний нет |
| Архитектура / rollout | A0 минимален, A1 независим от WS; C2 correctness/shadow/selection разделены; loss/rollback границы точны; +5% дополнительной нагрузки — кандидат до canary. Существенных противоречий нет |

По замечаниям внесены две правки:

1. Failed/incomplete full sweep или неполная диагностика не засчитываются в успешный «0 misses» знаменатель A0; показываются отдельно.
2. Hints являются prerequisite только для урежения, опирающегося на WS; они не создают зависимости независимого A1 от B1.

Отдельно [проверен diff](fansly-events-migration-plan-2026-09-07-review-code.md) `dcbba081..933d22f`: относящийся к плану Fansly runtime не менялся. Все локальные ссылки общего документа проверены; покрытие всех 17 существующих streams присутствует.

Новые HTTP/WS probes, тестовые сообщения, создание/отзыв credentials, runtime/unit/integration tests и production switches в этом раунде не выполнялись. `pnpm check` относится к будущим implementation PR; здесь изменены только документы. Этот review не подтверждает safe-stop, transport readiness или достигнутую экономию.
