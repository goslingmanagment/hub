# Независимая проверка A0 — 2026-09-14 23:08 UTC

**Есть существенное новое наблюдение: Lilly-1 G7527 содержит 806 missing-head occurrences ниже виртуального stop в завершённом sweep. Следующий G7528 содержит 711 таких occurrences, но завершён incomplete. Это основание сообщить о новом расхождении и исследовать его отдельно; число уникальных сообщений, потеря данных и причина не установлены. A0 остаётся NO-GO, A1 не разрешён.**

Проверены локальные cumulative exports `snapshot-20260914T230836Z` и `snapshot-20260914T174241Z` из `activation/20260910T225618Z`. Пересчёт выполнен независимо из `report.json`, без запуска прежнего анализатора, production/network calls, тестов или изменений кода/STATE. Создан только этот review.

## Целостность и границы

- SHA-256 обоих `report.json` совпадает с manifest: новый `bcf516eaa1e34272e827b4ac7733c6c7709410a94b2b4f00d57a79c2a4e6c73d`; предыдущий `74c2e9375d6e6df82932989e114c8ab5f67c349d7b80685108e87f914a328a1e`.
- В обоих raw receipts `role=read_only`, `readOnly=on`; `raw.report` равен нормализованному `report.json`. Manifest содержит `role=read_only`, `transaction=on`, `atomicSnapshot=false`. Число записей совпадает; `(page_id,generation)` уникальны.
- Общий старт сохранён: `2026-09-10T22:58:33.610Z`. Новый cutoff `2026-09-14T23:08:36.010622Z`, возраст окна 4.006972 дня; export выполнен `23:08:36.058963Z`–`23:08:45.628133Z`. Предыдущий cutoff `17:42:41.583795Z`.
- **1202 sweeps: 886 complete, 316 incomplete, 0 running.** Из прежних 1089 строк 1088 неизменны, удалённых нет. Добавлены 113 строк: 52 complete и 61 incomplete. Единственное изменение старой строки — Lora-1 G4927: running → complete, завершение `17:48:49.917597Z`; это не новая строка.
- Все 113 новых sweeps начались после предыдущего cutoff, от `17:44:24.640Z` до `23:06:20.418Z`. Все starts входят в общее окно. В новом снимке нет `started_at`, `updated_at` или `finished_at` после cutoff. Это проверка фактических timestamps, а не доказательство атомарности экспорта.

## Reader cohort

Все семь reader fields имеют integer-значения на 129 строках: **68 complete и 61 incomplete**. На 1072 старых строках поля отсутствуют, на одной строке — explicit null; частично известного набора нет. Историческое отсутствие/null не считается нулём. В предыдущем export было 15 complete и одна running instrumented-строка.

| Страница | Все sweeps C / I | Reader rows C / I | Advertised-ID checks C / I | Materialized below stop C / I | Missing below stop C / I |
|---|---:|---:|---:|---:|---:|
| ari-1 | 157 / 37 | 13 / 2 | 3890 / 499 | 0 / 0 | 0 / 0 |
| lilly-1 | 144 / 77 | 7 / 35 | 19711 / 29257 | 16605 / 989 | **806 / 711** |
| lilly-2 | 144 / 44 | 12 / 8 | 103368 / 11034 | 94956 / 0 | 12 / 0 |
| lora-1 | 142 / 63 | 10 / 9 | 49461 / 44524 | 40461 / 12141 | 0 / 0 |
| lora-2 | 149 / 51 | 13 / 7 | 32999 / 10686 | 18299 / 1433 | 0 / 0 |
| lora-3 | 150 / 44 | 13 / 0 | 24909 / 0 | 12809 / 0 | 0 / 0 |
| **Всего** | **886 / 316** | **68 / 61** | **234338 / 96000** | **183130 / 14563** | **818 / 711** |

Deleted, pending, archive-only below-stop counters и unknown reader checks равны нулю во всех известных C/I cohorts каждой страницы. Эти нули не распространяются на старые отсутствующие/null поля. У 13 complete Ari sweeps нет виртуального stop, поэтому их нулевой tail не доказывает проверенный хвост. Из 61 incomplete instrumented sweeps у 55 stop отсутствует; incomplete evidence не входит в успешный знаменатель.

