# Лейн C-replay-transcript — PR 158 / 159 / 161 / 162 (replay материала и окно переписки)

Код читался из worktree `/Users/dmitriy/code/goose/.worktrees/hub-audit-20260914` (origin/main = `0a08365f`); прод = `380326368f`. Все `file:line` ниже — по worktree, если не сказано «прод».

## 1. Вердикт

Сами четыре PR данных не теряют и не дублируют (msg-ключи стабильны, дедуп «первый писатель по (account_id, dedup_key)», reply-часы работают как заявлено), но **#159 в main не делает проходы capture/replay раздельными** (replay-проход выбирает и штампует parse_version=0 строки, poison-строки v0 сканируются обоими проходами каждый тик) — прод это уже починил коммитами 96a86c1f (Decision 311) и 14219b68 (Decision 315), которых **в main нет**, как нет в `docs/decisions.md` main записей 311/312/315. Replay/sweep к Fansly по сети не ходят вообще — рост `dm_messages` HTTP не из #158/#159.

## 2. Находки

| № | P | Статус | file:line | Что ломается (вход → неверный выход) | Наименьший фикс |
|---|---|---|---|---|---|
| 1 | P2 | CONFIRMED | `apps/runtime/src/services/canonicalize-driver.ts:473-487` (`belowParseVersion: pass === "unparsed" ? 1 : belowParseVersion` :476; `atLeastParseVersion: family.minimumParseVersion` :478 — для replay-прохода нижней границы нет) | Decision 279 заявляет «separate durable cursor for parse_version < 1» и «observation cursors remain independent». Фактически replay-проход (`parse_version < 6`, без `>= 1`) видит те же v0-строки. Вход: 2 unmapped v0-строки, pageSize 1, maxPages 2 → оба прохода читают строку 1 (`listObservationsForReplay` вызван с `[1,null,null]` и `[6,null,null]`, `skippedUnmapped: 2` за один тик); вход: 3 mapped v0-строки → строку 2 штампует **replay**-проход и его курсор (`pull:sync:v6:…` → afterId 2) уезжает за capture-работу, курсор `unparsed:` остаётся на 1. Следствие в проде до фикса: страница poison/unmapped v0 (например, страницы без native ref, `sync-pull.ts:159-165`) перечитывается дважды за тик, а «независимость» курсоров — только по ключу, не по множеству строк. Воспроизведено временным юнит-тестом (см. §5). | Перенести в main прод-коммит 96a86c1f: для `pass === "replay"` передавать `atLeastParseVersion: Math.max(1, family.minimumParseVersion ?? 0)` (+ его учёт `pagesUsed/reachedEnd` и одну доработку первого прохода, иначе при пустом replay capture теряет половину страниц — ровно то, что ревью Decision 311 отвергло в первой версии). |
| 2 | P2 | PLAUSIBLE (измерено на проде авторами Decision 315, здесь не воспроизводимо без БД) | `packages/db/src/repositories/domain-events.ts:1012-1076` (main) — в проде перед `select … order by o.id asc limit` стоит existence-guard по индексу 0144 (`git diff 380326368f origin/main -- packages/db/src/repositories/domain-events.ts`, −47 строк) | Пустая «голова» семейства (`parse_version < N`, `afterId null`, `order by id limit 200`) на проде планируется как id-обход помесячных PK: ~2,39 млн строк / ~999 000 буферов / 1,21–1,51 с на семейство за пустую первую страницу (Decision 315, прод-EXPLAIN). После #159 у семейства `pull:sync` таких селекторов **два** за тик (`unparsed:` и replay), и после завершения v6-replay оба пустые каждую минуту; плюс каждое другое догнавшее семейство. main без 14219b68 платит это на каждом тике сweep. | Перенести 14219b68 (`listObservationsForReplay` existence-probe через `(parse_version, source, kind, received_at)`), вместе с `tests/observations-replay-head.integration.test.ts`. |
| 3 | P2 | CONFIRMED | `git log origin/main..380326368f` → 96a86c1f, 14219b68 (+ bdbb981c, a86ac13e вне вопросов лейна); `docs/decisions.md` main: есть 313, 314, 316–320, **нет 311, 312, 315**; `tests/canonicalize-budget.test.ts` main −4 теста относительно прода (`resumes capture after its half-time allowance…`, `returns unused capture pages to replay…`, `preserves borrowed-page overshoot fairness…`, `does not start the borrowed forced first page…`); нет `tests/canonicalize-pass-partition.integration.test.ts`, `tests/observations-replay-head.integration.test.ts` | Прод в scope лейна ≠ main: reviewed-и-задеплоенные исправления driver'а и селектора живут только в release-ветке. Любой следующий релиз, собранный от main (или «dist-only follow-up» по CLAUDE.md), тихо откатит Decision 311/315 и вернёт находки 1–2; append-only журнал решений в main имеет дыры в нумерации (311/312/315 отсутствуют, 313 нумерован «## 313.» не в формате «## Decision N»). | Вмерджить release-коммиты (или cherry-pick 96a86c1f + 14219b68 + их тесты + тексты Decision 311/315) в main до следующего деплоя; проверка `git diff <prod> origin/main -- apps/runtime/src/services/canonicalize* packages/db/src/repositories/domain-events.ts` должна быть пустой. |

