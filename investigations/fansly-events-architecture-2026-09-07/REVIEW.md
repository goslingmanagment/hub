# Итог архитектурного review

2026-09-07. Основной результат: [ARCHITECTURE.md](ARCHITECTURE.md). Статус: предложение готово к рассмотрению и следующему исследовательскому этапу; работоспособность будущей реализации, экономия запросов и production readiness не объявлены доказанными.

## Независимые направления

Три отдельных агента сначала работали независимо: текущий ingestion/потребители, события/HAR/extension, архитектура/отказы. После сборки проекта каждый проверил основной draft; координатор исправил замечания, затем каждый повторно проверил своё направление.

| Проверка | Первоначальные находки | Результат повторной проверки |
|---|---|---|
| [Надёжность архитектуры](draft-review-architecture.md) | Silent lost signal исключён из receipt SLO; старые мутации за head boundary; apply receipt не определён; DB lease обещал отсутствие socket overlap | Все четыре закрыты. [Финальный verdict](final-review-architecture.md) |
| [Интеграция Hub](draft-review-ingestion.md) | Old edit/delete; discovery freshness; planner сбрасывает per-page cadence; конкурирующие append/materialization authority и уже существующий material event | Все четыре закрыты. [Финальный verdict](final-review-ingestion.md) |
| [Доказательства протокола](draft-review-evidence.md) | WS auth denial не равен смерти REST session; link anchor; independent discovery отдельно от дорогой сверки | Существенные замечания закрыты. [Финальный verdict](final-review-evidence.md) |

Замечания пересекаются, поэтому суммировать их как независимое количество ошибок неправильно. В повторных проверках открытых архитектурных P1/P2 не осталось. Это результат review документа, не математическое доказательство отсутствия всех ошибок.

После повторных reviews координатор принял две точечные редакции из заключений: HAR marker mismatch описан как численно больший ID с неизвестной причиной, без заявления о временном порядке/неатомарности; shadow→direct gate явно сохраняет deferred work и требует replay старых captured observations. Остальная проверенная архитектура сохранена. SHA в individual review относится к прочитанной reviewer редакции; ссылки на номера строк в draft reviews являются историческими.

## Что проверено в текущей сессии

- Код 17 Fansly streams, scheduler/leases, raw/direct/event пути, serving readers, session/egress, budgets, canonical dedup, projection/erasure и legacy dependencies.
- Local HEAD `582ef1cf…` и differences relevant Fansly paths с production image revision `2475b3046332`.
- Шесть локальных HAR: 18 уникальных исторических WS handshakes, 0 экспортированных frames; официальный bundle от 2026-08-20.
- Дополнительный HAR census `/messaging/groups`: 9 уникальных requests, 83 rows с list/embedded message markers, 1 mismatch. Counts не означают уникальных фанов/диалогов или сегодняшнюю семантику API.
- Живой Firefox `lora-1`: endpoint WSS и HTTP101; business frames/auth ACK/long-running continuity не сняты.
- Production: health, Docker revision, диск, bounded SQL под `read_only`; 24-часовые observation aggregates. Полный physical HTTP baseline и completeness serving planes не проверены из-за ограниченного доступного read scope.

## Проверка артефактов

Проверены существование локальных ссылок/номеров строк, anchors, валидность двух JSON evidence aggregates, отсутствие JWT-подобных секретов в новых текстовых файлах и `git diff --check`. В отчётах нет tokens/cookies/тел переписки. Это ограниченная проверка артефактов, не security scan.

Runtime/unit/integration tests не запускались: основной код не изменялся. Приведённый fault matrix — обязательные будущие тесты, а не утверждение, что они уже прошли. В исследовании не было production writes, deploy/flag/restart, изменения proxy/credentials, регистрации webhooks, сообщений/покупок/удалений ради fixtures. Существующая посторонняя untracked папка OFAPI-аудита не изменялась.

## Что остаётся перед реализацией

Свежий wire/transport canary, полный baseline физических попыток, актуальные scopes/TTL/second-connection semantics, recovery coverage и field-level reader parity. Если эти проверки не позволяют одновременно сохранить свежесть и достичь экономии, cadence сохраняется: цель перехода не считается выполненной ценой скрытой потери обнаружения.

Дальнейшая работа начинается с этапа 0 основного документа. Текущая задача завершается архитектурой и планом; никакого автоматического включения следующего этапа нет.
