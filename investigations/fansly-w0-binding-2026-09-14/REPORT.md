# W0 REST identity prerequisite — итог PR197

[PR197](https://github.com/goslingmanagment/core/pull/197) слит **14 сентября
2026, 19:43:34 UTC**. Merge commit:
`1d0ed3cf8232c24f659d37db9ceda21d65d09dd3`. Его tree совпадает с проверенным
HEAD `9f727fe17464158c6c7136b78bb414b27f841d47`:
`51ad62cb352a709a1615a162626fe999be6ff9b4`.

Подготовлен отдельный операторский preflight: один GET account/me через
существующую сессию и маршрут страницы; ограниченные время/размер ответа;
проверка account ID; безопасный приватный receipt. Receiver сверяет этот
receipt и generation перед подключением. Для continuity receipt обязателен,
для прежнего short-вызова — опционален. Известные отказы сохраняют причину
и нулевое число попыток socket. D336 и оба runbook обновлены.

## Проверки и предел доказательства

- `pnpm check`: **3821 passed, 9 skipped, 333 файла**, lint и dashboard build
  прошли. Typecheck ratchet сохраняет прежние 1897 ошибок в бюджете, нового
  долга нет.
- Docker-PostgreSQL suite: **16 passed**. Проверены согласованность account,
  session и route в READ ONLY / REPEATABLE READ snapshot и отсутствие
  изменений проверенных captured facts, credentials и pacing state.
- Transport suite: **15 passed**, также входит в итоговый unit run. Реальные
  локальные HTTP CONNECT/SOCKS соединения проверяют точный GET, headers,
  отказ redirect/retry/direct fallback, неверный account, HTTP ошибки,
  deadline/body limit, cancellation, proxy/TLS failure и redaction.
- Python launcher suites: **4 + 10 + 8 passed**. Admission, приватные копии,
  отмена и cleanup собственного контейнера; Docker там заменён fixtures.
- Три операторских bundle собраны; offline invalid-args проверки возвращают
  ожидаемый безопасный отказ до обращения к configuration/provider.
- [CI run](https://github.com/goslingmanagment/core/actions/runs/34887226869):
  **все пять обязательных checks SUCCESS**, включая три integration shards.
  Publish checked production image пропущен для PR согласно workflow.
- Независимое ревью исправило P3 о потерянном refusal receipt; повторное
  ревью не нашло оставшихся P1/P2/P3. SHA всех 30 изменённых файлов сверены
  с коммитом; после squash merge совпадение tree проверено повторно.

Исходные неуспешные локальные прогоны сохранены в validation: исправлены
fixture SQL column, interception тестового dispatcher и учёт Node loader
warning в CLI assertion. Итоговый `pnpm check` успешен; эти старые failures
не скрыты и не засчитаны как успешные прогоны.

## Production и следующий gate

Этот PR меняет операторские инструменты; новые модули используются только
W0 scripts. Production deployment, flag flip, socket probe и REST preflight
в рамках этого PR не выполнялись. Новых production measurements нет.
Сервисы перезапускать для подготовки этих bundles не требуется.

Общий W0 ещё не принят. Нужны живой generation-bound REST receipt,
paired delivery, независимый взгляд на presence, ≥6 часов continuity
и recovery receipts. Lilly-1 подходит для paired delivery; для проверки
её статуса извне нужен другой готовый аккаунт-наблюдатель. Владелец выбрал Ari как наблюдателя; конкретный браузерный контекст
ещё проверяется. Этот выбор не является измерением presence. Browser/proxy inspection остановлен; настройки
не менялись. Разрешение на deploy не подменяет недостающие live prerequisites.

## Состояние миграции

Строки ниже используют датированные результаты из
[независимого аудита gates](REMAINING-GATES.md) и прежней
[сводки](../fansly-a0-deploy-2026-09-11/PROGRESS-20260914.md).
Это не новый атомарный production snapshot. Результат merge выше заменяет
только устаревший статус CI pending в аудите gates.

| Stage | State | Что остаётся |
| --- | --- | --- |
| Pre-A0 | Исправления deployed; исходный bounded corpus принят | Recovery canary без eligible targets не измерила efficacy. |
| T0 | Учёт physical attempts доступен | Нет сопоставимого optimized cohort для savings. |
| A0 | Shadow; current candidate NO-GO | Расхождения и недостаточное валидное покрытие; исходный clock сохранён. |
| A1 | Gated | Full polling остаётся; календарный срок не принимает unsafe stop. |
| W0 | Инструменты PR195/197 merged; live acceptance pending | Binding, paired delivery/presence, continuity и recovery. |
| B0 | Gated by W0 | Durable capture, собственные ≥7 суток и достаточный корпус. |
| B1 | Gated by B0 | Hints, causal cost/latency и history fairness. |
| C1 | Диагностика deployed; policy не принята | Доказанный redundant-work кандидат и presence freshness. |
| C2a | Bounded parity принят | Это историческое ограниченное сравнение. |
| C2b | 1/2 qualifying daily walks | Ещё один естественный qualifying completion; scope неполон. |
| C2c | Gated | Quiet corrections, per-fan max-age и physical cost. |
| B2 | Parked | Отдельное решение владельца. |

A0 календарная точка остаётся **17 сентября 22:58:33.610 UTC**; она не
превращает старые пробелы и новую instrumentation в семь валидных дней.
Закрытый C1 Lora-2 follow-up run751279 (8140/8140, requested=false) не
прибавляется повторно к cumulative cohort и не доказывает suppression policy.

| Измерение | Результат | Scope |
| --- | --- | --- |
| SQL cost PR193 | 8.618–53.857 ms | Шесть отдельных samples по 100 current heads; inner SQL. |
| SQL cost PR196 | 4.818–143.473 ms | Другие шесть samples/cache states; inner SQL. |
| Реализованная HTTP-экономия | Не измерена | Цель ≥50% не объявлена достигнутой. |
| Event → reader p95/p99 | Не измерены | Живой event ingestion и paired evidence не установлены. |

Непокрыты: старые A0 receipt gaps, точная историческая missing-head
атрибуция, deletion/old-edit coverage, mutable offsets, quiet corrections,
untracked fans, presence freshness, live session scope и outage recovery.
Новых обязательных локальных code slices перед ближайшим gate аудит не
нашёл. Общая цель остаётся незавершённой; B0/B1 будут реализованы после
выполнения их prerequisites, B2 не включён в текущую работу.
