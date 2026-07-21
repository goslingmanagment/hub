# .agentic/backlog.md — отложенные улучшения (agentic workflow)

Формат: `### <ID> — <title>`, поля «Суть / Код / Закрыть». Не для дефектов —
для них корневой `backlog.md`.

### LINK-001 — fan_identities повторно покупает link-list обходы

- **Суть:** Phase-1 link discovery в fan_identities дёргает те же
  `/tracking-links` + `/trial-links`, которые теперь персистит link-stats
  reconcile (см. `docs/plans/2026-07-22-ofapi-link-stats-sync.md`), — двойная
  трата кредитов на одни и те же списки.
- **Код:** `apps/runtime/src/services/sync/ofapi-fan-identities.ts` (Phase 1,
  walkLinkPages) vs `apps/runtime/src/services/ofapi-link-stats-sync.ts`.
- **Закрыть:** читать link ids из последнего complete `page_link_stat_runs`
  вместо свежего discovery-обхода; перед этим зафиксировать freshness-контракт
  (bound на staleness каталога). Добавлено 2026-07-22.
