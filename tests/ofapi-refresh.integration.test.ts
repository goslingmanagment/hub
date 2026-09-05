import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createModel, createOnlyFansPage, ensurePageSyncStates, pausePageSync, findHistoricalPageByOfapiAccountId,
  findPageByOfapiAccountId, getOfapiBindingPage, setPageOfapiAccountId,
  upsertOfapiWebhookConfig, getOfapiWebhookConfig, listNotificationIncidents,
} from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCredentialPolicy } from "../apps/runtime/src/services/ofapi-credential-policy.ts";
import { applyOfapiAccountHealthEvent } from "../apps/runtime/src/services/ofapi-account-health.ts";
import { planErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { refreshOfapiBinding } from "../apps/runtime/src/services/ofapi-binding-refresh.ts";
import { OFAPI_WEBHOOK_EVENTS, registerOfapiWebhook } from "../apps/runtime/src/services/ofapi-webhooks.ts";
import { startIntegrationTestDatabase, resetIntegrationDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId: number;
let generation: number;
let roster: unknown[];
const endpointUrl = "https://hub.test/api/v1/ofapi/webhook";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const remote = { id: "wh_old", url: endpointUrl, events: [...OFAPI_WEBHOOK_EVENTS], enabled: true, account_scope: "global" };

beforeAll(async () => { testDb = await startIntegrationTestDatabase(); }, 120_000);
afterAll(async () => { await testDb?.stop(); });
afterEach(() => vi.unstubAllGlobals());
beforeEach(async context => {
  if (!testDb) return context.skip();
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb, { ofapiAccountHealthEnabled: true });
  app.config.ofapiExpectedTeamSlug = "expected";
  app.config.ofapiWebhookManagementScope = "team";
  const model = await createModel(app.db, { slug: "refresh", name: "Refresh" });
  const page = await createOnlyFansPage(app.db, { modelId: model!.id, label: "refresh-of" });
  pageId = page!.id;
  await setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: "acct_old" });
  generation = (await getOfapiBindingPage(app.db, pageId))!.generation;
  roster = [{ id: "acct_old", onlyfans_id: 123, is_authenticated: true }, { id: "acct_new", onlyfans_id: 123, is_authenticated: true }];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/whoami")) return json({ team: { slug: "expected" } });
    if (url.endsWith("/accounts")) return json(roster);
    if (url.endsWith("/webhooks/wh_old")) return json({ data: remote });
    if (url.endsWith("/webhooks") && init?.method === "POST") return json({ data: { id: "wh_new" } });
    if (url.endsWith("/webhooks")) return json({ data: [] });
    throw new Error("Unexpected synthetic request");
  }));
  app.ofapi = createOfapiClient({ apiKey: "synthetic-test-key", restDelayMs: 0, ...ofapiCredentialPolicy(app.db, app.config, app.logger) });
});
const bindingInput = () => ({ pageId, expectedAccountId: "acct_old", expectedGeneration: generation,
  accountId: "acct_new", identityEvidence: null, historicalEvidence: [], dryRun: true });
const lifecycle = (account: string, event: string, at = new Date()) => applyOfapiAccountHealthEvent(app,
  { id: 1, ofapiAccountId: account, eventType: `accounts.${event}`, receivedAt: at });
async function seedRegistration() {
  await upsertOfapiWebhookConfig(app.db, { externalWebhookId: "wh_old", endpointUrl, accountScope: "global",
    events: [...OFAPI_WEBHOOK_EVENTS], encryptedSigningSecret: JSON.stringify(encryptJson("synthetic-signing", app.config.encryptionKey, 1)) });
}

