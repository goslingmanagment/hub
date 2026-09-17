# Проверка оптимизаций CI после Decisions 359–360

Проверено 16 сентября 2026, около 19:07 MSK. Ревизия: `cb4539d372ce7bce8fc67bff931c600cdec97149` (#224), включающая #222 и #223. Исследован удалённый main через git objects и GitHub API; рабочий checkout старее и содержит чужие изменения. Workflow, настройки GitHub, production и активные запуски не изменялись. Платные проверки не запускались.

**Вывод:** повторные проверки действительно стали существенно дешевле. Два PR с прежним fingerprint использовали по 2 округлённые runner-минуты, два merge в main с успешной публикацией — по 7. Полный новый gate всё ещё требует 43–46 минут. Перед дальнейшими сокращениями стоит исправить три дефекта: несогласованность fingerprint с ESLint, потерю backend typecheck при full-deploy и перенос skip-маркеров в squash-сообщения.

## Что внедрено и подтверждено

| Изменение | Подтверждение | Ограничение |
|---|---|---|
| Повторное использование Quality Gate по хешу дерева | Два PR пропустили static/integration и получили gate на основании прежнего run; хеши d1513c5e и cb4539d3 совпадают | Доказательство хранится 30 дней; новый код всё ещё запускает полный gate |
| Повторные тесты после merge убраны | На двух main-запусках integration, lint, backend typecheck, contracts и unit пропущены | Сборка образа и публикация сохраняются |
| Убраны два повторных backend typecheck | CI вызывает typecheck один раз, host/Docker вызывают build:artifacts | Dashboard build по-прежнему включает собственный `tsc -b` |
| Исправлена публикация при skipped dependencies | После #223 publish завершился успешно на двух main-запусках | Первый main после #222, 2290ffb3, действительно остался без публикации |
| Nightly: полный API шесть дней, весь suite по понедельникам/вручную | Проверены cron, условия jobs и scripts; сейчас нет вложенных integration-файлов, выпадающих из root glob | После изменения ещё не было планового запуска: экономия пока не измерена |
| PR integration fail-fast | Включён только для pull_request | После изменения ещё не наблюдал красного PR, который продемонстрировал отмену |
| WIP push с skip-маркером и rerun только failed jobs | Правило добавлено в CLAUDE.md | Это инструкция агентам, а не автоматическая защита; ниже найден дефект |

Уже существовали pnpm cache, отмена устаревших PR runs, три интеграционных шарда, общий Postgres с клонированием БД и краткий срок хранения образов. Считать их новой экономией #222–223 нельзя.

## Свежие измерения

Минуты ниже — **расчёт суммы `ceil(job_duration / 60)` по реально выполненным jobs**, не продолжительность ожидания PR и не новый выгруженный счёт GitHub. Skipped jobs не учитываются. Выборка маленькая, поэтому месячное снижение на 40% пока остаётся прогнозом.

| Run | Режим | Runner-минуты | Результат |
|---|---|---:|---|
| [35111827978](https://github.com/goslingmanagment/core/actions/runs/35111827978) | Новый полный gate | 46 | Успех, записан proof |
| [35113367491](https://github.com/goslingmanagment/core/actions/runs/35113367491) | PR с прежним proof | 2 | Успех |
| [35113902586](https://github.com/goslingmanagment/core/actions/runs/35113902586) | Main после #222 | 6 | Gate зелёный, publish ошибочно пропущен |
| [35116418880](https://github.com/goslingmanagment/core/actions/runs/35116418880) | Новый полный gate #223 | 43 | Успех, записан proof |
| [35117837273](https://github.com/goslingmanagment/core/actions/runs/35117837273) | Main после #223 | 7 | Образ опубликован |
| [35118958478](https://github.com/goslingmanagment/core/actions/runs/35118958478) | PR #224, только evidence | 2 | Успех по прежнему proof |
| [35119077999](https://github.com/goslingmanagment/core/actions/runs/35119077999) | Main после #224 | 7 | Образ опубликован |

На main d1513c5e опубликован `ghcr.io/goslingmanagment/core/runtime@sha256:185dcd14ef373227f9855f3d35dd3ff333e173a658152306a1f9a7774a236fcd`. В job проверены image ID, revision, dependency checksum и linux/amd64.

Основной остаток цены полного run #223:

- Integration jobs: 696 + 515 + 473 секунды, **29 округлённых минут из 43**.
- Static: 709 секунд, 12 минут. Внутри unit tests — 469 секунд; typecheck — 57; lint — 30; host production build — 32; Docker build — 86.
- Unit: 350 файлов; 4125 passed, 9 skipped. Vitest сообщает import 267.50s против tests 129.77s. Это направление профилирования, а не обещание убрать все 267 секунд.
- DB shards: 79/78/78 файлов, все прошли. API subset: 27 passed, 77 skipped; nightly теперь исполняет весь файл из 104 тестов.
- Install dependencies уже занимает лишь 3–6 секунд на job. Дальнейшее усложнение pnpm cache сейчас малополезно.

## Три дефекта, которые нужно исправить первыми

### 1. Fingerprint может переиспользовать зелёный gate для дерева с новой lint-ошибкой

`scripts/ci-gate-fingerprint.sh:24` исключает **весь** `investigations/`. Но `pnpm lint` выполняет `eslint .`, а `eslint.config.mjs:46–63` не исключает investigations и даже содержит специальное правило для evidence JavaScript. Аналогично blanket-exclusions требуют проверки других читающих инструментов, а не только tests.

**Воспроизведено локально в временном git fixture с текущими script и ESLint config:** добавлен `investigations/repro.mjs` с `const unusedEvidence = 1;`. Fingerprint до и после одинаковый; ESLint завершился с exit 1 (`@typescript-eslint/no-unused-vars`). Значит, при существующем proof PR будет зелёным, хотя обычный gate на тех же файлах красный. Следующая полная проверка другого изменения может внезапно получить этот отложенный долг.

Текущий pin `tests/ci-gate-fingerprint.test.ts` сканирует только прямые файловые чтения в tests; он не проверяет ESLint inputs. Поэтому 61 существующий policy/fingerprint тест проходят, несмотря на воспроизведённую дыру.

**Исправление:** согласовать exclusion-list со всеми inputs gate. Минимальный консервативный вариант — включить в fingerprint lint-обрабатываемый код внутри исключённых каталогов, продолжая игнорировать обычную прозу. Если evidence принципиально не должен проверяться линтером, это отдельное явное изменение lint scope. Добавить поведенческий regression test на этот случай.

Evidence: `evidence/fingerprint-lint-repro.json`; исходники сохранены в `evidence/source/`.

### 2. Full/auto deploy потерял проверку типов backend

В #222 Dockerfile:69 заменил `pnpm build:production` на `pnpm build:artifacts`. При этом `scripts/deploy-production.sh:1185–1195` в `build_full_candidate_image()` напрямую вызывает docker build, без внешнего `pnpm typecheck`. Этот путь используют default `--mode full` и успешная full-ветка `--mode auto` (1489–1513).

`pnpm build:production` сохранился **только в dist-only** (1363). Утверждение Decision 359 «release built outside CI is still typechecked» поэтому неверно для full/auto. Backend собирается esbuild; dashboard отдельно сохраняет собственный `tsc -b`, так что речь именно о потере backend strictness-ratchet.

**Исправление:** сохранить typecheck по умолчанию для прямой Docker/full-сборки, предоставив CI явный способ пропустить уже выполненную проверку; либо обеспечить обязательный backend typecheck перед всеми локальными release-сборками. Первый вариант покрывает и прямой `docker build`. Нужен тест обоих путей. Production deploy и реальная сборка с намеренной ошибкой не запускались; вывод основан на полном вызовном пути и diff.

### 3. WIP skip-маркер может отключить CI и публикацию на main

Live repo settings: `squash_merge_commit_message=COMMIT_MESSAGES`, `squash_merge_commit_title=COMMIT_OR_PR_TITLE`. По умолчанию squash включает сообщения исходных коммитов. Следовательно, даже если **последний** ready-коммит уже без маркера, `[skip ci]` из **раннего WIP-коммита** может попасть в squash body и подавить push workflow на main.

Это шире предупреждения в CLAUDE.md о PR title/body. Также фраза «skip на последнем commit безвреден, main выполнит gate» неверна: активный ruleset `main-required-ci` требует Quality Gate; skipped PR workflow не создаёт успешной проверки для нового head. GitHub прямо описывает pending/blocking поведение.

**Исправление:** не рассчитывать на сообщения коммитов как безопасный автоматический регулятор. Для WIP предпочтительны Draft PR с явно настроенным `ready_for_review` либо отдельное условие запуска тяжёлых jobs с сохранённым обязательным gate. Если маркеры сохраняются, убрать их из автоматически формируемого squash-сообщения и проверять именно итоговый текст; поправить инструкцию агентам. Настройки репозитория в рамках аудита не менялись.

Источники: [GitHub: skip workflow runs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs), [GitHub: squash commit messages](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/configuring-commit-squashing-for-pull-requests), `evidence/repo-settings.json`, `evidence/branch-rules.json`.

## Что ещё имеет смысл сделать

| Приоритет | Работа | Ожидаемый смысл и предел эффекта |
|---|---|---|
| 1 | Исправить три дефекта выше | Сохранить корректность gate и стабильность публикации; не экономия минут сама по себе |
| 2 | Сделать WIP запуск управляемым, без опасной зависимости от commit message | Избегать полных запусков на незавершённой работе. Исторические 105 не-последних PR pushes нельзя целиком считать лишними: часть была нужной обратной связью |
| 3 | Убрать двойную production-сборку и добавить межзапусковый Docker layer cache | Сейчас host build 32–36s плюс Docker 85–86s. Собирать в Docker один раз, при необходимости извлекать dist для host-проверок. Вначале можно убрать host build только с доказанного main-пути, где unit вообще пропущен. На свежем PR отдельно проверить потребителей dist |
| 4 | Профилировать импорты и test fixtures, начиная с самых дорогих | 29/43 минут приходятся на integration; unit сам занимает почти 8 минут. Более узкие imports и облегчённые fixtures могут дать больше, чем сборочный cache, но нужен benchmark с теми же тестами и изоляцией |
| 5 | Рассмотреть отдельные fingerprints для независимых групп проверок | Сейчас любое изменение dashboard инвалидирует единый hash и запускает все backend DB suites. Потенциально большой выигрыш для frontend-only PR; сначала построить и проверить карту зависимостей, с full fallback для shared/contracts/config/migrations/неизвестных путей |
| 6 | Собирать cost summary и proof-hit rate по уже завершённым runs | Показывать full/reused, минуты по job, cancelled и число reruns; через неделю сравнить стоимость на изменённый PR и долю reuse. Одни расходы по дням смешивают цену проверки с объёмом работы |

Важные детали пунктов 3–5:

- В CI по-прежнему обычный `docker build` без `cache-from/cache-to`. `RUN --mount=type=cache` внутри Dockerfile сам по себе не переносит cache на следующий свежий runner. Docker документирует внешние [cache backends для GitHub Actions](https://docs.docker.com/build/ci/github-actions/cache/); cache mounts требуют отдельного решения и не экспортируются автоматически. Можно начать с layer cache, не добавляя registry-write token в job, исполняющий код PR.
- Удаление 32–36s host build отдельно **может не сэкономить ни одной оплачиваемой минуты** из-за округления: 709s и 677s обе дают 12 минут. Поэтому считать нужно всю job с загрузкой/выгрузкой cache, а не только ускорение одного шага. Потолок Docker-оптимизации здесь — минуты на full run, не десятки минут.
- Шарды неравномерны: 11.6 / 8.6 / 7.9 минуты. Балансировка по времени ускорит получение результата, но сама по себе почти не уменьшит сумму runner-минут; добавление шардов не является лечением стоимости.
- `--no-isolate` уже экспериментально отклонён в Decisions 359–360: unit failures и order-dependent integration failures. Повторно советовать включить его глобально было бы ошибкой.
- Старый месячный прогноз не является измерением результата. Новая nightly-схема и PR fail-fast ещё не проявились в нужных live-сценариях; их код проверен, но экономия не подтверждена.
- Cheaper runners сознательно отложены владельцем в Decision 359. В ближайший план их не возвращаю; текущее исследование не сравнивало провайдеров заново.

## Проверки и материалы

- Повторно исполнены `tests/ci-gate-fingerprint.test.ts` и `tests/deploy-ci-policy.test.ts` из проверенной ревизии в отдельном временном каталоге: **61/61 passed**, 2.62s. Общий DB global setup отключён только для этого автономного запуска двух policy-тестов; это не проверка всего suite.
- Отдельный lint/fingerprint counterexample подтвердил дефект, который эти тесты не ловят.
- Получены jobs семи live-runs и логи свежих static/integration/publish; расчёт в `evidence/run-summary.json`, сырые ответы `evidence/jobs-*.json`.
- Проверены live proof artifacts и совпадение main fingerprints (`evidence/artifacts.json`, `evidence/main-fingerprints.json`).
- Проверен активный required gate через ruleset API; legacy branch protection endpoint сам по себе вводит в заблуждение.
- Отчёт не утверждает, что production уже содержит новые CI-изменения, и не измеряет новый фактический счёт. Это аудит repository/CI, а не production deployment.
