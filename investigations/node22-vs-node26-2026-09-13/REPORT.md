# Node 22 → Node 26: проверка для Hub

13 сентября 2026. **На production Node 22.23.2. В локальном сравнении Node 26.7.0 ускорила проверенные JSON/codec операции; ускорение всего Hub и снижение расходов ещё не измерены.**

## Какая версия работает

В 03:15 МСК выполнен read-only `docker exec ... node -p` во всех трёх контейнерах: API, worker и scheduler работают на Node **22.23.2**, V8 **12.4.254.21-node.56**, Linux **x64**. [Полный результат](/Users/dmitriy/code/goose/hub/investigations/node22-vs-node26-2026-09-13/production-runtime.json).

В локальном shell Mac: Node **26.7.0**, V8 **14.6.202.34-node.28**, Darwin arm64. Версию сервера определяет Docker image. Node 22 также закреплена в [Dockerfile](/Users/dmitriy/code/goose/hub/Dockerfile:3), [deploy script](/Users/dmitriy/code/goose/hub/scripts/deploy-production.sh:110), [CI](/Users/dmitriy/code/goose/hub/.github/workflows/ci.yml:33) и [решении о runtime](/Users/dmitriy/code/goose/hub/docs/decisions.md:294).

## Одинаковый локальный стенд

Две официальные Docker-сборки Debian bookworm slim, одна Linux arm64 VM на Mac, network=none, 1 CPU, 512 MiB, readonly source mount. Шесть последовательных свежих контейнеров: 22,26,26,22,22,26. По 100 прогревочных и 200 измеряемых вызовов каждой функции в каждом запуске; порядок функций чередовался. Таблица — медиана трёх медиан, миллисекунды на вызов.

Пакет dm25 содержит 25 синтетических сообщений с текстом и media; catalog500 — 500 синтетических элементов каталога. Это fixtures предыдущего аудита, не текущие тела конкретного аккаунта. Использован неизменённый codec из рабочего дерева и отдельно его предложенная оптимизация — заменить только ручной encodeString на JSON.stringify строки.

| Fixture | Операция | Node22, мс | Node26, мс | Ускорение |
|---|---|---:|---:|---:|
| dm25 | Текущий canonical capture codec | 1.7905 | 0.4198 | 4.27× |
| dm25 | Codec с предлагаемой правкой encodeString | 0.1838 | 0.0900 | 2.04× |
| dm25 | Обычный JSON.stringify | 0.0577 | 0.0267 | 2.16× |
| dm25 | Обычный JSON.parse | 0.0380 | 0.0330 | 1.15× |
| catalog500 | Текущий canonical capture codec | 5.8957 | 3.7196 | 1.59× |
| catalog500 | Codec с предлагаемой правкой encodeString | 1.4382 | 1.0180 | 1.41× |
| catalog500 | Обычный JSON.stringify | 0.2283 | 0.1464 | 1.56× |
| catalog500 | Обычный JSON.parse | 0.3348 | 0.2258 | 1.48× |

При одинаковой Node22 оптимизация codec сама по себе остаётся полезной; на уже оптимизированном варианте Node26 даёт ещё **1,41–2,04×** именно для этой функции. Это разные сравнения. Прежние замеры с 3 прогревами/15 образцами и Mac-versus-Docker не использованы для расчёта перехода 22→26.

На обеих версиях сохранено равенство старого и предлагаемого codec в **86 807 byte cases +11 invalid/error cases** за запуск. Digests выходов измеряемых fixtures совпали между версиями. Это проверка конкретных входов, не доказательство совместимости всего приложения.

Полные измерения, CPU time и разброс трёх запусков: [results.json](/Users/dmitriy/code/goose/hub/investigations/node22-vs-node26-2026-09-13/results.json); [воспроизводимый runner](/Users/dmitriy/code/goose/hub/investigations/node22-vs-node26-2026-09-13/run.py). Image digests закреплены в результатах. Текущий source SHA256: `22b33b42ab7ac2628d37c54052e3a36c060f2bd20fba8c43567f11c02d92f75c`.

