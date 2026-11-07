/**
 * Решения — the data layer (spec §4.6). Owned by the Решения screen.
 *
 * The reads and their query keys are shared with the sidebar's count and the
 * «Ждут решения» line of Смены: src/shared/decisions.ts (`disputesQuery`,
 * `customsQuery`, `heldSendsQuery`). Use those; after a write invalidate
 * ["decisions"] so every count moves at once.
 *
 * Writes keep the console's requests, server checks and confirmation texts:
 *   - a dispute's split: `teamShiftResolve` { params: { saleRef }, body } —
 *     apps/dashboard/src/pages/team/TeamPayoutsPage.tsx, api/team.ts (useResolveShiftDispute);
 *   - a held send's resolve: `clientSendCustodyResolve` { params: { pageLabel, attemptId }, body } —
 *     apps/dashboard/src/pages/ClientHeldSendsPage.tsx, api/clientHeldSends.ts.
 * Fan names, not 18-digit ids: <FanName> from src/shared/FanName.tsx.
 */
export {};
