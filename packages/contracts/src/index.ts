export * from "./agent-doors.ts";
// Slice 0a vocabularies: the closed capability matrix a key grant is drawn from,
// and the dataset registry that is the ONLY bridge from a dataset name to code.
export * from "./agent-read-capabilities.ts";
export * from "./agent-read-datasets.ts";
// Agent Read Plane vocabulary. Declared once and derived, so a drift between
// the enum, the counts and the per-operation matrices becomes a compile error
// rather than an inconsistent response body (see the file header).
export * from "./agent-read-registry.ts";
export * from "./agent-reports.ts";
export * from "./agent-team.ts";
export * from "./authorization-policy.ts";
export * from "./chat-team.ts";
export * from "./chatter-stats.ts";
// Narrow device-token profiles (the chat extension's route allowlist, H-3).
export * from "./client-token-scopes.ts";
export * from "./contract-hash.ts";
export * from "./custom-order-rules.ts";
export * from "./custom-orders.ts";
export * from "./fan-queues.ts";
// Where an invitation's link opens (package C4).
export * from "./join-links.ts";
export * from "./matter-checks.ts";
export * from "./matters.ts";
export * from "./media-looks.ts";
export * from "./of-link-fans.ts";
export * from "./of-links.ts";
export * from "./ofapi-actions-account.ts";
export * from "./ofapi-actions-collections.ts";
export * from "./ofapi-actions-publishing.ts";
export * from "./ofapi-actions.ts";
export * from "./ofapi-smart-links.ts";
export * from "./ofapi-vendor-usage.ts";
export * from "./outreach.ts";
export * from "./own-shift-rows.ts";
export * from "./people-message-kinds.ts";
export * from "./people-messages.ts";
export * from "./people-paths.ts";
export * from "./people.ts";
export * from "./person-start.ts";
// House primitives (mills, platformEnum, the error body, pagination) — extracted
// from routes.ts so the agent route module shares ONE declaration of each.
export * from "./primitives.ts";
// The products a person crosses between (the frames' switcher, `auth/me`).
export * from "./products.ts";
export * from "./publication-files.ts";
export * from "./publication-words.ts";
export * from "./publications.ts";
// «Мои деньги»: the chatter's own pay behind the person's switch (`GET /api/v1/account/pay`), spread by routes.ts.
export * from "./routes-account-pay.ts";
// The chatter's own shift reports from the agency ledger (`GET /api/v1/account/reports`), spread by routes.ts.
export * from "./routes-account-reports.ts";
// Slice B: owner administration of the Agent Read Plane's keys (issue / list / revoke).
export * from "./routes-agent-keys.ts";
// Agent reports: named markdown pages an agent key publishes (package O), spread by routes.ts.
export * from "./routes-agent-reports.ts";
// Agent Read Plane operations #1-#10 (spread into routeSchemas by routes.ts).
export * from "./routes-agent.ts";
// The Anthropic accounts Hub spends (`/api/v1/admin/ai/accounts`), spread by routes.ts.
export * from "./routes-ai-accounts.ts";
export * from "./routes-ai-openers.ts";
export * from "./routes-ai-spend.ts";
// A chatter's statistics (the cabinet's «Статистика»), spread by routes.ts.
export * from "./routes-chatter-stats.ts";
// The chat extension's routes (client bootstrap…), spread by routes.ts.
export * from "./routes-client.ts";
// Заказ кастома: the candidates of a custom with no order (customs facts spec §8), spread by routes.ts.
export * from "./routes-custom-candidates.ts";
// Заказ кастома (package I), spread by routes.ts.
export * from "./routes-custom-orders.ts";
// Стирание фана: the ledger's feed of the erasures Hub completed.
export * from "./routes-erasures.ts";
export * from "./routes-fan-queues.ts";
export * from "./routes-fans.ts";
export * from "./routes-learn.ts";
// Дела: what waits for a person, by reason key (package D), spread by routes.ts.
export * from "./routes-matters.ts";
// Media looks: frames of a page's own media for an agent key (look:media), spread by routes.ts.
export * from "./routes-media-looks.ts";
export * from "./routes-model-applications.ts";
export * from "./routes-of-link-fans.ts";
export * from "./routes-of-links.ts";
export * from "./routes-ofapi-banned-words.ts";
export * from "./routes-ofapi-collection.ts";
export * from "./routes-ofapi-exports.ts";
export * from "./routes-ofapi-media.ts";
export * from "./routes-ofapi-read-collections.ts";
export * from "./routes-ofapi-vendor.ts";
// The operator screen's one read (`GET /api/v1/ops/live`), spread by routes.ts.
export * from "./routes-ops-live.ts";
// «Рассылки» kept by Hub (outreach-store-v1), spread by routes.ts.
export * from "./routes-outreach.ts";
// The owner's login of a page's server browser (Project Browser PR 15).
export * from "./routes-page-browser.ts";
// Система → «Сообщения людям»: the server's sender of messages to people, off twice (package S), spread by routes.ts.
export * from "./routes-people-messages.ts";
// The people registry (team list, the owner's card and writes, the agent feed and proposals), spread by routes.ts.
export * from "./routes-people.ts";
export * from "./routes-publication-files.ts";
// Publications: wall posts through Hub (owner + agent drafts), spread by routes.ts.
export * from "./routes-publications.ts";
// Цепочка продажи (package T): from one sale, whose it is down to its payout.
export * from "./routes-sale-chain.ts";
export * from "./routes-sale-claims.ts";
// «Чья продажа» «со слов» through Hub (review R2b-3).
export * from "./routes-sale-decisions.ts";
export * from "./routes-shift-handins.ts";
// «Смены» and «Мои смены»: what stands between a day's shifts and the report it is paid by (`GET /api/v1/shift-report-notes`).
export * from "./routes-shift-report-notes.ts";
// Команда → «Разбор смены» (`GET /api/v1/team/shift-review`), spread by routes.ts.
export * from "./routes-shift-review.ts";
// One sign-in across the names (the one-time code between names), spread by routes.ts.
export * from "./routes-signin.ts";
// Fansly Sync Engine owner routes (history requests), spread by routes.ts.
export * from "./routes-sync.ts";
// Система → «Состояние»: the routines and copies of every place (package P), spread by routes.ts.
export * from "./routes-system-state.ts";
// Выплаты from the agency ledger (`GET /api/v1/team/ledger-payouts`), spread by routes.ts.
export * from "./routes-team-ledger.ts";
export * from "./routes-team-questions.ts";
export * from "./routes-teams.ts";
export * from "./routes-workboard-today.ts";
export * from "./routes.ts";
export * from "./sale-claims.ts";
export * from "./sdk-runtime.ts";
export * from "./shift-report-board.ts";
export * from "./shift-review-audit.ts";
// The shift review's quality numbers, one definition for the review's screen and «Смены» (`teamChatterNumbers`).
export * from "./shift-review-rules.ts";
export * from "./system-state.ts";
export * from "./waiting-groups.ts";
// The narrow web session's route allowlist.
export * from "./web-session-scopes.ts";
// Client-side stop-reason predicate (coach-chat spec §8): surfaced through the
// contracts barrel — the same path that carries shared TYPES to the SDK — so
// out-of-workspace consumers (the extension) can import it from @kernel/sdk and
// apply it to a terminal stop reason before committing/attaching a generation.
export { isOutputExhausted } from "@agency_hub_core/shared";
// The `hub` CLI's dollar flags (`hub cross-spenders --min-source-spend 20`)
// become mills through the money codec, never through a CLI copy of it.
export { millsFromDollars } from "@agency_hub_core/shared";
