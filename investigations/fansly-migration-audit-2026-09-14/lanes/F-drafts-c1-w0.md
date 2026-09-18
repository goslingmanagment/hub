# Лейн F — черновики PR166 (C1, `feat/fansly-c1-followers` 3a6eace1) и PR167 (W0, `feat/fansly-w0-protocol` ea0d6405)

## 1. Вердикт

P1 нет; оба черновика по коду честные (C1 — только receipts поверх уже живущего в main/проде guarded UPDATE; W0 — сокет строго через `resolveEgress({kind:"page"})`, токен наружу не выходит), но: ledger миграций уже расходится с прод (0186 есть только в проде — любой будущий `0186_*` под другим именем валит старт API), W0 не закрыл требуемый планом ratchet на `WebSocket(`, живой прод-probe с мастер-ключом и app-DSN в `/tmp` не имеет в ветке записи owner-«yes» на запуск, а заявленная в теле PR166 деактивация в поколении 776 в ветке ничем не подтверждена.

## 2. Находки

| № | P | Статус | file:line | Что ломается (вход → неверный выход) | Наименьший фикс |
|---|---|---|---|---|---|
| 1 | P2 | CONFIRMED (воспроизведено на `runMigrations` с fake db) | `packages/db/src/migrate-runner.ts:50-68` (`assertContiguousAppliedPrefix`), `:151-160`; `packages/db/src/schema-guard.ts:378-385` | Runner и schema-guard видят только файлы на диске: строки `schema_migrations`, у которых нет файла, невидимы. Прод (380326368f) имеет применённые `0185_fansly_followers_membership_read.sql` и `0186_ops_metrics_recent_series.sql`; main (0a08365f) — ни одной из них, C1 — только 0185. Сценарии: (A) деплой main сегодня → тихий пропуск, функция 0185 и индекс 0186 остаются в БД без владельца в репо; (B) C1 (0185) на любую БД, где уже применены 0187–0191 без 0185 (не прод) → `Out-of-order migration detected` = API не стартует; (D) **любой будущий файл `0186_<другое имя>.sql` в main → на проде тот же fail-closed при следующем деплое**, т.к. `0186_ops_metrics_recent_series.sql` применён, а нового `0186_*` в ledger нет. main сейчас заканчивается на **0191** (не 0188, как в задании). | Внести `0186_ops_metrics_recent_series.sql` в main байт-в-байт под тем же именем (в C1 или отдельным PR) до следующего деплоя main; в runner добавить проверку «id в `schema_migrations` без файла на диске → fail» (или preflight в `deploy-production.sh`, у него уже есть `capture_remote_schema_migrations`). |
| 2 | P2 | CONFIRMED (grep ratchet-regex + отсутствие изменений в `scripts/check-raw-fetch.mjs`/eslint в диффе W0) | `scripts/check-raw-fetch.mjs:20-24` (regex `fetch\(`, скан только `apps/runtime/src` + `packages`, `services/egress/` исключён; `scripts/` не сканируется); `apps/runtime/src/services/egress/fansly-probe-socket.ts:7-16` | W0 вводит первый WebSocket-транспорт, но не расширяет ratchet и не банит глобальный `WebSocket` через ESLint — ровно то, что план требует в §7 «B0 capture» (`investigations/fansly-events-migration-plan-2026-09-07.md`, абзац «WS-кода в Hub нет вообще … расширить ratchet на `WebSocket(`/`connect(`»). Вход: `new WebSocket("wss://wsv3.fansly.com/?v=3")` без `dispatcher` в любом файле `apps/runtime/src` → CI зелёный, соединение уходит с IP VPS (риск бана Fansly). Единственная защита — конвенция `openFanslyProbeSocket`. | Расширить regex ratchet до `(fetch|WebSocket|connect)\(` с единственным легальным домом `services/egress/`, добавить `no-restricted-globals: WebSocket` в eslint; бюджет 0 вне egress. |
| 3 | P2 | CONFIRMED (в ветке нет receipt согласия на запуск) | `investigations/fansly-w0-protocol-2026-09-10/OWNER-CHOICE-20260913.md:1-10,34` («This note records authorization, not a live execution receipt»); `docs/runbooks/fansly-ws-protocol-check.md` «Live gates — each needs explicit approval» | План (§1 «Решения владельца 8 сентября»): «живые socket probes … только после явного «yes» в этом чате». В ветке зафиксировано одно «да давай использовать его же» — выбор **токена**, не разрешение запустить контейнер на проде. Живой probe 13.09 22:28 UTC запустил на VPS контейнер в сети `agency-hub_default` с `APP_ENCRYPTION_KEY` и app-`DATABASE_URL` (owner-gated класс действий по CLAUDE.md). Также не выполнена предпосылка runbook «Confirm binding through the authorized REST path for that credential generation» — `accountBinding: "unverified"` в receipt. | Приложить к OWNER-CHOICE/STATUS цитату явного «yes» на запуск (оркестратор: сверить с историей чата); если его не было — зафиксировать как отклонение от гейта плана. |
| 4 | P2 | CONFIRMED (путь кода) | `investigations/fansly-w0-protocol-2026-09-10/evidence/same-token-20260913T220004Z/launch-approved-probe.py:12-16,33-46` (`docker inspect agency-hub-api-1` → `probe.env` с `DATABASE_URL`, `APP_ENCRYPTION_KEY*`); `scripts/fansly-ws/run-probe.py:41-49` (`--env-file`); `scripts/fansly-ws/probe.ts:32-41` (pool под app-пользователем, `default_transaction_read_only=on`) | Секреты runtime (мастер-ключ шифрования + DSN app-пользователя) копируются из env контейнера в plaintext-файл `/tmp/hub-fansly-w0-…/probe.env` (0600, unlink в `finally`) и попадают в конфиг probe-контейнера (`docker inspect` на время жизни). БД-доступ — под app-ролью, не `read_only` (CLAUDE.md: «psql only via read_only role — never the app user»); техническая защита реальна (`fansly-probe-context.ts:66-75` проверяет `transaction_read_only=on` + `repeatable read`; тест `rejects an accidental write … 25006`). Следы: receipts подтверждают удаление контейнера и `probe.env`, но **удаление remote-каталога** `/tmp/hub-fansly-w0-20260913T222801Z-7d99ce14` (bundle `probe.mjs`, `run-probe.py`, `launch-approved-probe.py`, `live/report.json`, `stderr.log`, `execution.json`) нигде не записано (`live-invocation.json:2`). | Не создавать копию секретов: `--env-file` на уже существующий `${APP_DIR}/.env.production` (или `docker compose run --rm --no-deps api node -` с лимитами через override), записать `rm -rf` remote-каталога в receipt; долгосрочно — отдельная роль с SELECT на `pages/page_credentials/egress_endpoints` вместо app-DSN. |
| 5 | P2 | CONFIRMED (grep по всей ветке: «776» отсутствует в md-доказательствах) | тело PR166 («one actual deactivation in776»); `investigations/fansly-c1-followers-2026-09-10/OBSERVATION-20260912T183741Z.md:30-33` (Lora-3 gen 775: «candidates and actual retirements are zero», следующая incremental «outside this report») | Заявление PR о фактической деактивации в поколении 776 Lora-3 не подкреплено ни одним файлом ветки; источник — «локально в main checkout под `investigations/fansly-c1-deploy-2026-09-11/`». Для ревью это «заявленная гарантия без доказательства». Единственная подтверждённая в ветке деактивация — Lilly-2 gen 792: 2 строки при 18,324 active → source/generation 18,322, все protection-buckets = 0 (выглядит как легитимные unfollow). | Добавить в ветку receipt gen 776 (JSON из `fansly_followers_diagnostic_timeline`) или убрать утверждение из PR; SQL для сверки — в §6. |
| 6 | P2 | CONFIRMED (`git diff 380326368f origin/feat/fansly-c1-followers -- packages/db/src/repositories/fans.ts`) | прод `packages/db/src/repositories/fans.ts:213-217` (`aliasValues.sort(...)` — детерминированный порядок alias-локов в `upsertFans`); отсутствует и в main, и в C1 | Прод ≠ main в файле, который правит C1: прод несёт 5-строчный фикс порядка захвата `fan_username_aliases` (анти-deadlock из `fan-alias-concurrency`), main и C1 его не содержат. Мердж C1 этого не чинит; первый же деплой из main откатит фикс (regress → deadlock-класс ошибок при конкурентных upsert alias). Вне scope C1, но по брифу — отдельная находка. | Внести alias-sort в main (или в C1 как «preserve production», раз файл уже в диффе), проверить остальные 149 файлов расхождения прод/main — задача оркестратора. |

