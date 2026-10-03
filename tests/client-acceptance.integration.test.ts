import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createModel, createOnlyFansPage } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { runAiAcceptanceProjection } from "../apps/runtime/src/services/projections/ai-acceptance.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { issueChatterDeviceToken } from "./helpers/device-credentials.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Fixture passwords hash at minimum cost (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

// H-14a: the chat-extension reports ai_acceptance on the same capture lane as
// the desktop and the Fansly extension, with more fields in the payload (via,
// attemptId, platformMessageId, part, variant, surface). Nothing in the hub
// changes for it: the open payload is journaled verbatim, the projection reads
// generationRef + lifecycle + edited and ignores the rest. Idempotency is per
// (user, clientEventId) at ingest; the projection dedups on its own
// (generation_ref, lifecycle, occurred_at) unique, and books 'edited' only as
// the companion of a 'sent'. The frozen payloads of desktop 0.1.64 and Fansly
// 2.7.1 pin that the old clients still project exactly as before.

const CHAT_EXTENSION = "chat-extension/0.1.0";
const DESKTOP = "0.1.64";
const FANSLY = "chatgoose-extension/2.7.1";
const PAGE = "accept-of";

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let aliceKey = "";
let bobKey = "";
let pageId = 0;

type WireEvent = {
  clientEventId: string;
  kind: string;
  observedAt: string;
  payload: Record<string, unknown>;
  pageLabel?: string;
};

function post(key: string, clientVersion: string, events: WireEvent[]) {
  return server!.inject({
    method: "POST",
    url: "/api/v1/ingest/observations",
    headers: { authorization: `Bearer ${key}`, "x-client-version": clientVersion },
    payload: { events },
  });
}

async function journal() {
  const { rows } = await testDb!.pool.query<{
    id: number; kind: string; producer: string; account_id: number | null;
    actor: number; idempotency_key: string; payload: unknown; observed_at: Date;
  }>(`select id::int, kind, producer, account_id::int, actor_principal_id::int as actor,
             idempotency_key, payload, observed_at
        from observations where source = 'client_capture' order by id`);
  return rows;
}

async function projected(generationRef: string) {
  const { rows } = await testDb!.pool.query<{
    lifecycle: string; user_id: number | null; occurred_at: Date; source_observation_id: number;
  }>(`select lifecycle, user_id::int, occurred_at, source_observation_id::int
        from ai_acceptance_events where generation_ref = $1
       order by occurred_at, lifecycle`, [generationRef]);
  return rows.map((row) => ({ ...row, occurred_at: row.occurred_at.toISOString() }));
}

// The chat-extension's AcceptanceEvent (chat-extension docs/architecture.md §5.7, §9.6).
function extensionEvent(payload: Record<string, unknown>, observedAt: string): WireEvent {
  return { clientEventId: randomUUID(), kind: "ai_acceptance", observedAt, pageLabel: PAGE, payload };
}

function previewSent(generationRef: string) {
  return {
    generationRef, lifecycle: "sent", via: "preview", attemptId: randomUUID(),
    platformMessageId: "4815162342", part: 1, variant: 1, opId: randomUUID(),
    feature: "reply", surface: "preview", edited: true,
  };
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  app = createTestAppContext(testDb);
  server = await buildApiServer(app);
  await server.ready();
}, 120_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb || !server) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  const model = await createModel(app.db, { slug: "accept", name: "Accept" });
  const page = await createOnlyFansPage(app.db, { modelId: model!.id, label: PAGE });
  pageId = page!.id;
  for (const username of ["alice", "bob"]) {
    await createUserAccount(app, { username, role: "chatter" }, { source: "test" });
  }
  aliceKey = (await issueChatterDeviceToken(app, { username: "alice", pageLabel: PAGE }, { source: "test" })).key;
  bobKey = (await issueChatterDeviceToken(app, { username: "bob", pageLabel: PAGE }, { source: "test" })).key;
});

