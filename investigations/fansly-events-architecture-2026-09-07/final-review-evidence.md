# Финальная проверка доказательств

Дата: 2026-09-07. Проверен исправленный `ARCHITECTURE.md`; SHA-256 на момент чтения: `c0cdf69a2ed91d1278e5edbe4e9ac2e66675c37cd8e493aa6cb03baf3109b9c3`. Основной файл reviewer не менял.

**Вердикт: ACCEPT как conditional architecture proposal; implementation/production readiness не заявлена.** Существенные замечания предыдущего evidence review закрыты. Свежая работа должна начинаться с gate 0, не с отключения polling.

- **Закрыто:** §10:231–232 разделяет WS auth/capability failure и подтверждённую общую session failure. Исправный REST fallback сохраняется; bounded verification не превращается в logout или retry storm.
- **Закрыто:** §8:189–193 и rollout gate:253 отделяют independent discovery ≤30 min от дорогой detail/material сверки 2–6 h. Если необходим прежний scan, он остаётся; ≥50% экономия прямо остаётся недоказанной в таком режиме.
- **Закрыто:** source anchors `event-evidence.md#2-native-websocket-транспорт-и-сессия`, `#3-кандидаты-предметных-событий` и `#8-доппроверка-дешёвая-сверка-головы-диалогов` существуют. Остальные проверенные local anchors корректны.
- **Сохранены ограничения:** historical protocol/handlers не объявлены нынешним wire contract; live 101 не равен auth/coverage; provider enrichment не выдан за native fields; отсутствие replay не превращено в доказательство несуществования; transient offline facts не обещаны восстанавливаемыми. §13 оставляет transport/scopes/TTL/fan-out/hidden recovery и actual HTTP budget открытыми.

**Одна неблокирующая точность формулировки, §8:191:** HAR доказал несовпадение `data.lastMessageId` и embedded ID в 1/83 наблюдений, причём embedded ID численно больше. Фраза «embedded message новее. Это не атомарный snapshot» утверждает причину/временную семантику сильнее наблюдения. Рекомендуем: «embedded ID численно больше; причина расхождения неизвестна. Согласованность двух markers не доказана». Cache lag или разные semantics не исключены. Правило bounded repair при mismatch остаётся правильным.

На момент link check финальный `REVIEW.md` ещё не создан — единственный missing local file. Это артефакт финализации, его надо создать перед передачей пакета. Private traffic и production этим review не затрагивались.
