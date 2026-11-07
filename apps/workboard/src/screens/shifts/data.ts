/**
 * Смены — the data layer (spec §4.1). Owned by the Смены screen.
 *
 * Future contract (phase 2, spec §2.7): `teamNow` (who is on shift now, live
 * counters) and `teamShiftJournal` (every shift with money, $/h, reply median,
 * unanswered at end, AI share), page filters applied by Hub.
 *
 * Phase 1 adapter over today's operations:
 *   - `teamShiftSales` { days, until?, pageLabel? } — shifts of the window with money + the window before (the week grid);
 *   - `teamShifts` { from, to, pageLabel? } — the shifts themselves, ongoing ones included;
 *   - `teamChatterNumbers` { from, userId? } — per-shift numbers (reply median, unanswered, AI share);
 *   - waiting decisions: `useDecisionCounts()` from src/shared/decisions.ts.
 * Query keys start with "shifts". Polls only while the tab is visible: 60 s for
 * "now", none for closed weeks.
 */
export {};
