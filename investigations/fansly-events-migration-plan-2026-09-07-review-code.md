# Проверка актуальности кода для общего плана

Проверено 7 сентября 2026, только чтение Git. Диапазон: `dcbba081d3bfbbf19a5e3ccf0ea3d77646d5076d..933d22f70242ee02804954361de04ab27823c1aa`. На момент проверки local HEAD и origin/main равны `933d22f70242ee02804954361de04ab27823c1aa`. Production в этом раунде не проверялся; его ревизию нельзя выводить из HEAD.

**Вердикт: изменения не требуют пересматривать архитектуру или точки встраивания Fansly.** В диапазоне один commit — `933d22f7`, всего четыре файла:

- `docs/agent-read-skill.md` — описание production-pinned CLI.
- `scripts/deploy-production.sh` — пересборка локального CLI после проверенного deploy.
- `scripts/rebuild-hub-cli-prod.sh` — новый вспомогательный скрипт.
- `tests/compose-config.test.ts` — проверка места и режима вызова пересборки.

Полный `git diff` прочитан. Runtime handlers, planner, canonicalization, credentials, HTTP telemetry, schema, migrations и Fansly adapter **не изменились**. Все относящиеся к ним номера строк из проверки `dcbba081` остаются теми же на `933d22f`. Сохраняются выводы про slot rebase, отличие completion от no-op, independent discovery/full coverage, mutable offset, follower trigger из трёх ветвей и необходимость semantic transaction delta/revision-aware earnings snapshots. Нового native WS receiver или готового bounded walker этот commit не добавляет.

Единственное дополнение к разделу выкладки/проверки общего плана: verified deploy теперь по умолчанию запускает локальный production-pinned `hub` CLI rebuild. Он извлекает точную deployed revision через `git archive`, проверяет `capabilities` и compiled/server contract hash, затем переключает локальные ссылки; предыдущая копия сохраняется. Сбой этой локальной операции выдаёт warning и **не откатывает здоровый production**. Для последующих agent-read проверок CLI и deployed contract должны совпадать; явный skip существует, но не является рекомендуемым режимом плана. Это поведение нового commit, а не дополнительный запрос на production действие.

Runtime tests не запускались: в проверяемой области diff отсутствует; выполнена проверка актуальности источников, не оценка correctness самого deploy patch. Ни скрипты deploy/rebuild, ни production/runtime mutations не выполнялись.
