# Независимая оценка PostgreSQL logging — 2026-09-12

**Поддерживаю P2: включение slow-query logging вместе с `log_parameter_max_length=-1` нарушило существующую границу server logs. Запись сырых bind-параметров подтверждается сохранённой выборкой. Утечка конкретного пароля, prompt/completion или тела сообщения не установлена.**

Оценка сделана по сохранённым данным координатора и исходникам в `hub-regression-audit-20260912` на `c76c6db0`. Новых обращений к production и чтения содержимого SQL-параметров не было. Это отдельный finding; снятый P2 о времени очереди проекций к нему не относится.

## Доказательства и причинная цепочка

1. В снимке до оптимизации `log_min_duration_statement=-1` — журналирование длительных запросов выключено: [report-astra.md:551](/Users/dmitriy/code/goose/hub/docs/diag/2026-09-11-agency-hub-load/reports/report-astra.md:551), время снимка 2026-09-11 19:13:30 UTC.
2. Решение о производительности явно включает `log_min_duration_statement=2000` через постоянную конфигурацию PostgreSQL: [decisions.md:12345](/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912/docs/decisions.md:12345). Вместе с ним ограничение bind-параметров не зафиксировано.
3. Снимок от 2026-09-12 16:25:30 UTC показывает `log_min_duration_statement=2000`, `log_parameter_max_length=-1`, `log_parameter_max_length_on_error=0`, `log_statement=none`: [postgres-log-boundary.json:5](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/reviews/postgres-log-boundary.json:5). Для обычных сообщений о длительных запросах `-1` означает отсутствие ограничения bind-значений. Настройка `*_on_error` управляет другим путём, поэтому её ноль не закрывает slow-query logging. `log_statement=none` также не отменяет журналирование по длительности.
4. В сохранённой 30-минутной выборке из 566 строк PostgreSQL Docker logs найдено 7 строк `DETAIL: parameters`, максимальная длина 2952 символа, и 11 строк длительностей ([json:8](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/reviews/postgres-log-boundary.json:8)). Содержимое параметров не возвращалось. Это подтверждает работающий канал записи значений в logs, а не только риск по настройкам.
5. Запрет был до оптимизации и сохранился: [error-handling.md:387](/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912/docs/error-handling.md:387) относит raw SQL parameters к `Never allowed` для `Server log`. Та же строка отдельно проверена через `git show c0cd21c3:docs/error-handling.md`; правило не было введено после найденного изменения.

## Почему существующая redaction не защищает этот путь

Runtime строит Pino в [bootstrap.ts:318](/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912/apps/runtime/src/bootstrap.ts:318); redaction полей и сериализованных ошибок выполняется в [logger.ts:61](/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912/packages/shared/src/logger.ts:61). Эта защита действует на сообщения процесса runtime.

PostgreSQL запущен отдельным контейнером `postgres:16` и отдаёт вывод непосредственно Docker logging driver `local`: [docker-compose.production.yml:1](/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912/docker-compose.production.yml:1), [строка 8](/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912/docker-compose.production.yml:8). В показанной конфигурации нет фильтра/прокси, который перед записью прогоняет stderr PostgreSQL через Pino. Поиск по Compose, scripts, apps и packages не нашёл отдельной настройки для исключения параметров из PostgreSQL logs. Наличие Docker-ротации ограничивает объём, но не редактирует значения.

Обычный DB-клиент также не является таким фильтром: [client.ts:120](/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912/packages/db/src/client.ts:120) создаёт Drizzle поверх pg; сервер PostgreSQL уже получил bind-значения для исполнения запроса. Клиентская redaction throwable не может убрать их из отдельного серверного сообщения PostgreSQL.

Отдельной разрешённой области хранения сырых параметров в PostgreSQL logs не найдено. Решение о диагностике сохраняет slow-query logging, но не меняет канон границ данных. Для содержания есть специально ограниченные источники: например, `restricted_ai` в [capture-payloads.ts:52](/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912/packages/db/src/repositories/capture-payloads.ts:52). Операционный Docker log в этот класс не входит.

## Воздействие и точные пределы утверждения

Это воспроизводимый обход установленной границы хранения: любой bind может попасть в операционный лог при медленном запросе. В приложении значения параметров не ограничены только техническими ID: обычный observation writer передаёт JSON тела как параметр ([observations.ts:225](/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912/packages/db/src/repositories/observations.ts:225)); restricted AI writer передаёт prompt/completion в insert ([ai-restricted.ts:24](/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912/packages/db/src/repositories/ai-restricted.ts:24), [строка 33](/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912/packages/db/src/repositories/ai-restricted.ts:33)). Эти пути объясняют значимость границы, **но не доказывают, что именно они уже выгрузили содержание в выбранный log window**.

В сохранённой выборке нет строк SQL, называющих `ai_generation_content`; четыре строки с `observations` не позволяют установить содержание связанного bind. Не определены суммарный объём параметров с момента включения, круг фактических читателей Docker logs и наличие конкретных чувствительных значений. Поэтому оценка P2 относится к уже работающему каналу записи raw parameters, не к доказанному внешнему раскрытию содержимого.

## Узкое исправление и проверка

Нужно установить постоянное `log_parameter_max_length=0`, сохранив `log_min_duration_statement=2000` и действующее `log_parameter_max_length_on_error=0`. Это отключает запись bind-значений на найденном пути и сохраняет SQL-шаблон/длительность для диагностики. Положительное ограничение длины не выполняет правило: оно оставит в логе начало raw parameter.

После применения проверить фактическую настройку для рабочих соединений и новую выборку, в которой встречаются медленные параметризованные запросы, но нет строк с bind-значениями. Наличие только быстрых запросов не будет достаточной проверкой. `log_parameter_max_length=0` относится именно к bind-значениям; оно не является универсальным sanitizer произвольных SQL-литералов.

Настройка production здесь не менялась. Судьба уже записанных logs — отдельное действие после оценки их содержания/доступа, а не повод уничтожать диагностическое свидетельство во время аудита.
