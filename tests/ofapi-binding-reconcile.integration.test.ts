import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createModel, createOnlyFansPage, ensurePageSyncStates, findHistoricalPageByOfapiAccountId, getOfapiBindingPage,
  insertObservation, listNotificationIncidents, setPageOfapiAccountId,
} from "@agency_hub_core/db";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCredentialPolicy } from "../apps/runtime/src/services/ofapi-credential-policy.ts";
import { applyOfapiAccountHealthEvent } from "../apps/runtime/src/services/ofapi-account-health.ts";
import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import { runOfapiBindingReconcile } from "../apps/runtime/src/services/ofapi-binding-reconcile.ts";
import { startIntegrationTestDatabase, resetIntegrationDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";

// Decision 382: custody continuity by creator identity. The roster stub
// mirrors the prod capture shape (`ofapi_admin_accounts`, 2026-09-07): one
// `acct_…` per connection, the OnlyFans creator id beside it.

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId: number;
let roster: unknown[];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest();

beforeAll(async () => { testDb = await startIntegrationTestDatabase(); }, 120_000);
afterAll(async () => { await testDb?.stop(); });
afterEach(() => vi.unstubAllGlobals());
beforeEach(async context => {
  if (!testDb) return context.skip();
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb, { ofapiAccountHealthEnabled: true, ofapiBindingReconcileEnabled: true });
  app.config.ofapiExpectedTeamSlug = "expected";
  const model = await createModel(app.db, { slug: "lora", name: "Lora" });
  const page = await createOnlyFansPage(app.db, { modelId: model!.id, label: "lora-of" });
  pageId = page!.id;
  // The prod shape before this decision: a current account, no creator id on the page.
  await setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: "acct_current" });
  roster = [{ id: "acct_current", onlyfans_id: 518588958, onlyfans_username: "loravie", is_authenticated: true }];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/whoami")) return json({ team: { slug: "expected" } });
    if (url.endsWith("/accounts")) return json(roster);
    throw new Error(`Unexpected synthetic request: ${url}`);
  }));
  app.ofapi = createOfapiClient({ apiKey: "synthetic-test-key", restDelayMs: 0, ...ofapiCredentialPolicy(app.db, app.config, app.logger) });
});

const page = () => testDb!.pool.query<{ ofapi_account_id: string | null; ofapi_binding_generation: number; external_page_id: string | null; creator: string | null; ofapi_auth_status: string | null }>(
  "select ofapi_account_id, ofapi_binding_generation, external_page_id, metadata->>'onlyfansUserId' as creator, ofapi_auth_status from pages where id=$1", [pageId],
).then(result => result.rows[0]!);
const bindings = () => testDb!.pool.query<{ account_id: string; page_id: string; creator_id: string | null; generation: number | null; valid_to: Date | null; evidence: Record<string, unknown> }>(
  "select account_id, page_id, creator_id, generation, valid_to, evidence from ofapi_account_bindings order by account_id",
).then(result => result.rows);
const webhook = (account: string, id: number) => insertObservation(app.db, {
  source: "webhook", producer: "ofapi:webhook", platform: "onlyfans", accountId: null, nativeAccountRef: account,
  kind: "messages.received",
  payload: { event: "messages.received", account_id: account, payload: { id, createdAt: "2026-09-10T10:00:00+00:00", fromUser: { id: 900 }, text: "hi", price: 0, isFree: true, mediaCount: 0 } },
  payloadHash: sha256(`${account}:${id}`), idempotencyKey: `evt-${account}-${id}`,
});

