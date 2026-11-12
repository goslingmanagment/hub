// House primitives (mills, platformEnum, the error body, pagination) — extracted
// from routes.ts so the agent route module shares ONE declaration of each.
export * from "./primitives.ts";
export * from "./routes.ts";
// Agent Read Plane operations #1-#10 (spread into routeSchemas by routes.ts).
export * from "./routes-agent.ts";
// Slice B: owner administration of the plane's keys (issue / list / revoke).
export * from "./routes-agent-keys.ts";
// Fansly Sync Engine owner routes (history requests), spread by routes.ts.
export * from "./routes-sync.ts";
// The chat extension's routes (client bootstrap…), spread by routes.ts.
export * from "./routes-client.ts";
// Publications: wall posts through Hub (owner + agent drafts), spread by routes.ts.
export * from "./publications.ts";
export * from "./routes-publications.ts";
// Media looks: frames of a page's own media for an agent key (look:media), spread by routes.ts.
export * from "./media-looks.ts";
export * from "./routes-media-looks.ts";
export * from "./fan-queues.ts";
export * from "./routes-fan-queues.ts";
// Дела: what waits for a person, by reason key (package D), spread by routes.ts.
export * from "./matters.ts";
export * from "./matter-checks.ts";
export * from "./waiting-groups.ts";
export * from "./routes-matters.ts";
// Agent reports: named markdown pages an agent key publishes (package O), spread by routes.ts.
export * from "./agent-reports.ts";
export * from "./routes-agent-reports.ts";
// Заказ кастома (package I), spread by routes.ts.
export * from "./custom-orders.ts";
export * from "./custom-order-rules.ts";
export * from "./routes-custom-orders.ts";
export * from "./agent-team.ts";
export * from "./agent-doors.ts";
// «Рассылки» kept by Hub (outreach-store-v1), spread by routes.ts.
export * from "./outreach.ts";
export * from "./routes-outreach.ts";
// A chatter's statistics (the cabinet's «Статистика»), spread by routes.ts.
export * from "./chatter-stats.ts";
export * from "./routes-chatter-stats.ts";
export * from "./publication-files.ts";
export * from "./routes-publication-files.ts";
// Narrow device-token profiles (the chat extension's route allowlist, H-3).
export * from "./client-token-scopes.ts";
// One sign-in across the names (the one-time code between names), spread by routes.ts,
// and the narrow web session's route allowlist.
export * from "./routes-signin.ts";
export * from "./web-session-scopes.ts";
export * from "./authorization-policy.ts";
export * from "./sdk-runtime.ts";
export * from "./contract-hash.ts";
// Agent Read Plane vocabulary. Declared once and derived, so a drift between
// the enum, the counts and the per-operation matrices becomes a compile error
// rather than an inconsistent response body (see the file header).
export * from "./agent-read-registry.ts";
// Slice 0a vocabularies: the closed capability matrix a key grant is drawn from,
// and the dataset registry that is the ONLY bridge from a dataset name to code.
export * from "./agent-read-capabilities.ts";
export * from "./agent-read-datasets.ts";
// Client-side stop-reason predicate (coach-chat spec §8): surfaced through the
// contracts barrel — the same path that carries shared TYPES to the SDK — so
// out-of-workspace consumers (the extension) can import it from @kernel/sdk and
// apply it to a terminal stop reason before committing/attaching a generation.
export { isOutputExhausted } from "@agency_hub_core/shared";
// The `hub` CLI's dollar flags (`hub cross-spenders --min-source-spend 20`)
// become mills through the money codec, never through a CLI copy of it.
export { millsFromDollars } from "@agency_hub_core/shared";

export * from "./ofapi-vendor-usage.ts";
export * from "./routes-ofapi-vendor.ts";
export * from "./routes-ofapi-collection.ts";
export * from "./of-links.ts";
export * from "./routes-of-links.ts";
// The owner's login of a page's server browser (Project Browser PR 15).
export * from "./routes-page-browser.ts";
// The operator screen's one read (`GET /api/v1/ops/live`), spread by routes.ts.
export * from "./routes-ops-live.ts";
// The Anthropic accounts Hub spends (`/api/v1/admin/ai/accounts`), spread by routes.ts.
export * from "./routes-ai-accounts.ts";
export * from "./routes-ai-spend.ts";
export * from "./routes-ai-openers.ts";
// Команда → «Разбор смены» (`GET /api/v1/team/shift-review`), spread by routes.ts.
export * from "./routes-shift-review.ts";
// Выплаты from the agency ledger (`GET /api/v1/team/ledger-payouts`), spread by routes.ts.
export * from "./routes-team-ledger.ts";
// The chatter's own shift reports from the agency ledger (`GET /api/v1/account/reports`), spread by routes.ts.
export * from "./routes-account-reports.ts";
// «Мои деньги»: the chatter's own pay behind the person's switch (`GET /api/v1/account/pay`), spread by routes.ts.
export * from "./routes-account-pay.ts";
// Its quality numbers, one definition for the review's screen and «Смены» (`teamChatterNumbers`).
export * from "./shift-review-rules.ts";
export * from "./shift-review-audit.ts";
// The people registry (team list, the owner's card and writes, the agent feed and proposals), spread by routes.ts.
export * from "./people.ts";
export * from "./person-start.ts";
export * from "./routes-people.ts";
// Система → «Состояние»: the routines and copies of every place (package P), spread by routes.ts.
export * from "./system-state.ts";
export * from "./routes-system-state.ts";
export * from "./routes-shift-handins.ts";
// Система → «Сообщения людям»: the server's sender of messages to people, off twice (package S), spread by routes.ts.
export * from "./people-messages.ts";
export * from "./people-message-kinds.ts";
export * from "./routes-people-messages.ts";
export * from "./sale-claims.ts";
export * from "./routes-sale-claims.ts";
// Цепочка продажи (package T): from one sale, whose it is down to its payout.
export * from "./routes-sale-chain.ts";
// Стирание фана: the ledger's feed of the erasures Hub completed.
export * from "./routes-erasures.ts";
// «Чья продажа» «со слов» through Hub (review R2b-3).
export * from "./routes-sale-decisions.ts";

export * from "./routes-ofapi-banned-words.ts";
export * from "./routes-model-applications.ts";
export * from "./routes-ofapi-read-collections.ts";
export * from "./ofapi-smart-links.ts";
export * from "./routes-ofapi-exports.ts";

export * from "./routes-ofapi-media.ts";
export * from "./ofapi-actions.ts";
export * from "./ofapi-actions-collections.ts";

export * from "./ofapi-actions-publishing.ts";

export * from "./ofapi-actions-account.ts";
