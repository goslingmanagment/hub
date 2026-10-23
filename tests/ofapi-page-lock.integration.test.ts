import { createHash, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  createOrGetOfapiCommand,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { dispatchOfapiAction, prepareOfapiAction } from "../apps/runtime/src/services/ofapi-actions.ts";
import { executeOfapiCommand } from "../apps/runtime/src/services/ofapi-command-executor.ts";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCredentialPolicy } from "../apps/runtime/src/services/ofapi-credential-policy.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

const ACCOUNT = "acct_11000000000000000000000000000000";
const CONVERSATION = "123456789";
// The page's binding lock and its chat order lock (ofapi-bindings.ts).
const BINDING_LOCK = 9003010;
const ORDER_LOCK = 9003012;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
let ownerId = 0;
let chatterId = 0;

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
  chatterId = (await createUserAccount(app, { username: "chatter", role: "chatter" }, { source: "cli" })).id;
});

async function queueMessage(text: string) {
  const id = randomUUID();
  await createOrGetOfapiCommand(app.db, {
    id, clientCommandId: randomUUID(), pageId, chatterUserId: chatterId, ofapiAccountId: ACCOUNT,
    conversationId: CONVERSATION, kind: "send_text_message_v1", payload: { text }, payloadHash: createHash("sha256").update(text).digest("hex"),
  });
  return id;
}

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
  it.each(["message", "publication"] as const)(
    "sends a message while a publication is in flight; a binding change waits for both (the %s answers first)",
    async (answersFirst) => {
      const publicationResponse = deferred<Response>();
      const publicationSent = deferred<void>();
      const slowMessageResponse = deferred<Response>();
      const slowMessageSent = deferred<void>();
      const sent: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/whoami")) return json({ team: { slug: "agency" } });
        if (path.endsWith(`/${ACCOUNT}/posts`)) {
          publicationSent.resolve();
          return publicationResponse.promise;
        }
        if (path.endsWith(`/${ACCOUNT}/chats/${CONVERSATION}/messages`)) {
          const text = (JSON.parse(String(init?.body)) as { text: string }).text;
          sent.push(text);
          if (text !== "slow") return json({ data: { id: 900000 + sent.length } });
          slowMessageSent.resolve();
          return slowMessageResponse.promise;
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

      // A chatter's message sent after it goes out at once (before this change it waited for the publication).
      const quick = await within(executeOfapiCommand(app, await queueMessage("quick")), 5_000, "the message under a publication in flight");
      expect(quick).toMatchObject({ status: "confirmed" });

      // A second message is in flight too; the page's next message waits for it in the order lock.
      const slow = executeOfapiCommand(app, await queueMessage("slow"));
      await within(slowMessageSent.promise, 5_000, "the slow message request");
      const queued = executeOfapiCommand(app, await queueMessage("queued"));
      await vi.waitFor(async () => expect(await lockWaiters(ORDER_LOCK)).toEqual(["ExclusiveLock"]), { timeout: 5_000 });

      // A binding change waits for both requests in flight.
      let unmapped = false;
      const bindingChange = setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: null }).then(() => { unmapped = true; });
      await vi.waitFor(async () => expect(await lockWaiters(BINDING_LOCK)).toEqual(["ExclusiveLock"]), { timeout: 5_000 });

      const answerMessage = async () => {
        slowMessageResponse.resolve(json({ data: { id: 900099 } }));
        expect(await within(slow, 5_000, "the slow message")).toMatchObject({ status: "confirmed" });
      };
      const answerPublication = async () => {
        publicationResponse.resolve(json({ data: { id: 700001, responseType: "post" } }));
        expect(await within(publication, 10_000, "the publication")).toMatchObject({ state: "confirmed", remoteId: "700001" });
      };
      await (answersFirst === "message" ? answerMessage() : answerPublication());
      // The other request still holds the lock, so the binding change still waits.
      expect(await lockWaiters(BINDING_LOCK)).toContain("ExclusiveLock");
      expect(unmapped).toBe(false);

      await (answersFirst === "message" ? answerPublication() : answerMessage());
      await within(bindingChange, 5_000, "the binding change");
      expect(unmapped).toBe(true);
      const row = await testDb!.pool.query<{ ofapi_account_id: string | null }>("select ofapi_account_id from pages where id = $1", [pageId]);
      expect(row.rows[0]?.ofapi_account_id).toBeNull();

      // The queued message ran after the binding change and was refused: it never went out on the old binding.
      expect(await within(queued, 5_000, "the queued message")).toMatchObject({ status: "failed_terminal" });
      expect(sent).toEqual(["quick", "slow"]);
    },
    60_000,
  );
});
