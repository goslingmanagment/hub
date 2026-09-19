# Почему медленный деплой Hub

Проверено 12 сентября 2026, 20:30–20:40 UTC. Исследование кода, локальных журналов предыдущих деплоев, live GitHub Actions и production status. Production не изменялся, новые сборки не запускались. Созданы только этот отчёт и сводка CI.

**Главные причины подтверждены: повторная установка браузера из-за неверного ключа Docker-кэша, медленная передача артефактов через пользовательский сетевой маршрут и, в старых прогонах, многоминутная проверка sync health. Обычный source-only деплой уже удавалось выполнить за 2:49. CI — отдельные примерно 10–11 минут.**

Актуальность: checkout `b48f173d`, проверенный remote main `c76c6db0`; рассматриваемые deploy/build/CI файлы между ними одинаковы. Production по label активного контейнера — `96a86c1fcdde`. Dockerfile и CLI script совпадают с checkout; в production revision deploy script дополнен rollback allowlist для 0186, Compose — параметрами запрета логирования значений SQL. Ни одна из этих двух разниц не меняет вывод о build/transport.

**Что измерено**

Время ниже относится к deploy script, без CI, ревью и ожидания владельца. Не все журналы содержат timestamps каждой фазы, поэтому полной аддитивной раскладки для каждого запуска нет.

| Деплой | Режим | Время | Что произошло |
|---|---|---:|---|
| PR161, 9 сентября | dist-only | 13:46 | Успех; два timeout sync health по 150 с |
| PR162, повтор 9 сентября | dist-only | 27:00 | Успех; около 11:28 ушло на sync gate |
| A0, полный после отказа dist-base | full | 11:16 | Успех; browser layer 392,4 с |
| C1 health, 11 сентября | dist-only | 26:04 | Успех; медленный upload, около 7:44 sync gate |
| Membership, 12 сентября | dist-only | **2:49** | Успех; sync gate около 4,7 с |
| Performance, 12 сентября | auto → full, повтор | 9:41 | Успех; Docker cache уже прогрет первой попыткой |

Последний релиз от первой попытки до успеха занял **27:17**, включая отменённую передачу и повторный запуск. Его 9:41 нельзя использовать как benchmark холодной полной сборки.

Источники: [PR161 timing](/Users/dmitriy/code/goose/hub/investigations/fansly-pr161-deploy-2026-09-09/evidence/deploy-meta.json:14), [PR162 retry](/Users/dmitriy/code/goose/hub/investigations/fansly-pr162-release-2026-09-09/evidence/retry-1/deploy-result.json:2), [A0 full dispatch](/Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/evidence/full-build/deploy-dispatch.json:32) и [result](/Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/evidence/full-build/deploy-result.json:2), [C1 health timing](/Users/dmitriy/code/goose/hub/investigations/fansly-c1-deploy-2026-09-11/health-deploy-20260911T191946Z/result.json:3), [membership timing](/Users/dmitriy/code/goose/hub/investigations/fansly-c1-deploy-2026-09-11/membership-deploy-20260912/result.json:2), [performance attempts](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/implementation/deploy-state.json:2).

**1. Номер коммита сбрасывает кэш установки Chromium**