- **Lilly-1 G7527, complete:** `22:43:55.057Z`–`22:46:47.516159Z`, stop page 3 из 35, 3304 reader checks; ниже stop 2198 materialized и 806 missing. Missing counter также равен 806 в старой hot-диагностике; state/flags changes здесь нулевые.
- **Lilly-1 G7528, incomplete:** `23:00:39.388Z`–`23:02:32.172927Z`, причина `dm_conversations_snapshot_overlap_guard`, stop page 5 из 22; 2200 reader checks, ниже stop 989 materialized и 711 missing. Наличие `completeCoverage=true` внутри diagnostic object не отменяет итоговый статус incomplete.
- В Lilly-1 missing встречается по одному sweep в каждом C/I cohort. В Lilly-2 — по одному occurrence в каждом из 12 complete reader sweeps, всего 12 против прежних двух. Идентичность объектов между sweeps в export отсутствует; **806 и 711 нельзя складывать как число разных или потерянных сообщений**.

Новые 61 incomplete: 52 overlap guard и 9 uncertified/partial. По страницам overlap / uncertified: Ari 1/1, Lilly-1 32/3, Lilly-2 7/1, Lora-1 6/3, Lora-2 6/1, Lora-3 0/0. Cumulative reasons: 74 overlap и 242 uncertified/partial.

Дополнительные state counters: `stateChangesBelowStop` 2414→2417, flags 14→16, exclusion reasons 17→18, subscription tier 0→1; эти признаки могут пересекаться и не суммируются как разные события. `missingHotHeadsBelowStop` 165291→166818 (+1527), unknown hot-material checks 403215 без изменения. Ни эти агрегаты, ни нулевые flags в двух Lilly-1 sweeps не определяют причину missing.

## HTTP и полнота учёта

- Physical attempts **126644 (+9212)**: success 120760 (+9191), retry outcomes 4449 (+18), failed outcomes 1435 (+3). Retry ordinals 4447 (+18); retained started и HTTP 429 — ноль.
- Все три добавленных failed HTTP attempts — Lora-2, scheduled `dm_messages/messages`, HTTP 500. Там же девять новых retry outcomes HTTP 500; ещё девять retries transport-class в других buckets. Daily buckets не дают точного времени попыток и не устанавливают причину Lilly-1 missing или текущую аварию. Media-offer-stat buckets не изменились; это не доказательство recovery.
- Известные captured-object bytes **8381500146 (+598751988)**; unknown bytes у 7365 attempts (+113), null-byte buckets 159 против 154. Это не wire bytes и не измеренная экономия.
- HTTP coverage: **30160 runs (+2082)**; unknown 6 против 4. Новые unknown: Lilly-1 scheduled `dm_messages` и Lora-1 anomaly `followers_reconcile`, по одному. Boundary runs 4→3: прежний Lora-1 scheduled `dm_conversations` перестал быть boundary. Это изменение cumulative coverage, не отрицательное число новых запусков. Known unrecorded/unfinished attempt counters остаются нулевыми; historical unknown coverage сохраняется.
- DM coverage: **13634 runs (+912), failed 88 (+53), lost reports 8 и unknown 1 без изменения**. Приращение failed runs: Ari +1, Lilly-1 +33, Lilly-2 +7, Lora-1 +6, Lora-2 +6, Lora-3 +0. Failed run отличается от failed physical attempt и от unique sweep; агрегаты не связывают конкретные failures с missing objects.

Два export заменяют друг друга; signed differences не являются независимой переписью интервала и не должны складываться между snapshots. Новая reader cohort не даёт ретроспективного покрытия четырёх дней. Первоначальная семидневная граница остаётся `2026-09-17T22:58:33.610Z`; elapsed time сам по себе не закрывает расхождения. Текущие runtime/configuration и возможные причины проверяются отдельно координатором. Здесь не установлены unique lost messages, deletion/pruning, новая причина сбоев, realized savings, reader latency или разрешение менять polling/A1.
