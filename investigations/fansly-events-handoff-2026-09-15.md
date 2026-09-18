# Продолжить Fansly migration до измеримого результата

Ты senior engineer Agency Hub. Работай в `/Users/dmitriy/code/goose/hub`.
Продолжи существующую миграцию polling → events до завершения принятого scope.
Не начинай общий аудит заново. Не оценивай готовность выдуманным процентом.
Начни с default-off реализации B0; W0 live gates проверяй отдельно.

## Источники и рабочее дерево

Сначала прочитай `CLAUDE.md`, актуальный `origin/main:docs/decisions.md`, затем:

- `investigations/fansly-events-migration-plan-2026-09-07.md`;
- `investigations/fansly-events-migration-plan-2026-09-07-review.md`;
- `investigations/fansly-events-migration-plan-2026-09-07-review-code.md`;
- `investigations/fansly-events-cross-review-2026-09-07.md`;
- `investigations/fansly-events-cross-check-2026-09-07/DECISION.md`.

Эти пути относительно `/Users/dmitriy/code/goose/hub`. Plan, reviews и DECISION
задают стадии, gates и rollback. Более поздние решения владельца ниже заменяют
устаревший выбор Management Session. План не перепроектировать.
Свежесть по умолчанию не снижать. Голову треда после provider-side deletion в A0
не чинить: только считать отдельным типом discrepancy. Два `reader_missing`
не объявлять удалением без доказательства по соответствующим ID и времени.

Исторический аудит: `investigations/fansly-migration-audit-2026-09-14/REPORT.html`,
рядом `lanes/`, `evidence/`, `followup/`. Некоторые его замечания уже исправлены
PR #166–196; старый STATUS не является новым списком открытых дефектов.

Корневой checkout содержит чужие изменения и untracked расследования; локальная
ветка main отстаёт. Сделай fetch и отдельный worktree от актуального origin/main.
Не делай reset/clean, не удаляй расследования и не переноси весь грязный checkout.
Коммить свои файлы явно; docs git-ignored, для них нужен `git add -f`.

## Что завершено в сессии подчистки

Оба PR слиты в main. Последний подтверждённый main:
`6c0c0ff27e7607c47496ed8e10f7671bc49e9929` (2026-09-14 22:56:53 UTC).

