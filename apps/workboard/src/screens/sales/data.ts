/**
 * Что продаёт — the data layer (spec §4.5). Owned by the Что продаёт screen.
 *
 * Phase 1 adapter over today's operations (all take `days`; turn the period into
 * days with `period.days`, and say on screen when a read covers a different window):
 *   - Цена: `teamSalesPpv` { days } — PPV by page, chatter and price (`chatters[]` for by-chatter);
 *   - Скорость ответа: `teamSalesReplies` { days } — reply time against purchases;
 *   - Возврат фанов: `teamWinBackResults` { days }, `teamWinBackApproaches` (owner),
 *     write `teamWinBackApproachSave` (keep the console's body and confirmation:
 *     apps/dashboard/src/pages/team/TeamWinBackPage.tsx);
 *   - Приветствия и охват: `teamGreetings` { days }, `teamEmptyHours` { days }.
 * Query keys start with "sales".
 */
export {};
