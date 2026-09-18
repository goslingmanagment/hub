# Проверка координатора

Проверены буквальный transition-dedup на recurrent A-B-A-B, source/prod/remote-main divergence, batch append и арифметика общих обещаний. Детальные решения: [checks.json](checks.json).

Реальный tier canonicalizer плюс модель глобальной уникальности подтверждает C6; proposed previousHash→nextHash key теряет второй A→B и оставляет состояниеA вместоB. Это не исполнение PostgreSQL; контракт uniqueness подтверждён source. Stateful change detector с durable occurrence generation остаётся допустимым направлением.

Live38032636 не входит в freshly verified remote main0a08365f; sync код совпадает с74aac509. Main и production по-прежнему различаются. Проверка production только read-only, срез14Sep01:15–01:17MSK:19.218GB доступного диска; DB37.288GB; read_only не имеетpg_read_all_stats;14 соединений ролиpostgres сrolsuper=true (это role census, не самостоятельное доказательство attribution каждого соединения).

Headline Fansly−13/77% и OFAPI53k→15k сходятся по округлённой арифметике, но не доказаны как no-loss итог. PostgreSQL percentages — weighted assumptions; WAL — fixed-parameter model. Сохранённые evidence не содержат исходных CSV/результатов, используемых этими моделями. Ни проценты, ни срок заполнения диска не выдаются за текущий замер.

Корневая поправка к нашему прежнему учёту: внутри общего реестра явно отделить совпадающую проблему, пригодность конкретного исправления и уверенность в численном эффекте. Ошибка в числе не отменяет подтверждённого дефекта; совпадение двух обзоров не доказывает число.
