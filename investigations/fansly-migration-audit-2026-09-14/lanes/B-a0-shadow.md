# Лейн B-a0-shadow — измерительный shadow A0/T0 (PR 164, PR 176, замер стоимости 13.09)

## 1. Вердикт

Код shadow при `none` байт-в-байт не добавляет ни SQL, ни HTTP; при включении HTTP тоже не добавляет, но кладёт на горячий путь 1 последовательный SELECT (до 5 с) + 1 транзакцию отчёта + 1 строку `sync_run_events` на каждую страницу списка (~19 тыс. транзакций/сутки); вывод замера «+21,46 %» — артефакт одной страницы (lilly-2) за один день (12.09) с заниженным baseline-днём, а не флотовый рост; 11.09 потерян для 7-дневного гейта (225/275 sweeps incomplete), но часы гейта не сдвинуты; prod ≠ main по миграциям 0185/0186.

## 2. Находки

| № | P | Статус | file:line | Что ломается (вход → неверный выход) | Наименьший фикс |
|---|---|---|---|---|---|
| 1 | P2 | CONFIRMED (по retained JSON замера) | `investigations/fansly-cost-latency-measurement-20260913T094049Z/MEASUREMENT.md`, `HTTP-REPORT.md`; исходник — `http-summary.json`, `baseline-day-reread/report.json`, `current-day/report.json` | Заявлено «30 684 → 37 268 (+21,46 %), рост в dm_messages (+4 209) и fan_earnings (+2 046)» как свойство флота. По тем же JSON: из +6 584 lilly-2 даёт +6 450; остальные пять страниц вместе 19 825 → 19 959 (+0,7 %). На lilly-2: `dm_messages` 2 → 4 014 attempts (3 → 806 runs), `fan_earnings` 2 010 → 4 028 при ровно удвоенном числе runs (503 → 1 008, 4 attempts/run в оба дня), `followers_reconcile` +752. Baseline-день 5.09 для lilly-2 — минимум шестидневного T0 по `dm_messages` (2 attempts; остальные дни 108–563), т.е. пара дней выбрана так, что дельта максимальна. 13.09 (до 17:07 UTC) `dm_messages` lilly-2 = 1 attempt — всплеск однодневный. Ни один из документов (включая REVIEW.md «clean») не приводит разложение по страницам, хотя оно есть в `http-summary.json.comparison.byPage`. | Переписать вывод: «рост сосредоточен в lilly-2 12.09 (dm_messages ×27, fan_earnings runs ×2); флот без lilly-2 +0,7 %»; baseline брать как среднее 1–6.09 по странице × потоку, а не один день; причину lilly-2 разбирать отдельно (см. §6). |
| 2 | P2 | CONFIRMED (evidence + git) | `packages/db/src/repositories/fansly-dm-shadow.ts:57-61` (5 s, изменено в #175 `c76c6db0`, 12.09 16:05 UTC); `investigations/fansly-events-execution-2026-09-08.md:39`; `docs/runbooks/fansly-events-shadow.md:29`; PR 164 body («first verified observation point 2026-09-10T22:58:33.610Z … seven full days cannot elapse before 2026-09-17») | 11.09: из 275 sweeps 225 `incomplete/uncertified_or_partial_diagnostics`, у 230 `unknownMaterialChecks>0` (snapshot 20260913T170727Z), потому что material check с `statement_timeout='500ms'` отменялся 200–255 раз/час (диагностика нагрузки 11.09). Лог выполнения это фиксирует («182 incomplete, 318 615 unknown checks»), но «первая точка наблюдения 10.09 22:58» и «7 суток → 17.09» не пересчитаны. Гейт плана — ≥7 **полных** суток по шести страницам; при исключении 11.09 первые семь полных UTC-суток — 12–18.09, т.е. не раньше 19.09 00:00 UTC. Изменение 500 ms → 5 s не закреплено тестом (в `tests/` нет утверждения о таймауте), комментарий ссылается на `docs/diag/2026-09-11-agency-hub-load`, которого в репо нет (untracked в основном чекауте). | В runbook/STATUS явно: «счёт полных суток начинается с 12.09 00:00 UTC (11.09 исключён: N incomplete из-за таймаута)»; пин таймаутов: тест на текст SQL (`'5s'` для чтения, `'500ms'`/`'100ms'` для записи). |
| 3 | P2 | PLAUSIBLE (путь прослежен; объёмы — из retained отчёта 12.09; влияние на длительность не воспроизведено) | `apps/runtime/src/services/sync/fansly-dm-conversations.ts:575-582` (material SELECT до `withOwnedPageSyncTransaction`), `:335-348` (отчёт при старте chunk), `:1219-1231` (отчёт после каждой страницы), `dm-shadow-report.ts:20-47` (транзакция из 2 SET + UPDATE + INSERT … ON CONFLICT + `addNote` → `insertSyncRunEvent`), `packages/db/src/repositories/fansly-dm-shadow.ts:56-77` | При включённом флаге на **каждую** страницу списка: +1 последовательная DB-транзакция чтения (до 5 с под нагрузкой) **между** ответом провайдера и бизнес-записью, +1 транзакция отчёта, +1 строка `sync_run_events`; на каждый chunk ещё +1 отчёт +1 строка. Объём 12.09 (по `attempts`/`httpCoverage`): 15 864 `messaging_groups`-страниц + 3 343 runs → ≈15,9 тыс. SELECT, ≈19,2 тыс. транзакций отчёта, ≈19,2 тыс. строк `sync_run_events`/сутки (retention 30 сут → ~0,58 млн строк в таблице, которую `closeInactiveSyncRuns` сканирует каждую минуту — причина №3 в вердикте нагрузки 11.09: 1,4 млн строк). Медленный SELECT удлиняет цикл страниц → меньше страниц на chunk по wall-clock → больше resumes (lilly-1 gen 7314: 6 resumes к 21-й странице 11.09). Паритет-тест сравнивает только HTTP-вызовы и снимки таблиц (`tests/fansly-dm-shadow.integration.test.ts:94-110`), не число DB-стейтментов и не wall-clock. | Свернуть material check в уже существующий запрос `listPageDmConversationsByPlatformConversationIds` (lateral `exists` по `page_dm_messages` + `fansly_dm_head_debt`) — ноль дополнительных round-trip; отчёт `running` писать раз в chunk (в конце), а не при старте + на каждой странице. |
| 4 | P2 | CONFIRMED (evidence) / механизм PLAUSIBLE | `packages/db/src/repositories/fansly-dm-shadow.ts:68-72` (`present` = только `page_dm_messages … deleted_at is null`); PR 164 body («exact pre-apply hot-ID evidence»), runbook :92-94 | `missingHotHeadsBelowStop` на lilly-2: 89 008 (11.09), 66 459 (12.09, ≈1 356 на sweep), 68 (13.09). `page_dm_messages` — кэш с prune-политикой (см. `tests/retention-deleters.test.ts:15`), архив (`dm_message_archive`) не проверяется, `head_debt` заводится только при отсутствии hot-строки в момент наблюдения → счётчик не отличает «не захвачено» от «вычищено из кэша». Обвал 66 459 → 68 совпадает с 806 runs `dm_messages` на lilly-2 12.09 (пересбор hot-материала). Для гейта A1 «ноль необъяснённых пропусков» этот счётчик на lilly-2 непригоден, а в документах он подаётся как точное свидетельство. | `present := exists(hot) or exists(dm_message_archive по conversation_id+platform_message_id) or d.captured_at is not null`; отдельный счётчик `prunedHotHeadsBelowStop`. |
| 5 | P2 | CONFIRMED (git) | `git diff --stat 380326368f origin/main -- packages/db/migrations` → `0185_fansly_followers_membership_read.sql` (181 строка, `fansly_followers_diagnostic_timeline` security definer + grant read_only) и `0186_ops_metrics_recent_series.sql` (concurrent index) есть в проде и **отсутствуют** в origin/main; main имеет 0187–0191, которых нет в проде. PR 176 body: «182 applied migrations through 0186». Идентичность миграции = имя файла (`packages/db/src/migrate-runner.ts:153,188`). | Прод содержит функцию и индекс без источника истины в main; любая новая 0185/0186 в main — другой id, применится поверх; `schema_migrations` прода ⊄ файлов main. Прочие пути моего scope (`dm-shadow*.ts`, `fansly-dm-shadow.ts`) — различие только в комментарии (5 s есть и там, и там). | Внести 0185/0186 в main verbatim (forward-only) до любого переиспользования номеров; CI-проверка «prod `schema_migrations` ⊆ файлы main». |

Не выводится (P3/подтверждено-в-порядке): `resumes` недосчитывается, если chunk умирает до первой записи страницы (инкремент только в памяти, `:335-340`); ссылка в коде на untracked-док; счётчик `timestampTies` не имеет собственного assert (семантика «строго старше» покрыта `tests/dm-shadow.test.ts:77-83`).

## 3. Утверждения PR/decision

| Утверждение | Итог | Доказательство |
|---|---|---|
| PR 164: при `none` полная HTTP-последовательность, streak, checkpoint, финализация, follow-ups и слоты не меняются | подтверждено | `fansly-dm-conversations.ts:256-258` (только `isPageAllowlisted`), `:325-360` (`shadow=undefined`, `state.diagnostics` отсутствует → ветка `incomplete/disabled_during_sweep` не выполняется, деструктуризация без побочных эффектов), `:575` (`shadowMaterial=null`, SELECT не выполняется), `:864` (пуш в массив не выполняется), `:920` (`nextShadow=undefined`), `:1219` (отчёт не пишется). Ни одного лишнего SQL/HTTP. Единственная разница при `none` с оставшимся `diagnostics` в курсоре: один отчёт `incomplete` + одна строка `sync_run_events`, после чего ключ вычищается из курсора (`:350-361`). |
| PR 164: при включении — ноль дополнительных HTTP | подтверждено | Единственный вызов адаптера в цикле — `getMessagingGroupsPage` (`:424`); shadow-ветки вызывают только `readDmShadowMaterial` (SQL) и `persistDmShadowReport` (SQL). Паритет-тест `tests/fansly-dm-shadow.integration.test.ts:94-110` (`on.calls` = `off.calls`) — Docker, мной не запускался. |
| PR 164: ноль записей в бизнес-таблицы | подтверждено с оговоркой | Пишутся: `fansly_dm_shadow_sweeps` (1 строка/sweep, upsert на каждой странице), `sync_run_events` (телеметрия), и **`page_sync_cursors.state.diagnostics`** — диагностика едет внутри бизнес-документа курсора (`:931`, `:1115`), это решение 284, но формулировка «ноль записей в бизнес-таблицы» неточна; `sync_runs.stats` получает только `diagnosticsKeys` (`observability.ts:389-390`). Объём: `fansly_dm_shadow_sweeps` 292 строки/сутки (48 слотов × 6 страниц + рестарты), перезаписей ≈ страниц+chunks (lilly-2 ≈ 138+29 на sweep). |
| PR 164: «report table participates in page erasure» | подтверждено | `apps/runtime/src/services/erasure/index.ts:1370` — запись в `deletions` санкционированного erasure-модуля (Stage 28.4, файл в `SANCTIONED_DELETER_FILES`); FK `on delete restrict` (0174:4) без этой записи заблокировал бы erasure. `tests/retention-deleters.test.ts` — pass; в `fansly-dm-shadow.ts` только `update`/`insert`, `delete from` вне пина нет. |
| PR 164: «Fixed read functions grant no base-table access; no message bodies, credentials» | подтверждено | 0175/0176: `security definer`, `set search_path = pg_catalog, public, pg_temp`, `revoke all from public`, `grant execute to read_only`. 0175 отдаёт только агрегаты (`failure_kind` — pgEnum `sync_http_failure_kind`, schema.ts:191, не свободный текст) и `sync_run_events.details->'dmShadow'`. 0176 отдаёт `groupId/lastMessageId/senderId/timestamp/flags/tier/offset` — платформенные ID без текста; уже видимые `observations` содержат больше. ORDER BY везде квалифицирован (`e.emitted_at desc, e.id desc`; `r.id`; `n` — ordinality). |
| PR 164: «Scalar diagnostics survive chunk resumes» | подтверждено | `cursor-state.ts:393-407,513-525,571-589`; `tests/dm-shadow-cursor.test.ts` — pass. |
| PR 176: legacy/late-start counters остаются `null`, нигде не подменяются нулём | подтверждено | `dm-shadow-state.ts:35-40` (`.default(null)`), `:73` (`reasonCount = completeCoverage ? 0 : null`), `dm-shadow.ts:44-48` (инкремент только при `!== null`); 0175 отдаёт jsonb как есть; `scripts/fansly-events/corpus.ts:106-109` явные `null`; `summarize-corpus.py:26` суммирует только ненулевой `stateChangesBelowStop`. В retained отчёте 12.09: 251 строк без ключей (до деплоя #176), 1 — `null`, 40 — `0`; потребитель через `->>` получает NULL. |
| PR 176: «Completed observation does not mean complete reason coverage» | подтверждено | `status='complete'` требует `membershipCertified && completeCoverage && boundaryMs && unknownMaterialChecks===0` (`:1222-1223`), про reason-counters не проверяет; тест `completes a legacy sweep without inventing…` (integration). |
| PR 164/STATUS: shadow «Not deployed», «No canary is active» | не проверяемо / устарело | `investigations/fansly-a0-shadow-2026-09-10/STATUS.md` (git 12.09 23:53) помечен «historical»; PR body утверждает деплой 10.09 22:03 UTC; REVIEW.md датирован 10.09 20:38 — до деплоя и до #176 (для #176 отдельный REVIEW 12.09). |
| Замер 13.09: «5 и 12 сентября сравнимы (те же субботы, те же страницы)» | опровергнуто | Находка 1: делта — одна страница/один день; 5.09 — минимальный день по `dm_messages` lilly-2 в T0. |
| Замер 13.09: «за 12.09 все 8 539 runs имеют loss counters = 0» | подтверждено | `dmCoverage` 12.09: `unknown_runs=0`, `lost_report_runs=0` по всем шести страницам (retained `current-day/report.json`). |
| Гейт A0 (план §4–5) | частично | «≥7 полных суток» — только календарь, 11.09 непригоден (находка 2); «restart» — integration (resume, guard → `incomplete`); «outage >1 ч» — unit `tests/dm-shadow.test.ts:123-135` (скачок часов на 2 ч) + integration; «timestamp ties» — семантика «строго старше» в unit, счётчик без assert; «ноль необъяснённых пропусков» — не проверяется кодом: lora-1 12.09 `stateChangesBelowStop=2 371` объяснён в `lora1-4830-20260913T003537Z/REPORT.md` (2 363 pointer clearings, 1 не разрешён; кандидат NO-GO), lilly-2 `missingHot` 66 459 не объяснён (находка 4). |

## 4. Архитектура

1. **Инструмент стоит в измеряемом контуре.** Material check выполняется последовательно между ответом провайдера и бизнес-транзакцией (`:575`), с таймаутом 5 с; на VPS с одним реальным ядром (вердикт 11.09) он уже отменялся сотнями раз в час и «съел» день наблюдения. Пре-apply чтение обязано быть до записи, но не обязано быть отдельным round-trip — его место в уже выполняемом `listPageDmConversationsByPlatformConversationIds`.
2. **Второй писатель в бизнес-документ курсора.** `diagnostics` живёт в `page_sync_cursors.state` (решение 284: «optional cursor state»). Это делает откат безопасным (парсер игнорирует ключ), но каждая страница переписывает +~1,3 КБ, и любой будущий strict-парсер курсора сломает shadow молча (парсер отбрасывает malformed → `completeCoverage=false` → все sweeps `incomplete`). Отдельная таблица уже есть — курсор мог бы хранить только `generation`.
3. **Отчёт = телеметрия с двумя стоками, но знаменатель живёт в 30-дневной таблице.** «Независимый receipt» — строка `sync_run_events` на страницу; `dmCoverage` в 0175 строится через lateral по `sync_run_events`, которые `deleteExpiredSyncObservability` удаляет через 30 суток, а `fansly_dm_shadow_sweeps` — навсегда. Через месяц coverage-знаменатель исчезнет, отчёт станет «сколько строк в таблице», что runbook как раз запрещает трактовать как полноту.
4. **Граница virtual stop — время завершения предшественника, не его старта.** `boundaryMs = lastFullSweepCompletedAt` (`:326-331`); lilly-2 sweep идёт ~30 мин (138 страниц), поэтому граница систематически поздняя на длину sweep. Для измерения пропусков это консервативно (пропуск ниже стопа всё равно считается), но чувствительность K/overlap из PR (28 пропусков при K=3/60 с) привязана к этой границе; стоп-контракт A1 должен брать время начала предшественника или per-page read time.
5. **`missingHotHeadsBelowStop` смешивает две политики.** Кэш `page_dm_messages` вычищается по retention-политике, архив — источник истины; счётчик «missing hot» без обращения к архиву измеряет prune, а не захват (находка 4). Аналогично `invalidMarkers` на lilly-2 ≈ 47 на страницу из 100 — это профиль провайдера (нет embedded head у старых групп), а не дефект; стоп достигается только потому, что первые страницы валидны.

## 5. Что прогнал

```
cd /Users/dmitriy/code/goose/.worktrees/hub-audit-20260914
pnpm exec vitest run tests/dm-shadow.test.ts tests/dm-shadow-corpus.test.ts tests/dm-shadow-cursor.test.ts \
  tests/retention-deleters.test.ts tests/fansly-corpus-export.test.ts tests/observability.test.ts \
  tests/config-registry.test.ts tests/effective-config.test.ts tests/fansly-capture-allowlist.test.ts
 RUN  v4.1.10
 Test Files  9 passed (9)
      Tests  100 passed (100)
   Duration  4.02s
exit=0
```
Лог: `/private/tmp/claude-501/-Users-dmitriy-code-goose-hub/f46f0fc5-e743-4901-83dc-ac3a5d3d1b36/scratchpad/B-a0-shadow-unit.log`.

Git-сверки: `git diff --stat 380326368f origin/main -- apps/runtime/src/services/sync/dm-shadow* packages/db/migrations packages/db/src/repositories/fansly-dm-shadow.ts apps/runtime/src/services/sync/fansly-dm-conversations.ts apps/runtime/src/services/sync/observability.ts apps/runtime/src/services/erasure/index.ts scripts/fansly-events docs/runbooks/fansly-events-shadow.md` → 4 файла: 0185 (−181), 0186 (−20), `fansly-dm-shadow.ts` (комментарий, 8 строк), `scripts/fansly-events/earnings-audit-export.ts` (+4, лейн C2a). `git log -S"statement_timeout = '5s'"` → `c76c6db0` (#175, 12.09 16:05 UTC).

Пересчёты retained JSON (python3, локально, без прода): `http-summary.json`, `baseline-day-reread/report.json`, `current-day/report.json`, `fansly-a0-deploy-2026-09-11/evidence/t0-2/baseline.json`, `activation/20260910T225618Z/snapshot-20260913T170727Z/report.json` — кросс-таблицы stream×page×day, статусы sweeps по дням, распределение null/absent/0 у шести reason-счётчиков.

Временный тест-файл не создавался; репо не менялось.

## 6. Не проверено и почему

- Integration-suites (`fansly-dm-shadow`, `fansly-events-measurement`, `fansly-dm-conversations-sweep`, `erasure-page-owned-tables`) — Docker, запрещены брифом; паритет HTTP/снимков (находка 3) и erasure-инвентарь приняты по чтению кода.
- Реальное влияние shadow на длительность sweep/chunk (находка 3) — нет прод-данных; `sync_runs` невидимы для `read_only`.
- Причина всплеска lilly-2 12.09 — по коду не устанавливается; кандидаты и различающие запросы ниже. По коду исключены как источник HTTP: PR 164/176 (ноль вызовов адаптера), PR 158/159 (только канонизация/архив), PR 165 (domain-events/архив), PR 169 C2b («does not add provider calls», `fan-earnings.ts:35` — только флаг; allowlist на 13.09 01:00 UTC = `lilly-1`), PR 157 (recovery гейтится `fanslyDmHeadCatchupPageAllowlist=none` на 13.09; `recovery`-attempts упали 2 009 → 1 659).

### Запросы к оркестратору (роль `read_only`, `BEGIN READ ONLY; SET LOCAL statement_timeout='20s'`)

Гипотезы по lilly-2 12.09, по убыванию:

**H1 — `dm_messages` (806 runs) = follow-up'ы полного обхода, пересобирающие hot-материал.** Механизм: `fansly-dm-conversations.ts:1006-1019` (`shouldRequestDmMessagesFollowup` при `headCatchup=off` → `pending_backfill` или `last_message_id ≠ newest_stored_message_id && last_message_sync_at < last_message_at`) → `requestPageSync(dm_messages, scheduled)` (`:1234-1239`) → кандидат по тому же предикату (`page-dm.ts:1091-1101`), 1 запрос `messages` на диалог. Косвенно: `missingHotHeadsBelowStop` lilly-2 66 459 → 68 за сутки. Различает: почасовой профиль (равномерный ~34/час = sweep-driven; пик = разовое действие/replay) и сколько диалогов участвовало.

```sql
select p.label, o.kind,
       date_trunc('hour', o.received_at at time zone 'UTC') as hour_utc,
       count(*) as observations,
       count(distinct o.idempotency_key) as distinct_keys
from observations o
join pages p on p.id = o.account_id
where p.platform = 'fansly' and o.source = 'pull'
  and o.kind in ('dm_messages', 'dm_conversations')
  and o.received_at >= '2026-09-11T00:00:00Z' and o.received_at < '2026-09-14T00:00:00Z'
group by 1, 2, 3
order by 1, 2, 3;
```
(индекс `observations_account_received_idx`; `account_id` = `pages.id`, как в erasure-scope.)

**H2 — `fan_earnings` runs ×2 (503 → 1 008 при 4 attempts/run в оба дня) = удвоенная частота выборки, а не расщепление работы.** Варианты: изменение cadence/slot для lilly-2; удвоенный dirty-ростер после завершения исторической переканонизации earnings v7 (вердикт 11.09: курсор `pull:earnings:v7` на 12.08, «ещё ~43 ч» → финиш ≈ 12–13.09); два воркера в окне деплоев 12.09 (#175 ~16 UTC, #176 20:59 UTC). Различает: cadence в `page_sync_states` (виден) + почасовой профиль по `fan_earnings_stats`/`fan_earnings_monthly`.

```sql
select p.label, s.stream, s.cadence_seconds, s.slot_offset_seconds,
       s.last_scheduled_slot, s.applied_seq, s.consecutive_failures, s.updated_at
from page_sync_states s
join pages p on p.id = s.page_id
where p.platform = 'fansly' and s.stream in ('fan_earnings', 'dm_messages', 'dm_conversations')
order by 1, 2;

select p.label, o.kind,
       date_trunc('hour', o.received_at at time zone 'UTC') as hour_utc, count(*)
from observations o
join pages p on p.id = o.account_id
where p.platform = 'fansly' and o.source = 'pull'
  and o.kind in ('fan_earnings_stats', 'fan_earnings_monthly')
  and o.received_at >= '2026-09-04T00:00:00Z' and o.received_at < '2026-09-14T00:00:00Z'
group by 1, 2, 3
order by 1, 2, 3;
```
Если cadence lilly-2 равен остальным, а профиль 12.09 равномерно ×2 с резкой границей по часу — искать флип/деплой в этот час (config audit оркестратору); если пик — dirty-ростер после replay (`projection_watermarks` по earnings-проекции покажет момент завершения).

**H3 — `followers_reconcile` lilly-2 +752** — вне моего scope (лейн C1), но входит в +6 450; тот же почасовой запрос с `o.kind` потока followers.

Дополнительно для находки 2 (сколько полных суток реально есть):
```sql
select (started_at at time zone 'UTC')::date as day_utc, page_label, status, reason,
       count(*) as sweeps,
       count(*) filter (where (diagnostics ->> 'unknownMaterialChecks')::bigint > 0) as unknown_checks_sweeps
from fansly_dm_shadow_report
where started_at >= '2026-09-10T22:58:33Z'
group by 1, 2, 3, 4
order by 1, 2, 3, 4;
```