describe("chat-extension ai_acceptance on the capture lane (H-14a)", () => {
  it("journals a preview send verbatim, projects sent + edited, and a resend is a duplicate", async () => {
    const aliceId = await fixtureUserId(app, "alice");
    const generationRef = randomUUID();
    const event = extensionEvent(previewSent(generationRef), "2026-10-03T10:00:00.000Z");

    const first = await post(aliceKey, CHAT_EXTENSION, [event]);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ accepted: 1, duplicates: 0 });
    const [row, ...rest] = await journal();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      kind: "desktop.ai_acceptance",
      producer: "chat-extension@0.1.0",
      account_id: pageId,
      actor: aliceId,
      idempotency_key: `${aliceId}:${event.clientEventId}`,
      payload: event.payload,
    });
    expect(row!.observed_at.toISOString()).toBe(event.observedAt);

    expect(await runAiAcceptanceProjection(app)).toEqual({ scanned: 1, projected: 2, skippedNoRef: 0 });
    const booked = { user_id: aliceId, occurred_at: event.observedAt, source_observation_id: row!.id };
    expect(await projected(generationRef)).toEqual([
      { lifecycle: "edited", ...booked },
      { lifecycle: "sent", ...booked },
    ]);

    const resend = await post(aliceKey, CHAT_EXTENSION, [event]);
    expect(resend.json()).toEqual({ accepted: 0, duplicates: 1 });
    expect(await journal()).toHaveLength(1);
    expect(await runAiAcceptanceProjection(app)).toMatchObject({ scanned: 0, projected: 0 });
    expect(await projected(generationRef)).toHaveLength(2);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keys ingest on (user, clientEventId) and the projection on (generation_ref, lifecycle, occurred_at)", async () => {
    const aliceId = await fixtureUserId(app, "alice");
    const bobId = await fixtureUserId(app, "bob");
    const generationRef = randomUUID();
    const event = extensionEvent(previewSent(generationRef), "2026-10-03T10:00:00.000Z");
    await post(aliceKey, CHAT_EXTENSION, [event]);

    // Same clientEventId from another user is another fact in the journal…
    const fromBob = await post(bobKey, CHAT_EXTENSION, [event]);
    expect(fromBob.json()).toEqual({ accepted: 1, duplicates: 0 });
    expect((await journal()).map((row) => row.idempotency_key)).toEqual([
      `${aliceId}:${event.clientEventId}`,
      `${bobId}:${event.clientEventId}`,
    ]);
    // …and a re-minted clientEventId from the same user is one too.
    const reminted = await post(aliceKey, CHAT_EXTENSION, [{ ...event, clientEventId: randomUUID() }]);
    expect(reminted.json()).toEqual({ accepted: 1, duplicates: 0 });

    // The projection books the (generation_ref, lifecycle, occurred_at) once.
    expect(await runAiAcceptanceProjection(app)).toEqual({ scanned: 3, projected: 2, skippedNoRef: 0 });
    expect((await projected(generationRef)).map((row) => [row.lifecycle, row.user_id])).toEqual([
      ["edited", aliceId],
      ["sent", aliceId],
    ]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("books edited only as the companion of a sent", async () => {
    const generationRef = randomUUID();
    const base = { generationRef, opId: randomUUID(), feature: "reply", surface: "dock" };
    const response = await post(aliceKey, CHAT_EXTENSION, [
      extensionEvent({ ...base, lifecycle: "copied", edited: true }, "2026-10-03T10:00:00.000Z"),
      extensionEvent({ ...base, lifecycle: "inserted", edited: true }, "2026-10-03T10:00:01.000Z"),
      extensionEvent({ ...base, lifecycle: "sent", via: "composer", edited: false }, "2026-10-03T10:00:02.000Z"),
    ]);
    expect(response.json()).toEqual({ accepted: 3, duplicates: 0 });

    expect(await runAiAcceptanceProjection(app)).toEqual({ scanned: 3, projected: 3, skippedNoRef: 0 });
    expect((await projected(generationRef)).map((row) => row.lifecycle)).toEqual(["copied", "inserted", "sent"]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("projects three Split parts sent at different observedAt as three sent rows", async () => {
    const generationRef = randomUUID();
    const opId = randomUUID();
    const parts = [1, 2, 3].map((part) => extensionEvent({
      generationRef, lifecycle: "sent", via: "composer", attemptId: randomUUID(),
      platformMessageId: String(7_000_000_000 + part), part, variant: 1, opId,
      feature: "reply", surface: "dock", edited: false,
    }, `2026-10-03T10:00:0${part}.000Z`));
    expect((await post(aliceKey, CHAT_EXTENSION, parts)).json()).toEqual({ accepted: 3, duplicates: 0 });

    expect(await runAiAcceptanceProjection(app)).toEqual({ scanned: 3, projected: 3, skippedNoRef: 0 });
    expect((await projected(generationRef)).map((row) => [row.lifecycle, row.occurred_at])).toEqual([
      ["sent", "2026-10-03T10:00:01.000Z"],
      ["sent", "2026-10-03T10:00:02.000Z"],
      ["sent", "2026-10-03T10:00:03.000Z"],
    ]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("projects the frozen desktop 0.1.64 and Fansly 2.7.1 payloads as before", async () => {
    const desktopRef = randomUUID();
    const fanslyRef = randomUUID();
    // onlyfans-chat v0.1.64 apps/desktop/src/main/hub/acceptance-reporter.ts
    // toWireEvent: no envelope pageLabel, 'action' not 'lifecycle', requestId
    // doubled as generationRef, absent on the direct lane; edited on sent only.
    const desktop = (action: string, at: string, extra: Record<string, unknown> = {}, ref: string | null = desktopRef) => ({
      clientEventId: randomUUID(), kind: "ai_acceptance", observedAt: at,
      payload: {
        operationId: "9d0f1c2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f",
        ...(ref !== null ? { requestId: ref, generationRef: ref } : {}),
        feature: "fast-reply", action, accountId: "acct_frozen", conversationId: "424242", ...extra,
      },
    });
    // fansly-chat v2.7.1 src/background/acceptance-reporter.ts toWireEvent:
    // pageLabel inside the payload, never 'sent'.
    const fansly = (action: string, at: string) => ({
      clientEventId: randomUUID(), kind: "ai_acceptance", observedAt: at,
      payload: {
        operationId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", requestId: fanslyRef, generationRef: fanslyRef,
        feature: "fast-reply", action, pageLabel: "frozen-fansly", conversationId: "717171",
      },
    });

    expect((await post(aliceKey, DESKTOP, [
      desktop("shown", "2026-10-03T09:00:00.000Z"),
      desktop("inserted", "2026-10-03T09:00:01.000Z"),
      desktop("sent", "2026-10-03T09:00:02.000Z", { edited: true }),
      desktop("shown", "2026-10-03T09:00:03.000Z", {}, null),
    ])).json()).toEqual({ accepted: 4, duplicates: 0 });
    expect((await post(aliceKey, FANSLY, [
      fansly("shown", "2026-10-03T09:00:00.000Z"),
      fansly("copied", "2026-10-03T09:00:01.000Z"),
      fansly("inserted", "2026-10-03T09:00:02.000Z"),
    ])).json()).toEqual({ accepted: 3, duplicates: 0 });

    const rows = await journal();
    expect(new Set(rows.map((row) => `${row.kind} ${row.producer} ${row.account_id}`))).toEqual(new Set([
      "desktop.ai_acceptance desktop@0.1.64 null",
      "desktop.ai_acceptance desktop@chatgoose-extension/2.7.1 null",
    ]));

    expect(await runAiAcceptanceProjection(app)).toEqual({ scanned: 7, projected: 7, skippedNoRef: 1 });
    expect((await projected(desktopRef)).map((row) => row.lifecycle)).toEqual(["shown", "inserted", "edited", "sent"]);
    expect((await projected(fanslyRef)).map((row) => row.lifecycle)).toEqual(["shown", "copied", "inserted"]);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
