**Fansly: безопасный транспорт и свежесть данных для agency backend**

Исследование на **16 сентября 2026 года**. Ответ на бриф из pasted-text.txt. Метрики 29k requests/day, 6 pages и 17 streams — исходные данные брифа, а не повторное измерение сегодняшнего production. Исследованы публичные документы, GitHub-код с закреплёнными commit SHA и локальный официальный web bundle от 20 августа 2026. Авторизованные запросы к Fansly, новые логины, WebSocket-подключения и изменения production не выполнялись.

**Решение:** целевой вариант — собственный постоянный browser broker на каждую page: отдельная delegated Management Session, native account WebSocket, REST через настоящий сетевой стек браузера, raw journal и независимая сверка истории. Начинать стоит с passive relay существующего Firefox и сокращения доказанно лишних запросов. Переход на Camoufox или копирование нового UA не решает главную проблему: сейчас свежесть привязана к дорогому обходу списка диалогов.

**Буквальный набор требований пока не доказан достижимым.** Нет публичного способа гарантировать одновременно «всё за секунды», полный архив, работу без chatter browser и риск не выше обычного использования. Management Session ограничивает полномочия; realtime не является журналом с доказанной полнотой; фоновые чтения добавляют активность. Ниже — вариант с наименьшим числом ненужных действий и контролируемыми неизвестными, а не обещание отсутствия банов.

Обозначения: **П** — подтверждено первоисточником: официальной справкой или просмотренным кодом, в указанных пределах; **З-вендор** — поставщик описывает свой продукт, но его runtime независимо не проверен; **З-сообщество** — конкретный пользовательский incident report; **В** — инженерный вывод или предлагаемая настройка; **?** — публичного доказательства не найдено. Наличие документации подтверждает описание продукта, а не его эффективность или одобрение со стороны Fansly.

**1. Что действительно известно о продуктах**

