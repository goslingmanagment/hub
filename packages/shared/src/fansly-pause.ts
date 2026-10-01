// Bounds of the owner's "Пауза между запросами Fansly" (`fanslyDefaultDelayMs`): the
// minimum pause between two requests of one Fansly page (Fansly Sync Engine plan
// §2.1). The floor is the owner's rule — at most one request of a page every 2 s — so
// going lower is a code change made only at the owner's request; the ceiling only
// catches a typo. A value outside is rejected at both write boundaries (boot env and
// the live override), never clamped. Dependency-free so the dashboard bundle
// (shared/browser.ts) and the server share one source with the registry, the env
// check and the tests.

export const FANSLY_PAUSE_MIN_MS = 2_000;
export const FANSLY_PAUSE_MAX_MS = 60_000;