describe("OFAPI binding custody and recovery", () => {
  it("previews exact replacement, retains attribution, preserves checkpoint and owner pause", async () => {
    await ensurePageSyncStates(app.db, { pageId });
    await testDb!.pool.query("update page_sync_states set status='idle',blocker_kind=null,blocker_code=null where page_id=$1", [pageId]);
    await testDb!.pool.query("update page_sync_states set status='paused',blocker_kind='manual_action_required',blocker_code='operator_pause' where page_id=$1 and stream='posts'", [pageId]);
    await testDb!.pool.query("insert into page_sync_cursors(page_id,stream,state) values($1,'subscribers',$2::jsonb)", [pageId, JSON.stringify({ offset: 77, generation: 9 })]);
    await lifecycle("acct_old", "authentication_failed");
    expect((await listNotificationIncidents(app.db, { status: "open" })).filter(row => row.kind === "ofapi_auth")).toHaveLength(1);
    await pausePageSync(app.db, { pageId, streams: ["subscribers"] });
    const preview = await refreshOfapiBinding(app, bindingInput(), 1);
    expect(preview.recovery.length).toBeGreaterThan(0);
    expect(preview.recovery.some(row => row.stream === "posts" || row.stream === "subscribers")).toBe(false);
    expect((await getOfapiBindingPage(app.db, pageId))!.account_id).toBe("acct_old");
    await refreshOfapiBinding(app, { ...bindingInput(), dryRun: false, previewToken: preview.previewToken }, 1);
    expect((await listNotificationIncidents(app.db, { status: "open" })).filter(row => row.kind === "ofapi_auth")).toHaveLength(0);
    expect((await getOfapiBindingPage(app.db, pageId))!).toMatchObject({ account_id: "acct_new", creator_id: "123", generation: generation + 1 });
    expect(await findPageByOfapiAccountId(app.db, "acct_old")).toBeNull();
    expect(await findHistoricalPageByOfapiAccountId(app.db, "acct_old")).toMatchObject({ id: pageId });
    // Unparsed historical refs are included in page erasure despite account_id NULL.
    await testDb!.pool.query(`insert into observations(source,producer,platform,native_account_ref,kind,payload,payload_hash,idempotency_key)
      values('webhook','ofapi:webhook','onlyfans','acct_old','messages.received','{}'::jsonb,sha256('old-proof'::bytea),'old-proof')`);
    const erasePreview = await planErasure(app, { scopeType: "page", pageLabel: "refresh-of" });
    expect(erasePreview.targets.some(target => target.target === "observations" && target.rows > 0)).toBe(true);
    const checkpoint = await testDb!.pool.query("select state from page_sync_cursors where page_id=$1 and stream='subscribers'", [pageId]);
    expect(checkpoint.rows[0].state).toEqual({ offset: 77, generation: 9 });
    const paused = await testDb!.pool.query("select status,blocker_code from page_sync_states where page_id=$1 and stream='posts'", [pageId]);
    expect(paused.rows[0]).toEqual({ status: "paused", blocker_code: "operator_pause" });
    for (const event of ["connected", "reconnected", "authentication_failed", "otp_code_required", "face_otp_required", "disconnected", "session_expired"]) {
      await lifecycle("acct_old", event, new Date(Date.now() + 60_000));
    }
    const auth = await testDb!.pool.query("select ofapi_auth_status from pages where id=$1", [pageId]);
    expect(auth.rows[0].ofapi_auth_status).toBeNull();
    await expect(refreshOfapiBinding(app, { ...bindingInput(), dryRun: false, previewToken: preview.previewToken }, 1)).rejects.toThrow("changed");
  });
  it("refuses username-only seeds, conflicting identities and a changed blocker preview", async () => {
    roster = [{ id: "acct_new", onlyfans_id: 123, is_authenticated: true, onlyfans_username: "same" }];
    await expect(refreshOfapiBinding(app, bindingInput(), 1)).rejects.toThrow("evidence");
    roster = [{ id: "acct_old", onlyfans_id: 456 }, { id: "acct_new", onlyfans_id: 123, is_authenticated: true }];
    await expect(refreshOfapiBinding(app, bindingInput(), 1)).rejects.toThrow("evidence");
    roster = [{ id: "acct_old", onlyfans_id: 123, is_authenticated: true }, { id: "acct_new", onlyfans_id: 123, is_authenticated: true }];
    await ensurePageSyncStates(app.db, { pageId });
    const preview = await refreshOfapiBinding(app, bindingInput(), 1);
    await lifecycle("acct_old", "authentication_failed");
    await expect(refreshOfapiBinding(app, { ...bindingInput(), dryRun: false, previewToken: preview.previewToken }, 1)).rejects.toThrow("preview changed");
  });
  it("does not release another generation on current-account recovery", async () => {
    await ensurePageSyncStates(app.db, { pageId });
    await testDb!.pool.query("update page_sync_states set status='paused',blocker_kind='auth',blocker_code='ofapi_authentication_failed',blocker_ofapi_generation=$2 where page_id=$1", [pageId, generation - 1]);
    await lifecycle("acct_old", "reconnected");
    const blockers = await testDb!.pool.query("select count(*)::int as n from page_sync_states where page_id=$1 and blocker_kind='auth'", [pageId]);
    expect(blockers.rows[0].n).toBeGreaterThan(0);
  });
});