| Продукт | Fansly и место исполнения / credentials | Proxy и realtime | Что нельзя заключить |
|---|---|---|---|
| **OnlyMonster** | **З-вендор:** Fansly поддерживается внутри OnlyMonster Browser; вход выполняется в этом браузере. Есть права сотрудников и уведомления. | Docs требуют единый IP для сотрудников одного аккаунта; есть стабильные назначаемые proxies, регионы DE/SG/US, custom SOCKS5. Точный источник уведомлений не раскрыт. | Не доказаны server-side headless farm, способ хранения/синхронизации session, `wsv3`, client-check, cadence и полнота архива. [S3](https://docs.onlymonster.ai/), [S4](https://docs.onlymonster.ai/onlymonster-browser/proxy-management), [S5](https://onlymonster.ai/blog/how-to-manage-onlyfans-and-fansly/) |
| **Infloww** | **З-вендор:** Fansly с Messages Pro, Vault Pro и метриками. Onboarding просит Fansly credentials; Management Session не требуется. | Общая proxy-справка описывает уникальный proxy на creator и custom proxy, но явно обсуждает OnlyFans: перенос всех условий на Fansly не подтверждён. | Не опубликовано, где именно идут Fansly HTTP и WS. Инструкция советует отключать 2FA при подключении — это свойство их flow, не рекомендация для Hub. [S6](https://help.infloww.com/en/articles/324832-getting-started-with-fansly-on-infloww), [S7](https://help.infloww.com/fr/articles/262102-proxys-personnalises) |
| **FBuddy** | **З-вендор:** Fansly extension и отдельный CRM; подключение через single-use Management Session claim link. Для Smart Lists заявлены все permissions OFF, для отправки — Send Messages ON. | Changelog от 29.08.2025 описывал обновление Smart Lists каждые 15 минут; более новые записи говорят о снижении агрессивности refresh. | 15 минут — историческая cadence конкретной функции, не сегодняшняя частота всего продукта. Extension не доказывает, что все запросы идут локально. Proxy, native WS и полный архив не раскрыты. [S8](https://fbuddy.net/extension/fansly-management-session-setup/), [S9](https://fbuddy.net/updates/), [S10](https://www.fbuddy.net/crm/guide/) |
| **OnlyFansAPI.com / fansly-api.com** | **З-вендор:** полноценная Fansly API-продуктовая линейка; `POST /api/fansly/authenticate` принимает username/password, поддерживает 2FA, `proxyCountry` или `customProxy`. | Fansly webhooks прямо описаны как собственный WebSocket relay, с near-real-time delivery. Это самое конкретное публичное описание account realtime среди изученных API. | Нет опубликованных Fansly requests/account/day, устройства HTTP-клиента, socket coexistence SLA или сырых upstream frame guarantees. [S11](https://docs.onlyfansapi.com/api-reference/fansly/connect-fansly-account/start-authentication), [S12](https://docs.onlyfansapi.com/webhooks/fansly-events) |
| **ApiFansly.com** | **З-вендор:** отдельный от предыдущего поставщик; login/password + 2FA, REST и webhooks. | Заявляет exclusive mobile IP на account; custom proxy — dedicated residential/mobile, без shared/rotating/datacenter. Документированы message/subscription/tip webhooks. | Наличие webhook не доказывает `wsv3`, отсутствие polling или восстановление пропущенных событий. [S15](https://docs.apifansly.com/introduction/quickstart), [S16](https://docs.apifansly.com/introduction/essentials/proxies), [S17](https://docs.apifansly.com/webhooks/create-webhook) |
| **CreatorAPI / creator-api.com** | **З-вендор:** native `apiv3` proxy, импорт existing session либо hosted-browser login; заявляет отсутствие password handling. | Заявляет один residential IP/account и signed events. | Hosted browser означает дополнительного доверенного оператора, даже если пароль не сохраняется приложением. Raw fidelity, SLA, management support, fingerprint и объём не проверены. [S20](https://creator-api.com/fansly-api) |
| **The Only API** | **З-вендор:** Fansly поддерживается в normalized CRM layer; OnlyFans passthrough на Fansly не распространяется. | В FAQ прямо указано **Fansly polling-only**, без realtime WebSocket в их интеграции. Proxy для Fansly optional. | Это ограничение их продукта, а не отсутствие WebSocket у Fansly. Для строгого raw-Fansly архива normalized-only контракт недостаточен. [S21](https://docs.theonlyapi.com/docs/faq), [S22](https://docs.theonlyapi.com/docs/proxies) |
| **Supercreator** | **П-док:** актуальный Product Overview описывает OnlyFans. Публичное подтверждение Fansly-интеграции в просмотренных официальных источниках не найдено. | Fansly-specific transport неизвестен. | Нельзя переносить OnlyFans extension, proxy, AI или «safe» заявления на Fansly. [S23](https://help.supercreator.app/en/articles/6306439-start-here-product-overview) |
| **CreatorHero** | **П-док:** актуальная продуктовая страница — OnlyFans CRM. Подтверждение Fansly onboarding/API не найдено. | Fansly-specific transport неизвестен. | Совместное упоминание Fansly и CreatorHero в резюме чаттера не доказывает интеграцию. [S24](https://www.creatorhero.com/only-fans-crm) |

Дополнительные семейства: **ModelVI** заявляет Fansly среди платформ publishing/agent API и хранение sessions/proxies у себя; это полезный пример session broker, но не доказанная замена 17 read streams. **FanGrowth** в проверенных материалах — прежде всего внешний social scheduler для продвижения OF/Fansly. **Fans-CRM** описывает antidetect browser для OnlyFans; конкретную Fansly-интеграцию этими материалами подтвердить нельзя. [S25](https://modelvi.com/agent-api), [S26](https://www.fangrowth.io/), [S27](https://fans-crm.com/onlyfans-free-vpn-proxy-ip-antidetect-browser/)

**Главная граница публичных данных:** у названных закрытых CRM не найдены проверяемые спецификации `fansly-client-check`, device-id lifecycle, HTTP/TLS transport, requests/day на Fansly account и алгоритма полной reconciliation. Нельзя честно утверждать, что «все крупные используют headless», «все вычисляют check» или «все держат socket на сервере».

**Баны.** Fansly-продукт OnlyFansAPI публикует claims «5+ years», «0 accounts banned», «millions of requests per day». Это **З-вендор** без раскрытого Fansly-specific периода, account-days, определения бана и независимой проверки. Совокупная история компании не устанавливает возраст конкретной Fansly-интеграции. Сравнимого, независимо проверенного ban record для изученных продуктов не найдено. [S13](https://www.fansly-api.com/)

**2. Что показывает открытый код**

Исходники скачаны для чтения, не запускались. Закреплённые версии и SHA-256 находятся в [manifest](/Users/dmitriy/code/goose/hub/investigations/fansly-access-research-2026-09-16/evidence/source-code-manifest.json).

| Проект / дата commit | Подтверждено кодом | Ограничение |
|---|---|---|
| **prof79/fansly-downloader-ng**, `2a6e63f`, 28.06.2024 | Python `requests.Session`; вычисление client-check из key/path/device; получение device id; короткое подключение к `wsv3` для session id. | Этот WS helper возвращает session id и выходит; это не постоянный event collector. В нём выключена TLS certificate verification. Нельзя копировать транспорт в Hub. [S28](https://github.com/prof79/fansly-downloader-ng/blob/2a6e63f82ddb41a1b75af0fbe91dafe9874f118e/api/fansly.py) |
| **agnosto/fansly-scraper**, `e45b519`, 13.08.2026 | Go header builder, device/session cache, извлечение check key из JS, собственный hash; `http.Client` для bootstrap и `gorilla/websocket` для session id через `wsv3`. | Не browser-grade proof. В просмотренных bootstrap helper нет Hub-подобного обязательного per-page proxy; корректность самописного hash не установлена. [S29](https://github.com/agnosto/fansly-scraper/blob/e45b519c3beebde2f42a0c25fc57324f8dbeb75a/headers/headers.go) |
| **yllvar/fansly-api**, `1451830`, 03.10.2025 | Go REST wrapper с обычным `http.Client`. | Наличие wrapper не доказывает полный account coverage, realtime или эксплуатационную безопасность. [S30](https://github.com/yllvar/fansly-api/blob/14518307f8438c75088b2bd18c11b11886b46cbe/internal/api/fansly_client.go) |
| **openFansly**, `e8009eb`, 07.03.2023 | Python `requests`, прямой login/2FA flow, собственный device id; есть старые frontend documentation / WebJS материалы. | Историческая реконструкция. Client содержит auto-close session поведение; не безопасный drop-in для общей сессии. [S31](https://github.com/h3llo-wor1d/openFansly/tree/e8009ebac057fcf74f008c81103138b7c882706e) |
| **ZerGo0/fansly.streamerbot**, `c738286`, 14.06.2026 | Документирует `wss://chatws.fansly.com/?v=3` и использование claimed Management Session token для chatroom sends. | **chatws — livestream chat, не account `wsv3`.** Это не доказательство DM/earnings coverage или второго account socket. [S32](https://github.com/ZerGo0/fansly.streamerbot/blob/c738286b2d263f1d360ce8e2c23b82f7e4d118ad/docs/protocol.md) |

У downloader-ng есть незамерженный **PR #134 от 24.01.2026**: смена `/api/v1/group` на `/api/v1/messaging/groups` и разбор `aggregationData`. В марте автор другого fork указал на Jakan-Kink/fansly-scraper. Это **З-сообщество** о дрейфе endpoint contract, а не доказательство обновлённого upstream release. Последний проверенный main commit самого prof79 остаётся 2024 года. [S33](https://github.com/prof79/fansly-downloader-ng/pull/134)

Отдельный поддерживаемый публичный архив *каждой* версии Fansly web bundles подтвердить не удалось. Не следует путать архивы пользовательского контента с исходниками frontend. Для вашего вопроса полезнее собственный датированный архив официального bundle: URL, capture time, hash, extracted protocol, fixtures. Сам snapshot ничего не доказывает о следующем deploy Fansly.

**Что подтверждает ваш официальный bundle от 20.08.2026:**

- `fansly-client-check = hex(cyrb53(checkKey + "_" + URL.pathname + "_" + deviceId))`. Query string в этом вычислении не участвует. Есть отдельный `fansly-client-ts`, связанный с client/server time. Это наблюдение версии, не вечный API contract. [Локальный код](/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/analysis/main.pretty.js:36335).
- Check добавляет **application HTTP interceptor**. Произвольный `window.fetch` внутри страницы сам этот interceptor не вызывает. Для native transport нужен проверенный application request path либо явно воспроизведённые актуальные application headers; браузер решает TLS/cookies, но не автоматически этот уровень.
- Account socket берёт активный session token и отправляет verification request. На этом участке нет client-check. В той же модели session есть `deviceId` и management metadata. Это основание тестировать delegated token в общем account flow, но не доказательство серверных scopes или portability. [Socket](/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/analysis/main.pretty.js:20762), [session model](/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/analysis/main.pretty.js:13020).
- Native клиент после возвращения видимости страницы более чем через 30 секунд перечитывает unread/active conversation. Уже сам frontend сочетает push и REST repair. [Код](/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/analysis/main.pretty.js:34883).
- На WS error 401 frontend вызывает logout. Для общего owner token это потенциальный побочный эффект browser broker; собственная обработка auth-dead не должна автоматически отзывать чужую сессию. [Код](/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/analysis/main.pretty.js:20778).

**3. Что Fansly обнаруживает и чем это заканчивается**

| Фактор | Доказательство | Корректный вывод |
|---|---|---|
| Объём / повторные обходы | **З-сообщество:** issue от 24.08.2023 описывает пустую следующую страницу при сохранённой форме ответа; задержка помогала. | Тихая деградация возможна; точный механизм и сегодняшний threshold неизвестны. Не считать HTTP success доказательством полноты. [S34](https://github.com/Avnsx/fansly-downloader/issues/148) |
| Новый IP при login | **З-вендор:** Fansly auth документация OnlyFansAPI описывает emailed verification code для нового IP. | Проверка входа подтверждается описанием поставщика; автоматический hard ban за новый IP не доказан. [S11](https://docs.onlyfansapi.com/api-reference/fansly/connect-fansly-account/start-authentication) |
| География | **П:** Fansly описывает country-dependent age verification, актуальная статья от 19.05.2026. | Geo меняет access flow. Проверку возраста нельзя классифицировать как captcha от scraping. [S2](https://help.fansly.com/en/articles/11845000-global-age-verification-requirement) |
| Несколько managers | **П:** Management Sessions официально предусмотрены для команды. | Само участие нескольких людей не доказывает нарушение. Клонирование одного token/device между IP — отдельная, непроверенная ситуация. [S1](https://help.fansly.com/en/articles/12328641-management-sessions) |
| Два `wsv3` socket на один token | **?** Есть клиентский код подключения, нет controlled coexistence test. | Неизвестны fanout, конкуренция, unread/presence side effects и invalidation. Успешный HTTP 101 недостаточен. |
| Node TLS/HTTP против Firefox UA | **В:** сетевые fingerprints различимы; toolkit docs подтверждают разные уровни impersonation. | Конкретный Fansly detector и связь с банами не установлены. Устранить внутреннее противоречие разумно, но это не доказанное лечение ban risk. [S35](https://github.com/lexiforest/curl_cffi), [S36](https://github.com/refraction-networking/utls) |
| Headless / automation | **П-код:** browser tools патчат automation-visible свойства. **?** Fansly-specific enforcement. | Ни headed, ни Camoufox не дают доказательства неотличимости на Fansly. |
| Missing/wrong client-check | **П-код:** клиент генерирует header. **?** Серверная обязательность по каждому route и последствия ошибки. | Успех на нескольких endpoints не даёт права игнорировать check везде; ошибку нельзя автоматически считать баном. |
| Datacenter IP | **З-вендор:** ApiFansly запрещает такие custom proxies в своём сервисе. | Это политика поставщика, не опубликованный Fansly ban rule. В исходном брифе тип proxy вообще неизвестен. [S16](https://docs.apifansly.com/introduction/essentials/proxies) |
| HTTP 403 | **З-сообщество:** 07.02.2024 downloader сообщал CDN/M3U8 403, при этом просмотр в браузере работал. | CDN entitlement/URL/transport failure и account suspension — разные состояния. [S37](https://github.com/prof79/fansly-downloader-ng/issues/17) |

**П, policy:** индексируемые Fansly ToS имеют дату 21.07.2026; содержат ограничения на автоматизированный доступ в описанных условиях, scraping значительной части платформы и чрезмерную нагрузку, а также право suspension/termination за запрещённое использование. Прямое открытие SPA через web extractor не дало текста; использован индексируемый текст официального URL. **В:** из ownership аккаунта или Management Session не следует разрешение на любой 24/7 backend collector. Письменные условия Fansly могут уточнить допустимый сценарий; эксперимент на тестовом аккаунте этого не решает. [S38](https://fansly.com/tos)

Детальных воспроизводимых Fansly hard-ban reports, связывающих исключительно JA3/HTTP2 mismatch, headless или второй socket с санкцией, в просмотренных источниках не найдено. Форумные истории про OnlyFans и SEO-страницы «как разбаниться» не использованы как доказательство правил Fansly. Ноль terminal 403/429 за 14 дней описывает только имеющиеся счётчики: он не измеряет silent truncation, reauth prompts или риск будущего бана.

**4. Management Session: что заменяет и чего не обещает**

**П:** официальная справка от 01.12.2025 подтверждает delegated access без выдачи пароля, настройку разрешений, single-use links, редактирование и отзыв. После logout/истечения link нужен новый link. Чувствительные области, включая payouts и account closure, ограничены. Числовой TTL активного token и mapping REST scopes там не опубликованы. [S1](https://help.fansly.com/en/articles/12328641-management-sessions)

| Вопрос | Ответ для проектирования |
|---|---|
| Уберёт ли full owner token? | **В:** для разрешённых функций — целевая замена. Для «всех данных владельца» пока не доказано. |
| Работают ли account REST endpoints? | **П-код:** bundle содержит create/update/remove/claim management routes и management marker в session. **?** Read coverage каждого из 17 streams. |
| Доступны ли `wsv3` events? | **В:** общий active-session auth flow делает вариант правдоподобным. **?** Нужен тест business frames, не только handshake. |
| Новый ли это device identity? | **?** Отдельная delegated session и отдельное устройство — разные понятия. Снять фактические account/session/device IDs после claim в новом persistent profile. |
| Все permissions OFF = read-only? | **З-вендор:** так FBuddy настраивает Smart Lists. Это не проверенная universal REST read scope. [S8](https://fbuddy.net/extension/fansly-management-session-setup/) |
| Что с payouts? | Раздельно проверить payout history/status, wallet, payout-method details и initiation. Запрет payout actions не доказывает отсутствие всех финансовых reads; доступность earnings не доказывает доступность payouts. |
| Logout и revoke | Не использовать logout как штатное завершение worker/browser. Profile сохранять; восстановление после revoke требует нового делегирования. |

Для этого исследования Management Session — **механизм credentials и прав**, который сочетается с любым transport, а не самостоятельный transport. То же относится к proxy, cache и WebSocket: это независимые слои.

Если часть owner-only reads недоступна, честные варианты — сохранить явно ограниченный owner access для этих потоков, использовать пассивный owner-browser capture с соответствующей доступностью либо сузить freshness/coverage. Нельзя объявлять delegated-only migration законченной, скрыв пропущенные payout данные.

**5. Полная карта подходов**

Оценки ниже — **В**, качественное сравнение для ваших требований. Это не измеренные вероятности бана.

| Семейство | Добавленный технический риск | Свежесть / работа при закрытом chatter browser | Объём и стоимость | Custody / сложность |
|---|---|---|---|---|
| Нынешний Node replay | Несогласованная identity, ручные headers, неизвестные проверки | Poll interval; сервер работает | Мало RAM; сейчас много повторных scans | Токен у Hub; lifecycle поддерживаете сами |
| Browser-grade HTTP: curl-impersonate/curl_cffi/impers, tls-client | Убирает часть TLS/HTTP mismatch; JS/session behaviour остаётся вашим | Секунды только с отдельно проверенным WS; без chatter работает | Низкая RAM; объём определяется planner | Свой небольшой transport sidecar; native deps и обновления fingerprint |
| uTLS самостоятельно | Только часть TLS; HTTP2 и всё остальное надо собрать | Как выше | Низкая RAM, высокая цена собственной поддержки | Не первый выбор для шести accounts |
| Stock persistent browser с native HTTP + native WS | Меньше искусственно воспроизводимых протоколов; фоновый collector всё ещё automation | Секунды для доставленных events; автономен на VPS | Browser RAM/bootstrap traffic; разумный вариант на 6 pages | Свой profile/session broker, поддержка reconnect и recovery |
| Headless Firefox / Camoufox | Новый набор automation/fingerprint особенностей | Возможен постоянный WS; автономен | Потенциально экономнее GUI/VM; фактическую RAM измерять | Дополнительные browser patches и release drift |
| Playwright + Patchright / Chromium | Меняет engine и automation stack | Автономен | Browser resources | Patchright не поддерживает Firefox |
| Headed browser в VM/desktop session | Оператор может вручную восстановить вход; не исчезает automation footprint | Автономен при работающем host | Больше RAM/ops, особенно отдельная VM на account | Self-hosted custody; полезный начальный эталон |
| Antidetect: AdsPower/GoLogin/Dolphin-класс | Менеджмент profiles полезен; synthetic identity не доказывает меньший риск | Нужен постоянно работающий runtime, наличие profile manager само по себе его не даёт | Лицензия + browser/VM + proxies | Обновления и sync profiles у стороннего ПО |
| Remote browser: Browserbase/Browserless-класс | Передача session оператору; reconnect/timeout | Независим от chatter, но не обязательно один вечный socket | Browser-hours + proxy bandwidth | Ниже infra burden; больше custody и service constraints |
| Passive extension relay | Минимальный добавленный Fansly traffic; есть риск сломать клиентский capture hook | Секунды во время работы вкладки; без браузера события не видит | Почти ноль новых platform requests | Существующий profile; spool/ACK/dedup обязательны |
| Extension как активный read worker | Настоящий browser network, но запросы дополнительные | Работает только при доступном host/profile | Использует RAM chatter host и общий request budget | Закрытие/сон компьютера делает worker unavailable |
| Mobile API imitation | Отдельный привилегированный Fansly mobile contract не подтверждён | Не доказано | Исследовательская стоимость высокая | App headers/attestation/session нужно изучать заново |
| Third-party creator API | Транспорт и upstream нагрузка непрозрачны | Vendor-specific: WS relay либо polling | Credits, account slots, webhook cost | Токен, иногда пароль, у поставщика |
| Browser owns identity + WS, HTTP does bulk | Native realtime, но один IP не делает HTTP-client Firefox | Автономен | Экономия возможна, если browser context сам слишком дорог | Два transport, общие identity generation, cooldown и budgets |

**П по tooling:** curl_cffi заявляет TLS/JA3/HTTP2 impersonation; `tls-client` даёт готовые profiles; uTLS прямо описывает изменение ClientHello, а не полного HTTP/browser stack. Для Node есть bindings/sidecar варианты: backend переписывать не требуется. Наличие инструмента не подтверждает Fansly acceptance. [S35](https://github.com/lexiforest/curl_cffi), [S39](https://github.com/bogdanfinn/tls-client), [S36](https://github.com/refraction-networking/utls)

**П:** Camoufox — модифицированный Firefox; Patchright работает только с Chromium. Playwright использует patched Firefox и не управляет обычным branded Firefox этим же driver. Нельзя считать эти три варианта взаимозаменяемыми «настоящими Firefox». [S40](https://github.com/daijro/camoufox), [S41](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright), [S42](https://playwright.dev/docs/browsers#firefox)

**П / В:** Browserbase поддерживает persisted contexts, но документирует session timeout максимум 21,600 секунд; `keepAlive` не превращает это в бессрочную сессию. Это минимум четыре browser sessions/day для 24/7 работы при использовании максимума; cached profile не сохраняет живой socket. Browserless предлагает reconnect/live handoff. Это полезные услуги, но Fansly-specific совместимость не проверена. [S43](https://docs.browserbase.com/reference/api/create-a-session), [S44](https://docs.browserbase.com/platform/browser/core-features/contexts), [S45](https://docs.browserless.io/baas/start)

Дополнительные варианты, которых не было в брифе:

- **В:** Stock browser + ваша extension + local native-messaging sidecar: транспорт выполняет браузер, локальный процесс надёжно передаёт raw в Hub. Для Firefox это позволяет не делать Playwright условием архитектуры.
- **В:** Постоянный agency browser на собственном отдельном компьютере, доступный по remote desktop, вместо VPS farm. Та же архитектура; другая доступность питания/сети и RAM.
- **В:** Durable vendor export / initial seed, затем собственный delta capture. Полезно лишь при доказанной исходной полноте и raw fidelity.
- **В:** Email/push notifications как дополнительный сигнал «что-то изменилось», без претензии на account archive.
- **В:** Прямое договорное разрешение/партнёрский доступ Fansly. Это способ уточнить policy, а не существующий публичный API, который можно сейчас подключить.

**6. Что именно я бы построил**

Целевая цепочка:

`Fansly native HTTP/WS → browser broker → durable raw journal → существующий parser/canonicalization → Hub`

На каждой page — один постоянный collector profile, одна выделенная delegated session и один назначенный egress. У каждого chatter — своё делегирование/устойчивая browser identity; owner token не размножается как device identity сотрудников.

Planner, Postgres, projections и outbox остаются вашими. Меняется реализация transport interface, а не модель данных:

1. Broker получает узкий разрешённый read intent; не произвольный `eval` от клиента.
2. Запрос действительно выполняется browser network stack. `page.request` / `APIRequestContext` с общими cookies не следует считать доказательством native browser TLS; это отдельный API-клиент. [S46](https://playwright.dev/docs/api/class-apirequestcontext)
3. Native application headers получаются через проверенный request path. Нельзя ожидать, что просто `fetch` добавит application interceptor.
4. Оригинальный response body или WS message data сохраняется до business parsing. Учитывается место capture: HTTP entity body / WS payload / vendor envelope. Не называть повторно сериализованный JSON исходными bytes.
5. ACK означает durable commit. При потере связи с Hub остаётся локальный spool; повторная доставка в **Hub** разрешена и дедуплицируется. Это не повторная отправка DM в **Fansly**.
6. Event с полной сущностью обновляет систему через raw-first pipeline без немедленного REST reread; частичный event создаёт coalesced dirty intent по entity. Нет `full sync` на каждый frame.
7. После disconnect — bounded catch-up с overlap и независимым обнаружением изменений. Локальная последовательность frames не превращается в server replay cursor.
8. Account/session generation, origin, capture time, connection epoch и provenance сохраняются вместе с фактом. Token и claim link находятся в отдельном secret storage, не в диагностическом отчёте.

Для passive Firefox HTTP capture имеется `webRequest.filterResponseData`, но extension обязана правильно передавать и завершать поток, иначе сломает страницу. Это нужно проверять отдельно от сохранности данных. HTTP interception не даёт автоматически доступ к WS message frames: для них нужен отдельный наблюдатель существующего socket/application flow, без второго соединения. [S47](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/filterResponseData)

**Raw constraint для vendor route:** OnlyFansAPI, например, прямо декодирует некоторые upstream `metadata` strings в object. Сохранённый webhook body будет raw **vendor**, а не неизменённый raw **Fansly**. Перед использованием vendor в качестве основного источника нужно получить/проверить original upstream body/frame и отсутствие непредусмотренных повторов mutating requests. Пока этого нет, vendor годится как freshness hint и отдельный provenance lane. [S12](https://docs.onlyfansapi.com/webhooks/fansly-events)

**7. Cadence и нижняя граница запросов**

Все интервалы в этом разделе — **В**, предлагаемый старт испытаний, не «безопасные лимиты Fansly». Маскировать работу движениями мыши или случайными логинами не требуется. Нужны стабильная identity, ограниченная concurrency, общий scheduler, приоритет живых событий и явный backoff.

| Данные | Предлагаемое обслуживание | Что остаётся вне гарантии |
|---|---|---|
| Новые DM и replies | Native WS/passive frames; target p95 durable capture ≤5 s при здоровом канале. Частичный payload → приоритетная hydration | Dropped frames, hidden threads, неполные payloads; delivery SLO не равен completeness SLO |
| Discovery диалогов | Начальный trial head poll каждые 60–120 s с overlap и продвижением до проверенного watermark | Один unchanged page нельзя использовать как universal stop; сначала проверить сортировку, pinned/hidden/filter partitions и старые диалоги |
| Socket loss | Ограниченный reconnect с jitter; после recovery — catch-up за gap window; независимый discovery продолжает работать | Heartbeat подтверждает соединение, не доставку каждого бизнес-события |
| Transactions/subscriptions | Events как приоритетный сигнал; incremental reads в окне recent changes каждые 2–5 min; расширенная сверка сутки | Refunds/reversals/settlement могут менять прошлое; нужен overlap по изменяемым состояниям |
| Spender earnings | Dirty fan из transaction/purchase signal, coalescing 30–120 s; активные/on-demand; периодическая сверка aggregate и изменяемого прошлого | Daily reread всех spenders можно ослаблять только после доказательства охвата, включая refunds |
| Followers | Positive changes через подтверждённые сигналы и head reads; полный presence walk пока по прежнему расписанию | Unfollow/отсутствие нельзя вывести из отсутствия события или одной страницы |
| Posts/vault/inventory | Event/собственное действие → targeted read; head 5–15 min; холодная сверка 12–24 h после проверки | Media edits, deletes, delayed processing; отдельный coverage debt |
| Payouts/account stats | По доступным scopes; terminal statuses реже, pending states чаще; конкретный interval после capability probe | Эти данные нельзя объявить секундными лишь из наличия WS |

Снижение полного conversation sweep до 6 часов и follower walk до суток допустимо **только после** доказательства альтернативного discovery для требуемых изменений. Если hidden conversation может не всплыть в голове и не прислать event, полному sweep всё ещё принадлежит его freshness deadline. Нельзя получить экономию, молча заменив 30 минут на 6 часов для этого класса сообщений.

Для arbitrary old edits/deletes нужен либо полный доказанный change log, либо проход соответствующей истории, либо честно ограниченный SLA. Без change signal «весь архив всегда за секунды» при низком объёме принципиально не следует из имеющихся endpoints. ETag/304 также экономит bytes, но не число requests; наличие ETag/If-Modified-Since на нужных Fansly routes не установлено.

**Расчёт по брифу, без новых production измерений:**

| Категория | Сейчас / day | Условный сценарий / day |
|---|---:|---:|
| Conversation list | 15,370 | ≈5,601: четыре full sweeps/day вместо 48, плюс ровно один head request каждые 120 s на каждую из 6 pages |
| Spender earnings | 5,510 | 551, **если** dirty subset действительно 10% и остальная сверка учтена отдельно |
| Followers | 3,480 | 580, **если** остаётся один full walk/day и решён discovery unfollows |
| Остальные streams | 4,640 | 4,640 без изменений |
| Сумма | 29,000 | ≈11,372 **до** дополнительных hydration, overlap, retries, browser bootstrap и repair |

Это демонстрация порядка экономии, а не обещанный production target: реальное число head pages и доля dirty fans пока неизвестны. 87% одинаковых страниц нельзя механически отбросить заранее — их неизменность обнаруживается только после чтения, если нет доказанного server-side change marker.

Один head request каждые 5 секунд на 6 accounts — уже **103,680 HTTP requests/day**, ещё без архива. При low-volume требовании секундная свежесть должна приходить из событий. Среднее исходного брифа — примерно **3.36 requests/min/account**; оно не описывает burst и не является safe threshold.

Browser bootstrap, device/login checks, OPTIONS, retries, WS handshakes и собственный frontend polling входят в физический traffic budget. WS ping/pong считаются отдельно от HTTP calls: замена polling на WS не означает нулевой сетевой трафик.

Нативный трафик чаттеров нужно наблюдать и учитывать при выделении фонового бюджета. Bulk queue не должна задерживать ручную работу в inbox; cooldown в первую очередь останавливает автоматические читатели. Если native UI продолжает нагружать аккаунт, это отдельный наблюдаемый фактор, а не основание считать, что account-wide нагрузка уже остановлена.

**8. Proxy, identity и recovery**

**В, выбор класса proxy:** сначала инвентаризировать существующие шесть egress. Покупку и смену IP не считать необходимым первым шагом. Для нового подключения предпочтителен **dedicated static ISP/residential endpoint** в устойчивом регионе аккаунта, с длительным сохранением одного exit IP, поддержкой WSS/CONNECT или SOCKS5, документированными idle timeouts и без TLS interception. Dedicated mobile тоже возможен, но сам ярлык mobile не гарантирует стабильный public IP.

«Sticky 10–30 min» из residential rotation pool не соответствует постоянной session identity. Источник IP, ASN, shared/exclusive, geo, срок удержания, rotation policy, провайдер и observed exit address должны быть явными полями, а не догадкой по названию тарифа. IP intelligence даёт дополнительный сигнал, не доказательство добросовестности всей цепочки.

**П по рынку:** ApiFansly документирует exclusive mobile/default и ограничения custom proxies; OnlyMonster — stable account proxies и SOCKS5 без публичного подтверждения residential/mobile класса. Разница этих рекомендаций сама показывает отсутствие единого опубликованного Fansly стандарта. [S16](https://docs.apifansly.com/introduction/essentials/proxies), [S4](https://docs.onlymonster.ai/onlymonster-browser/proxy-management)

**В, pinning:**

- Одна page → один assigned egress для collector и browser profiles чаттеров. API, account WSS и auth/bootstrap маршруты должны проходить его целиком, fail-closed.
- Одинаковый proxy URL не всегда означает одинаковый exit IP: gateway может менять выход на новое TCP-соединение. Сверять фактический выход HTTP и WSS, long-lived behaviour и reconnect.
- В одном общем Firefox profile с несколькими аккаунтами глобальная proxy setting неудобна для per-account isolation. Начальный надёжный вариант — отдельные persistent profiles/processes; более сложный container-aware routing нужно доказывать.
- Chatters не копируют device id collector. У них собственные устойчивые devices и delegated sessions; общий egress решает сетевую согласованность, не требует подделывать единое устройство.
- Модель может иметь отдельную owner session на телефоне. Это не та же ситуация, что параллельный replay одного owner token с клонированным device id.
- Переезд egress — управляемая смена с pause/owner-assisted reauth при необходимости. Proxy rotation не используется как ответ на challenge/429.

**В, lifecycle:** хранить access type, account id, session id, device id, credential generation, profile/browser version, bundle/check-key version, egress, scope evidence, время получения и подтверждения. Expiry не вычислять по выдуманному TTL: подтверждённого универсального значения нет. Не логиниться на расписании «для продления»; поддерживать профиль, реагировать на реальные auth transitions, передавать 2FA владельцу в нормальном браузерном flow. Claim link не считать активным session token.

**В, классификация отказов:**

| Наблюдение | Действие collector |
|---|---|
| 401 либо native auth-error | Прекратить использование generation; raw error сохранить без credentials; request owner-assisted reauth. Не повторять login и не вызывать автоматический logout/revoke. |
| 403 | При неясной причине остановить автоматический доступ page до классификации. Только доказанный endpoint-scoped permission denial позволяет ограничить pause этим scope. Различать entitlement, region/age-check, session, HTML challenge, CDN и account restriction; не ставить диагноз «бан» по status. |
| 429 | Уважить `Retry-After` полностью: seconds либо HTTP-date; абсолютный persisted deadline общий на page/egress. Урезать backfill. Не переключать IP и не обходить cooldown другим transport. |
| 2xx с HTML/login/challenge либо `success:false` | Не отправлять в обычный business parser. Отдельное состояние challenge/auth/contract-error; сохранить исходный ответ. |
| 2xx с подозрительной пустотой, оборванной pagination, повтором cursor | Не продвигать completion checkpoint и не интерпретировать как удаление данных. Зафиксировать anomaly и проверить эталоном с ограниченным числом reads. |
| Socket alive, данных нет | Отдельно следить за event delivery, REST discovery и бизнес-активностью. Отсутствие событий на тихой page не равно поломке; pong не равно полноте. |
| 5xx / proxy/network loss | Ограниченные retry только идемпотентных reads, учитывая общий budget; circuit breaker при повторении. Writes по-прежнему one attempt, indeterminate остаётся indeterminate. |

Challenge detector должен анализировать status, content-type, redirect/final URL, native success/error envelope, доступность требуемых полей, изменение количества/coverage и видимый auth state браузера. Проверять правило на сохранённых fixtures и сверять с browser read. «Silent throttling» остаётся гипотезой, пока другие причины не исключены.

**9. Стоимость для шести pages**

Все суммы — USD; цены прочитаны 16.09.2026. Это transport budget, не финансовый план агентства.

| Вариант | Ориентир |
|---|---|
| Собственные fixed proxies | IPRoyal публикует static residential от $2.70/proxy за 30 дней. Шесть по стартовой цене — $16.20, но доступность региона, minimum order и разрешённый use case требуют конкретной оферты. Bright Data показывает dedicated ISP tier 10 IPs за $35/month. Это примеры класса, не Fansly-tested endorsement. [S48](https://iproyal.com/pricing/static-residential-proxies/), [S49](https://brightdata.com/pricing/proxy-network/isp-proxies) |
| Шесть собственных browser profiles | **В, резерв до измерения:** 0.5–1 GiB/profile, то есть 3–6 GiB плюс примерно 50% headroom = 4.5–9 GiB **добавочно к** нынешним Hub/Postgres потребностям. Это не benchmark. Измерить PSS/RSS, steady-state/peak, CPU и swap на representative account. |
| Cloud browsers | 6 × 24 × 30 = **4,320 browser-hours/month**, плюс proxy bytes и session lifecycle. Нельзя оценивать такой режим по цене короткого automation job. |
| OnlyFansAPI credits | Standard uncached call — 1 credit; webhook — 1/100 events; 1M extra credits — $799. Исходные 29k/day означают 870k/30 days: ≈$695.13 потреблённой стоимости по ставке этого pack, с покупкой пакета за $799 и отдельно subscription/account conditions. Это условие 1:1 calls, не измерение vendor upstream fanout. [S14](https://docs.onlyfansapi.com/introduction/essentials/credits) |
| ApiFansly | Starter $49/24k credits/2 accounts, Pro $129/60k/5 accounts: шесть pages не помещаются в опубликованный Pro account cap. Нужна другая оферта. Standard request = 1 credit, но каждые 140kb увеличивают расход; 80 webhook events = 1 credit. [S18](https://apifansly.com/), [S19](https://docs.apifansly.com/introduction/essentials/credits) |
| CreatorAPI | $39/24k credits для Fansly; top-ups от $45/25k. Самый дешёвый entry price не описывает стоимость нынешнего traffic. [S20](https://creator-api.com/fansly-api) |

Vendor rate limits — ограничения входящего API сервиса, а не разрешённый Fansly upstream RPM. Например, OnlyFansAPI считает RPM по team/workspace; это не инструкция слать столько запросов в каждый аккаунт. [S50](https://docs.onlyfansapi.com/introduction/essentials/rate-limits)

**10. Миграция от схемы брифа**

1. **Сделать наблюдаемым нынешний transport.** Actual attempts/bytes по route/account, soft-failure classifier, absolute cooldown, egress identity inventory, latency distributions и coverage debt. Сначала проверить, что из этого уже существует в текущем checkout/production: бриф — snapshot.
2. **Passive relay из существующего Firefox.** Снимать уже полученные HTTP/WS данные, raw spool/ACK/dedup, без нового socket. Сравнивать с текущим REST discovery, не отключая его автоматически. Это первый новый transport slice с минимальной дополнительной Fansly нагрузкой.
3. **Лаборатория отдельной Management Session и browser broker.** Один тестовый creator, операторский headed stock-browser baseline. Полная матрица read scopes, стабильность device/session, socket semantics, recovery, browser side effects, raw fidelity и RAM.
4. **Один collector profile на согласованной production page.** Один egress, independent delegated session; native WS + bounded REST. Chatter relay помогает обнаруживать расхождения. Не запускать два полных history collectors «для сравнения».
5. **Сокращать scans по доказанной coverage.** Сначала конкретная категория данных; критерии — пропуски, p95/p99 durable latency, attempts/bytes, auth/challenge anomalies, browser UX и bounded reconciliation debt. Изменять interval отдельно от identity/transport.
6. **После измерения ресурсов выбирать экономию.** Если browser budget приемлем — оставить HTTP в браузере. Если доказана реальная проблема ресурсов/throughput, тестировать browser-grade HTTP для bulk; общий IP и token сами не дают доказательства эквивалентности.
7. **Расширять по одной page.** При расхождении вернуть discovery/transport в последний проверенный режим; сохранённые raw не удаляются. Никакая green canary автоматически не меняет права, credentials или sends policy.

**11. Ранжированная рекомендация**

Рейтинг — по соответствию вашим требованиям, а не по выдуманной статистике банов.

1. **Собственный persistent browser broker + минимальная Management Session + native WS + incremental REST / reconciliation.** Лучший целевой вариант для шести pages: протокол обновляет сам сайт, есть ручное recovery, вы сохраняете raw и custody. Первый production шаг к нему — passive relay и наблюдаемость. Initial headed baseline; headless — последующая проверяемая оптимизация.
2. **Свой browser-grade HTTP transport + независимо проверенный `wsv3`, browser только для onboarding/recovery.** Экономичнее по RAM; больше собственной ответственности за headers, session, WS и fingerprints. Предпочесть, если browser budget фактически мешает.
3. **OnlyFansAPI как ограниченный fallback / event hint.** У него наиболее явное публичное описание Fansly WS relay. Полная замена допустима лишь после проверки raw upstream fidelity, coexistence, нужных endpoints, account costs и retry semantics.
4. **Relay только из chatter browser.** Лучший малый шаг по добавленной platform нагрузке; самостоятельным решением 24/7 не является. Можно оставить как независимый контроль.
5. **Managed browser / antidetect service.** Уместен при нехватке собственных operations, но для шести pages custody, browser-hours и session caps могут перевесить удобство.
6. **Mobile imitation и непроверенный stealth stack.** Исследовательские варианты без достаточного Fansly-specific основания для первого внедрения.

**12. Что требует live test, и что live test не докажет**

| Неизвестное | Ограниченный проверочный сценарий |
|---|---|
| Management scopes | На корректно оформленном тестовом creator проверить все 17 read families: сообщения, fans, transactions, subscriptions, followers, earnings, stats, posts, vault, notifications, payout history/status отдельно от methods/actions. Зафиксировать response и denied reason. |
| `wsv3` с delegated token | Browser login/claim → auth ACK → контролируемые business events → raw capture. Livestream `chatws` не заменяет этот тест. |
| Второй socket | Сравнить browser-only, второй socket на том же token, затем отдельная delegated session. Проверить delivery в обоих направлениях, session survival, unread/read/delivered side effects. Прекратить при влиянии на основной browser. |
| Device/session lifecycle | Снять ID при claim, reload, browser restart, нормальном обновлении браузера, scope edit и revoke. Проверить, какие изменения разрывают REST/WS. TTL измерять, не предполагать. |
| HTTP correctness | Один разрешённый route через native browser и candidate client при том же egress; сравнить headers, query semantics, body, CORS/preflight и ошибки. Без load sweep. |
| client-check drift | Offline fixtures из актуального bundle и native captured requests: paths, query independence, JS integer semantics, device generation, timestamp. Live только минимальное подтверждение после offline совпадения. |
| Event coverage | Контролируемые DM, reply, reaction, edit/delete, tip/purchase, follow/unfollow, subscription changes, profile/post/vault updates; payouts — при естественном тестовом событии. Отдельно hidden/pinned/filtered conversations. |
| Gap recovery | Отключить collector network, создать несколько разрешённых изменений, вернуть связь; проверить bounded catch-up и отсутствие ложного «complete». Потерю отдельного frame воспроизвести локально. |
| IP / browser mode | Сначала фактический exit и WSS stability. Headed/headless сравнивать при неизменных остальных условиях. Не искать предел бана стрессом или массовой сменой стран. |
| RAM / bytes / latency | 24–72 h на representative profile, рестарт и login peak; PSS/RSS/CPU, native background HTTP, WSS reconnect, p95/p99 до durable journal. |
| 401/403/challenge | Fixtures и естественно возникшие проверки: подтвердить stop, отсутствие hidden retries и автоматического logout. Не генерировать captcha искусственной нагрузкой на реальные модели. |
| Vendor fallback | Проверить origin payload, event latency, дубликаты, реконнект, backfill limits, account cap и независимый upstream traffic budget; получить письменные ответы о непрозрачных деталях. |

Обычный disposable fan account не покрывает creator earnings/payouts/management. Для этой матрицы нужен легитимный тестовый creator с нужными возможностями; real model account не используется для поиска destructive thresholds.

Ни 72 часа теста, ни отсутствие 429 не установят вероятность редкого бана, универсальные антибот thresholds, полноту всех будущих событий или разрешение Fansly. Для contract/policy нужен ответ самой платформы; для runtime — длительное наблюдение с независимой проверкой и честным coverage статусом.

**13. Основные источники и что они подтверждают**

Все недатированные living docs проверены 16.09.2026; «updated over 2 weeks ago» не превращено в точную дату. Даты source code закреплены commit SHA.

- [Fansly Management Sessions, 01.12.2025](https://help.fansly.com/en/articles/12328641-management-sessions) — делегирование, link lifecycle, права и отзыв.
- [Fansly Creator Security FAQ](https://help.fansly.com/en/articles/12328615-creator-security-faq) — официальный agency/manager access.
- [Fansly age verification, 19.05.2026](https://help.fansly.com/en/articles/11845000-global-age-verification-requirement) — географически обусловленные проверки.
- [Fansly ToS, 21.07.2026, индексируемый текст](https://fansly.com/tos) — policy ограничения и санкции, с указанной выше extraction-оговоркой.
- [OnlyMonster Browser onboarding](https://docs.onlymonster.ai/), [proxy settings](https://docs.onlymonster.ai/onlymonster-browser/proxy-management), [Fansly coverage](https://onlymonster.ai/blog/how-to-manage-onlyfans-and-fansly/) — продуктовый browser/proxy flow; не скрытый backend.
- [Infloww Fansly setup](https://help.infloww.com/en/articles/324832-getting-started-with-fansly-on-infloww), [custom proxies, 23.01.2026](https://help.infloww.com/fr/articles/262102-proxys-personnalises) — credentials flow и границы proxy-доказательства.
- [FBuddy Management Session](https://fbuddy.net/extension/fansly-management-session-setup/), [changelog](https://fbuddy.net/updates/), [CRM guide](https://www.fbuddy.net/crm/guide/) — реальное использование делегирования сторонним продуктом и историческая cadence.
- [OnlyFansAPI Fansly authentication](https://docs.onlyfansapi.com/api-reference/fansly/connect-fansly-account/start-authentication), [Fansly webhooks](https://docs.onlyfansapi.com/webhooks/fansly-events), [credits](https://docs.onlyfansapi.com/introduction/essentials/credits), [rate limits](https://docs.onlyfansapi.com/introduction/essentials/rate-limits), [Fansly landing](https://www.fansly-api.com/) — auth/proxy параметры, relay, стоимость и self-reported ban claims.
- [ApiFansly proxies](https://docs.apifansly.com/introduction/essentials/proxies), [webhooks](https://docs.apifansly.com/webhooks/create-webhook), [credits](https://docs.apifansly.com/introduction/essentials/credits), [plans](https://apifansly.com/), [independence / terms, 23.08.2026](https://apifansly.com/terms-of-service) — отдельный vendor и его ограничения.
- [CreatorAPI](https://creator-api.com/fansly-api), [The Only API FAQ](https://docs.theonlyapi.com/docs/faq), [The Only API proxies](https://docs.theonlyapi.com/docs/proxies), [ModelVI](https://modelvi.com/agent-api) — дополнительные подходы и существенные различия покрытия.
- [Supercreator Product Overview](https://help.supercreator.app/en/articles/6306439-start-here-product-overview), [CreatorHero](https://www.creatorhero.com/only-fans-crm), [FanGrowth](https://www.fangrowth.io/), [Fans-CRM](https://fans-crm.com/onlyfans-free-vpn-proxy-ip-antidetect-browser/) — граница между поддержкой Fansly и соседними OnlyFans/marketing продуктами.
- [Downloader-ng pinned source](https://github.com/prof79/fansly-downloader-ng/blob/2a6e63f82ddb41a1b75af0fbe91dafe9874f118e/api/fansly.py), [Go scraper headers](https://github.com/agnosto/fansly-scraper/blob/e45b519c3beebde2f42a0c25fc57324f8dbeb75a/headers/headers.go), [Go wrapper](https://github.com/yllvar/fansly-api/blob/14518307f8438c75088b2bd18c11b11886b46cbe/internal/api/fansly_client.go), [openFansly](https://github.com/h3llo-wor1d/openFansly/tree/e8009ebac057fcf74f008c81103138b7c882706e), [streamerbot protocol](https://github.com/ZerGo0/fansly.streamerbot/blob/c738286b2d263f1d360ce8e2c23b82f7e4d118ad/docs/protocol.md) — конкретные реализации, не production acceptance.
- [Silent-empty report, 24.08.2023](https://github.com/Avnsx/fansly-downloader/issues/148), [CDN 403, 07.02.2024](https://github.com/prof79/fansly-downloader-ng/issues/17), [endpoint drift PR, 24.01.2026](https://github.com/prof79/fansly-downloader-ng/pull/134) — датированные случаи с ограничениями причинности.
- [curl_cffi](https://github.com/lexiforest/curl_cffi), [tls-client](https://github.com/bogdanfinn/tls-client), [uTLS](https://github.com/refraction-networking/utls), [Camoufox](https://github.com/daijro/camoufox), [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright), [Playwright browsers](https://playwright.dev/docs/browsers#firefox) — возможности transport toolkits.
- [Browserbase session API](https://docs.browserbase.com/reference/api/create-a-session), [contexts](https://docs.browserbase.com/platform/browser/core-features/contexts), [Browserless](https://docs.browserless.io/baas/start) — границы managed browser runtime.
- [Mozilla response capture](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/filterResponseData), [Playwright APIRequestContext](https://playwright.dev/docs/api/class-apirequestcontext) — границы browser capture и отдельного API request client.
- [IPRoyal static residential pricing](https://iproyal.com/pricing/static-residential-proxies/), [Bright Data ISP pricing](https://brightdata.com/pricing/proxy-network/isp-proxies) — ориентиры класса proxy, без Fansly acceptance.
- [Локальный официальный bundle snapshot, 20.08.2026](/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/analysis/main.pretty.js:36335) — client-check, session model и account WS. Это историческая версия.
