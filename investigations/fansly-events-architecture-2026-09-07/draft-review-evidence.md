# Проверка архитектурного draft: точность доказательств

Дата: 2026-09-07. Проверены `ARCHITECTURE.md` и `evidence/live-verification.md`, собственный `event-evidence.md`, исторический Fansly bundle, HAR-агрегат и исходная безопасная production SQL-выборка. Основной документ не менялся этим reviewer. Номера строк соответствуют draft до исправлений координатора.

## Вердикт

**Архитектурный выбор обоснован как conditional proposal.** Ошибок, опровергающих выбранный WS+REST вариант, не обнаружено. Native transport остаётся canary-gated; ни readiness, ни полнота событий не выданы за подтверждённые. Перед финализацией требуется исправить одну точную ссылку и уточнить границу auth-failure, чтобы не погасить исправный REST fallback из-за непроверенной WS capability. Финальный `REVIEW.md` ещё ожидается при проверке ссылок.

## Исправления

| Приоритет | Место | Что исправить и почему |
|---|---|---|
| P2 | `ARCHITECTURE.md:211`, §10 Auth failure; связать с :108 и :209 | «Auth failure» сейчас можно реализовать как shared session block при любом WS401/handshake denial. Но standalone WSS portability/scopes не подтверждены, а REST может оставаться валидным. Явно разделить `ws_capability_blocked` и доказанную invalid/revoked shared session generation. WS-specific failure оставляет прежний REST fallback; общая invalidation только при подтверждённой недействительности session/identity, с bounded verification, без retry storm и без `/logout`. Это устраняет конфликт с :209, который уже обещает REST fallback при живой REST session. |
| P3 | `ARCHITECTURE.md:40`, §2 transport source | Ссылка `event-evidence.md#2-протокол-который-реально-читает-fansly-клиент` не существует. Верный anchor: `event-evidence.md#2-native-websocket-транспорт-и-сессия`. |
| Finalization check | `ARCHITECTURE.md:284` | `REVIEW.md` при проверке ещё не существовал. Создать после сведения независимых reviews либо убрать обещание готового результата. Это ожидаемый артефакт workflow, не ошибка самой архитектуры. |

Неблокирующее уточнение: `ARCHITECTURE.md:149` содержит «Message … change» как будущую реакцию. В разобранном bundle подтверждены message create/delete/ack/reaction, но отдельный message edit wire type не подтверждён. Таблицу полезно пометить как design routing для подтверждённых типов; edit/change пока остаётся UNKNOWN и проверяется в gate 0. Не придумывать для него numeric type по аналогии с post update.

## Дополнительный gate: discovery latency при пропаже signals

После основного review координатор запросил проверку дешёвых head markers, чтобы снижение full inventory до 6 h не ухудшило silent-loss discovery. Историческое подтверждение и его пределы добавлены в [event-evidence §8](event-evidence.md#8-доппроверка-дешёвая-сверка-головы-диалогов), безопасный машинный результат — [messaging-group-marker-evidence.json](messaging-group-marker-evidence.json).

83/83 sampled rows содержат `lastMessageId` и embedded aggregate `lastMessage`; у одного ответа markers расходятся (82/83 совпадения). Нет group/list `updatedAt`, нет controlled hidden/sort/mutation proof. Поэтому `ARCHITECTURE.md:172,232` должны раздельно назвать cheap independent discovery deadline и cadence дорогостоящего detail/inventory. Снизить последний до 2–6 h можно только когда первый доказан и сохраняет допустимый срок обнаружения пропущенного нового сообщения. Иначе прежний нужный scan остаётся; реальная экономия в таком режиме ещё не доказана. Сравнивать оба markers, направлять mismatch/missing metadata в scoped refresh; старые edits/deletes отдельно сверять, lastMessage marker их не покрывает.

## Что независимо подтвердилось

1. **Live и историческое разнесены правильно.** §2:39/47 и live report:32–35 дают свежий HTTP101 endpoint, но не auth ACK, business frames, second-connection fan-out или continuity. Имя актуального bundle отличается от августовского. Нулевой HTTP body не назван отсутствием WS traffic. Browser notes описывают наблюдение координатора; reviewer не выдаёт его за собственный повторный UI эксперимент.
2. **Protocol labels совпадают с bundle.** Исходящий auth `t=1` и входящий SessionVerified `t=1` — разные направления; `t=2` pong, `10000` service event, `10001` batch, application `p` каждые 20–25 s. Transport parser в прежнем bundle не содержит обнаруженного resume cursor или контроля upstream seq. Формулировка «не обнаружен» сохранена.
3. **Provider enrichment не выдан за native data.** §2:43 прямо называет OnlyFansAPI посредником, его WS relay и enrichment. В direct apply допускаются только реально подтверждённые full payloads; senderData из provider documentation не объявлено native обязательным полем.
4. **Сервисы и notification types не смешаны.** §7:153 сохраняет разные пространства числовых типов. Presence §8:182 не следует из одного OnlineStatus handler. Message/group/money/catalog scopes не объявлены покрытыми одним heartbeat.
5. **Нереплеируемая история описана честно.** §2:49–53, §5:120–122, §9:200 различают durable capture, восстановление доступного состояния и потерянные transient facts. DB-down закрывает receiver с explicit gap, без ложного exactly-once. REST count не выдан за доказательство всей истории.
6. **Browser/session безопасность учтена.** Native logout-on-WS401 назван риском server browser; собственному receiver `/logout` запрещён. Optional relay требует ранний wire hook и новый durable spool. Synthetic Angular bus и telemetry-grade ingest не переиспользуются как доверенный платформенный поток. Никакие тестовые платежи, сообщения или session revoke не авторизованы автоматически архитектурой.
7. **Production observation totals пересчитаны из файла.** Всего 28 444; страницы: lora-1 7 064, lora-2 5 008, lora-3 3 644, lilly-1 2 585, lilly-2 9 625, ari-1 518. Producer counts 15 560 / 4 416 / 3 435 / 1 701 совпадают с report. Они корректно названы observations, не HTTP attempts, и не используются как точный baseline экономии.
8. **Проверка локальных ссылок.** В `ARCHITECTURE.md` найдены 16 relative local links и 2 external links. Единственный неверный существующий-document anchor — transport link выше; `event-evidence.md#3-кандидаты-предметных-событий` корректен. Ссылки на ingestion matrix и adversarial section корректны. 27 абсолютных локальных source links внутри `event-evidence.md` ранее проверены на существование файла и line bounds.

## Предел этого review

Новый live WS experiment не выполнялся; private API, production и приложения не изменялись. Не перепроверялись network claims отдельным подключением. Этот review проверяет соответствие архитектурных утверждений сохранённым доказательствам и их пределам; implementation readiness остаётся будущим gate 0.
