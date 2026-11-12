import type { AppConfig } from "@agency_hub_core/shared";
import type { Database } from "@agency_hub_core/db";
import { getConfigOverride } from "@agency_hub_core/db";
import { formatDuration, ruPlural } from "@agency_hub_core/look";
import { validateConfigOverride } from "@agency_hub_core/shared";

import { loadEffectiveConfigField } from "./effective-config.ts";

/**
 * Hub's Telegram messages in Russian (ecosystem plan §4: «оповещения хаба
 * по-русски»): the same facts, the same recipients, the same schedule; only the
 * words. Behind the owner's live switch `telegramRussian` (off: English, as
 * before), so the switch flips after the owner has seen both side by side
 * (`cli telegram compare`).
 *
 * The catalog is keyed by the English line the code already writes (as a
 * gettext msgid): every branch that picks an English title picks its Russian
 * one too, so the two languages cannot say different facts. A line without its
 * Russian here goes out in English, never empty. The detail after «Ошибка:» is
 * what the producer recorded with the incident (often a code, a JSON context or
 * an HTTP error) and goes as recorded.
 */

export type NotificationLanguage = "en" | "ru";

/** The language of the next message: the owner's live switch, read at every send. A failed read sends English, as before. */
export async function notificationLanguage(app: { db: Database; config?: AppConfig | undefined }): Promise<NotificationLanguage> {
  try {
    if (app.config !== undefined) {
      return (await loadEffectiveConfigField(app.db, app.config, "telegramRussian")) === true ? "ru" : "en";
    }
    // A caller without the boot config (a sweep in a test harness): the override alone; the env default is off.
    const override = await getConfigOverride(app.db, "telegramRussian");
    if (override === null) return "en";
    const validated = validateConfigOverride("telegramRussian", override.value);
    return validated.ok && validated.value === true ? "ru" : "en";
  } catch {
    return "en";
  }
}