P3 (не выводятся): дублированный fallback `Object.hasOwn`-логики presence между `sync-pull.ts:784-795` и `message-archive.ts:141-144`; `## 313.` без слова Decision.

## 3. Утверждения PR / decision

| Утверждение | Статус | Доказательство |
|---|---|---|
| #158: «ordinary `msg:<direction>:<id>` events retain their original dedup identity», replay «не дублирует message events» | подтверждено | `sync-pull.ts:203` ключ `msg:${direction}:${messageId}` не зависит от версии; дедуп — `domain-events.ts:372-374` `insert into domain_event_keys … on conflict (account_id, dedup_key) do nothing` (первый писатель по ключу, не по хэшу). Временный тест: два observation одного сообщения с разным `receivedAt` → `msg:received:m-1` один и тот же; `msg-material:` ключи разные; тот же observation повторно → тот же `msg-material` ключ (дедуп при следующем бампе версии). |
| #158: v6 replay «чинит связи, не заменяя более новое тело» | подтверждено (прослежено) | Тело: `message-archive.ts:324-338` — upsert только если `content_pending` или `serving_contract_version <` или `material_observed_at >= target` (у replayed события `materialObservedAt = observation.receivedAt`, `sync-pull.ts:858`) → старое тело не перекрывает новое. Reply: `applyReplyMaterial` вызывается **всегда** при `replyContractVersion === 1 && fieldPresence.reply === true` (`:354-359`), с часами `accept_parent = observesParent AND observedAt >= coalesce(reply_parent_observed_at, case when in_reply_to_ref is not null then material_observed_at end, '-infinity')` (`:150-154`), root аналогично (`:155-159`). Равенство часов принимается (`>=`) — тот же observation повторно перезаписывает тем же значением; два разных observation с одинаковым `received_at` практически невозможны. Legacy без часов: известный ref → `material_observed_at`, неизвестный (NULL) → `-infinity` (любое retained наблюдение чинит). Явный clear (`inReplyTo:null,inReplyToRoot:null`) → `reply = null`, presence true (`sync-pull.ts:791-795`) → часы двигаются, stale replay отвергается (`observedAt >= clock` ложь). |
| #158: «v5 sidecar больше не очищает reply» | подтверждено | `message-archive.ts:239-240` `observesReply = fieldPresence.reply !== false && head.originClass !== "fansly_dm_sidecar"` → для sidecar whole-head никогда не трогает `in_reply_to_ref/reply_metadata`; только `applyReplyMaterial` с часами. |
| #158: «No provider request» / runbook «No new Fansly HTTP calls are made by reply replay» | подтверждено | см. §7. |
| #159: «Select parse version zero separately … independent cursors» | **опровергнуто частично** | Находка 1: ключи курсоров разные (`canonicalize-driver.ts:458`), множества строк пересекаются (v0 ⊂ `< 6`). Именно это чинит прод-коммит 96a86c1f. |
| #159: «either pass receives the first turn after a slow page, deadline overshoot, or process restart» | подтверждено | Маркер `next-pass:` пишется CAS-ом **до** работы (`:439-444`, `canonicalize-sweep.ts:23-34` `where key and revision`), после обоих проходов сбрасывается (`:455`); структурная ошибка первого прохода пробрасывается в `runCanonicalization` (`:793-817`, семейство `errored`), второй проход в этом тике не бежит, но маркер уже отдал первую очередь другой половине на следующий тик; per-row ошибки не влияют (`:649-679`). Тест `gives the other pass its turn after page overshoot and process restart` (последовательность `[1, 6, 1]`) — пройден. |
| #159: «keeps fresh capture moving» с конкретными числами | не проверяемо в тесте | Юнит: pageSize 1, maxPages 2–4, бюджет 100 мс, 3–4 строки (`tests/canonicalize-budget.test.ts:157-217`); интеграция: 4 строки + 1 unmapped (`tests/canonicalize-sweep.integration.test.ts:165-243`). Производственных чисел (1 422/2 394 never-parsed за 295 738 v5) в тестах нет; реальная скорость в PR-теле: 400 из 2 394 за ~19 мин до отката, т.е. ~21 obs/мин при потоке ~5 dm_messages/мин. |
| #159: starvation | опровергнуто (голодания нет) | Первый проход ≤ floor(20/2)=10 страниц и половина остатка времени (`:445-449`), второй — остаток страниц (`:451`) и полный дедлайн; overshoot → маркер меняет очередь; худший случай — очередь через тик. Бесконечного голодания одной половины нет; из-за overlap (находка 1) capture-строки также съедаются replay-проходом, что скорее ускоряет capture, но ломает учёт курсоров. |
| #161: «preserves source priority across timestamp changes» | подтверждено (по дизайну), см. Q3 ниже | `agent-transcript.ts:149-170` `window_refs` = refs, у которых **любая** копия в окне; `:201/238/274` грузятся все версии; `:313-317` `distinct on (message_ref) … source_rank desc`; `:362` финальный `inWindow(u.event_time)` по **победившей** копии. Следствие: сообщение, у которого предпочтительная копия вне окна, а непредпочтительная — в окне, **исчезает** из этого окна (до #161 показывалась непредпочтительная копия). Для Fansly обе копии датируются одной эвристикой (`canonicalize/types.ts:86-96` vs `sync/shared.ts:48-51`), расхождение возможно только у pre-2024 строк, созданных `message.received` с клампом (`canonicalize-driver.ts:92-113` → `occurred_at = receivedAt`) и не получивших v6-материала — тогда окно «истинного» времени теряет сообщение, окно времени приёма показывает его. Реальность такого корпуса на проде не проверена (запрос в §6). |
| #161: ORDER BY без квалификации (ловушка alias) | подтверждено (чисто) | `agent-keyset.ts:72-76` `order by k_sort/k_key` — это единственные алиасы CTE `u` (`agent-transcript.ts:325-330`), совпадают с колонками; `:316` `order by c.message_ref, c.source_rank desc` квалифицирован. Alias-ловушки нет. |
| #162: «chatless delete stubs still dominate», scoped к текущему binding | подтверждено, но семантика **не изменилась** относительно до-#162 | До: `git show 34d89777^:…agent-transcript.ts:255-264` — `d.ofapi_account_id = page.ofapi_account_id … where page.ofapi_account_id is not null`; после: `:288-296` — `d.platform = $platform and d.ofapi_account_id = (select p.ofapi_account_id from page p)`. Оба смотрят только на **текущий** binding. |
| Q4: перепривязка страницы → tombstones старого binding невидимы → «воскрешение» | PLAUSIBLE, **не введено #162** (было и до), OF-only | `cross_tombstones` читает только `dm_message_archive` (`:291`) по текущему `ofapi_account_id`; chatless-стаб старого binding не попадает ни туда, ни в `dm_arm` (`platform_conversation_id` NULL, `:240-241`). Для Fansly неприменимо: у Fansly-страниц `ofapi_account_id` NULL → `cross_tombstones` пуст; продюсеров `message.deleted` для Fansly нет (`ofapi-webhook.ts:160-172`, `client-capture.ts:88-96` — оба OnlyFans), `deletePageDmMessageByPlatformMessageId` (`page-dm.ts:640-661`) вызывается только из `ofapi-dm-projection.ts:366`. Т.е. Fansly-удаления в транскрипте **не представлены вовсе** (не «воскресают», а никогда не «умирают») — PR 158/159 честно оставляют «edits/deletes uncovered». |
| Hard rules (Q5) | подтверждено | `node scripts/check-platform-branches.mjs` → `155 (budget 155)`; в диффах четырёх PR по `apps/`+`packages/` нет добавленных `delete from`/`truncate` и `platform ===`; prompts/contracts/sdk/reference не тронуты (stat по 4 merge-коммитам); миграция 0173 следует за 0172 (#157), forward-only, только `ADD COLUMN` nullable; egress не затронут (canonicalize-дерево не импортирует адаптеров). |

## 4. Архитектура (по существу)

1. **Второй писатель reply-поля.** `in_reply_to_ref` у Fansly-строк пишут два механизма с разными часами: whole-head upsert (для не-sidecar/OFAPI, часы `material_observed_at`/`vendor_changed_at`) и `applyReplyMaterial` (sidecar, свои часы `reply_*_observed_at`). Строка, у которой parent пришёл из superseding head (`message-archive.ts:363-373`, `material_observed_at` NULL), имеет часы `-infinity` (`:151-153`) — любой retained observation её перепишет, в т.ч. другим parent'ом (`changed_parent` сносит root). Для Fansly reply-ссылки неизменяемы, поэтому сейчас безвредно; закладка на будущее — clock должен ставиться каждым писателем поля.
2. **Амплификация материала.** Fingerprint включает `materialObservedAt` (`sync-pull.ts:858-861`), поэтому одно сообщение, попавшее в K страниц `dm_messages` (страницы перекрываются, а `inReplyTo:null` — обычный ключ у Fansly), порождает K событий `message.material_observed` и K×2 statement'ов в проекции (upsert + row-lock reply update) — не только при replay, но и на каждом свежем захвате. PR-тела: 22 941 текстовых occurrences/сутки как кандидаты; тик проекции 343 с (242 с в `message_archive`); подтверждение serving после Lilly-replay через 50–66 мин. Это не баг, но проекция стала линейной по числу страниц, а не по числу сообщений; фильтр «fingerprint без времени приёма + отдельный clock» убрал бы K→1 без потери часов.
3. **Граница replay-проходов = граница множеств, а не ключей.** Decision 279 описала независимость через ключи курсоров; корректная граница — предикат селектора (Decision 311 в проде). Рецензия #159 это пропустила, потому что тест `gives replay the whole page allowance…` мокает `listObservationsForReplay` и **сам** отдаёт v0-строки replay-проходу как норму.
4. **Три хранилища tombstone'ов и один lookup.** Транскрипт ищет chatless-стабы только в замороженной `dm_message_archive` (`agent-transcript.ts:288-296`), тогда как новые `message.deleted` от OFAPI-вебхука без chat-scope создают стаб в `message_archive` с `conversation_ref` NULL (`message-archive.ts:468-483`) — он невидим и `archive_arm` (`:204`), и `cross_tombstones`. Пока стаб гидрируется контентным событием — ок; если контент живёт только в hot-таблице — сообщение показывается живым. OF-only, вне Fansly-лейна, но это та самая «спекулятивная» lookup-ветка, которую #162 оптимизировал, не пересмотрев.
5. **Release-ветка как источник правды.** Decisions 311/315 существуют только в `380326368f`; main-ветка не знает ни кода, ни решений. С правилом CLAUDE.md «commits made after a deploy starts need a dist-only follow-up» это означает, что следующий follow-up от main откатит их без ревью.

## 5. Что прогнал

```
cd /Users/dmitriy/code/goose/.worktrees/hub-audit-20260914
pnpm exec vitest run tests/canonicalize-budget.test.ts tests/canonicalize-media-plane.test.ts \
  tests/canonicalize-sync-pull.test.ts tests/agent-read-transcript-witnesses.test.ts \
  tests/canonicalize-fansly-replay.test.ts tests/retention-deleters.test.ts tests/agent-read-cursors.test.ts
→ Test Files 7 passed (7); Tests 95 passed (95); Duration 4.04s; exit=0
   (лог: scratchpad/laneC-unit-run1.log)

# временный пробник (удалён): tests/audit-tmp-C-replay-transcript-overlap.test.ts
pnpm exec vitest run tests/audit-tmp-C-replay-transcript-overlap.test.ts
→ Test Files 1 passed (1); Tests 4 passed (4)
   H2a: unmapped v0 строка видна обоим проходам: вызовы [below=1,atLeast=null,after=null],[6,null,null]; skippedUnmapped=2
   H2b: 3 mapped v0 строки, pageSize 1, maxPages 2 → markObservationParsed [1, 2]; курсор "unparsed"→1, курсор "pull:sync:v6"→2
   H3a: один message в 2 observation → msg:received:m-1 ×1 (одинаковый), msg-material ×2 (разные); тот же observation повторно → тот же msg-material
   H3b: inReplyTo:null,inReplyToRoot:null → ["message.received","message.material_observed"], head.reply=null, fieldPresence.reply=true

node scripts/check-platform-branches.mjs → platform === branch sites: 155 (budget 155)
git diff 380326368f origin/main -- apps/runtime/src/services/canonicalize apps/runtime/src/services/canonicalize-driver.ts packages/db/src/repositories/message-archive.ts apps/runtime/src/modules/agent packages/db/src/repositories/agent-transcript.ts
→ 4 files changed, 44 insertions(+), 152 deletions(-) (driver 115, index.ts 61, types.ts 17, fansly-earnings.ts 3); message-archive.ts / agent-transcript.ts / modules/agent идентичны
git diff 380326368f origin/main -- packages/db/src/repositories/domain-events.ts → −47 строк (existence-guard только в проде)
```

Интеграционные тесты (`fansly-dm-reply-material`, `canonicalize-sweep`, `agent-transcript-window`, `agent-transcript-tombstone`, `message-archive*`) **не запускались** по режиму брифа; их даты коммитов совпадают с merge-коммитами PR (08.09 15:03 / 17:24, 09.09 00:07 / 21:09), REVIEW.md тех же дат.

## 6. Не проверено и почему

- Реальное поведение SQL `applyReplyMaterial` и окна транскрипта на Postgres (нужны Testcontainers) — только трассировка; интеграционные тесты авторов покрывают stale replay / clear / rebuild (`tests/fansly-dm-reply-material.integration.test.ts:72-217`) и window/tombstone (`tests/agent-transcript-*.integration.test.ts`), но не Fansly-кейс с клампом pre-2024.
- Стоимость пустой головы (находка 2) — только по прод-EXPLAIN из Decision 315; локальной БД нет.
- Q4 для OF после смены binding — не воспроизводил (вне Fansly-scope).

**Запросы к оркестратору (роль `read_only`):**
1. Есть ли на Fansly-страницах pre-2024 сообщения, у которых архивная дата сдвинута клампом (Q3-регресс #161 возможен только при них):
   ```sql
   select o.account_id, count(*) 
   from observations o
   where o.source='pull' and o.kind='dm_messages' and o.platform='fansly'
     and o.received_at >= now() - interval '90 days'
     and exists (select 1 from jsonb_array_elements(o.payload->'messages') m
                 where (m->>'createdAt')::numeric < 1704067200)
   group by 1;
   ```
   (если `payload` для pointer-only строк NULL — сказать, тогда нужен другой источник.)
2. Динамика двух селекторов `pull:sync` после завершения v6-replay (пусто ли `parse_version < 6` кроме v0):
   ```sql
   select parse_version, count(*) from observations
   where source='pull' and kind in ('dm_messages','purchase_history','earnings_transactions')
     and parse_version < 6 group by 1 order by 1;
   ```
3. Ключи курсоров семейства (`canonicalize_sweep_cursors` не в списке read_only — если недоступно, пропустить): наличие двух ключей `unparsed:pull:sync:v6:*` и `pull:sync:v6:*` и их `after_id` подтвердят находку 1 на проде.

## 7. Отдельно: даёт ли replay (#158) / sweep (#159) HTTP к Fansly (`dm_messages`)?

**Нет. Оба PR — чисто журнальные; ни одна ветка кода replay/sweep не ведёт к сетевому запросу.**

Путь v6-replay (и минутного sweep, и CLI `events:replay`, и scoped `fansly-replay`):
- `worker-services.ts:395-396` → `runCanonicalization({ useSweepCursor: true, maxDurationMs })` → `canonicalize-driver.ts:706-827` → `runFamily` (`:399-687`):
  - `listObservationsForReplay` (`domain-events.ts:1012-1076`) — SELECT из `observations`;
  - `resolveCapturePayloadRow` (`payload-reader.ts`) — inline-колонка или CAS-каталог в Postgres; в файле нет ни одного `fetch(`/`http` (grep пуст);
  - `family.canonicalize` = `canonicalizeSyncPullObservation` (`sync-pull.ts:214-233`) — чистая функция над `observation.payload`;
  - `appendMixedDomainEvents` / `markObservationParsed` — Postgres.
  - Импорты `canonicalize-driver.ts:1-40` и всего `services/canonicalize/*`: нет адаптеров платформ, egress-резолвера, `undici`/`fetch` (grep по `fetch\(|https?://|undici|axios|createFanslyClient|egress` — 0 совпадений, кроме комментария в `fansly-payouts.ts:218`).
- Scoped replay CLI: `fansly-replay.ts:418-437` → тот же `runCanonicalization` + `runFanslyReplayProjection` (проекция); сетевых импортов нет. Единственный HTTP в процессе CLI — OFAPI credential preflight `GET /whoami` (`ofapi.ts:838-845`, только при настроенном `expectedTeam`), это OFAPI, не Fansly, и runbook это честно оговаривает (`docs/runbooks/fansly-dm-reply-repair.md:90-91`).
- #159 меняет только порядок/лимиты страниц селектора (`canonicalize-driver.ts:428-457`) — 0 сетевых вызовов.

Где физически рождаются `dm_messages`-запросы к Fansly: **только** sync-executor, стрим `dm_messages`: `executor-handlers.ts:2648` `fanslyDmMessagesChunk` → цикл `while (input.budget.hasRequestCapacity() && input.budget.hasWallClockCapacity())` (`:2899`) → `fetchAndJournalFanslyDmMessagePage(...)` (`:2909-2918`). Кандидаты на обход — `selectNextPageDmMessageSyncCandidate` (`:2793-2796`): `pending_backfill`/follow-up из `fanslyDmConversationsChunk` (`fansly-dm-conversations.ts:922-928`) и, **только при allowlist**, head-debt (`includeHeadDebt` `:2794`). Равномерные ~5 req/мин (300/час 03:00–11:00 UTC 12.09) — сигнатура бюджетного обхода executor'а, а не replay (replay в принципе не умеет делать запросы).

Про #157 (для лейна A, не дублирую): его новые запросы гейтятся `fanslyDmHeadCatchupPageAllowlist` (`executor-handlers.ts:2651-2654`, `fansly-dm-conversations.ts:247-250`), который по PR-телам был `none` весь период → при выключенном флаге в цикле запросов нет новых веток; единственный не-гейтнутый побочный эффект — очистка «рider'а» `headCatchup` при выключенном флаге (`:2671-2680`), которая при `overlapReached || pagesRead === 0` сбрасывает **весь** cursor-state страницы в `emptyDmMessagesCursorState()` (перезапуск обхода разговора = лишние страницы), и инвалидация всего state парсером при невалидном `headCatchup` (`cursor-state.ts:713-720` → `null` → пустой state). Это касается только страниц, где rider успел появиться (ari-canary 08.09), и не объясняет старт роста на lilly-2 **07.09** — до деплоя всех трёх PR. Объём HTTP от #157/#158/#159 при `allowlist=none`: **0 дополнительных запросов** по коду.
