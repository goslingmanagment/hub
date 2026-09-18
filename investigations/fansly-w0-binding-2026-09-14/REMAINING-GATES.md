# Fansly migration — remaining gates audit, 14 September 2026

**Новых обязательных локальных code slices, которые открывают ближайший gate
без недостающих W0 prerequisites, не найдено.** Это не доказательство завершения
миграции и не отказ от последующих этапов. После закрытия их prerequisites
реализация и проверка продолжаются по принятому плану.

На срезе аудита [PR197](https://github.com/goslingmanagment/core/pull/197)
с HEAD `9f727fe17464158c6c7136b78bb414b27f841d47` прошёл локальную проверку и
независимое ревью, но **CI оставался pending; merge не подтверждён**.
Root зафиксирует результат CI и merge отдельно. Operator-only изменение
не требует runtime deployment. Новых живых замеров в этом аудите нет.

Эта сводка заменяет только актуальные указания о состоянии и следующем действии
в прежнем [PROGRESS-20260914.md](../fansly-a0-deploy-2026-09-11/PROGRESS-20260914.md).
Сам PROGRESS и прежние sealed reports остаются неизменёнными историческими
доказательствами. Browser/proxy inspection остановлен после вопроса владельца;
предыдущая формулировка о продолжении такого осмотра не является текущим действием.

| Stage | Actual state | Missing evidence / next action |
| --- | --- | --- |
| A0 / A1 | A0 наблюдается; текущий early-stop candidate NO-GO. Полный polling сохранён. | 17 сентября 22:58:33.610 UTC — исходная семидневная календарная точка отчёта, не автоматический проход. Нужны достаточное валидное покрытие и объяснение расхождений. Старые пробелы не превращаются в измеренные дни. |
| W0 | Короткая проба 13 сентября выполнена; новое binding/paired/continuity испытание не начато. PR197 CI pending. | После CI/merge — согласованный конкретный live experiment: generation-bound REST identity receipt, рабочий Lilly-1 browser context, paired delivery, presence, не менее шести часов continuity и recovery receipts. Не выводить новое probe approval из deploy approval; UI не возобновлять автоматически. |
| B0 / B1 | Следующие этапы остаются впереди, их gates не пройдены. | Сначала W0. Затем B0 durable capture, собственные не менее семи суток и достаточный корпус; после соответствующего gate — B1 hints, physical attempts, latency и history fairness. |
| C1 | Диагностика работает; suppression policy не принята. Следующая естественная сверка Lora-2 после revision 1640 уже наблюдена без нового reconcile. | Нужен доказанный redundant-work candidate и сохранение presence freshness. Закрытый единичный follow-up не является fleet-wide suppression acceptance; повторять его ради того же вывода не требуется. |
| C2a / C2b / C2c | C2a bounded parity принято. C2b: один из двух qualifying daily walks; tracked scope неполон. C2c gated. | Ещё одно естественное qualifying completion и bounded report. Это само по себе не подтверждает C2c: quiet corrections, per-fan max-age и physical cost остаются отдельными требованиями. Daily rotation сохранена. |
| B2 | Parked. | Отдельное scoped owner decision и собственные предпосылки; сейчас не реализовывать. |
| T0 / общая цель | Physical-attempt accounting доступен; сопоставимый optimized cohort отсутствует. | Реализованная экономия и event-to-reader p95/p99 не измерены. SQL-cost samples и shadow counters не доказывают целевые результаты. |

## Датированные доказательства

Это разные срезы, не единый атомарный снимок production. Целевые follow-up
наблюдения перекрывают cumulative cohorts и не прибавляются к их счётчикам.

- **A0:** [снимок](../fansly-a0-deploy-2026-09-11/activation/20260910T225618Z/snapshot-20260914T174241Z/REPORT.md)
  через 14 сентября **17:42:41.583795 UTC**. Отдельный
  [missing-head разбор](../fansly-a0-reader-missing-2026-09-14/REPORT.md)
  использует current debt на **18:15:55 UTC** и transcript window через
  **18:22:43 UTC**. Один повторный candidate совпадает с двумя историческими
  list windows; точная атрибуция их pre-apply counters не доказана.
- **C1:** [targeted Lora-2 packet](../fansly-c1-deploy-2026-09-11/lora2-post1640-20260914T184910Z/REPORT.md)
  имеет cutoff **18:49:10.237073 UTC**, snapshot **18:49:12.782266 UTC**.
  Run **751279**: active/source counts **8,140 / 8,140**, `requested=false`.
  [Finalization](../fansly-c1-deploy-2026-09-11/lora2-post1640-20260914T184910Z/FINALIZATION.md)
  подтверждает завершённое независимое ревью; presence equivalence и causal
  savings этим наблюдением не установлены.
- **C2b:** [STATE](/Users/dmitriy/.codex/worktrees/hub-fansly-c2b-shadow/investigations/fansly-c2b-earnings-shadow-2026-09-10/activation/20260912T233234Z/STATE.json)
  с последним report as-of **14 сентября 17:49:59.376402 UTC**. Первый
  transitional completion исключён; qualifying completion — **14 сентября
  10:53:41.787 UTC**. Требуется ещё один qualifying walk, а не просто наступление
  следующей даты.
- **W0:** [STATE на срезе аудита](STATE.json), updatedAt **19:32:17.599757 UTC**,
  фиксирует `reviewed_pr_waiting_for_ci`, отсутствие новых provider measurements
  и остановленный browser/proxy inspection. Последующая финализация может
  обновить STATE; зафиксированный здесь результат аудита остаётся историческим.

## Предел локальной работы

Безопасное ближайшее действие — завершить CI/merge evidence packet PR197 и
подготовить точный следующий W0 gate с уже известными ограничениями. Живую часть
нельзя заменить дополнительными unit tests, повторным чтением тех же отчётов
или преждевременной реализацией B0/B1.

Исторические per-ID pre-apply сведения A0 не были сохранены; сегодняшние
transcript/cost reads их не восстановят. Prospective bounded anomaly receipts
можно рассматривать при отдельном конкретном вопросе о будущей атрибуции,
но обязательный следующий PR из этого аудита не следует. Принятый
[план §5](../../investigations/fansly-events-migration-plan-2026-09-07.md)
требует scalar cursor diagnostics и запрещает per-thread arrays. Новая
диагностика не отменит уже установленный NO-GO и не восстановит прошлое.

Аудит выполнен по локальным источникам и сохранённым evidence/review packets.
Production, provider, browser и proxy tools не использовались; исходники,
предыдущие отчёты, flags, jobs и deployments не менялись; тесты не запускались.
Единственная запись при финализации этого аудита — данный файл.