**Ограничения:** production x64, локальный benchmark arm64; общая нагрузка Mac и CPU quota могут влиять на GC и wall time. Медиана отдельного вызова не включает всю стоимость фонового GC, поэтому в JSON отдельно сохранён общий process CPU на операцию. Не измерялись whole-app throughput, RSS под реальной нагрузкой, p95 sync, PostgreSQL, HTTP и provider credits. Переносить 4,3× на весь Hub нельзя.

## Почему возможен выигрыш и где его границы

Node26 содержит V8 14.6. В новых V8 улучшены обработка строк и JSON, включая быстрый проход для обычных объектов и повторяющихся форм; некоторые улучшения затрагивают JSON.parse. Публичный результат V8 относится к отдельному benchmark, а не Hub. Наши таблицы получены независимо. [Node26 release notes](https://nodejs.org/en/blog/release/v26.0.0), [V8 JSON optimizations и ограничения](https://v8.dev/blog/json-stringify).

В Hub есть прямые вызовы JSON.stringify, например запись [observations.payload](/Users/dmitriy/code/goose/hub/packages/db/src/repositories/observations.ts:225). Поэтому направление применимо. Однако конкретную причину всего измеренного ускорения ручного codec мы не изолировали: различаются V8/JIT/GC и версии runtime в целом.

SQL-планы, число jobs, HTTP-вызовов и rate limits от смены Node сами не меняются. Fansly импортирует fetch из отдельно установленного [undici](/Users/dmitriy/code/goose/hub/packages/fansly/src/adapter.ts:4), [версия ^7.27.2](/Users/dmitriy/code/goose/hub/apps/runtime/package.json:29); обновление встроенного Undici до8 не заменит эту зависимость автоматически.

Денежный эффект зависит от доли CPU в полной работе и возможности сократить платное потребление. На прежнем VPS-тарифе счёт может остаться тем же; выигрыш даст запас CPU и меньшую задержку обработки. Подтверждённого процента экономии всего сервера нет.

## Что потребуется для перехода

1. **Поправить установку pnpm/Corepack.** [Dockerfile:13](/Users/dmitriy/code/goose/hub/Dockerfile:13) и [:41](/Users/dmitriy/code/goose/hub/Dockerfile:41) вызывают corepack enable. Начиная с Node25 Corepack не входит в дистрибутив. В скачанном официальном Node26 image вызов corepack --version воспроизвёл exit127: executable file not found. Нужна явная закреплённая установка Corepack или pnpm; прежняя простая замена base image ломает сборку. [Официальный Corepack README](https://github.com/nodejs/corepack#default-installs).
2. **Согласовать build и CI.** Сначала можно оставить esbuild target node22: новые возможности языка для проверки runtime не нужны. Полная сборка должна заново установить production dependencies для целевой Linux x64 среды; dist-only поверх старого runtime не является обновлением Node.
3. **Проверить реальные зависимости и поведение.** В первую очередь DuckDB, argon2, Playwright, TLS/proxy, AsyncLocalStorage, shutdown/lease loss, затем обычные проверки проекта. Node-API уменьшает ABI-риск, но не заменяет проверку загрузки native-модулей. Эти проверки в данной оценке не запускались.
4. **Сравнить один и тот же workload перед выпуском.** Полезно завершённые captures/jobs, CPU, event-loop lag, GC/RSS, p95 capture→material, ошибки и старая задолженность. Это даст оценку эффекта на систему.

На 13.09.2026 Node26 — **Current**, LTS запланирован на **28.10.2026**. Node22 находится в Maintenance LTS до **30.04.2027**. Поэтому переход стоит подготовить и проверить; для штатного production-перехода разумно ориентироваться на Node26 LTS, если раньше не появится измеренная причина. [Официальный release schedule](https://github.com/nodejs/Release/blob/main/schedule.json).

В этой задаче менялись только исследовательские артефакты; официальный Node26 image скачан локально. Продукт, CI, зависимости проекта и production не изменены.
