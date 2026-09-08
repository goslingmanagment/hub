# Review основного архитектурного проекта

Проверено 2026-09-07: `ARCHITECTURE.md`, SHA-256 `a7695693109788eec1753768d8310339fccc85d251ec4fad8315db7c6caf32e6`, вместе с `evidence/live-verification.md` и `event-evidence.md`. Строки ниже относятся к этой версии. Основной файл не изменялся.

**Вердикт:** выбранное направление можно принимать как основу дальнейшего исследования и inert implementation. План урежения polling пока имеет один P1 blocker: отсутствует предел свежести для *не доставленного* события. Ещё три P2 уточнения нужны до direct apply/production canary. Новые инфраструктурные сервисы или другая архитектура для исправлений не требуются.

## P1 — SLO не замечает потерянный сигнал, а canary увеличивает худшую задержку в 12 раз

**Место:** §8, строки 172/184; §10, строки 209–210; §11, строки 232/240–245.

Предлагается изменить DM inventory с 30 минут до 6 часов. SLO измеряет `event receipt → required reader`, то есть событие, которое вообще не пришло в Hub, не входит в знаменатель. При живом pong и потерянном message signal новая беседа может оставаться неизвестной 6 часов. До следующего inventory все указанные receiver/hydration SLO останутся зелёными. Возврат старой cadence после обнаруженного miss ограничивает следующий сбой, но не задержку первого. Это конкретное ослабление freshness для доступного REST факта; оговорка о невосстановимой transient history его не покрывает.

**Минимальная правка:** добавить отдельный контракт `max_undiscovered_change_age` / максимального интервала независимого discovery для каждого pilot plane. В первом DM canary не ухудшать прежнюю документированную границу обнаружения: пока дешёвый независимый delta/head discovery с достаточной областью не доказан, полный inventory остаётся на прежней cadence. Урежать дорогой full inventory до 2/6 часов можно лишь если другой bounded discovery сохраняет согласованную границу. Если бизнес принимает более долгую degraded freshness при silent WS loss, прямо вынести эту изменённую гарантию в решение владельца, а не скрывать её в receipt-based SLO.

**Точный текст для вставки после строки 240:**

> Для события, не доставленного по WS, действует отдельная граница discovery lag: `[значение, не хуже принятого baseline]` для DM create/new group. Она измеряется от независимого подтверждённого появления изменения в источнике до его обнаружения Hub, а не от WS receipt. Искусственно выброшенный frame при продолжающихся pong обязан попасть в Hub в пределах этой границы. До доказательства дешёвого discovery, сохраняющего её, full DM inventory не урежается. Значения 2/6 часов относятся к дорогостоящей полной сверке, только если независимый discovery уже сохраняет freshness; иначе это отдельное согласованное ухудшение degraded freshness.

**Проверка:** отбросить единственный signal новой беседы непосредственно после завершения discovery; pong продолжать. Измерить источник→Hub, не только receipt→reader. Проверить на максимальном интервале предлагаемой policy и исчерпанном live budget.

## P2 — Head catch-up не описывает восстановление старых edit/delete

**Место:** §7 строка 149; §9 строки 196–200; §11 строки 231/241–242.

`group-head refresh до известной boundary` и чтение thread до последнего известного ID восстанавливают новые сообщения. Они не обнаружат потерянное изменение или удаление старого сообщения за пределами overlap. Инвентаризация всех групп тоже не доказывает, что metadata группы меняется при любой старой мутации. Это **не** тот случай, когда тело создано и удалено во время offline: здесь Hub уже хранит старое неверное состояние объекта, а актуальность может проверяться доступным REST чтением. Формулировка `state_reconciled` на уровне plane и требование нулевых stale tombstone resurrection оставляют неясным, как такой объект попадает в revalidation.

**Минимальная правка:** добавить три строки к recovery contract:

| Вид изменения | Восстановление | Что разрешено закрыть |
|---|---|---|
| Новое сообщение / новая группа | Inventory + head→known boundary | Head/new-object gap в реально пройденном scope |
| Edit/delete известного сообщения в проверяемом окне | Адресный reread или bounded overlap comparison по stable IDs и доказанным absence semantics | Только проверенное окно/набор IDs |
| Старое изменение вне проверенного окна, без надёжного change index | Bounded rotating anti-entropy при доступной REST поверхности; иначе `mutation_history_unknown` | Полноту старых мутаций не объявлять; `state_reconciled` head не распространяется на них |

