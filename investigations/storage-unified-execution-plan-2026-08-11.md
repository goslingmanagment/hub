# Единый исполняемый план компакции хранения (финальный)

Дата: 2026-08-11. Статус: G1 построен в worktree `ai/260811-storage-g1`, прод не менялся
(кроме owner-одобренных read-only замеров и удаления `/tmp/agency-hub-dist-overlay-20260717…`, 24 МБ).

Этот документ — синтез двух независимых расследований и их адверсариальной перепроверки:

- **Архитектурный документ (codex)**: `investigations/storage-compaction-architecture-2026-08-11.md` —
  остаётся канонической спецификацией G2–G6 (generation membership, CAS payload model,
  tiering-исправления). Здесь НЕ дублируется; ниже — только поправки к нему.
- **Верификация (14 агентов, два раунда: 12 вердиктов + 4 адверсариальных рефутации,
  все требования подтверждены file:line-цитатами)**: журнал
  `~/.claude/projects/-Users-dmitriy-code-goose-hub/fd296d1a…/subagents/workflows/wf_f52595f1-1ec/journal.jsonl`.

## Замеренные факты (прод, 2026-08-11)

- Диск 88% (свободно ~9.3 ГБ и падает), БД 55 ГБ, чистый рост ~2.0 ГБ/день values + ~0.42 ГБ/день логов.
  Операционный режим: **runway ≤ 4 дня**.
- Топ-писатель: чекпоинт-телеметрия `sync_run_events.details` + `sync_runs.stats`
  (~1.34 ГБ/день) — O(N²) от `snapshotConversationIds` через `summarizeCheckpoint`.
- Пара raw∥observations ~0.67 ГБ/день (дубль-копия ~0.33 ГБ/день).
- 83% строк stdout воркера — `sync_http`-трейс (замерено на VPS).
- `local`-лог-драйвер на VPS работает (Docker 29.6.1, daemon.json отсутствует → сейчас json-file unbounded).
- Событий `sync_run_events` старше 7 дней: 958 652 строки / ~2.4 ГБ values.
- 5 старых image-тегов = ровно 2 удаляемых образа (ID-карта снята; one-step rollback остаётся).
- `sync_raw_payloads`: 643k из 1.29M строк уже с `sync_run_id = NULL` (ночной свип нуллит lineage давно).

## Вердикты верификации → поправки к плану

