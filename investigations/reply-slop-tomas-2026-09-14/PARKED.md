# Работа с промптами отложена

2026-09-15 МСК. Владелец: «вернем все как было и оставим на потом». Эксперименты остановлены; новых запусков или отложенного автоматического продолжения не назначено.

## Откат

- Draft PR #203 закрыт без merge: https://github.com/goslingmanagment/core/pull/203.
- Ветка codex/reply-owner-voice-20260915 восстановлена отдельным revert-коммитом 9dc73340c40e32d30cbea88d5439cc301832c4d6, push выполнен; remote ref независимо сверен.
- Полное tracked tree ветки совпадает с базой 78aa7d48a1071939cdd24c1037c5f5f98f8ecc91. Возвращены все9файлов: Fast Reply, его константа, persona catalog, manifest, тесты и неслитая запись решения.
- Worktree чистый. В основном checkout файлы промптов и затронутые тесты/decisions не имеют местных изменений.
- Проверены4prompt suites:107passed,7existing skips. Новых quality calls для отката не было.

## Production

В рамках этих экспериментов production не менялся; откат/перезапуск/seed/изменение mapping или model selection там не выполнялись. При завершении read-only проверка running api.js подтвердила: Fast Reply совпадает с восстановленным исходником (сравнение после trim, SHA2569d5847f5f62e8a7a2d0c15338fb49a0c16603178898a5d1378ab34fca0a80dc6; runtime literal5928bytes). builtin:lora-soft в runtime отсутствует. API/worker/scheduler healthy. Значения DB-персон в этой финальной проверке не читались; ранее read_only не имела доступа, обхода не было.

## Сохранено для возможного продолжения

Исходный кандидат доступен в истории commit9f10d26d65098bedb08f88a0cce23483fd6b7146. Экспериментальные промпты, реальные outputs, captures, blind reviews и runner-скрипты сохранены в этой investigation и tmp/reply-eval; ничего из них в production не опубликовано.

Основные результаты: OWNER-VOICE-ASSESSMENT.md, GOAL-VOICE-ASSESSMENT.md, MINIMAL-VOICE-ASSESSMENT.md, FABLE51-TWO-REPLIES.md. Они описывают исторические кандидаты, не текущие изменения к выпуску. Полноценного исправления нежелательной манеры не получено. Возвращаться к работе только по новой просьбе владельца.