const LINES: Readonly<Record<string, string>> = {
  // ── Page browsers: open ──
  "🚨 Page browser down: its operator is silent or unreachable, or the browser does not come up — nothing of the page goes":
    "🚨 Браузер страницы недоступен: его оператор молчит или не отвечает, или браузер не поднимается. Со страницы ничего не уходит",
  "🚨 Page browser needs a login: Fansly signed the browser out — log in through the dashboard":
    "🚨 Браузеру страницы нужен вход: Fansly вышел из аккаунта в браузере. Войдите через консоль",
  "🚨 Page browser cannot reach Fansly through its proxy (unavailable or refusing the login)":
    "🚨 Браузер страницы не может дойти до Fansly через свой прокси (прокси недоступен или не принимает вход)",
  "🚨 Page browser stopped: its proxy's exit IP changed — it stands until the owner decides":
    "🚨 Браузер страницы остановлен: у его прокси сменился выходной IP. Стоит до решения владельца",
  "🚨 Page browser buffer filling up (what the browser keeps for Hub) — at the cap the page stops":
    "🚨 Буфер браузера страницы заполняется (то, что браузер держит для Hub). На пределе страница остановится",
  "🚨 Page browser self-test failed: one of its guards did not hold — the page stands":
    "🚨 Самопроверка браузера страницы не прошла: одна из его защит не сработала. Страница стоит",
  "🚨 Page browser saw Fansly change: an unknown socket message or request headers that differ — the page stands":
    "🚨 Браузер страницы заметил изменение Fansly: незнакомое сообщение сокета или другие заголовки запросов. Страница стоит",
  "🚨 Page browser lost control of Chrome (CDP) — a request it held may have left":
    "🚨 Браузер страницы потерял управление Chrome (CDP). Запрос, который он держал, мог уйти",
  "🚨 Page browser holds the site's requests Hub has not journaled — their pause and 429 holds wait on Hub":
    "🚨 Браузер страницы держит запросы сайта, которые Hub не записал в журнал. Их пауза и задержки после 429 ждут Hub",
  "🚨 Page browser cut one socket of the site: its socket gate refused a record (it never left) — the page goes on, the site reconnects":
    "🚨 Браузер страницы разорвал один сокет сайта: защита сокета не пропустила запись (она не ушла). Страница работает, сайт переподключится",
  "🚨 Page browser cannot confirm its exit IP: the check got no answer — Hub's requests wait, Chrome and the site go on, the check retries":
    "🚨 Браузер страницы не может подтвердить выходной IP: проверка не получила ответа. Запросы Hub ждут, Chrome и сайт работают, проверка повторится",
  "🚨 Page browser runs with a fault of its own: a diagnostic journal not written, or a screen not 1920×1080 — the page goes on":
    "🚨 У браузера страницы своя неполадка: не пишется журнал диагностики или экран не 1920×1080. Страница работает",
  // ── Page browsers: resolved ──
  "Page browser up again (10 min clean)": "Браузер страницы снова работает (10 мин без сбоев)",
  "Page browser logged in again": "Браузер страницы снова вошёл в Fansly",
  "Page browser reaches Fansly through its proxy again": "Браузер страницы снова доходит до Fansly через прокси",
  "Page browser's exit IP settled (10 min clean)": "Выходной IP браузера страницы устоялся (10 мин без сбоев)",
  "Page browser buffer back below its alarm": "Буфер браузера страницы снова ниже тревожного уровня",
  "Page browser self-test passes again": "Самопроверка браузера страницы снова проходит",
  "Page browser saw nothing new from Fansly for 10 min": "Браузер страницы 10 мин не видел изменений Fansly",
  "Page browser under control again (10 min clean)": "Браузер страницы снова под управлением (10 мин без сбоев)",
  "Page browser's site requests journaled by Hub again (10 min clean)": "Hub снова записывает в журнал запросы сайта из браузера страницы (10 мин без сбоев)",
  "Page browser cut no socket of the site for 10 min": "Браузер страницы 10 мин не разрывал сокеты сайта",
  "Page browser's exit IP confirmed again: Hub's requests go (10 min clean)": "Выходной IP браузера страницы снова подтверждён: запросы Hub идут (10 мин без сбоев)",
  "Page browser without a fault of its own for 10 min": "У браузера страницы 10 мин нет своих неполадок",

  // ── The ChatSpace tab on the server ──
  "🚨 ChatSpace server tab silent: no report from it — the browser, the extension or its hub sign-in is down, the OnlyFans feed stops when chatters close their tabs":
    "🚨 Вкладка ChatSpace на сервере молчит: от неё нет отчётов. Не работает браузер, расширение или его вход в Hub; лента OnlyFans остановится, когда чаттеры закроют свои вкладки",
  "🚨 ChatSpace server tab is not on ChatSpace: signed out of OnlyMonster or its tab is gone — log in again on its screen (/api/v1/chatspace-browser/screen)":
    "🚨 Вкладка ChatSpace на сервере не на ChatSpace: она вышла из OnlyMonster или её нет. Войдите заново на её экране (/api/v1/chatspace-browser/screen)",
  "⚠️ ChatSpace server tab sits in a fan's chat: opening a chat marks it read on OnlyFans — take it back to the Accounts Overview":
    "⚠️ Вкладка ChatSpace на сервере стоит в чате фана: открытый чат отмечается прочитанным на OnlyFans. Верните её на Accounts Overview",
  "🚨 ChatSpace server tab does not cover a page: the account is not open in its sidebar, or ChatSpace's socket for it is down":
    "🚨 Вкладка ChatSpace на сервере не покрывает страницу: аккаунт не открыт в её боковой панели или сокет ChatSpace для него не работает",
  "🚨 ChatSpace server tab's socket is down: ChatSpace has not reconnected for 5 min, the OnlyFans feed stops — open its screen and press Reconnect":
    "🚨 Сокет вкладки ChatSpace на сервере не работает: ChatSpace 5 мин не переподключается, лента OnlyFans стоит. Откройте её экран и нажмите Reconnect",
  "🚨 ChatSpace server tab alert": "🚨 Вкладка ChatSpace на сервере: сбой",
  "ChatSpace server tab reports again": "Вкладка ChatSpace на сервере снова присылает отчёты",
  "ChatSpace server tab is on ChatSpace again": "Вкладка ChatSpace на сервере снова на ChatSpace",
  "ChatSpace server tab left the fan's chat": "Вкладка ChatSpace на сервере ушла из чата фана",
  "ChatSpace server tab covers the page again": "Вкладка ChatSpace на сервере снова покрывает страницу",
  "ChatSpace server tab's socket is up again": "Сокет вкладки ChatSpace на сервере снова работает",
  "ChatSpace server tab alert cleared": "Сбой вкладки ChatSpace на сервере снят",

  // ── Voice notes (ElevenLabs) ──
  "🚨 ElevenLabs rejected the voice-notes API key — every voice note fails": "🚨 ElevenLabs отклонил ключ API голосовых: ни одно голосовое не получится",
  "🚨 ElevenLabs refuses voice notes: the key lacks a permission or the account is blocked": "🚨 ElevenLabs отказывает в голосовых: у ключа нет права или аккаунт заблокирован",
  "🚨 ElevenLabs subscription not active — voice notes fail or soon will": "🚨 Подписка ElevenLabs не активна: голосовые не получаются или скоро перестанут",
  "🚨 ElevenLabs out of characters — voice notes fail": "🚨 У ElevenLabs кончились символы: голосовые не получаются",
  "⚠️ ElevenLabs characters running low — voice notes stop when they run out": "⚠️ У ElevenLabs мало символов: голосовые остановятся, когда они кончатся",
  "ElevenLabs accepts the voice-notes API key again": "ElevenLabs снова принимает ключ API голосовых",
  "ElevenLabs rendered a voice note again": "ElevenLabs снова сделал голосовое",
  "ElevenLabs subscription active again": "Подписка ElevenLabs снова активна",
  "ElevenLabs has characters for a whole voice note again": "У ElevenLabs снова хватает символов на целое голосовое",
  "ElevenLabs characters back above the alert line": "Символов ElevenLabs снова больше порога оповещения",

  // ── The Fansly Sync Engine («Сбор Fansly» on the console's «Сбои») ──
  "🚨 Fansly Sync Engine route held: a 429 stops one endpoint of a page (the rest runs; the endpoint then runs at half rate until raised)":
    "🚨 Сбор Fansly придержал адрес: 429 остановил один адрес страницы (остальное работает; потом адрес идёт в половину темпа, пока его не поднимут)",
  "Fansly Sync Engine route open again (10 min clean; its slowdown stays until raised)":
    "Сбор Fansly снова открыл адрес (10 мин без сбоев; замедление остаётся, пока его не поднимут)",
  "🚨 Fansly Sync Engine stopped a page (429, auth, identity, network or ownership)": "🚨 Сбор Fansly остановил страницу (429, вход, личность, сеть или владение)",
  "🚨 Fansly public account reader stopped (429, 401/403, network or an unexpected answer) — nothing sends until the owner resumes it":
    "🚨 Публичная проверка аккаунтов Fansly остановилась (429, 401/403, сеть или неожиданный ответ). Ничего не отправляется, пока владелец её не запустит",
  "🚨 Fansly Sync Engine alerts unevaluated — some alerts of a page have not been judged for 5 min (they can neither page nor resolve)":
    "🚨 Проверки сбора Fansly не считаются: часть проверок страницы не оценивалась 5 мин (они не могут ни поднять тревогу, ни закрыть её)",
  "🚨 Fansly Sync Engine could not journal a page browser's own site requests — the pace audit and the route clocks miss them":
    "🚨 Сбор Fansly не смог записать в журнал собственные запросы сайта из браузера страницы. Проверка темпа и часы адресов их не видят",
  "🚨 Fansly Sync Engine pace violated: two sends of a page closer than their pause, or of a route closer than its interval":
    "🚨 Сбор Fansly нарушил темп: два запроса страницы ближе паузы или два запроса адреса ближе его интервала",
  "🚨 Fansly Sync Engine live path degraded (socket, decode debt or quarantined work)": "🚨 Живой канал сбора Fansly работает хуже (сокет, неразобранные кадры или отложенная работа)",
  "🚨 Fansly Sync Engine freshness broken (messages, money or urgent work late)": "🚨 Сбор Fansly отстаёт (опаздывают сообщения, деньги или срочная работа)",
  "🚨 Fansly Sync Engine work stuck (a request or a planned resource without progress)": "🚨 Сбор Fansly застрял (запрос или плановый сбор не двигается)",
  "🚨 Fansly Sync Engine process silent — no sync heartbeat for 2 min while a page is in the engine": "🚨 Процесс сбора Fansly молчит: 2 мин нет сигнала, а страница в сборе",
  "🚨 Fansly Sync Engine alert": "🚨 Сбор Fansly: сбой",
  "Fansly Sync Engine page running again (10 min clean)": "Сбор Fansly снова ведёт страницу (10 мин без сбоев)",
  "Fansly public account reader resumed by the owner": "Владелец снова запустил публичную проверку аккаунтов Fansly",
  "Fansly Sync Engine alerts evaluated again": "Проверки сбора Fansly снова считаются",
  "Fansly Sync Engine journals the page browsers' own site requests again (5 min clean)": "Сбор Fansly снова записывает в журнал собственные запросы сайта из браузеров страниц (5 мин без сбоев)",
  "Fansly Sync Engine pace violation acknowledged by the owner": "Владелец принял нарушение темпа сбора Fansly",
  "Fansly Sync Engine live path healthy again": "Живой канал сбора Fansly снова в порядке",
  "Fansly Sync Engine freshness back within bounds": "Сбор Fansly больше не отстаёт",
  "Fansly Sync Engine work progressing again": "Сбор Fansly снова двигается",
  "Fansly Sync Engine heartbeat back": "Сигнал процесса сбора Fansly вернулся",
  "Fansly Sync Engine alert cleared": "Сбой сбора Fansly снят",

  // ── Why a latch closed without its own recovery ──
  "the page is owned by the Fansly Sync Engine; the legacy stream no longer runs": "страницу ведёт сбор Fansly, старый поток больше не работает",
  "OFAPI is switched off (no key); the check no longer runs": "OnlyFans API выключен (нет ключа), проверка больше не идёт",
  "the page's money has another writer on purpose; the refused writer no longer tries": "деньги страницы намеренно пишет другой процесс, отклонённый больше не пытается",
  "no mapped page has a live OFAPI session; each page's auth alert covers it": "ни у одной привязанной страницы нет живого входа OnlyFans API, об этом говорит оповещение о входе каждой страницы",

  // ── Every other kind: open ──
  "🚨 Capture payload sha256 collision": "🚨 Сохранённые данные: совпадение sha256",
  "🚨 Capture payload reference points at nothing": "🚨 Сохранённые данные: ссылка никуда не ведёт",
  "🚨 AI image describer paused for the day: too many refusals": "🚨 ИИ-описание картинок остановлено до конца дня: слишком много отказов",
  "🚨 AI image describer stopped: provider rejected the key (401/403)": "🚨 ИИ-описание картинок остановлено: поставщик отклонил ключ (401/403)",
  "⚠️ Fansly image fast lane unavailable for over 10 minutes": "⚠️ Быстрая дорожка картинок Fansly недоступна больше 10 минут",
  "🚨 Fansly page closed: a request overran its lease, nothing is sent for the page": "🚨 Страница Fansly закрыта: запрос не уложился в своё время, для страницы ничего не отправляется",
  "🚨 Fansly pace violated: two requests of a page closer than the pause setting": "🚨 Нарушен темп Fansly: два запроса страницы ближе заданной паузы",
  "🚨 OnlyFans link series is not being written": "🚨 Ряд статистики ссылок OnlyFans не пишется",
  "🚨 OnlyFans page has no OFAPI account mapping": "🚨 Страница OnlyFans не привязана к аккаунту OnlyFans API",
  "🚨 OnlyFans scheduled collection is stale": "🚨 Плановый сбор OnlyFans устарел",
  "🚨 Server disk fills in under 30 days": "🚨 Диск сервера заполнится меньше чем за 30 дней",
  "🚨 Server disk fills in under 7 days": "🚨 Диск сервера заполнится меньше чем за 7 дней",
  "🚨 Auth failed": "🚨 Вход не удался",
  "🚨 Proxy failed": "🚨 Прокси не работает",
  "🚨 Fansly proxy missing — sync refused (fail-closed)": "🚨 У Fansly нет прокси: сбор не идёт (без прокси закрыт)",
  "🚨 Stream sync failed": "🚨 Сбор потока не удался",
  "🚨 OFAPI account auth needs attention": "🚨 OnlyFans API: вход аккаунта требует внимания",
  "🚨 OFAPI credit balance low": "🚨 OnlyFans API: мало кредитов",
  "🚨 OFAPI account claimed by two pages": "🚨 OnlyFans API: аккаунт привязан к двум страницам",
  "🚨 Wall posts stopped on a page: the platform refused it; posts wait until the owner turns it on":
    "🚨 Посты на стене страницы остановлены: площадка отказала. Посты ждут, пока владелец не включит публикацию",
  "🚨 A wall post did not go out: a fresh read of the platform does not show it": "🚨 Пост на стене не вышел: свежее чтение площадки его не показывает",
  "📨 OnlyFans wrote to the page: read it in the page's Notifications → OnlyFans and act; a late answer can freeze earnings":
    "📨 OnlyFans написал странице: прочитайте письмо в уведомлениях страницы, раздел OnlyFans, и ответьте. Поздний ответ может заморозить доход",
  "🚨 OFAPI webhooks silent": "🚨 OnlyFans API: события не приходят",
  "🚨 OFAPI credit burn rate high": "🚨 OnlyFans API: кредиты сгорают слишком быстро",
  "🚨 Server disk usage high": "🚨 Диск сервера почти заполнен",
  "🚨 Observations partition lead too short": "🚨 Журнал наблюдений: мало готовых разделов вперёд",
  "🚨 Wrong transactions writer refused": "🚨 Операции пытался записать не тот процесс: отказано",
  "🚨 Read-gateway capture tee dropping": "🚨 Шлюз чтения теряет копии собранного",
  "🚨 Golden-signal lag over threshold": "🚨 Отставание ключевых метрик выше порога",
  "🚨 Scheduler heartbeat silent — cron is not firing": "🚨 Планировщик молчит: задачи по расписанию не запускаются",
  "🚨 Golden-signal sampler silent — ops telemetry is blind": "🚨 Сбор ключевых метрик молчит: замеры работы не видны",
  "🚨 Fansly sync silent — no chunk is starting": "🚨 Сбор Fansly молчит: ни одна порция не начинается",
  "🚨 OFAPI chargebacks reconcile failed": "🚨 OnlyFans API: сверка чарджбэков не удалась",
  "🚨 OFAPI link-stats reconcile failed": "🚨 OnlyFans API: сверка статистики ссылок не удалась",
  "⚠️ Anthropic: Hub's AI money runs out soon": "⚠️ Anthropic: деньги Hub на ИИ скоро кончатся",
  "🚨 AI provider billing needs attention": "🚨 ИИ: оплата поставщика требует внимания",
  "🚨 AI provider generation failed": "🚨 ИИ: поставщик не смог ответить",
  "🚨 Capture payload copy disagrees with the inline fact": "🚨 Сохранённые данные: копия расходится с записью",

  // ── Every other kind: resolved ──
  "Auth failed": "Сбой входа",
  "Proxy failed": "Сбой прокси",
  "Proxy assigned; Fansly egress restored": "Прокси назначен, выход к Fansly восстановлен",
  "OFAPI account auth recovered": "OnlyFans API: вход аккаунта восстановлен",
  "OFAPI credit balance recovered": "OnlyFans API: кредитов снова достаточно",
  "OFAPI credit burn rate back to normal": "OnlyFans API: кредиты снова сгорают как обычно",
  "Disk runway back above the critical threshold (7 days); usage latches unaffected":
    "Запас диска снова больше критического порога (7 дней); оповещения о заполнении не затронуты",
  "Disk runway back above the warning threshold (30 days); usage latches unaffected":
    "Запас диска снова больше порога предупреждения (30 дней); оповещения о заполнении не затронуты",
  "Server disk usage back under the threshold": "Заполнение диска сервера снова ниже порога",
  "Observations partition lead restored": "Запас разделов журнала наблюдений восстановлен",
  "OFAPI binding custody conflict cleared": "OnlyFans API: конфликт привязки снят",
  "Wall posts on the page turned on again": "Посты на стене страницы снова включены",
  "The owner looked at the post that did not go out": "Владелец посмотрел пост, который не вышел",
  "The owner handled the OnlyFans notice": "Владелец разобрал письмо OnlyFans",
  "OFAPI webhooks delivering again": "OnlyFans API: события снова приходят",
  "OFAPI webhook silence check closed": "OnlyFans API: проверка тишины событий закрыта",
  "Transactions writer conflict cleared": "Конфликт записи операций снят",
  "OnlyFans scheduled collection completing on schedule again": "Плановый сбор OnlyFans снова успевает по расписанию",
  "OnlyFans scheduled collection check closed": "Проверка планового сбора OnlyFans закрыта",
  "Read-gateway capture tee healthy again": "Шлюз чтения снова сохраняет копии собранного",
  "Golden-signal lag back under threshold": "Отставание ключевых метрик снова ниже порога",
  "Scheduler heartbeat back; cron firing again": "Планировщик снова работает, задачи по расписанию запускаются",
  "Golden-signal sampler emitting again": "Сбор ключевых метрик снова идёт",
  "Fansly page open again: its request holder completed or was confirmed gone": "Страница Fansly снова открыта: запрос завершился или подтверждено, что его нет",
  "No Fansly pace violation for an hour": "Час без нарушений темпа Fansly",
  "Fansly sync chunks starting again": "Порции сбора Fansly снова начинаются",
  "OFAPI chargebacks reconcile recovered": "OnlyFans API: сверка чарджбэков снова идёт",
  "OnlyFans link series is being written again": "Ряд статистики ссылок OnlyFans снова пишется",
  "OnlyFans page is mapped to an OFAPI account again": "Страница OnlyFans снова привязана к аккаунту OnlyFans API",
  "OFAPI link-stats reconcile recovered": "OnlyFans API: сверка статистики ссылок снова идёт",
  "Anthropic: Hub's AI money lasts past the warning window again": "Anthropic: денег Hub на ИИ снова хватает дольше срока предупреждения",
  "AI provider billing recovered": "ИИ: оплата поставщика в порядке",
  "AI image describer resumed": "ИИ-описание картинок снова работает",
  "AI image describer re-enabled by the owner": "Владелец снова включил ИИ-описание картинок",
  "Fansly image fast lane retired: the Sync Engine reads a fan's new media": "Быстрая дорожка картинок Fansly убрана: новые медиа фана читает сбор Fansly",
  "AI provider generation recovered": "ИИ: поставщик снова отвечает",
  "Capture payload sha256 collisions cleared (no object carries a collision ordinal); the inline-copy parity latch is unaffected":
    "Совпадения sha256 в сохранённых данных сняты (ни у одного объекта нет номера совпадения); оповещение о расхождении копий не затронуто",
  "Capture payload references all resolve again (none point at a missing catalog row) in the measured window; the parity and sha256 collision latches are unaffected":
    "Все ссылки сохранённых данных снова ведут к записям каталога в проверенном окне; оповещения о расхождении копий и о совпадениях sha256 не затронуты",
  "Capture payload copies match the inline facts again; the sha256 collision latch is unaffected":
    "Копии сохранённых данных снова совпадают с записями; оповещение о совпадениях sha256 не затронуто",
};