До реализации достаточно выбрать конкретный pilot window/scope и честное состояние старой области. Не требуется немедленно перечитывать весь архив. Проверка — удалить/изменить старое fixture message глубже head boundary, потерять signal, выполнить recovery и убедиться, что либо материал восстановлен, либо область остаётся явно непроверенной.

## P2 — Не определена durable граница общего materializer

**Место:** §5 строка 120; §6 строки 128/133; §7 строка 143; §10 строка 217.

Для router граница задана точно: dirty intents и routed revision в одной транзакции. Для общего `applyCaptured…` перечислены direct serving tables, archive/media/tip context и canonical append, но не указано, какие записи коммитятся атомарно и какой durable marker заставляет повторить незавершённый direct apply. Existing canonical sweep сам по себе не воспроизводит legacy handler writes — это признано в §3. Crash после отметки parse/routed или части serving writes не должен оставлять корректный journal с бесконечно устаревшей таблицей, которую этот sweep не обслуживает.

**Минимальная правка:** определить `apply_version`/receipt на observation или существующем apply-work record. Все обязательные синхронные serving writes + canonical append + apply receipt выполняются в одной DB transaction под нужными fences; async projections остаются отдельно со своими watermarks. При чрезмерно широкой транзакции допустим durable debt с отдельными idempotent шагами, но тогда `appliedRevision`/freshness нельзя считать полными до всех required readers. Предпочтителен один небольшой DM transaction, без общей workflow системы.

**Точный текст для добавления к §6:**

> Raw observation не получает завершённый apply receipt до коммита обязательных синхронных materializer writes и canonical append. Эти записи и receipt коммитятся одной транзакцией; повторный apply безопасен по receipt/version и semantic keys. Sweep выбирает также captured/routed observations без текущего apply receipt, независимо от canonical parse_version. Асинхронные projections завершаются по собственным watermarks, и reader freshness не объявляется готовой раньше обязательной projection.

**Проверка:** crash после первой direct write, перед canonical append и после append до receipt; restart без новых Fansly requests. Все required serving rows и event ledger должны сойтись либо показать конкретную durable debt.

## P2 — DB lease не гарантирует ровно один физически открытый upstream socket

**Место:** §5 строки 93–95; §10 строка 215; §13 строка 270.

Фраза «один active connection на page» сильнее механизма TTL lease. Старый worker может зависнуть/попасть в stop-the-world pause дольше TTL; новый владелец откроет socket, пока старый физически ещё существует. DB fence защищает запись/dispatch, но Fansly ничего не знает о нашем token. Если второе соединение вытесняет первое или делит delivery, это влияет на capture continuity, даже когда оба владельца правильно проверяют token при очередной возможности. Canary second-connection уже предусмотрен, но формулировка гарантии сейчас этому не соответствует.

**Минимальная правка:** заменить обещание на «один действующий DB lease; краткое перекрытие физических sockets возможно при failover». Сохранить fail-closed watchdog и generation fence перед state writes; включить в transport gate именно overlap при stale owner, не только два здоровых connections. Если безопасный overlap не доказан, native auto-failover не готов к cutover; нужен консервативный recovery policy вместо обещания исключённого overlap. Новая distributed consensus система не требуется и также не заставит Fansly соблюдать наш fencing token.

## Проверенные границы без новых замечаний

- `live-verification.md` сообщает только два WS 101, без auth ACK/business frames. Основной draft сохраняет эту границу; transport readiness не приписан живой проверке.
- Августовский bundle не объявлен текущим контрактом; внешний webhook provider не подменяет Fansly primary source.
- Source/account/generation trust, sparse/full dedup, owner pauses, provider cooldown и revision-R+1 race явно рассмотрены. Увеличивать инфраструктуру ради этих свойств не нужно.
- Rollback отделяет flags от исправления уже применённых данных и требует совместимого runtime. Перед реальным deploy конкретный последний совместимый release необходимо указать в runbook; отдельного архитектурного blocker здесь нет.

**После минимальных правок:** архитектура достаточна для этапа 0 и inert safety foundation. Production cadence/direct apply всё ещё остаются за empirical gates, как и требует сам документ.
