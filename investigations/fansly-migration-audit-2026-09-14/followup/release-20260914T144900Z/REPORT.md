# Проверенный rollout исправлений аудита — 14 сентября 2026

**Production переведён на main `4e18d130ea6c`; штатный deploy завершился
успешно в 14:58:50 UTC. Приёмка событийной миграции остаётся открытой.**

Все 12 PR из [итога аудита](../RESULT.md) вошли в этот релиз. Проверенное дерево
`372b84f04df46c3cb607d5d5eef9c8a7c401bb62` соответствует локальным 3751 unit
(9 прежних skips), 96 PostgreSQL checks и успешному [CI main](https://github.com/goslingmanagment/core/actions/runs/34798541588).
[Независимый preflight](REVIEW-PREFLIGHT.md) проверил исходники, квитанции и миграции.

Первый pull опубликованного GHCR digest завершился `unauthorized` до остановки
сервисов. Его квитанция и лог сохранены. Затем штатный `--mode full` собрал тот же
чистый commit и передал образ через SSH. Это новый artifact, а не опубликованный
CI digest. Фактический image ID:
`sha256:a8919d6a00d03471f1b84e0d15c4f55cdc8c0801beeb06c169b0942161ed6a1d`.
Source и dependency checksum совпали с release worktree.

| Проверка production | Результат |
|---|---|
| API / worker / scheduler | Running, healthy, 0 рестартов; source `4e18d130ea6c` |
| Защищённый sync health | HTTP 200 в штатном deployment gate |
| Dashboard | Same-origin HTML проверен штатным gate |
| Миграции | Все 187 записей и applied timestamps совпали до/после; новых нет |
| PostgreSQL | Прежний image и start 13 сентября; в этом rollout не пересоздавался |
| Chromium | Нативный linux/amd64 smoke на VPS прошёл, network none |
| Локальный hub CLI | Обновлён до `4e18d130ea6c`; capabilities/contract совпали |
| Диск после rollout | 79%, доступно 17 555 316 KiB (16.74 GiB) |

Локальный Chromium smoke на ARM Mac упал в qemu/GPU emulation. Нативный запуск
того же candidate на VPS успешно завершился; оба результата сохранены. В первом
post-image выводе была ошибка JSON-шаблона; исправленный повторный metadata read
сохранён отдельно, исходный вывод оставлен.

Настройки не переключались. Свежий authenticated UI read в 15:10:14 UTC
подтвердил совпадающие reported values на всех трёх новых runtime instances:
DM shadow — шесть страниц (v1), earnings shadow — lilly-1 (v1), head catch-up —
none (v4). Drift/pendingApply отсутствуют. Квитанция хранит только эти три
несекретные настройки и сведения о ролях; Save не нажимался.

Первоначально Chrome был закрыт, а `read_only` не имел SELECT на
`runtime_instances` и `config_settings`; этот результат сохранён отдельно.
Штатное открытие Chrome вернуло уже авторизованную UI-сессию. Текущие значения
подтверждены; точный applied version каждой роли и историческая непрерывность
из этого snapshot не следуют. Окна A0/C1/C2b сохранены с явной границей runtime,
без новой приёмки или обнуления часов.

Короткий post-worker tail содержит 19 записей до 14:59:31 UTC без numeric error
и показывает продолжающийся Lilly-2 DM sweep. Он не доказывает долгосрочную
стабильность, восстановление прежних media ошибок или полноту reader.

Следующая работа: отдельный PR с узким A0 cost-read и фактический EXPLAIN после
его deployment; W0 continuity runner и парное наблюдение на lilly-1. Savings ≥50%,
event → reader latency, A1/B0/B1/C2c acceptance остаются неподтверждёнными.
B2 не строится. Image GC не выполнялся.

[Финальная независимая проверка](REVIEW-POST-RELEASE.md) завершилась без замечаний.
Текущие ссылки состояния исправлены, прежние версии сохранены.