| Узел | Вердикт | Обязательная поправка |
|---|---|---|
| Чекпоинт-телеметрия (G1) | NEEDS_CHANGE | Generic-проекция state (скаляры verbatim, массивы→`Count`, объекты→`Keys`; cap 32 ключа, строки ≤120); **сохранить** `cursorText`/`cursorTimestamp`/`lastSuccessfulRunId` (CLI-читатели view.ts:232-233); **починить `advanced`-флаг** write-time-сетом вместо JSON-диффа (иначе progress-only раны станут «unchanged»); события НЕ переставать эмитить (partial/failed-классификация) |
| Retention-флип 30→7 | REFUTED | Ручка `runtimeApply:"none"` — только env+рестарт воркера, НЕ live/НЕ audited; one-shot ночной свип опасен (unbatched, pg-boss 15-мин expiry → повторный диспатч). День-0 = **батчевый DELETE только листовых** `sync_run_events` (по индексу emitted_at) + `sync_http_attempts`; **`sync_runs` не трогать** (неиндексированный FK SET NULL → seq-scan 19.5 ГБ ×130k; `sync_run_id` — компонент ключей идемпотентности observations, на нём ремонт класса A22/#133). Steady-state = **14 дней** (читатели: monitor windowHours до 14д, incidents summary 7д), env-правка едет в окно G1-рестарта |
| Подавление stdout-трейса | CONFIRMED+fix | Фильтровать только stdout-синк; дропать started+success; **DB-failure-фолбэк обязателен** (пин tests/observability.test.ts:53: при потере DB-строки stdout — выживающая запись); флаг `SYNC_HTTP_ATTEMPT_TRACE_STDOUT` EDITABLE/`none`, default false |
| Лог-ротация compose | NEEDS_CHANGE | Анкор 20m×5 на все 4 сервиса + деривативный контракт-тест; применять **не полным деплоем** (образ сожрёт runway) и не по-сервисно (`up -d worker` тянет deps): один recreate всех четырёх с полным вызовом (`--env-file .env.production --no-build --force-recreate`); архив старых логов опционален (история <1 дня, деплой и так их рушит); stdout — на sync-критическом пути (blocking) — после флипа смотреть sync-throughput, `mode: non-blocking` НЕ ставить |
| Image GC + EXIT-trap | CONFIRMED | Кип-сет по полным sha256-ID (никогда по коротким!), abort при <2 ID, только `production-candidate-*`/`-rollback-*`, никаких `system/volume prune`; GC не валит здоровый деплой |
| days_to_full | NEEDS_CHANGE | В G1 — только сэмплинг (3 гейджа `disk_*` в ops_metric_samples) + **фильтр deadman'а** (иначе ops_sampler_silent флапает ежечасно); слоуп+алерт — отдельный PR на своих subKey-латчах (существующий db_disk_usage латч не ре-пейджит — владелец при 88% получил максимум одну страницу) |
| Generation membership (G2/G3) | NEEDS_CHANGE | Монотонный guard в ОБЩЕМ conflict-update (без platform-аргумента — бюджет platform-веток); дефектных писателей три (terminal dm_messages, ofapi-dm-projection.ts:319, ofapi-dm-sync.ts:705); erasure-fence: page-транзакция берёт shared try-lock, completion-count терпит erasure-дельту; `::int`→`::bigint` в maxPageDmThreadGeneration; доказательства — только интеграционные (mock-db не проверяет атомарность) |
| G4 (реклейм телеметрии) | NEEDS_CHANGE | DROP PARTITION = новый механизм удаления → расширить пин retention-deleters (grep на drop/detach/truncate + statement-level пин) в ТОМ ЖЕ PR; PK → `(id, emitted_at)`; экспорт ДО любого delete sync_runs (каскад); pg_repack недоступен (сток postgres:16) → только VACUUM FULL post-prune по headroom-неравенству; следующая миграция — от листинга каталога (уже 0122, CLAUDE.md устарел) |
| G5 (CAS) | NEEDS_CHANGE | Erasure: body умирает только при нуле выживших envelope-ссылок (refcount/reverse-index + свой decision-entry); seam обязан дать `scanBodies` (erasure ищет substring по всему телу); `platform_account_id` NULLABLE + UNIQUE NULLS NOT DISTINCT; два-шаговый протокол — по образцу вебхучного `capture_state='raw_captured'`; **найден живой баг**: `insertObservation` неатомарен — краш после клейма `observation_keys` до журнала = перманентная потеря факта при ретрае; полный реестр читателей payload расширен (`loadOfapiCaptureObservation` #158-реплей, `listObservationsForReplay`×3, webhook-проекции ×6, agent-read `payloadBytes`-контракт и др. — см. журнал) |
| pg-boss | NEEDS_CHANGE | `createQueue` НЕ апсертит (ON CONFLICT DO NOTHING) → только `boss.updateQueue` через единый `reconcileQueueRetention`; `maintenanceIntervalSeconds: 3600` во всех трёх конструкторах; классы очередей A–D (heartbeat 24ч / work 7д / daily ≥7д / DLQ не трогать); это лайфцикл-пин (98 МБ), НЕ runway-мера |
| Image-теги дня-0 | CONFIRMED | Список KEEP/DELETE подтверждён вторым раундом |

## Roadmap (живой раздел — обновлять при каждом продвижении)

| Этап | Что | Статус | Чекпоинт выхода |
|---|---|---|---|
| S0. Замер | Census прода, атрибуция байтов, дубль-рейты | ✅ 11.08 | цифры в этом доке |
| G1. Stop-loss | Чекпоинт-телеметрия ~75×↓, stdout ~8×↓, лог-ротация 20m×5, disk-гейджи, деплой EXIT-trap + opt-in GC | ✅ задеплоен и верифицирован 12.08 (~12:50 UTC), PR #70 → main 5a23794b, Decision #212 | 5/5 компонентов проверены на проде |
| G1-чекпоинт: слоуп | Фактический рост по `disk_free_bytes` за 24–48ч | ✅ 13.08 16:23 UTC, 15ч чистых пост-деплой данных: **−0.37 ГБ/день по регрессии** (по df-эндпоинтам ~−0.6) — гипотеза ≤0.7 подтверждена с запасом; чекпоинт-события ~11 МБ/день (было ~950). Runway ~12–19 дней; runway_warning (<30д) ожидаемо откроется — предупреждён владелец | slope ≤ ~0.7 ГБ/день ✓ |
| День 0.5. Реклейм | Прунинг телеметрии v2 (checkpoint-события >7д + attempts >14д) + снятие 5 image-тегов | поглощён G4-lite (см. строку G4): обе попытки владельца запустить скрипт по ssh-однострочнику молча падали (`&` фонит всю &&-цепочку → stdin=/dev/null → cat пишет пустой файл); 15.08 ~18:52 UTC скрипт залит через scp (sha256 сверен) и запущен — см. итог в строке G4. Снятие 5 старых image-тегов НЕ сделано (owner-gated #176, ~1–2 ГБ, низкий приоритет → S7) | +2.5–3 ГБ reusable, +1–2 ГБ df |
| G1.5. Runway-алерт | `computeRunwayDays` по disk-гейджам + subKey-латчи warning<30д / critical<7д | ✅ PR #72 → main 0b4db19f, Decision #213; задеплоен 13.08 ~00:45 UTC | алерт срабатывает/резолвится симметрично, не флапает, нет страниц на <6ч истории |
| G2. Generation dual-proof | Слайс 1: монотонный `last_seen_generation` в общем conflict-update + ::bigint + интеграционный race-proof. Слайс 2: dual-proof телеметрия рядом с легаси-массивом | слайс 1 ✅ PR #71 (13.08); слайс 2 ✅ PR #74 → main 61f7c1dd, задеплоен 15.08 ~15:15 UTC (после уборки двух протухших замков от убитого рестартом деплоя — удалённого и локального в /var/folders). Копит доказательства; гейт G3 = ноль расхождений за полный цикл (~неделя) | полный бизнес-цикл: generation-set count/digest = легаси-массив |
| G3. Checkpoint cutover | ✅ PR #75 → main c56c6616 (Decision #214), задеплоен 15.08 ~17:30 UTC по доказательному гейту (5 страниц × 3-4 чистых свипа, ноль расхождений; окно ночной уборки снято с критериев — не касается механизма членства). Первый боевой v2-свип сертифицирован: gen-set 13511, certified=true, ноль membership-тревог. Ужесточения по codex-ревью: erasure никогда не авторизует деструктив; несертифицированное членство всегда воздерживается | полный + interrupted sweep без расхождений ✓ |
| G4. Реклейм телеметрии | **ПЕРЕСМОТРЕН 15.08 (G4-lite):** G1 обнулил будущий рост телеметрии (~11 МБ/день против ~1 ГБ) — дневные партиции, смена PK и расширение retention-пина потеряли смысл (steady-state 30д-окна ≈ 350 МБ, штатный свип справляется). Архивация жирных July-данных не нужна: это O(N²)-мусор (дублированные префиксы id), который санкционированный 30д-свип и так удаляет каждую ночь. Остался только финальный аккорд: (1) прунинг >7д (скрипт v2 у владельца; либо естественный roll-off к ~11.09), (2) maintenance-окно: стоп worker+scheduler → VACUUM FULL ×3 → старт. **✅ ВЫПОЛНЕН 15.08 18:52–19:00 UTC** (после двух молчаливых фальстартов из-за пустого файла — см. строку «День 0.5»). Итог: sync_run_events 10 ГБ→3.9, attempts 644→248 МБ, sync_runs 3648→3591 МБ (его жир внутри 30д-окна, roll-off к ~11.09); диск 84%→**77%**, свободно 13→**19 ГБ**. Пауза воркеров всего 82 с; пост-чек: все контейнеры healthy, 32 sync-рана за 10 мин. Выигрыш меньше ранней оценки 13–15 ГБ, потому что ночные свипы уже вымыли часть июльского жира за прошедшие дни — забрано всё, что законно забрать сегодня | ~13–15 ГБ (факт: −6–7 ГБ сейчас + roll-off остатка к 11.09) |
| G5. Payload-CAS | Content-addressed тела (месяц+scope): убирает пару raw∥observations и повторные снапшоты (79.95% корпуса — дубликаты) | **Слайс 1 ✅ PR #79 → main cd26de46 (Decision #215), задеплоен 16.08 ~09:48 UTC. Канарейка включена на page 4 (lilly-1) 17.08: первое включение («4») тихо НЕ сработало — вскрыт латентный баг ядра (drizzle jsonb double-parse: строка «4» читается числом 4, validateConfigOverride отбрасывает, live-оверлей молча пропускает; #216). Обход на проде: значение «4,» (JSON-парс падает → остаётся строкой; CSV-парсер пустые элементы игнорирует). Корневой фикс: PR #80 → main e7bbce31 (Decision #216) — jsonbSafe customType (чтение identity, запись JSON.stringify байт-в-байт), все 55 jsonb-колонок, lint-бан builtin jsonb, регрессионные пины; попутно CI вскрыл три квирк-зависимых теста (setFlag писал числа/булевы строками) — хелперы переведены на типизированные значения. Задеплоен 17.08, обходное «4,» возвращено на честное «4» (version 3) — флип служит живым доказательством фикса. **18.08: суточный гейт пройден (14 сверок подряд 50/50, дедуп-рейт 62% на lilly-1) → канарейка расширена на ВСЕ страницы («*», version 4, по «го» владельца); подтверждён мультистраничный каталог. Слайс 2 (reader migration, PR #81, Decision #217): mode-aware seam inline→shadow→serve, задеплоен 19.08; shadow-окно 319/319 чисто за сутки → serve live (отдачи из каталога, 0 откатов). Слайс 3a (typed columns §6.4, PR #82, Decision #218): 6 SQL-мест отцеплены от inline, миграции 0125+0126. Слайс 3b (erasure каталога + collision-защёлка, PR #83, Decision #219): тело умирает только при доказанном нуле выживших ссылок (единственный санкционированный удалятель тел, двухуровневый ретеншн-пин), общие тела — bystander's facts; sha256_collision — отдельный subKey, гаснет только при нуле. Осталось: выкат #82+#83 (миграции 0125-0127) и 3c — pointer-only + историческая перезапись (§9.1-9.2, новой сессией) — возврат десятков ГБ.** **слайс 0 (фундамент) ✅ PR #78 → main c64bdc27 (15.08):** миграция 0123 `capture_payload_objects` (identity-кортеж месяц+scope+класс+кодек+sha256+байты+ordinal, UNIQUE NULLS NOT DISTINCT, двусторонний locator-CHECK hot/cold), кодек, репозиторий, read-seam `payload-reader` (loadPayloadBody скрыт из barrel — пин tests/capture-payload-barrel.test.ts). Аддитивно, поведение не менялось. Попутно в main: #76 атомарный claim+journal observations, #77 обработчик фоновых ошибок пула | dual-write parity (canary, флаг default-off) → pointer-only → исторический rewrite — следующей сессией |
| G6. Tiering | **ОТЛОЖЕН решением владельца 15.08: «в облако пока уходить не планируем»** — вся история остаётся на VPS; G5-дедуп становится единственным путём сжатия. Вернуться при пересмотре (пререквизиты и фиксы описаны) | — |
| S7. Вторичное | AI-блоки CAS, индексы idx_scan=0 (~180 МБ), pg-boss retention-пин, retention 30→14 (после leaf/parent-split + индекса `sync_raw_payloads(sync_run_id)`) | бэклог | — |

**Инцидент 12–13.08 (попутно обнаружен и закрыт):** pg-boss перестал создавать джобы
в 21:38 UTC 12.08 (известный клин планировщика; контейнеры при этом «healthy» —
heartbeat-файлы пишутся) → sync/canonicalize/disk-check стояли ~3.2ч. Контейнеры также
были кем-то рестартованы ~15:25 UTC (не деплоем, хост без ребута — uptime 50д; источник
не установлен). Деплой G1.5+G2 (quiesce + recreate) восстановил всё: 14 очередей
создают джобы, 37 sync-ранов и 216 observations за первые 10 минут. Урок для G1.5+:
runway-гейджи теперь дают и второй сигнал — молчание `disk_free_bytes` дольше 2ч =
мёртвый cron (deadman ops_sampler_silent это уже ловит по минутному сэмплеру).

Параллельный трек вне кода: **расширение диска VPS** — runway после G1 ~13 дней; G4-реклейм
требует временного headroom'а. Owner-решение.

## Порядок исполнения

**Порядок скорректирован по [open]-ревью кодекса на финальном плане (вердикт «NO-GO as
written» — все 8 находок триажированы, принятые вошли ниже, амендменты закоммичены):**

1. **Сначала G1-деплой, потом прунинг** (прунинг даёт reusable-страницы, не df-байты;
   реальный df-выигрыш даёт recreate контейнеров, стирающий старые unbounded-логи).
2. **Retention-флип 30→14 ИСКЛЮЧЁН из этого окна** — общий cutoff погнал бы ночной свип
   через unbatched-удаление `sync_runs` (неиндексированный FK SET NULL по 19.5 ГБ +
   разрыв lineage ремонта #133). Пererequisites для 14д: leaf/parent-split свипа +
   индекс `sync_raw_payloads(sync_run_id)` — G2-эра.
3. **Прунинг сужен**: события — только `checkpoint_advanced`/`checkpoint_loaded` старше 7д
   (это ~95% байтов; warnings/errors/anomalies/терминальные события живут), попытки —
   старше 14д (их читает monitor windowHours≤14д и failure-streak механика);
   flock-синглтон + disk-guard перед первым батчем.
4. **Image GC переведён в opt-in (default OFF)** — решение #176 пинит удаление
   образов/тегов как явное owner-действие; автодефолт ему противоречил.
5. Амендменты G1 по кодексу: `advanced`-флаг = write-time set **OR** дифф bounded-саммари
   (transactions и OFAPI-пути пишут чекпоинты без вызова телеметрии — один Set лгал);
   явная пропагация ошибок в `build_dist_only_candidate_image` (голый `pnpm build` при
   отключённом errexit мог загрузить stale dist); `stop_grace_period: 60s` у Postgres;
   decision #212 записан в `docs/decisions.md` тем же чейнджем.

**G1 — stop-loss (один dist-only деплой):**
- ✅ Построено, отревьюено (мной + codex `review --uncommitted`, 3 P2 пофикшены) и
  закоммичено в `ai/260811-storage-g1`: чекпоинт-скаляры (−~1.34 ГБ/день), stdout-подавление
  с DB-failure-фолбэком (−~0.4 ГБ/день логов), compose-анкор 20m×5 + контракт-тест,
  deploy EXIT-trap + opt-in image GC, disk-гейджи + deadman-фильтр. `pnpm check` зелёный.
- Пре-деплой чек: `df` ≥ 5 ГБ, ancestry прод-образа = базе ветки (12707af4, проверено),
  бэкап `.env.production`, не попадать в окно 02:00 UTC (ночной свип).
- Ожидание (гипотеза, не SLA): slope values ~2.0 → ~0.7 ГБ/день. Даже так runway ≈ 13 дней —
  G1 покупает время, не безопасность; расширение диска остаётся параллельным треком.

**День 0.5 (после деплоя, за владельцем):**
1. ⏳ Суженный батчевый прунинг телеметрии (скрипт `telemetry-prune.sh` v2).
2. ⏳ Снятие 5 старых image-тегов (список верифицирован, one-step rollback жив).
3. ✅ Мусорный dist-overlay удалён.

**G1.5 — сразу после:** слоуп+runway-алерт (subKey-латчи), регенерация
`docs/generated/07-sync-engine.md`/`17-ops-observability.md`, decision-entry в `docs/decisions.md`.

**G2→G3** (generation membership, O(N) чекпоинт), **G4** (архив+партиции телеметрии),
**G5** (CAS), **G6** (tiering: persistent lake-volume ДО первого запуска, Zstd, seal+digest,
cold-aware читатели, UV-007) — по канонической спеке codex-документа с поправками из таблицы выше.
**S7**: AI-блоки (только content-addressed — персоны без истории байт), неиспользуемые индексы
(idx_scan=0: ops_metric_samples_metric_time_idx 82М, page_fans_external_presence_idx 68М,
GIN message_archive_text_search_idx 31М — после полного бизнес-цикла наблюдения), pg-boss пин.

## Что НЕ делать (сводно, оба расследования)

Не включать tiering ради места; не удалять `sync_runs`/raw/observations/проекции; не делать
VACUUM FULL без post-prune headroom-математики; не дропать индексы по размеру; не gzip-ить JSONB
в opaque bytea до reader-seam; никаких `docker system prune --volumes`; lake ≠ бэкап (#128/#161).
