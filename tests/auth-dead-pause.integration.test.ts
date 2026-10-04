import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  advancePageOfapiAuthStatus,
  createModel,
  createOnlyFansPage,
  createOrGetOfapiCommand,
  ensurePageSyncStates,
  getOfapiCommandById,
  listPageSyncStates,
  listRunnablePageSync,
  requestPageSync,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { applyOfapiAccountHealthEvent } from "../apps/runtime/src/services/ofapi-account-health.ts";
import { executeOfapiCommand } from "../apps/runtime/src/services/ofapi-command-executor.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

const ACCOUNT = "acct_authdead1";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;

async function seedMappedPage(label = "lora-of") {
  const model = await createModel(appContext.db, {
    slug: `model-${label}`,
    name: `Model ${label}`,
  });
  const page = await createOnlyFansPage(appContext.db, { modelId: model.id, label });
  await setPageOfapiAccountId(appContext.db, { pageId: page.id, ofapiAccountId: ACCOUNT });
  await ensurePageSyncStates(appContext.db, { pageId: page.id });
  return page;
}

async function pageStreamStates(pageId: number) {
  const states = await listPageSyncStates(appContext.db, { pageId });
  return states.map((state) => ({
    stream: state.stream,
    status: state.status,
    blockerKind: state.blockerKind,
    blockerCode: state.blockerCode,
  }));
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb, { ofapiAccountHealthEnabled: true } as never);
});

describe("auth-dead pause wiring (Stage 26)", () => {
  it("accounts.authentication_failed parks every page stream and the planner skips it within one cycle", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedMappedPage();
    await requestPageSync(appContext.db, {
      pageId: page.id,
      streams: ["light"],
      source: "manual",
    });
    const runnableBefore = await listRunnablePageSync(appContext.db);
    expect(runnableBefore.map((row) => row.pageId)).toContain(page.id);

    await applyOfapiAccountHealthEvent(appContext, {
      id: 1,
      eventType: "accounts.authentication_failed",
      ofapiAccountId: ACCOUNT,
      receivedAt: new Date("2026-07-06T10:00:00.000Z"),
    });

    const states = await pageStreamStates(page.id);
    expect(states.length).toBeGreaterThan(0);
    const posts = states.find((state) => state.stream === "posts");
    expect(posts).toMatchObject({
      status: "paused",
      blockerKind: null,
      blockerCode: null,
    });
    for (const state of states.filter((candidate) => candidate.stream !== "posts")) {
      expect(state.status, state.stream).toBe("paused");
      expect(state.blockerKind, state.stream).toBe("auth");
      expect(state.blockerCode, state.stream).toBe("ofapi_authentication_failed");
    }

    // The planner's runnable set drops the page immediately.
    const runnableAfter = await listRunnablePageSync(appContext.db);
    expect(runnableAfter.map((row) => row.pageId)).not.toContain(page.id);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a later accounts.connected event releases the auth pause (pending work resumes)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedMappedPage();
    await requestPageSync(appContext.db, {
      pageId: page.id,
      streams: ["light"],
      source: "manual",
    });

    await applyOfapiAccountHealthEvent(appContext, {
      id: 1,
      eventType: "accounts.authentication_failed",
      ofapiAccountId: ACCOUNT,
      receivedAt: new Date("2026-07-06T10:00:00.000Z"),
    });
    await applyOfapiAccountHealthEvent(appContext, {
      id: 2,
      eventType: "accounts.connected",
      ofapiAccountId: ACCOUNT,
      receivedAt: new Date("2026-07-06T11:00:00.000Z"),
    });

    const states = await pageStreamStates(page.id);
    expect(states.find((state) => state.stream === "posts")).toMatchObject({
      status: "paused",
      blockerKind: null,
    });
    for (const state of states.filter((candidate) => candidate.stream !== "posts")) {
      expect(state.status, state.stream).toMatch(/^(idle|pending)$/);
      expect(state.blockerKind, state.stream).toBeNull();
    }
    expect(states.find((state) => state.stream === "light")?.status).toBe("pending");

    const runnable = await listRunnablePageSync(appContext.db);
    expect(runnable.map((row) => row.pageId)).toContain(page.id);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("commands fail fast on an auth-dead page without spending the one attempt", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedMappedPage("lora-of-commands");
    appContext.config.ofapiDesktopCommandExecutionEnabled = true;
    const chatter = await createUserAccount(appContext, {
      username: "chatter",
      role: "chatter",
    }, { source: "cli" } as never);
    if (!chatter) {
      throw new Error("chatter account creation failed");
    }

    await advancePageOfapiAuthStatus(appContext.db, {
      pageId: page.id,
      authStatus: "authentication_failed",
      changedAt: new Date(),
    });

    const sendTextMessage = vi.fn(async () => ({ messageId: "should-not-happen" }));
    appContext.ofapi = { sendTextMessage } as unknown as AppContext["ofapi"];

    const { row } = await createOrGetOfapiCommand(appContext.db, {
      id: randomUUID(),
      clientCommandId: randomUUID(),
      pageId: page.id,
      chatterUserId: chatter.id,
      ofapiAccountId: ACCOUNT,
      conversationId: "1001",
      kind: "send_text_message_v1",
      payload: { text: "must never leave" },
      payloadHash: "a".repeat(64),
    });

    const result = await executeOfapiCommand(appContext, row.id);
    expect(result).toMatchObject({ status: "failed_terminal", commandId: row.id });
    expect(sendTextMessage).not.toHaveBeenCalled();

    const settled = await getOfapiCommandById(appContext.db, { commandId: row.id });
    expect(settled).toMatchObject({
      state: "failed_terminal",
      lastErrorCode: "ofapi_auth_action_required",
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