describe("missing binding read boundary", () => {
  it("captures account_not_found, parks only its generation and prevents further vendor reads", async () => {
    await ensurePageSyncStates(app.db, { pageId });
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: "account_not_found" } }, 404)));
    await expect(app.ofapi!.listActiveFans({ pageId }, "acct_old", { limit: 20 })).rejects.toThrow();
    const firstCount = vi.mocked(fetch).mock.calls.length;
    expect(firstCount).toBe(1);
    await expect(app.ofapi!.listActiveFans({ pageId }, "acct_old", { limit: 20 })).rejects.toThrow("binding unavailable");
    expect(vi.mocked(fetch).mock.calls.length).toBe(firstCount);
    const state = await testDb!.pool.query("select ofapi_auth_status from pages where id=$1", [pageId]);
    expect(state.rows[0].ofapi_auth_status).toBe("account_not_found");
    const captured = await testDb!.pool.query("select count(*)::int as n from observations where kind='ofapi.account.response'");
    expect(captured.rows[0].n).toBe(1);
  });
});

describe("remote webhook verification", () => {
  it("reads remote state before stable noop and never sends a mutation on match", async () => {
    await seedRegistration();
    await registerOfapiWebhook(app, { endpointUrl });
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.some(([url]) => String(url).endsWith("/webhooks/wh_old"))).toBe(true);
    expect(calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
  it.each([401, 403, 500])("never creates after remote inspection status %i", async status => {
    await seedRegistration();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/whoami")
      ? json({ team: { slug: "expected" } }) : json({ error: "denied" }, status)));
    await expect(registerOfapiWebhook(app, { endpointUrl })).rejects.toThrow("absence is unproven");
    expect((await getOfapiWebhookConfig(app.db))!.externalWebhookId).toBe("wh_old");
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
  it("requires full configured visibility for a 404 and retains provenance on confirmed absence", async () => {
    await seedRegistration();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/whoami")) return json({ team: { slug: "expected" } });
      if (url.endsWith("/webhooks/wh_old")) return json({ error: "not_found" }, 404);
      if (url.endsWith("/accounts")) return json(roster);
      if (init?.method === "POST") return json({ data: { id: "wh_new" } });
      return json({ data: [] });
    }));
    app.config.ofapiWebhookManagementScope = "unknown";
    await expect(registerOfapiWebhook(app, { endpointUrl })).rejects.toThrow("absence is unproven");
    app.config.ofapiWebhookManagementScope = "team";
    await registerOfapiWebhook(app, { endpointUrl });
    expect((await getOfapiWebhookConfig(app.db))!.externalWebhookId).toBe("wh_new");
    const history = await testDb!.pool.query("select external_webhook_id,reason from ofapi_webhook_registration_history");
    expect(history.rows).toEqual([{ external_webhook_id: "wh_old", reason: "confirmed_missing" }]);
  });
});