Не выведено как находки (P3/процесс): (а) обе ветки правят одну и ту же строку 32 `investigations/fansly-events-execution-2026-09-08.md` → гарантированный конфликт при мердже второй; C1 к тому же переписывает строки чужих лейнов (A0+T0, C2b) — текст датирован позже main, регресса нет; (б) `probe.ts:47-49` создаёт второй dispatcher при повторном `readContext()` и не использует его (оба уничтожаются в `finally`); (в) `restRequests: 0` в отчёте — константа (`probe.ts:79`), а не измерение — по коду REST-путей действительно нет (адаптер не импортируется), но как «receipt» это не доказательство.

## 3. Утверждения PR/decision

**PR166 / Decision 294 (C1)**
- «No predicate, cadence, presence policy or runtime flag changes» → **подтверждено**: в трёхточечном диффе `pageFollowDeactivationCandidatePredicate` (`fans.ts:712-724`), `deactivatePageFollowsByGeneration` (`fans.ts:1125-1150`), `followers-reconcile-decision.ts`, `followers-reconcile-safety.ts` не тронуты; диф кода = `executor-handlers.ts` +25/−1 (захват `deactivatedIds.length` + новая note `followersMembership`), `fans.ts` +40/−1 (7 новых `count(*) filter` в том же SELECT), `sync-handlers.test.ts` +1 (mock).
- «guarded membership-update receipts» / «one actual deactivation in generation 776» → **receipts подтверждены** (`executor-handlers.ts:2181,2226-2246`: UPDATE `returning id` уже был в main с #117/#122, ветка лишь пишет `deactivatedCount` в note); **факт 776 — не проверяемо из ветки** (находка 5).
- «Migration 0185 … applied» / байт-в-байт с продом → **подтверждено**: `git diff 380326368f origin/feat/fansly-c1-followers -- packages/db/migrations/0185_*` пуст; `0185` = `create or replace function` с той же сигнатурой, что в 0183 (`timestamptz,timestamptz,bigint,bigint,integer`) — перегрузки не создаёт.
- «the retained production reference additionally includes applied 0186 … A future release must preserve it» → **подтверждено и недооценено** (находка 1: не «preserve», а fail-closed при любом чужом `0186_*`).
- «Decision 294 and the runbook cover the restricted readers» → **подтверждено**: main уже имеет `## Decision 294` (docs/decisions.md:12227) и строку quick-ref (:294); ветка добавляет абзац «12 September diagnostic refinement» — конфликтов нумерации нет.
- «pnpm check 3,365 passed / Serial Docker-Postgres 86 passed» → **не проверяемо** (интеграционные/полный прогон запрещены лейну); мои юнит-прогоны — §5.
- «A failed note does not undo business work» → **подтверждено по коду**: note пишется после commit транзакции через `safeTelemetryOp` (`observability.ts` — ошибка логируется и проглатывается); интеграционный тест «leaves a failed note unknown…» есть в ветке (не запускал).
- Hard rules: `delete from`/`.delete(` в диффе нет (пин retention-deleters проходит); ORDER BY в 0185 квалифицированы (`r.id`, `e.id`, `r.run_id`; `order by id` в CTE `runs` над `candidates` без алиасов-омонимов); `platform ===` 155 = main; новых роутов нет.

**PR167 / Decision 321 (W0)**
- «one fixed endpoint for at most 120 seconds, without reconnects, REST requests, pacing writes or business writers» → **подтверждено**: `probe-observer.ts:3` `MAX_PROBE_DURATION_MS=120_000`, `connect()` вызывается ровно один раз (тесты `toHaveBeenCalledTimes(1)`), `pace()` не вызывается (transport-тест `paceCalls: 0`), `fansly-probe-socket.ts:13-16` фиксированный URL; REST-адаптер не импортируется.
- «page-proxied transport / fail-closed» → **подтверждено**: `resolveEgress({kind:"page"})` (`resolver.ts:104-119`) бросает `ProxyMissingError` без прокси; `openFanslyProbeSocket` дополнительно отвергает `dispatcher=null`, `"direct"`, `vendor:|service:|legacy-page:`; undici 7.27.2 `WebSocket` принимает `dispatcher` (`lib/web/websocket/websocket.js:716`, `connection.js:95`); transport-тест поднимает реальные HTTP CONNECT и SOCKS5 fixture-прокси, глобальный dispatcher отказывает (`fallbackCalls: 0`), проверяет TLS и отсутствие `authorization|cookie|fansly-*` заголовков — пройдено (§5).
- «The token stays inside the trusted runtime credential path … Reports retain bounded received metadata, without credentials» → **подтверждено по коду и тестам**: токен только в памяти (`contexts[].token`) и в auth-кадре `{t:1,d:'{"token":…,"v":3}'}`; stderr — фиксированные строки (`probe-cli.ts:33-34,38`); report содержит только типы/байты/HMAC; observer-тесты grep'ают синтетический секрет во всех стоп-путях. `credentialRouteGeneration` = sha256(ciphertext+ids) — необратим. Куда пишутся кадры: `report.json` в приватном каталоге хоста, **не в observations** → изменения enum `observation_source`/контракта/SDK не требуются (и их нет).
- Kill-switch принудительный → **подтверждено**: observer `deadlineTimer` → `socket.close()` + resolve; `probe-cli.ts:12-15` жёсткий `process.exit(124)` через 145 с; `run-probe.py:64-66` `communicate(timeout=150)` → `kill` + `docker rm --force <uuid>`; `--rm --memory=256m --pids-limit=64 --read-only --cap-drop=ALL`. От сервера не зависит.
- «Decision 321 numbered from main 0a08365f (latest 320)» → **подтверждено**; замечание: main не содержит Decision 288 ни в quick-ref, ни заголовком (execution-log на main ссылается на 288 «в воздух») — W0 добавляет и 288, и 321 с обеими строками quick-ref; конфликтов с C1 (294) нет.
- «platform branch budget 155→156 … explicit boundary» → **подтверждено** (`git grep` по regex ratchet: main 155, C1 155, W0 156; `w0_2026_09_13` с обоснованием в `platform-branch-budget.json`).
- «Before/after credential-route fingerprints match; zero REST requests» → fingerprints **измерены** (`generationUnchanged: true`); zero REST — **по конструкции, не измерено** (константа).
- «container removal and temporary configuration removal are confirmed» → **не проверяемо офлайн** (receipt `validation.json:112-113`); удаление remote-каталога `/tmp/hub-fansly-w0-…` не заявлено (находка 4).
- «Independent reviews … Source fingerprints» → sha256 всех 10 файлов из `validatedSourceSha256` совпадают с ea0d6405 (`fansly-probe-context.ts` — с хешем после «removed one EOF blank line»).
- «The approved Lilly-1 probe ran» → **опровергнуто как receipt**: одобрение запуска в ветке отсутствует (находка 3).

## 4. Архитектура

1. **Ledger миграций уже «двухголовый».** Прод несёт применённые 0185/0186, репо — нет; runner проверяет контиг только по файлам на диске, guard — только «последний файл применён». Система не умеет сказать «в БД есть миграция, которой нет в коде». Пока прод деплоится release-коммитами, а main — источник для PR-ов, такое расхождение будет повторяться; нужен инвариант «`schema_migrations` ⊆ файлы на диске» на старте (fail-closed), а 0186 — в main под тем же именем.
2. **Граница egress для WS не механизирована.** Stage 26 держится на ratchet `fetch(`; W0 добавляет второй вид транспорта и оставляет его на конвенции. План это предвидел и потребовал расширить ratchet — не сделано. До B0 (постоянный receiver в worker) это обязательный гейт, иначе первый же рефакторинг уведёт сокет мимо прокси.
3. **Второй читатель credentials.** `resolveFanslyProbeContext` дублирует политику «Fansly без прокси = отказ» из `resolveStoredPageContext` (без инцидента), а `resolveEgress` создаёт ещё один dispatcher помимо адаптерного кэша. Для probe приемлемо; для B0 план сам требует вынести `FanslyPageEgress` в `services/egress` — сейчас появилось три места, где решается «какой прокси у страницы».
4. **C1 receipts честны, но остаточный риск существующего предиката остаётся (PLAUSIBLE, не воспроизведено).** Правило деактивации (main с #117/#122): `is_active and last_seen_at < fullSweepStartedAt and (last_seen_generation is null or < generation-1)`, только при exact membership proof (`generationObservedCount === followCount` или delta полностью объяснена `firstSeenDuringSweepOutsideGeneration`) и при `candidates ≤ max(50, active/100)`. Grace = один предыдущий generation + любое касание с начала sweep. Сценарий ложной деактивации: фолловер, пропущенный offset-пагинацией в двух подряд поколениях N и N+1 (перекрытие при сдвиге списка), при точном совпадении счётчика (компенсация новым фолловером) → retired; cap ≥50 одиночную строку не защищает. 429 посреди обхода безопасен (run падает, offset/generation сохраняются, verification только после `page.done`). C1 впервые делает это наблюдаемым (`deactivatedCount` рядом с `terminalDelta`/`offset_drift_tolerated`); политика «withhold при `deactivatedCount>0 ∧ terminalDelta≠0`» — решение уровня плана, не этого PR.
5. **`fansly-events-execution-2026-09-08.md` как общая изменяемая таблица лейнов** — каждый черновик переписывает вводную строку и чужие ряды; конфликт C1↔W0 гарантирован, а «текущее состояние» в файле не является ничьим источником истины (что CLAUDE.md и запрещает для CLAUDE.md, но не для этого файла).

## 5. Что прогнал

Временные worktree `hub-audit-F-c1` (3a6eace1) и `hub-audit-F-w0` (ea0d6405), `node_modules` симлинками; удалены через `git worktree remove --force` (проверено `git worktree list`). Файлов в репо не создавал; `tests/audit-tmp-E-*` в аудит-worktree — чужие (лейн E).

- W0: `pnpm exec vitest run tests/fansly-probe-args.test.ts tests/fansly-probe-observer.test.ts tests/fansly-ws-diagnostic.test.ts tests/fansly-ws-report.test.ts tests/fansly-probe-transport.test.ts tests/platform-registry.test.ts` → **5 файлов pass, 64 теста pass; 1 файл (`fansly-probe-args`) не загрузился**: `Cannot find package 'pg' imported from scripts/fansly-ws/probe.ts` — причина среды: `pg` есть в root `devDependencies` на main (package.json:53), но в `node_modules` основного чекаута (отстаёт на 9 коммитов) симлинка `pg` нет. После добавления линка на `.pnpm/pg@8.20.0` в temp-worktree: **7 passed**. Не дефект ветки.
- W0: `pnpm exec vitest run tests/retention-deleters.test.ts` → 4 passed. `python3 tests/fansly-probe-launcher.py` → `Ran 6 tests … OK`.
- C1: `pnpm exec vitest run tests/sync-handlers.test.ts tests/followers-reconcile-decision.test.ts tests/followers-reconcile-cursor-state.test.ts tests/retention-deleters.test.ts tests/platform-registry.test.ts` → 5 файлов, **104 passed**.
- Repro runner (scratchpad `migr-repro/repro.mts`, `tsx` против `hub-audit-20260914/packages/db/src/migrate-runner.ts`, fake `db.query`):
  `A main-today → prod (applied 0185/0186, disk lacks): OK, executed=[]`
  `B C1 merged, DB without 0185 but with 0187+: ERROR Out-of-order migration detected: "0185_…" is not applied but the later "0187_…" already is`
  `C C1 merged → prod: OK, executed=[]`
  `D another "0186_something_else.sql" → prod: ERROR Out-of-order migration detected: "0186_something_else.sql" …`
- Ratchet `platform[[:space:]]*(===|!==)` через `git grep` по деревьям: main 155, C1 155, W0 156 (новый сайт `fansly-probe-context.ts:25`).
- Байтовые сверки: `git diff 380326368f origin/feat/fansly-c1-followers -- packages/db/migrations` → только `−0186` (0185 идентичен); `… -- packages/db/src/repositories/fans.ts` → прод +5 строк alias-sort; sha256 10 файлов W0 = `validatedSourceSha256`.
- Диффы веток: `git diff origin/main...origin/<branch> --stat` — 34 (C1) и 49 (W0) файлов, все в списках PR; кодовые hunks только аддитивные/рефакторинг (`page-context.ts`: вынос `decodeStoredFanslySession`, для OnlyFans-страниц ранний return сохранён — поведение эквивалентно).

## 6. Не проверено и почему

- Интеграционные suites обеих веток (`followers-membership`, `fansly-probe-context` и др.), `pnpm check`, CI-run 34729730620 — запрещено лейну / офлайн.
- Реальная совместимость undici `WebSocket` + `ProxyAgent`/SOCKS с прод-прокси — только локальные fixtures; живой receipt в ветке говорит, что сработало.
- Факт удаления remote-каталога probe, состояние docker на VPS, наличие строк 0185/0186 в `schema_migrations`, receipt gen 776 — прод.
- Наличие явного owner-«yes» на запуск живого probe — история чата.

### Запросы к оркестратору (`read_only`)

```sql
-- (1) ledger: подтвердить, что прод применил 0185/0186 и что после них есть 0187–0191
select id, applied_at from schema_migrations where id >= '0184' order by id;

-- (2) доступ к restricted reader из 0185
select has_function_privilege('read_only',
  'fansly_followers_diagnostic_timeline(timestamptz,timestamptz,bigint,bigint,integer)', 'EXECUTE');

-- (3) все терминальные receipts с фактической деактивацией с момента восстановленного релиза (12.09 14:43 UTC);
--     окно ≤ 8 дней, пагинация по nextRunId (передать как 3-й аргумент), 500 строк/страница
with t as (
  select fansly_followers_diagnostic_timeline('2026-09-12T14:40:00Z','2026-09-14T12:00:00Z', 0, null, 500) as j
)
select r->>'run_id' run_id, r->>'page_label' page, r->>'stream' stream, r->>'started_at' started_at,
       r->>'outcome' outcome, r->>'membership_proof' proof, r->>'membership_receipt_valid' receipt_valid,
       r#>>'{sections,membership,generation}' gen,
       r#>>'{sections,membership,sourceFollowerCount}' src,
       r#>>'{sections,membership,generationObservedCount}' observed,
       r#>>'{sections,membership,activeFollowerCount}' active_before,
       r#>>'{sections,membership,deactivationCandidateCount}' candidates,
       r#>>'{sections,membership,deactivatedCount}' deactivated,
       r#>>'{sections,membership,generationGraceOnlyCount}' grace_only,
       r#>>'{sections,membership,touchedSinceStartOnlyCount}' touched_only,
       r#>>'{sections,statistics,destructiveFinalization}' destructive,
       (select j->>'nextRunId' from t) next_run_id
from t, jsonb_array_elements(t.j->'records') r
where r#>>'{sections,membership,outcome}' = 'complete'
order by (r->>'run_id')::bigint;
-- Ожидание по ветке: Lilly-2 run 734771 gen 792 deactivated=2 (18,324→18,322, buckets 0);
-- для находки 5 — строка Lora-3 с gen 776 и deactivated>0 (в ветке отсутствует).
```

Дополнительно (git, без прода): `git diff 380326368f origin/main -- packages/db/src/repositories/fans.ts` — подтвердить, что alias-sort (находка 6) прод-only; `git diff 380326368f origin/main --stat -- apps packages scripts` даёт 149 файлов расхождения прод/main — вне лейна F.