- [PR #201](https://github.com/goslingmanagment/core/pull/201), Decision 340,
  merge `78aa7d48a1071939cdd24c1037c5f5f98f8ecc91`: убраны дублирующий
  expected-generation аргумент W0 и второй dispatcher/дешифрование при post-read.
  Исходный binding receipt и все generation fences сохранены. Это operator tooling,
  runtime deploy не требуется; bundle и Python-компоненты брать из одной ревизии.
  Проверки: pnpm check 3839 +9 existing skips, PG16, Python25, три operator bundles.
  CI: все пять обязательных checks PASS на head `b20976648609c01d914a16b1d5f898ffab16d5b7`.
  Один старый heartbeat-тест с реальным дедлайном 1ms упал в первом CI;
  isolated6 и один повтор упавшего job прошли без изменения кода. Не скрывать этот факт.
- [PR #202](https://github.com/goslingmanagment/core/pull/202), Decision 341,
  merge `6c0c0ff27e7607c47496ed8e10f7671bc49e9929`: ошибка settlement успешного
  C2b receipt после durable capture больше не перезапускает сохранённый baseline.
  Отдельная проверка page lease сохраняет остановку при потере владения/недоступной БД;
  missing receipt остаётся долгом. Pre-fetch/provider/parser/capture handling не меняется.
  Проверки финальной ветки: pnpm check 3846 +9 existing skips, PG23 в четырёх suites;
  оба новых PG fault-injection случая падали до исправления. CI пять checks PASS
  с первого запуска на head `3acff813f2945e9537c2cbf6410dc8b93ff73708`.

Оба изменения прошли независимое correctness/readability review без findings.
Type ratchet в обоих pnpm check: 1897 уже известных ошибок /120 debt files,
нового долга нет; lint/build прошли. CI Publish image для PR — skipped, не шестой PASS.
Повторно открывать эти исправления и переносить их cherry-pick не требуется.

Первичные локальные логи, включая неуспешные попытки, остаются в:
`/Users/dmitriy/.codex/worktrees/hub-fansly-w0-single-binding/investigations/fansly-w0-single-binding-2026-09-15/`
и `/Users/dmitriy/.codex/worktrees/hub-fansly-c2b-shadow-isolation/investigations/fansly-c2b-shadow-isolation-2026-09-15/`.

**Операционный остаток подчистки: #202 ещё не выложен.** Перед B0 live activation
доставь этот runtime fix из чистого merged main штатным deploy script и проверь
source/image + здоровье трёх ролей. Разрешение на deploy уже есть. Это короткий
операционный шаг; default-off разработку B0 им не блокировать. В этой сессии
подчистки production не менялся, flags не переключались, новых live probes не было.

Старые временные W0 receiver/key для остановленной подготовки убраны.
Нового live receiver эта подготовка не запускала, W0 не принят.
Единственный указатель на результат подготовки:
`investigations/fansly-w0-continuity-2026-09-15/diagnostic-followup-20260914T2139Z/PREPARATION-STOPPED.json`.

## Датированный статус стадий

Это исходная точка для продолжения, не обещание текущего состояния production.
Метрики ниже сняты 14 сентября примерно 17:42–18:44 UTC; свежий отчёт может
закрыть естественное ожидание. Не повторяй исследование закрытых PR.

| Этап | Состояние и реальный остаток |
|---|---|
| До A0 | Три исходных DM-дефекта исправлены и выложены. |
| T0 | Учёт физических HTTP attempts реализован; доказанной экономии ещё нет. |
| A0 | Shadow работает, full polling сохранён. NO-GO: среди 15 инструментированных полных обходов два `reader_missing` Lilly-2, G6917/G6918. Это требует объяснения, не нового полного аудита. |
| A1 | Не реализован/выключен. Только после принятого A0 и stop/freshness contract. |
| C1 | Диагностика работает; suppression и эквивалентность свежести ещё не приняты. Старый Lora-2 seq1640 завершился run751074; следующий естественный run751279 имел 8140/8140 без OR-trigger. Этот follow-up закрыт. |
| C2a | Correctness и ограниченная replay parity приняты. |
| C2b | Shadow работает, daily rotation сохранена. 99 fans, по 198 checks/receipts на endpoint, без missing/pending/expired в том срезе; scope_complete=false. Была 1 из 2 подходящих суточных completions. |
| C2c | Не реализован. Нужны quiet-correction coverage, per-fan max-age и стоимость; недельную свежесть не принимать молча. |
| W0 | Офлайн инструменты готовы; REST identity binding HTTP200 доказан. Нет принятого paired fan-out/presence и 6h + gap/recovery. Последний настоящий receiver закончился ошибкой через 158ms, причина не установлена. |
| B0 | Production capture-only receiver ещё не реализован. Его default-off код и тесты можно делать сейчас. |
| B1 | Не реализован; зависит от принятого durable B0 shadow для разрешённых типов. |
| B2 | Отложен; отдельное решение владельца обязательно. |

A0 clock: 2026-09-10 22:58:33.610 UTC. Самое раннее чтение семидневного отчёта —
2026-09-17 в это время. Прошедшие семь суток не равны семи валидным суткам и GO.
C2b первая подходящая daily completion: 2026-09-14 10:53:41.787 UTC;
переходный 13 сентября исключён. Проверь новую completion существующим отчётом.

Экономия ≥50% и event → reader p95/p99 НЕ измерены. Старое сравнение
30569.33/day → 30699.5/day (+0.426%) использовало несопоставимые окна и не доказывает
эффект миграции. Миллисекунды выполнения SQL — не HTTP savings и не reader latency.

Production read-only snapshot 2026-09-14 22:56:57 UTC:
source label `6e07620ab5b9` (main с PR #200), image
`sha256:32c80a117e2afa65d5f1ffa9ebf0eec80c10b229dc074786d0fad53249c5d03d`.
API/worker/scheduler healthy, restart_count=0; диск 80% used, примерно 17GiB free.
PR #200 выложен другой задачей. Не откатывай его при следующем deploy.
SSH `root@45.8.230.111`, deploy только через `scripts/deploy-production.sh`.
Перед следующим deploy один раз сверь свежие main и production, затем используй
изолированную проверенную ревизию; не деплой старый грязный корневой checkout.

## Следующая основная работа — B0

Ошибка прошлого процесса: W0 live-entry gates блокировали даже написание B0.
Они блокируют live activation, а ≥7 суток durable shadow — переход B0 → B1.
Не ждать календарь перед default-off разработкой. Не ослаблять live gates ради
галочки. A1, C1 и C2 имеют собственные условия и могут остаться выключенными.

Реализуй минимальный B0 по §7 плана, в существующем worker:

- одно logical ownership страницы; предусмотренная планом dedicated advisory-lock
  session достаточна, потеря владения закрывает sockets; credentials/route generation fenced;
- page egress через resolver, fail-closed; отдельный receiver dispatcher,
  transport-тесты HTTP CONNECT и SOCKS5, ratchet/ESLint запрет обхода resolver;
- durable business envelope до decode/route, connection UUID + local ordinal,
  неизвестные batch children и debt сохранены; source/registries/contracts/SDK
  и erasure codec согласованы. Не сохранять auth/heartbeat как business payload;
- bounded queue: при недоступном durable capture остановка/degraded/gap,
  без тихого drop и без обещаний восстановить transient факты через REST;
- default-off live flag с пустым allowlist = никто, понятный runbook и kill-switch ≤60s;
  никакого business apply/hints в B0 и отдельного общего lease/dispatch framework.

Переиспользуй полезные protocol/decoder/generation части W0, а не перенос всего
временного CLI-стенда в runtime. Изучай конкретные участки перед правкой.
Обязательные регрессии должны проверять потерю ownership, смену generations,
DB/proxy failure, overflow/gaps, restart, raw-before-decode, unknown children и erasure.

## W0: уже сделанный выбор и недостающие доказательства

Владелец выбрал существующий зашифрованный REST token Lilly-1 для сокета:
«да давай использовать его же» (2026-09-13). Не спрашивай снова про менеджерку.
Lilly-1 — page4, provider account 643579795946348544. Ari выбран независимым
наблюдателем presence; Ari не требуется для каждой технической диагностики сокета.

Принятый bounded REST binding:
`investigations/fansly-w0-continuity-2026-09-14/live-binding-20260914T200628Z/server-output/report.json`.
HTTP200 2026-09-14 20:09:41.786–42.189 UTC, ровно один GET.
Используй receipt только при совпадении свежей generation. Не выдумывай TTL
receipt и не делай новый account/me из-за каждого перерыва. Исходный cleanup=false
сохранён, отдельная последующая проверка подтвердила отсутствие контейнера.

Следующий live шаг — один ограниченный приёмник с уже исправленной диагностикой,
по существующему runbook, затем paired events/presence и continuity ≥6h с коротким
и >3min receiver-only gap и REST catch-up receipts. Это реальные незакрытые gates.
HTTP101, pong или REST200 сами по себе их не закрывают.

Безопасность capture: в прошлой подготовке сырой AX Received t=1 вывел nested
token в tool transcript. Инцидент описан в `OUTPUT-INCIDENT.md` рядом с
`PREPARATION-STOPPED.json`; не перечитывай и не ищи значение токена.
Никогда не печатай сырой AX/Received payload, даже входящий кадр. Экспортируй только
allowlist результата существующего pure `diagnoseReceivedRecord`. Не копируй auth
в clipboard, не ставь WS hooks и не исследуй настройки браузерного/системного прокси.
Используй штатный page resolver; live proxy configuration не менять.
Не отзывай/не ротируй рабочую сессию автоматически.

## Разрешения, качество и критерий завершения

Владелец уже разрешил продолжение, деплои и согласованные шаги этой миграции
(«Да деплой на все», «да все разрешаю»). Не запрашивай то же разрешение заново.
Это не разрешение менять прокси, отзывать credentials, слать фанам сообщения,
делать денежные операции или строить B2. Новые действия вне этого scope уточняй.
Production диагностика: hub CLI, loopback curl/logs; SQL только `read_only`
в READ ONLY transaction, без app user/superuser.

Один этап = один worktree, branch и PR в `goslingmanagment/core`. Бери следующий
decision/migration number из свежего main. Перед PR — `pnpm check` и релевантные
Docker-Postgres suites последовательно, с результатами в PR. Каждый PR до merge
проверяет независимый reviewer на correctness, читаемость и лишнюю сложность;
исправляй подтверждённые findings. Не запускай новые круги без нового изменения,
падения или конкретного риска. Не маскируй сбой/неполный тест как успешный.

Нужен простой читаемый код: небольшие модули, без гигантских строк и новых
frameworks ради будущих сценариев. Дублирование A0 query или nested C2 transaction
можно рассмотреть отдельно при подтверждённом выигрыше; это не prerequisites B0.
Не удаляй ради LOC raw capture, receipts/debt, ownership, erasure и rollback.

Один актуальный указатель на состояние и оригинальные receipts достаточны.
Не плодить отчёты, манифесты и release packets на каждое чтение. Не переписывать
старые неуспешные receipts. Existing `fansly-a0-shadow` automation уже есть;
не создавать ещё один монитор, не сообщать о каждом неизменном опросе.

После этапа кратко: PR, что доказали тесты, что измерено на production,
конкретный остаток. Зависимое от календаря довести до «flip flag/read report»;
не ждать семь дней в активном цикле. Конечный отчёт: stage → state,
фактические savings и latency, rollback и непокрытые сценарии. Если сохранение
свежести не позволяет ≥50%, показать измерение и оставшийся выбор владельца,
а не ослаблять требование или объявлять цель достигнутой.