/** Lines with a name or a number in them: the English shape → the Russian. */
const SHAPES: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
  [/^🚨 Golden-signal lag over threshold: (.+)$/u, (m) => `🚨 Отставание ключевой метрики выше порога: ${m[1]}`],
  [/^Golden-signal lag back under threshold: (.+)$/u, (m) => `Отставание ключевой метрики снова ниже порога: ${m[1]}`],
  [/^🚨 Anthropic account (.+) stopped serving$/u, (m) => `🚨 Аккаунт Anthropic ${m[1]} перестал работать`],
  [/^Anthropic account (.+) is serving again$/u, (m) => `Аккаунт Anthropic ${m[1]} снова работает`],
  [/^Stream (.+) recovered$/u, (m) => `Поток ${m[1]} восстановился`],
  [/^Stream (.+) closed$/u, (m) => `Поток ${m[1]} закрыт`],
];

/** The Russian of one English line of a message; a line not in the catalog stays as it is. */
export function inRussian(line: string): string {
  const known = LINES[line];
  if (known !== undefined) return known;
  for (const [shape, say] of SHAPES) {
    const match = shape.exec(line);
    if (match) return say(match);
  }
  return line;
}

/** The line in the message's language. */
export function said(line: string, language: NotificationLanguage): string {
  return language === "ru" ? inRussian(line) : line;
}

/** «45 с», «12 мин», «5 ч 7 мин», «2 дня 4 ч»: how long, as Hub's screens say it. */
const SECOND_MS = 1_000;

export function durationRu(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / SECOND_MS));
  if (seconds < 60) return `${seconds} с`;
  return formatDuration(Math.floor(seconds / 60), { days: true });
}

/** «3 раза». */
export function timesRu(count: number): string {
  return `${count} ${ruPlural(count, "раз", "раза", "раз")}`;
}