В [Dockerfile:73](/Users/dmitriy/code/goose/hub/Dockerfile:73) runtime `ARG APP_SOURCE_REVISION` объявлен до [RUN установки браузера](/Users/dmitriy/code/goose/hub/Dockerfile:97). Значение аргумента меняется с коммитом. Docker неявно передаёт объявленные ARG в последующие RUN, поэтому этот RUN получает новый cache key, даже без прямого обращения к переменной. Это соответствует [официальному правилу Docker](https://docs.docker.com/reference/dockerfile/#impact-on-build-caching).

В последней первой попытке:

- Docker context 11,41 MB передан локальному builder за 0,2 с — [лог:47](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/implementation/deployment.log:47).
- COPY node_modules использует CACHED; установка Chromium всё равно выполняется.
- Production JS/CSS build — **31,6 с**, параллельно с установкой браузера — [лог:310](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/implementation/deployment.log:310).
- Browser/system dependencies — **400,2 с**. Только скачивание 100 MB apt packages заняло **4:33** — [лог:478](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/implementation/deployment.log:478), [итог:968](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/implementation/deployment.log:968).
- Экспорт образа — ещё 11 с. В предыдущем A0 browser layer занял 392,4 с.

Исправление: перенести **runtime ARG и LABEL** после установки Chromium. Перенести только LABEL недостаточно. При неизменных зависимостях и прогретом кэше измеренный критический путь сборки мог бы сократиться примерно на **6 минут**: этапы 400 и 32 с параллельны, их нельзя складывать. Dockerfile входит в dependency checksum: после изменения потребуется один полный релиз для публикации нового checksum-pinned base, и он ещё установит Chromium с новым ключом кэша. Этот переходный full планируется через winpc; последующие сборки должны переиспользовать браузерный слой. Повтор той же ревизии мог попадать в кэш и до исправления — дефект относится к смене revision.

Приёмка: собрать две разные revision при одинаковых зависимостях; во второй browser RUN должен быть CACHED, revision label — новым; smoke Chromium и запуск startup bundle должны пройти. Полный холодный build также должен оставаться работоспособным.

**2. `auto` выбирает дорогой путь, а full передаёт весь образ**

Режим по умолчанию — full. [Auto branch](/Users/dmitriy/code/goose/hub/scripts/deploy-production.sh:1381) сначала запускает full; dist-only используется только при ошибке самой сборки. При ошибке upload fallback уже не выполняется.

[Full transport](/Users/dmitriy/code/goose/hub/scripts/deploy-production.sh:1154) — `docker save | ssh docker load`. В последней попытке точный архив содержал **364 143 616 bytes**. На маршруте через `utun6` наблюдалось около **83 kB/s**; CPU процессов передачи был около нуля. При постоянной такой скорости передача всего архива заняла бы примерно **73 минуты** — это экстраполяция, реальную попытку отменили раньше. Внутренняя причина ограничения VPN/провайдера не установлена.

Исторический сравнительный замер через winpc: **2 MiB за 1,38 с**, с точным совпадением количества принятых bytes. Это короткий замер, а не обещание скорости длинной загрузки. Gzip exact image уменьшил размер всего на **0,75%**: компрессия полного образа здесь почти ничего не решает. [Transport evidence](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/implementation/transfer-review.md:7), [raw route probe](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/implementation/transfer-route-probe.json:2).

Медленно передавался и dist-only: 11 сентября наблюдалось около 20,14 MB роста распакованного контекста за 344 с. Маленький артефакт снижает объём, но не исправляет плохой маршрут.

Короткий вариант после уточнения плана: **auto не менять**. До перехода на registry явно выбирать существующий `--mode dist-only` при совместимой базе. Сохранить отказ при несовместимой базе, миграционные и rollback проверки. Переработка auto потребовала бы менять контракт, документацию и тесты ради временного пути, который станет необязательным после B.

Вариант B: дополнить существующий CI публикацией в GHCR после Quality Gate и добавить `--mode pull` в существующий deploy script. VPS получает проверенный image digest; это убирает Mac/VPN из доставки и позволяет получать отсутствующие слои. `save | load` сейчас передаёт в том числе node/Chromium, уже находящиеся на VPS. После появления проверенного candidate на VPS сохраняются locks, rollback image, migrations, capabilities, health gates и owner approval. Отдельный workflow-файл не обязателен. Pinned-base/dist-only не нужны самому pull-пути; их удаление из старых режимов не требуется для запуска B.

Есть два небольших, но обязательных связующих изменения. Образ сейчас живёт только в job `static`, а Quality Gate выполняется в другом job: для публикации после gate тот же образ надо передать artifact в publish job существующего workflow, без повторной сборки. Это штатная [передача artifacts между jobs](https://docs.github.com/en/actions/tutorials/store-and-share-data). Также текущая CI-команда не передаёт `APP_SOURCE_REVISION`/`APP_DEPENDENCY_CHECKSUM`, поэтому labels равны `unknown`. CI должен выставлять metadata exact checkout до smoke-тестов, а pull-путь — проверить digest, revision и checksum до quiesce/migrations и использовать release-файлы той же ревизии. Иначе нынешняя сверка labels обнаружит mismatch только после переключения. Нужны ограниченные права publisher/puller; публикация привязана к успешному gate той же ревизии. [Docker CI cache guidance](https://docs.docker.com/build/cache/optimize/) описывает внешний cache, скорость GHCR → VPS ещё надо измерить.

**3. Старые health-задержки реальны, но текущий снимок быстрее**

[Sync gate](/Users/dmitriy/code/goose/hub/scripts/deploy-production.sh:1021) делает до шести запросов по 150 с с паузами. Он принимает 200 или 503 при наличии `pages`: не ждёт устранения всех проблем синхронизации. Исторические timeout действительно случались, это не вывод из максимального таймера.

PR162: три timeout, затем 200 за 144,24 с; от первого запроса до успешного ответа около 11:28. C1 health: два timeout, затем ответ за 133,3 с — всего около 7:44. [PR162 requests](/Users/dmitriy/code/goose/hub/investigations/fansly-pr162-release-2026-09-09/evidence/sync-health-requests-final.json:5), [C1 report](/Users/dmitriy/code/goose/hub/investigations/fansly-c1-deploy-2026-09-11/health-deploy-20260911T191946Z/REPORT.md:50).

Свежая read-only проверка production `96a86c1fcdde`: `/api/v1/health` **200 / 0,052 с**, `/api/v1/health/sync` **200 / 6,373 с**, корректный `pages`. Это один прогретый запрос, не cold-start benchmark и не доказательство устранения всех будущих задержек. Membership deploy ранее 12 сентября также прошёл этот gate примерно за 4,7 с.

Поэтому сокращение таймера сейчас не первоочередная оптимизация. Сначала измерить app-релиз с сохранением работающего Postgres: уменьшение прежних задержек от этого правдоподобно, но комментарий в коде не доказывает их единственную причину. Worker catch-up сохраняется и без рестарта БД. При возврате задержек — профилировать вычисление endpoint и ограничивать работу на сервере с корректной отменой SQL. Один клиентский timeout не гарантирует прекращения SQL.

**4. Пересоздание всей БД и обновление локального CLI удлиняют завершение**

[Compose up](/Users/dmitriy/code/goose/hub/scripts/deploy-production.sh:1608) выполняется с `--force-recreate` без списка сервисов, поэтому пересоздаётся также Postgres. **Сохранение Postgres в обычном app release поднято в A**, вместе с ARG-кэшем: пересоздавать api/worker/scheduler, оставить rollback-путь без изменений. Изменения конфигурации/образа Postgres должны идти явным отдельным путём, не игнорироваться молча. Проверено для установленного Compose 5.3.0: достаточно добавить `api worker scheduler`, чтобы неизменённый Postgres больше не пересоздавался принудительно; все `depends_on: service_healthy` сохраняются. Для зависимостей остаётся стратегия `RecreateDiverged`, поэтому при изменении конфигурации/образа БД или общей инфраструктуры Compose всё ещё может её пересоздать — такие изменения надо выявлять до переключения и относить к отдельной операции. [Исходник выбора стратегии](https://github.com/docker/compose/blob/v5.3.0/cmd/compose/create.go#L125). Добавлять `--no-deps` в минимальный A не требуется: это убрало бы встроенное ожидание Postgres и потребовало отдельной проверки его здоровья. Приёмка: неизменные Postgres container ID/StartedAt, новые app revisions, пройденные migration/health gates, проверенный rollback.

Перед recreate также всегда останавливаются scheduler/worker для исторической миграции 0097. Условное выполнение legacy-quiesce возможно позже, после отдельной проверки fence/rollback гарантий; это не часть минимальной правки recreate.

В последнем конкретном релизе Postgres command действительно изменился, поэтому его restart нельзя считать лишним именно в этой попытке. Длительность экономии этого предложения пока не измерена.

После успешных серверных проверок [CLI updater](/Users/dmitriy/code/goose/hub/scripts/rebuild-hub-cli-prod.sh:100) делает полный `pnpm install --force` в архиве всего монорепозитория. Есть смысл собирать отдельный CLI artifact или устанавливать только его необходимые зависимости. Сохранить проверку server contract hash и атомарное переключение ссылки. Сейчас отсутствует точный timing этого хвоста; обещать минуты экономии нельзя. Установки локально показывают около 1,9 GB каждая по `du`, но это не доказательство уникального занимаемого места из-за возможных shared/hardlinked данных.

**CI отдельно от выкладки**

Проверены восемь последних успешных CI runs 12 сентября: семь PR и один main. Медиана ожидания Quality Gate **10:45**, диапазон **9:12–11:53**. Static checks ограничивает завершение в 7/8; очередь runner 2–3 с, install dependencies 3–5 с. Источник: [сохранённые timings](/Users/dmitriy/code/goose/hub/investigations/deploy-latency-2026-09-12/ci-timings.json), [последний run](https://github.com/goslingmanagment/core/actions/runs/34716212438).

| Этап static | Медиана |
|---|---:|
| Unit tests | 5:28 |
| Docker build | 1:49 |
| Отдельный production build | 1:20 |
| Отдельный Typecheck | 0:56 |
| Lint | 0:26 |

Host production build повторяется внутри Docker; результаты host dist исключены из Docker context. Удаление этой дублирующей сборки при сохранении полного root Typecheck и Docker build/smoke моделирует около **1:20** экономии общего gate. Вынос unit tests в отдельный обязательный job моделирует около **1:27**. Это альтернативные оценки по текущим durations, не измерения после правки; они не складываются, поскольку затем ограничивает integration, самая медленная shard — около **9:10**.

Полный root Typecheck нельзя считать покрытым Docker build: Docker context не включает весь тестовый workspace. Для дальнейшего ускорения надо одновременно работать со static и балансировкой integration shards; сохранить текущий состав проверок, изоляцию БД и обязательный Quality Gate. Внешний Docker cache полезен, но весь Docker CI step сейчас около 1:49 и не даёт сам по себе большого сокращения общего gate.

**Предлагаемый порядок**

| Вариант | Изменение | Ожидаемый эффект | Ограничения |
|---|---|---|---|
| A — небольшой патч текущего пути | Исправить ARG-кэш; сохранять Postgres при app release; добавить timings. Auto оставить как есть, совместимый dist-only выбирать явно | Убрать около 6 минут из повторной full-сборки; избежать холодного старта БД. Цель обычного deploy после CI — 2–5 минут, опираясь на измеренные 2:49 | Один переходный full через winpc; влияние сохранения Postgres на health нужно измерить. Rollback не менять |
| B — замена доставки | Публикация того же проверенного образа в GHCR после gate существующего CI; `--mode pull` того же deploy script | Убрать повторную локальную сборку и зависимость доставки от Mac/VPN; передавать отсутствующие слои | Нужны artifact между jobs, корректные image labels и проверка digest/source до переключения. Owner gate сохраняется |
| C — отдельная работа над CI | Убрать duplicate build, вынести unit job, затем балансировать integration | Сначала примерно 1–2 минуты общего gate; следующие выигрыши требуют работы над integration | За рамками A/B; не удалять обязательные проверки и не складывать модель экономии по шагам |

Я бы начал с A, затем B. C полезен отдельно, но не объясняет 26–35 минут самого deploy script. Сразу добавить timestamps/durations для build, upload, migrate, recreate, каждого gate и CLI; фиксировать bytes/throughput, итог «production verified» до локальной установки CLI. При отмене upload привязывать завершение удалённого importer к конкретной попытке и проверять, что повтор не оставляет старый importer: в последнем инциденте такой процесс остался, однако точный внутренний lock Docker не доказан.

Production snapshot около 20:36 UTC: API/worker/scheduler/Postgres healthy; VPS 2 CPU / 8 GB, load 0,71/0,79/0,82, около 20 GiB свободно, около 4 GB available memory. Это текущий снимок, не историческое доказательство отсутствия перегрузки. Измеренные главные задержки располагаются до переключения сервисов и в старых проверках здоровья; оснований начинать с покупки более мощного VPS этот аудит не дал.
