import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { dispatchOfapiAction, prepareOfapiAction } from "../apps/runtime/src/services/ofapi-actions.ts";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCredentialPolicy } from "../apps/runtime/src/services/ofapi-credential-policy.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

const ACCOUNT = "acct_11000000000000000000000000000000";
// The page's binding lock (ofapi-bindings.ts).
const BINDING_LOCK = 9003010;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
let ownerId = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

afterEach(() => vi.unstubAllGlobals());

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  app.config.ofapiExpectedTeamSlug = "agency";
  const model = await createModel(app.db, { slug: "lora", name: "Lora" });
  const page = await createOnlyFansPage(app.db, { modelId: model.id, label: "lora-of" });
  pageId = page.id;
  await setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: ACCOUNT });
  ownerId = (await createUserAccount(app, { username: "owner", role: "owner", password: "owner-password-for-tests" }, { source: "cli" })).id;
});

/** This page's requests for the two-key advisory lock `(lockClass, pageId)` that Postgres has not granted yet. */
async function lockWaiters(lockClass: number) {
  const result = await testDb!.pool.query<{ mode: string }>(
    `select mode from pg_locks where database = (select oid from pg_database where datname = current_database()) and locktype = 'advisory' and classid = $1 and objid = $2 and objsubid = 2 and not granted order by mode`,
    [lockClass, pageId],
  );
  return result.rows.map((row) => row.mode);
}

async function within<T>(promise: Promise<T>, ms: number, what: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("OFAPI page lock", () => {
  it("a binding change waits for a publication in flight", async () => {
    const publicationResponse = deferred<Response>();
    const publicationSent = deferred<void>();
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/whoami")) return json({ team: { slug: "agency" } });
      if (path.endsWith(`/${ACCOUNT}/posts`)) {
        publicationSent.resolve();
        return publicationResponse.promise;
      }
      throw new Error(`unexpected OFAPI request ${path}`);
    }));
    app.ofapi = createOfapiClient({ apiKey: "synthetic-key", restDelayMs: 0, ...ofapiCredentialPolicy(app.db, app.config, app.logger) });

    // A publication takes the page lock and waits on the slow vendor.
    const prepared = await prepareOfapiAction(app, {
      id: randomUUID(),
      command: { action: "post_create", pageId, text: "saved for later", saveForLater: true, reuseProviderOperation: false },
    }, ownerId);
    const publication = dispatchOfapiAction(app, prepared.id, ownerId);
    await within(publicationSent.promise, 10_000, "the publication request");

    // A binding change waits for the request in flight.
    let unmapped = false;
    const bindingChange = setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: null }).then(() => { unmapped = true; });
    await vi.waitFor(async () => expect(await lockWaiters(BINDING_LOCK)).toEqual(["ExclusiveLock"]), { timeout: 5_000 });
    expect(unmapped).toBe(false);

    publicationResponse.resolve(json({ data: { id: 700001, responseType: "post" } }));
    expect(await within(publication, 10_000, "the publication")).toMatchObject({ state: "confirmed", remoteId: "700001" });
    await within(bindingChange, 5_000, "the binding change");
    expect(unmapped).toBe(true);
    const row = await testDb!.pool.query<{ ofapi_account_id: string | null }>("select ofapi_account_id from pages where id = $1", [pageId]);
    expect(row.rows[0]?.ofapi_account_id).toBeNull();
  }, 60_000);
});
