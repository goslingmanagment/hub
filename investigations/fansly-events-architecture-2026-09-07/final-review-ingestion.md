# Финальная независимая проверка интеграции с Hub

Проверено 2026-09-07 по исправленному `ARCHITECTURE.md`, без изменений main document или runtime. Основание code review: Hub `582ef1cf8a2de52eba6639ef775ddbe3e15ba74c`; relevant production diff `2475b3046332` сверялся в ingestion report.

**Вердикт: все четыре замечания первоначального review закрыты на уровне архитектуры. Новых блокеров в исправлениях не обнаружено.** Это готовность к реализации по этапам, не подтверждение работоспособности ещё не написанного кода и не разрешение менять production.

| Замечание | Проверенное исправление | Вывод |
|---|---|---|
| R1: старый edit/delete терялся за head overlap | §7, строки 151–152 разделяют create и mutation. §9, строки 211–220 требуют exact tombstone/target traversal, отдельную old-range coverage и unresolved debt; head receipt не закрывает старое изменение. | Закрыто. Недоступный exact endpoint не выдуман; lost mutations без refs прямо остаются отдельной задачей/unknown. |
| R2: пропущенный frame при живом pong ухудшал freshness | §8, строки 187–193 отделяют независимый discovery deadline от receipt SLO, сохраняют необходимые list pages и проверяют оба head markers. §8, строки 175–177 ограничивают снижение cadence дорогой сверкой; отсутствие дешёвого корректного detector означает сохранение старого обхода. | Закрыто. Экономия больше не объявляется гарантированной, если полное независимое discovery съедает выигрыш. |
| R3: planner перезаписывает per-page cadence | §8, строка 187 явно называет текущий reset и вводит audited typed overrides, единый effective policy resolver для planning/settlement/fallback и snapshot rollback. | Закрыто. При реализации planner включает seed/ensure normalization и расчёт slots/due; обязательный тест нескольких planner cycles/restart должен поймать обход resolver. |
| R4: конкурирующие append/materialization owners | §5, строка 120 оставляет router только hints и назначает canonicalization driver единственным business append authority. §6, строки 128–130 задают общий REST/projector writer и атомарный receipt, независимые projection debt/watermarks. Строки 135–136 требуют расширить существующий `message.material_observed`, проверить semantic hash, field presence и late arrival. | Закрыто. Routed, canonicalized и applied больше не смешиваются; новый дублирующий event type не требуется. |

Матрица 17 streams, скрытые readers, единицы денег/финансовая authority, scope/erasure, fairness и rollback из предыдущего review остаются учтёнными. Отдельной архитектурной переделки по этим пунктам не требуется.

Перед включением соответствующих gates остаются проверки из плана: old-ID update/delete и late REST, silent frame drop при живом heartbeat, фактическая полнота/стоимость marker traversal, сохранение per-page policy после scheduler cycles/restart/rollback, crash/replay между raw/routing/canonical append/material receipts. Shadow→direct apply должен сохранять replayable pending work для ранее captured observations: выключенный business append не должен необратимо объявлять их применёнными. Последнее — проверка заявленной раздельной completion semantics, а не новый вариант архитектуры.

Runtime tests здесь не запускались: выполнена независимая проверка исправленного документа против уже исследованного текущего ingestion path.
