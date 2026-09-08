# Финальная проверка архитектурных замечаний

2026-09-07. Проверен `ARCHITECTURE.md`, SHA-256 `c0cdf69a2ed91d1278e5edbe4e9ac2e66675c37cd8e493aa6cb03baf3109b9c3`. Повторная проверка ограничена четырьмя замечаниями из `draft-review-architecture.md`; основной файл не изменён.

**Вердикт: все четыре замечания закрыты в архитектурном документе. Открытых P1/P2 в этом review не осталось.** Документ пригоден для следующего исследовательского этапа и последующей поэтапной реализации после принятия решения; это не подтверждение production readiness или фактической экономии.

| Замечание | Закрытие |
|---|---|
| P1: lost signal исключён из receipt SLO, inventory урежается до 6 h | §8:189–193 и §11:253/262 сохраняют независимый discovery deadline ≤30 min либо более строгий baseline, требуют dropped-frame проверки и прямо признают feasibility gate недостигнутым, если нужные list pages нельзя убрать. 2/6 h относятся к отдельной дорогой сверке |
| P2: old edit/delete за head boundary | §7:152, §9:206/211–220 разделяют новые головы, exact-ID mutation repair и старые неизвестные изменения; head receipt не объявляет весь DM state проверенным |
| P2: durable граница materializer | §5:120 и §6:128–130 определяют единственную canonical append authority, общий idempotent writer, transaction serving writes+receipt, отдельные projection watermarks/debt и зависимость dirty settlement от apply receipt |
| P2: DB lease обещает отсутствие физических overlaps | §5:93–95 теперь различает одного логического владельца и возможное сосуществование sockets при failover; epoch/fencing и влияние второго connection входят в transport gate |

Прежние empirical gates остаются обязательными: свежие wire fixtures и auth/account proof, безопасный proxy/WSS transport и failover, реальные physical-attempt baseline/capacity, discovery latency и reader parity. Ничего из этого финальный документ не выдаёт за уже полученный результат.
