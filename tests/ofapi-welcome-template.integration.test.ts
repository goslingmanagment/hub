import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyOfapiCollectionPolicy,
  createModel,
  createOfapiCollectionJob,
  createOnlyFansPage,
  createUser,
  getEffectiveOfapiCollectionPolicy,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCollectionPolicyHooks } from "../apps/runtime/src/services/ofapi-collection-policy.ts";
import { ofapiCollectionHandlers } from "../apps/runtime/src/services/ofapi-collection-handlers.ts";
import { runOfapiCollectionJob, sweepOfapiCollections } from "../apps/runtime/src/services/ofapi-collection-runner.ts";
import { rebuildOfapiReadSnapshotProjection } from "../apps/runtime/src/services/projections/ofapi-read-snapshots.ts";
import { readLatestOfapiWelcomeTemplate } from "../apps/runtime/src/services/ofapi-welcome-template.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let db: StartedTestDatabase;
let app: ReturnType<typeof createTestAppContext>;
let actor: number;
let pageId: number;
let otherPageId: number;

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("DB unavailable");
  db = started;
}, 120000);
afterAll(async () => {
  await db?.stop();
});
afterEach(() => vi.unstubAllGlobals());
beforeEach(async () => {
  await resetIntegrationDatabase(db.pool);
  app = createTestAppContext(db);
  actor = (await createUser(app.db, { username: "owner", role: "owner", passwordHash: "synthetic" }))!.id;
  const model = (await createModel(app.db, { slug: "welcome", name: "Welcome template" }))!;
  pageId = (await createOnlyFansPage(app.db, { modelId: model.id, label: "welcome-page" }))!.id;
  otherPageId = (await createOnlyFansPage(app.db, { modelId: model.id, label: "other-page" }))!.id;
  await setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: "acct_welcome" });
  await db.pool.query(
    "insert into ofapi_credit_state(id,last_balance,last_balance_at) values(1,10000,now()) on conflict(id) do update set last_balance=10000,last_balance_at=now()",
  );
  app.ofapi = createOfapiClient({ apiKey: "synthetic", restDelayMs: 0, ...ofapiCollectionPolicyHooks(app.db) });
});

const template = (overrides: Record<string, unknown> = {}) => ({
  id: "42",
  template: "reply_on_subscribe",
  text: "<p>Welcome!</p>",
  price: 5,
  lockedText: false,
  mediaCount: 1,
  media: [{ id: 7, type: "photo", canView: true }],
  createdAt: "2026-10-01T10:00:00+00:00",
  isActive: true,
  ...overrides,
});
const response = (data: unknown) =>
  new Response(JSON.stringify({ data, _meta: { _credits: { used: 1, balance: 9999 } } }));

describe("account_settings collects the welcome template as a stored snapshot", () => {
  it("stays off until the owner schedules it, then reads one template per interval into mills", async () => {
    const fetch = vi.fn(async () => response(template()));
    vi.stubGlobal("fetch", fetch);
    const send = vi.fn(async () => null);
    const boss = { send } as unknown as Parameters<typeof sweepOfapiCollections>[1];

    expect(await getEffectiveOfapiCollectionPolicy(app.db, "account_settings", pageId))
      .toMatchObject({ mode: "off", source: "default_off" });
    await sweepOfapiCollections(app, boss, ofapiCollectionHandlers);
    expect(send).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(await readLatestOfapiWelcomeTemplate(app.db, pageId)).toBeNull();

    // The owner's flip: one page, daily, one call and one credit.
    await applyOfapiCollectionPolicy(app.db, { expectedRevision: 0, changes: [{
      pageId, category: "account_settings", mode: "scheduled", intervalMinutes: 1440,
      dailyCreditLimit: 1, maxCallsPerRun: 1, includeDetails: false,
    }] }, actor);
    await sweepOfapiCollections(app, boss, ofapiCollectionHandlers);
    expect(send).toHaveBeenCalledTimes(1);
    const { jobId } = (send.mock.calls[0] as unknown as [string, { jobId: string }])[1];
    expect(await runOfapiCollectionJob(app, jobId, ofapiCollectionHandlers)).toEqual({ state: "completed" });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string | URL, RequestInit | undefined];
    expect(new URL(String(url)).pathname).toBe("/api/acct_welcome/settings/welcome-message");
    expect(new URL(String(url)).search).toBe("");
    expect(init?.method ?? "GET").toBe("GET");
    const accounting = await db.pool.query("select category,purpose,reserved_credits::int reserved_credits from ofapi_collection_requests");
    expect(accounting.rows).toEqual([{ category: "account_settings", purpose: "background", reserved_credits: 1 }]);

    const latest = await readLatestOfapiWelcomeTemplate(app.db, pageId);
    expect(latest).toEqual({
      ref: "42", observedAt: expect.any(String), enabled: true, hasText: true, hasMedia: true,
      // $5 on the wire is 5000 mills.
      priceMills: 5000,
    });
    expect(await readLatestOfapiWelcomeTemplate(app.db, otherPageId)).toBeNull();

    // The facts live in the canonical event: a projection rebuild keeps them without a vendor call.
    await rebuildOfapiReadSnapshotProjection(app, { accountId: pageId });
    expect(await readLatestOfapiWelcomeTemplate(app.db, pageId)).toEqual(latest);

    // Inside the 1440-minute interval the sweep schedules nothing new.
    send.mockClear();
    await sweepOfapiCollections(app, boss, ofapiCollectionHandlers);
    expect(send).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("serves the newest snapshot after the owner changes the template", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(template({ price: 0, isActive: false })))
      .mockResolvedValueOnce(response(template({ id: "43", text: "<p></p>", mediaCount: 0, media: [], price: 0 })));
    vi.stubGlobal("fetch", fetch);
    for (let run = 0; run < 2; run++) {
      const approved = await createOfapiCollectionJob(app.db, {
        pageId, category: "account_settings", expectedRevision: 0, maxCalls: 1, maxCredits: 1,
        maxBytes: 1_000_000, from: null, to: null, selection: ["welcome_message"],
      }, actor);
      expect(await runOfapiCollectionJob(app, approved.id, ofapiCollectionHandlers)).toEqual({ state: "completed" });
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await readLatestOfapiWelcomeTemplate(app.db, pageId)).toMatchObject({
      ref: "43", enabled: true, hasText: false, hasMedia: false, priceMills: 0,
    });
  });
});
