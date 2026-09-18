# A0: стоимость material query измерена

[PR #193](https://github.com/goslingmanagment/core/pull/193) слит и развёрнут
14 сентября 2026 года. Production работает на `e73513737e19`; все три роли
healthy, 0 рестартов, protected sync health 200. Единственная новая миграция —
0192; прежние 187 записей и их timestamps сохранены. PostgreSQL не пересоздавался.

Релиз использовал штатный `dist-only`, `apps`, без image GC. Проверенное дерево
`6a6620d2187a195b07fc04ec98d2eb3e003b0aa0` точно совпадает с PR head `3446cbd3`.
Фактический runtime image:
`sha256:349c03e7a7e73c603564f6e22cc86d38dcab598d47081dd95505cbebfc92268f`.
Dependency checksum соответствует прежнему проверенному clean full image 4e18.
Deployment завершён в 15:27:40 UTC; локальный production-pinned CLI обновлён.

## Проверки кода

- `pnpm check`: 3 753 passed, 9 прежних skips, 325 файлов; lint, typecheck
  ratchet и сборка прошли. Это не устранение исторического typecheck debt.
- Пять последовательных Docker-Postgres suites: 45/45, включая 17 новых
  проверок ACL, scope, лимитов, экранирования IDs, snapshot и реального timeout.
- [CI на точном PR head](https://github.com/goslingmanagment/core/actions/runs/34860432177):
  Static, три Integration shard и Quality Gate прошли. Итоговый merge имеет
  идентичное дерево; образ не выдаётся за опубликованный CI artifact.
- Независимые [source review](/Users/dmitriy/.codex/worktrees/hub-fansly-a0-material-cost-read/investigations/fansly-a0-material-cost-read-2026-09-14/REVIEW.md)
  и [preflight](REVIEW-PREFLIGHT.md) завершены без замечаний.

## Production measurement

15:29:34–15:29:45 UTC: ровно один последовательный вызов для каждой из шести
страниц, по 100 newest visible nonempty **текущих stored heads**. Все вызовы
выполнены как `read_only`, в READ ONLY / REPEATABLE READ, с установленными до
SELECT statement timeout 5 s и lock timeout 100 ms. EXECUTE новой функции
доступен; широкого SELECT на messages нет. Raw SQL, identity receipts и планы
сохранены в [material-cost](material-cost/). Ошибок и повторов нет.

| Страница | Heads | Planning, мс | Execution, мс | Shared hit / read blocks |
|---|---:|---:|---:|---:|
| ari-1 | 100 | 1.214 | 30.766 | 557 / 13 |
| lilly-1 | 100 | 1.243 | 49.562 | 514 / 58 |
| lilly-2 | 100 | 1.299 | 33.891 | 563 / 9 |
| lora-1 | 100 | 1.544 | 48.968 | 506 / 66 |
| lora-2 | 100 | 1.231 | 8.618 | 569 / 2 |
| lora-3 | 100 | 1.698 | 53.857 | 524 / 47 |

Execution: **8.618–53.857 мс** на пакет из 100 голов. Это шесть отдельных
наблюдений, не p95/p99 и не нагрузочный тест. Planning и execution взяты из
верхнего уровня EXPLAIN; buffers — из корневого Plan, без повторного сложения
дочерних узлов. Полное время шести SSH/psql вызовов около 11.2 s относится к
транспорту и оболочке измерения, его нельзя выдать за runtime SQL latency.

Выборка текущих stored heads смещена относительно исходного pre-apply запроса
и может прогреть buffers. EXPLAIN содержит instrumentation overhead; ожидание
runtime pool, очереди, запись отчёта и публикация reader здесь не измерены.
Исторические 500-ms/5-s таймауты этим snapshot не объяснены и не опровергнуты.
План не возвращает predicate rows: количество доступных/потерянных сообщений
из этих 600 выбранных IDs не установлено. Запросов к Fansly выполнено 0.

## Настройки и оставшаяся работа

Свежая [UI-квитанция](configuration-read.json) в 15:29:13 UTC показывает
одинаковые desired/reported values на новых api/worker/scheduler: DM shadow
на шести страницах v1, earnings shadow lilly-1 v1, catch-up none v4. Drift и
pendingApply отсутствуют; Save/flip не выполнялись. Точные per-role applied
versions и историческая непрерывность не доказаны.

Стоимость существующего запроса теперь измерена. A0 reader availability
остаётся отдельным пробелом: hot-counter не учитывает archive precedence,
tombstones и content_pending. Такой диагностический follow-up готовится
отдельно, с проверкой против настоящего reader. Исходные A0/C1/C2b clocks,
счётчики наблюдений и закрытые gates сохранены с новой границей runtime.
Экономия HTTP >=50% и event-to-reader latency по-прежнему не измерены.

[Финальная независимая проверка](REVIEW-POST-RELEASE.md) завершена без замечаний. Нового разрешения
на deployment не требуется; для парной W0 пробы ожидается уточнение рабочего
браузерного контейнера lilly-1. B2 не строится.