describe("OFAPI binding reconcile (Decision 382)", () => {
  it("stays off unless enabled, and the CLI force runs it as a report", async () => {
    app.config.ofapiBindingReconcileEnabled = false;
    expect(await runOfapiBindingReconcile(app)).toMatchObject({ skipped: "disabled", actions: [] });
    const forced = await runOfapiBindingReconcile(app, { dryRun: true, force: true });
    expect(forced.skipped).toBeNull();
    expect(forced.actions).toEqual([expect.objectContaining({ action: "seed_identity", applied: false })]);
    expect((await page()).external_page_id).toBeNull();
  });

  it("seeds the creator id from the roster onto a page and its custody row, once", async () => {
    const first = await runOfapiBindingReconcile(app);
    expect(first).toMatchObject({ skipped: null, pagesChecked: 1, waiting: [], duplicates: [], identityMismatches: [] });
    expect(first.actions).toEqual([expect.objectContaining({ action: "seed_identity", accountId: "acct_current", creatorId: "518588958", applied: true })]);
    expect(first.rosterEvidence?.observationId).toEqual(expect.any(Number));
    expect(await page()).toMatchObject({ external_page_id: "518588958", creator: "518588958", ofapi_account_id: "acct_current" });
    const [current] = await bindings();
    expect(current).toMatchObject({ account_id: "acct_current", creator_id: "518588958" });
    expect(current!.evidence).toMatchObject({ source: "roster_reconcile", decision: 382, action: "seed_identity" });
    // Idempotent: the second run has nothing to do.
    expect((await runOfapiBindingReconcile(app)).actions).toEqual([]);
  });

  it("rebinds a page whose account disappeared from the roster to the creator's new authenticated account", async () => {
    await ensurePageSyncStates(app.db, { pageId });
    await runOfapiBindingReconcile(app);
    await applyOfapiAccountHealthEvent(app, { id: 1, ofapiAccountId: "acct_current", eventType: "accounts.authentication_failed", receivedAt: new Date() });
    expect((await listNotificationIncidents(app.db, { status: "open" })).filter(row => row.kind === "ofapi_auth")).toHaveLength(1);
    const before = (await page()).ofapi_binding_generation;
    await webhook("acct_current", 1);
    // Prod 2026-07-21 / 2026-09-05: the old connection is gone, a new one exists.
    roster = [{ id: "acct_new", onlyfans_id: 518588958, onlyfans_username: "loravie", is_authenticated: true }];
    await webhook("acct_new", 2);

    const run = await runOfapiBindingReconcile(app);
    expect(run.actions).toEqual([expect.objectContaining({ action: "rebind", accountId: "acct_new", previousAccountId: "acct_current", applied: true })]);
    expect(run.waiting).toEqual([]);
    expect(await page()).toMatchObject({ ofapi_account_id: "acct_new", ofapi_binding_generation: before + 1, ofapi_auth_status: null });
    const rows = await bindings();
    expect(rows.map(row => row.account_id)).toEqual(["acct_current", "acct_new"]);
    expect(rows[0]!.valid_to).not.toBeNull();          // retired, custody kept
    expect(rows[1]).toMatchObject({ creator_id: "518588958", generation: before + 1 });
    expect(rows[1]!.evidence).toMatchObject({ source: "roster_reconcile", action: "rebind", previousAccountId: "acct_current" });
    const audit = await testDb!.pool.query("select payload, actor_principal_id from observations where kind='ofapi.binding.replaced'");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.payload).toMatchObject({ source: "roster_reconcile", accountId: "acct_new", expectedAccountId: "acct_current" });
    expect(audit.rows[0]!.actor_principal_id).toBeNull();
    expect((await listNotificationIncidents(app.db, { status: "open" })).filter(row => row.kind === "ofapi_auth")).toHaveLength(0);
    // Both refs now resolve: the sweep replays the old row and the new one to the page.
    const sweep = await runCanonicalization(app);
    expect(sweep).toMatchObject({ appended: 2, skippedUnmapped: 0, unmappedRefs: [], errored: 0, bindingConflicts: [] });
    expect(await findHistoricalPageByOfapiAccountId(app.db, "acct_current")).toMatchObject({ id: pageId });
    expect(await findHistoricalPageByOfapiAccountId(app.db, "acct_new")).toMatchObject({ id: pageId });
    // And the reconciler is quiet afterwards.
    expect((await runOfapiBindingReconcile(app)).actions).toEqual([]);
  });

  it("rebinds when the account is still listed but no longer authenticated", async () => {
    await runOfapiBindingReconcile(app);
    roster = [
      { id: "acct_current", onlyfans_id: 518588958, is_authenticated: false },
      { id: "acct_new", onlyfans_id: 518588958, is_authenticated: true },
    ];
    const run = await runOfapiBindingReconcile(app);
    expect(run.actions).toEqual([expect.objectContaining({ action: "rebind", accountId: "acct_new", applied: true })]);
    expect((await page()).ofapi_account_id).toBe("acct_new");
  });

  it("waits while the dead account has no authenticated replacement, and refuses an ambiguous one", async () => {
    await runOfapiBindingReconcile(app);
    roster = [{ id: "acct_stranger", onlyfans_id: 999, is_authenticated: true }];
    const waiting = await runOfapiBindingReconcile(app);
    expect(waiting.actions).toEqual([]);
    expect(waiting.waiting).toEqual([expect.objectContaining({ pageId, accountId: "acct_current", reason: "no_authenticated_replacement" })]);
    expect(waiting.unownedRosterAccounts).toEqual([expect.objectContaining({ accountId: "acct_stranger", creatorId: "999" })]);
    roster = [
      { id: "acct_a", onlyfans_id: 518588958, is_authenticated: true },
      { id: "acct_b", onlyfans_id: 518588958, is_authenticated: true },
    ];
    const ambiguous = await runOfapiBindingReconcile(app);
    expect(ambiguous.waiting).toEqual([expect.objectContaining({ reason: "ambiguous_replacements" })]);
    expect((await page()).ofapi_account_id).toBe("acct_current");
    // The two candidates are still the creator's: they join custody as history.
    expect(ambiguous.actions.map(action => [action.action, action.accountId, action.applied])).toEqual([
      ["attach_historical", "acct_a", true], ["attach_historical", "acct_b", true],
    ]);
  });

  it("keeps a working binding when the creator was connected twice, attaching the duplicate as history", async () => {
    await runOfapiBindingReconcile(app);
    roster = [
      { id: "acct_current", onlyfans_id: 518588958, is_authenticated: true },
      { id: "acct_dup", onlyfans_id: 518588958, is_authenticated: true },
    ];
    await webhook("acct_dup", 3);
    const run = await runOfapiBindingReconcile(app);
    expect(run.duplicates).toEqual([{ pageId, label: "lora-of", currentAccountId: "acct_current", duplicateAccountId: "acct_dup" }]);
    expect(run.actions).toEqual([expect.objectContaining({ action: "attach_historical", accountId: "acct_dup", applied: true })]);
    expect((await page()).ofapi_account_id).toBe("acct_current");
    const dup = (await bindings()).find(row => row.account_id === "acct_dup");
    expect(dup).toMatchObject({ creator_id: "518588958", generation: null });
    expect(Number(dup!.page_id)).toBe(pageId);
    expect(await runCanonicalization(app)).toMatchObject({ appended: 1, skippedUnmapped: 0 });
  });

  it("never moves custody between pages and leaves a page whose identity disagrees with the roster alone", async () => {
    await runOfapiBindingReconcile(app);
    const other = await createOnlyFansPage(app.db, { modelId: (await createModel(app.db, { slug: "lilly", name: "Lilly" }))!.id, label: "lilly-of" });
    await setPageOfapiAccountId(app.db, { pageId: other!.id, ofapiAccountId: "acct_lilly", creatorId: "777" });
    await testDb!.pool.query("update pages set external_page_id='777' where id=$1", [other!.id]);
    // Lora's account died; the only authenticated account of her creator id is already Lilly's.
    roster = [{ id: "acct_lilly", onlyfans_id: 518588958, is_authenticated: true }];
    const run = await runOfapiBindingReconcile(app);
    expect(run.waiting).toEqual([expect.objectContaining({ pageId, reason: "no_authenticated_replacement" })]);
    expect(run.identityMismatches).toEqual([expect.objectContaining({ pageId: other!.id, pageCreatorId: "777", rosterCreatorId: "518588958" })]);
    expect(run.actions).toEqual([]);
    expect((await page()).ofapi_account_id).toBe("acct_current");
    expect((await getOfapiBindingPage(app.db, other!.id))!.account_id).toBe("acct_lilly");
    // A page with NO identity whose roster creator is another page's: reported, never seeded.
    await testDb!.pool.query("update pages set external_page_id=null, metadata=metadata-'onlyfansUserId' where id=$1", [other!.id]);
    const claimed = await runOfapiBindingReconcile(app);
    expect(claimed.identityMismatches).toEqual([expect.objectContaining({ pageId: other!.id, pageCreatorId: `page:${pageId}`, rosterCreatorId: "518588958" })]);
    expect(claimed.actions).toEqual([]);
    expect((await getOfapiBindingPage(app.db, other!.id))!.creator_id).toBeNull();
  });

  it("reports the reasons it cannot inspect the roster", async () => {
    app.ofapi = undefined;
    expect((await runOfapiBindingReconcile(app)).skipped).toBe("client_unavailable");
    app.config.ofapiExpectedTeamSlug = "someone-else";
    app.ofapi = createOfapiClient({ apiKey: "synthetic-test-key", restDelayMs: 0, ...ofapiCredentialPolicy(app.db, app.config, app.logger) });
    expect((await runOfapiBindingReconcile(app)).skipped).toMatch(/^credential_/);
  });
});
