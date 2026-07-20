
## Fast-follow: pre-existing fan-erasure gaps (найдены range-ревью PR #15, 2026-07-19)

Все четыре — про код, существовавший до voice-ленты; вынесены из PR #15,
чтобы не раздувать его сверх ревью-бюджета. Один маленький PR (~30 строк):

- [ ] **P1** `erasure/index.ts` generationPred: `conversation_ref = fanRef` не
  матчит Fansly groupId-fallback (расширение шлёт `fanAccountId ?? groupId`) —
  restricted prompt/completion + acceptance-события переживают fan-erasure.
  Фикс: считать fanGroupIds ДО generationPred, добавить в предикат (готовый
  резолвер уже есть — переиспользовать из voice_notes-фикса f8b76706).
  Тест: реальная source generation + acceptance row на groupId.
- [ ] **P1** `erasure/index.ts` threadPred (~539): нет `partner_platform_user_id
  = fanRef` — тред с fan_id=NULL (Fansly-синк реально пишет такие,
  executor-handlers.ts:2795+) переживает erasure вместе с page_dm_messages.
- [ ] **P2** frozen fanGroupIds: список групп снимается до fence-лока —
  войс, созданный в окне, останется навсегда. Оценить перенос резолва под лок.
- [ ] **P2** тред с fan_id И partner_platform_user_id оба NULL (неатрибутируемый
  партнёр) не резолвится вовсе → warn при остаточных voice_notes на страницах
  скоупа, чей conversation_ref не разрешился (немой остаток → видимый).
