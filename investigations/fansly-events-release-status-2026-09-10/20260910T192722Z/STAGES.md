# Fansly events — результат продолжения работы

Срез GitHub: 2026-09-10T19:36:49.987731+00:00. Read-only срез production: 2026-09-10 19:27:24 UTC.

C2b слит: [PR169](https://github.com/goslingmanagment/core/pull/169),
merge `5ae757547900c54959f57fe4c767a6c5425011af`.
Проверенный head: `9d09af4b0932d3d21884b8f473af9bffa7fbb499`.

Изменение транзакции и обе отметки на обновление earnings сохраняются атомарно.
Ответы lifetime/monthly имеют отдельные результаты и ревизии; R+1 не теряется
при завершении R. Ошибка записи диагностики не заменяет HTTP 404/429 провайдера.
Неизменившийся или пустой снимок после сигнала остаётся неподтверждённым.
Старый daily-обход сохранён; дополнительных provider-запросов код не добавляет.
Самый большой новый production-модуль — 184 строки, ширина новых модулей ≤109.

## Проверки

- C2b: `pnpm check` — 3190 passed, 291 unit-файл, 9 существующих skips;
  Docker-Postgres — 57 passed в 10 файлах, 0 skips. Проверены rollback
  транзакции, old/new bindings, гонки R/R+1, независимые endpoints, capture
  перед второй ошибкой, HTTP 404/429 при сбое записи результата, reader
  permissions и erasure на двух страницах с одинаковым transaction ID.
- Независимое ревью C2b закрыто; все находки исправлены. Все пять GitHub CI
  checks зелёные: [run 34519992345](https://github.com/goslingmanagment/core/actions/runs/34519992345).
- C1 после синхронизации с main: 3190 unit + 50 Docker-Postgres, все пять CI
  checks зелёные на `5e13b7fa`. Стадия остаётся draft до production RCA/фикса.
- W0 после синхронизации с main: 3214 unit + 10 существующих Docker-Postgres
  regression checks, все пять CI зелёные на `d80c91d2`. Это offline-проверка.
- Strictness budget не увеличен: 1908 известных ошибок в 121 старом файле.
  Все новые файлы проходят ratchet; lint/build проходят.

## Состояние плана

| Этап | Состояние | Непокрытый остаток / следующий gate |
|---|---|---|
| Pre-A0 | Исправления PR157–162 deployed; канарейка завершена и выключена | Канарейка: 0 eligible / 0 recovery attempts; эффективность не измерена. Проверенные 8/8 сообщений были захвачены обычным сбором до включения. Старые расхождения других страниц не объявлены закрытыми. |
| A0/T0 — PR164 | Merged, не deployed | Выгрузка сохранённого корпуса за 1–6 сентября, офлайн-анализ, затем ≥7 полных суток shadow на всех шести страницах. |
| C1 — PR166 | Draft; диагностическая часть tested/reviewed | Production timeline трёх trigger-веток и узкий фикс в том же PR. |
| C2a — PR165 | Merged, не deployed | Совместимые readers, v7 replay всего retained корпуса, сверка/repair. |
| C2b — PR169 | Merged, флаг по умолчанию none; не deployed | Одностраничный shadow и измерение коррекций/возраста/потерь результатов. |
| C2c | Gated | Quiet corrections в прежний срок свежести либо отдельное принятие нового max-age. |
| W0 — PR167 | Draft; offline diagnostics готовы | Live Management Session binding, fan-out, независимая presence-проверка, ≥6 часов continuity/gaps. |
| B0 → B1 | Gated | Сначала W0; далее ≥7 суток durable shadow, parity, бюджеты и latency. |
| A1 | Gated | A0/T0 evidence и отдельное yes. |
| B2 | Не строился | Отдельное решение владельца. |

Экономия физических запросов и latency свежих событий не измерены ни на одном
из новых этапов. Цель ≥50% не объявлена достигнутой. Старые sampled repair bounds
не подменяют распределение задержки свежих событий.

## Production и действие владельца

В production всё ещё PR162: image
`sha256:893cc4cc7fd2fadfd0afa204dd10c188b62449201adf4e668c7c1e2fd597a513`,
source label `8b25d57e5d13`. API/worker/scheduler healthy, restarts 0/0/1,
свободно 28 GiB. Читались только Docker metadata, свободный диск и loopback
health; запросов к БД, деплоя, replay, socket connection и flag flip не было.
Это проверка состояния развёртывания, не измерение поведения C2b.

Следующий production gate из исходного задания — конкретный одобренный deploy.
Для A0-only цель остаётся PR164 / `a3caa0e9`, затем export и отдельное включение
shadow. Последующий source с C2a/C2b требует совместимых readers и явного учёта
v7 reparsing при старте worker. C1/W0 сохраняют собственные gates. Слияние PR169
не является разрешением выполнить эти операции.

Источники текущего среза: [runtime.txt](runtime.txt),
[pull-requests.json](pull-requests.json). Подробный C2b runbook и evidence входят
в PR169. Сводка не переписывает исходные исследовательские выводы и календарные gates.
