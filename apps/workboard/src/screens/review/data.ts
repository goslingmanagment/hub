/**
 * Разбор смены — the data layer (spec §4.2). Owned by the Разбор screen.
 *
 * Future contract (phase 2): the shift review split in two — a chat index of
 * the shift and one chat's transcript.
 *
 * Phase 1 adapter: `teamShiftReview` { userId, at } (the owner only; a finished
 * shift does not change, a running one is re-read every 2 min). `at` is the
 * shift's start from the address: `parseShiftKey(params.shiftStart)` in
 * src/shared/links.tsx. Query keys start with "review".
 */
export {};
