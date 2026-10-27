import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clientNoteAttributionsResponseSchema,
  errorResponseSchema,
  type ClientNoteAttributionsResponse,
} from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, createOnlyFansPage, insertAgentKey } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, assignPageToUser, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { executeErasure, planErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { armNoOutboundTrap, type NoOutboundTrap } from "./helpers/no-outbound.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// note-attribution-v1: who wrote each Fansly note, as a route.
//   POST /api/v1/client/pages/:pageLabel/note-attributions   (clientNoteAttributions)
// What the route does on real rows: the writer is the token's person, the first
// report of an event wins, a page that is not the caller's or a platform that
// does not take the source is refused, nothing leaves the process, erasure takes
// a fan's rows and a page's, and the agent reads who wrote a synced note.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const AUDIT = { source: "cli" } as const;
const EXTENSION_VERSION = "chat-extension/3.3.0";
const SOURCE = "fansly-extension";
const AGENT_KEY_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}noteattrib0000000000`;

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["inject"]>>;
type Fact = {
  eventId: string; fanRef: string; noteRef: string; noteKind: string; action: string; origin?: string; fields?: string[];
  observedAt: string;
};

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: ApiServer | null = null;
let trap: NoOutboundTrap | null = null;
let grishaToken = "";
let nikitaToken = "";
let svetaToken = "";
const userIds: Record<"owner" | "grisha" | "nikita" | "sveta", number> = { owner: 0, grisha: 0, nikita: 0, sveta: 0 };
const pageIds: Record<string, number> = {};
let seq = 0;
let noteSeq = 8_100_000_000;
const nextNote = () => String(++noteSeq);
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}`, "x-client-version": EXTENSION_VERSION });

const fact = (over: Partial<Fact> = {}): Fact => ({
  eventId: uuid(),
  fanRef: "518588958",
  noteRef: nextNote(),
  noteKind: "note",
  action: "created",
  origin: "quick",
  observedAt: new Date().toISOString(),
  ...over,
});

function report(token: string, facts: readonly Fact[], options: { pageLabel?: string; source?: string } = {}) {
  return server!.inject({
    method: "POST",
    url: `/api/v1/client/pages/${options.pageLabel ?? "lora-fansly"}/note-attributions`,
    headers: bearer(token),
    payload: { source: options.source ?? SOURCE, facts },
  });
}

function ok(response: InjectResponse): ClientNoteAttributionsResponse {
  expect(response.statusCode, response.body).toBe(200);
  const body = clientNoteAttributionsResponseSchema.parse(response.json());
  expect(response.body).not.toMatch(/grisha|nikita|sveta|userId/i);
  return body;
}

const outcomes = (body: ClientNoteAttributionsResponse) => body.results.map((result) => result.outcome);

function expectRefused(response: InjectResponse, statusCode: number, error: string, reason?: string) {
  expect(response.statusCode, response.body).toBe(statusCode);
  const body = errorResponseSchema.parse(response.json());
  expect(body).toMatchObject({ error, statusCode });
  expect(body.reason, response.body).toBe(reason);
}

const rowsOf = (eventIds: readonly string[]) => testDb!.pool.query<{
  event_id: string; page_id: string; fan_ref: string; note_ref: string; note_kind: string; action: string;
  origin: string | null; fields: string[] | null; user_id: string; source: string; client_version: string | null;
  observation_id: string | null;
}>(
  `select event_id::text, page_id::text, fan_ref, note_ref, note_kind, action, origin, fields, user_id::text, source,
     client_version, observation_id::text
   from client_note_attributions where event_id = any($1::uuid[]) order by observed_at, event_id`,
  [eventIds],
).then((result) => result.rows);

describe("chat-extension note attribution route", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);

    await createUserAccount(app, { username: "owner", role: "owner", password: "owner-secret" }, AUDIT);
    for (const username of ["grisha", "nikita", "sveta"]) {
      await createUserAccount(app, { username, role: "chatter" }, AUDIT);
    }
    for (const username of ["owner", "grisha", "nikita", "sveta"] as const) {
      userIds[username] = await fixtureUserId(app, username);
    }
    const lora = await createModel(app.db, { slug: "lora", name: "Lora" });
    for (const [label, create] of [
      ["lora-fansly", createFanslyPage],
      ["mia-fansly", createFanslyPage],
      ["lora-of", createOnlyFansPage],
    ] as const) {
      pageIds[label] = (await create(app.db, { modelId: lora!.id, label }))!.id;
    }
    for (const [userId, labels] of [
      [userIds.grisha, ["lora-fansly", "lora-of"]],
      [userIds.nikita, ["lora-fansly"]],
      [userIds.sveta, ["mia-fansly"]],
    ] as const) {
      for (const pageLabel of labels) await assignPageToUser(app, { userId, pageLabel }, AUDIT);
    }
    grishaToken = (await issueDeviceTokenForUserId(app, { userId: userIds.grisha, label: "grisha client" })).token;
    nikitaToken = (await issueDeviceTokenForUserId(app, { userId: userIds.nikita, label: "nikita client" })).token;
    svetaToken = (await issueDeviceTokenForUserId(app, { userId: userIds.sveta, label: "sveta client" })).token;
    await insertAgentKey(app.db, {
      name: "note-attribution-probe",
      keyPrefix: AGENT_KEY_TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(AGENT_KEY_TOKEN),
      capabilities: ["read:datasets", "read:messages"],
      pageIds: [pageIds["lora-fansly"]!],
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdBy: null,
    });

    server = await buildApiServer(app);
    await server.ready();
  }, 120_000);

  beforeEach(async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    trap = await armNoOutboundTrap(testDb);
  });

  afterEach(async () => {
    await trap?.restore();
    trap = null;
  });

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("records the token's person for each write: ids, kind, action, origin, field labels, journaled first", async () => {
    const quick = fact();
    const field = fact({ action: "edited", origin: "field", fields: ["Возраст", "Питомцы"] });
    const name = fact({ noteKind: "custom_name", action: "deleted", origin: "name" });
    const unknownOrigin = fact({ origin: "voice" });
    const body = ok(await report(grishaToken, [quick, field, name, unknownOrigin]));
    expect(body.pageLabel).toBe("lora-fansly");
    expect(outcomes(body)).toEqual(["recorded", "recorded", "recorded", "recorded"]);
    const rows = await rowsOf([quick.eventId, field.eventId, name.eventId, unknownOrigin.eventId]);
    expect(rows.map(({ observation_id, ...row }) => ({ ...row, journaled: observation_id !== null }))).toEqual(
      [quick, field, name, unknownOrigin].map((f) => ({
        event_id: f.eventId, page_id: String(pageIds["lora-fansly"]), fan_ref: f.fanRef, note_ref: f.noteRef,
        note_kind: f.noteKind, action: f.action, origin: f === unknownOrigin ? null : f.origin!, fields: f.fields ?? null,
        user_id: String(userIds.grisha), source: SOURCE, client_version: EXTENSION_VERSION, journaled: true,
      })),
    );
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("takes the first report of an event: a repeat is `duplicate`, another person's or another note's is a `conflict`", async () => {
    const first = fact();
    expect(outcomes(ok(await report(grishaToken, [first])))).toEqual(["recorded"]);
    expect(outcomes(ok(await report(grishaToken, [{ ...first, eventId: first.eventId.toUpperCase() }])))).toEqual(["duplicate"]);
    expect(outcomes(ok(await report(nikitaToken, [first])))).toEqual(["conflict"]);
    expect(outcomes(ok(await report(grishaToken, [{ ...first, noteRef: nextNote() }])))).toEqual(["conflict"]);
    // Twice in one report: recorded once.
    const twice = fact();
    expect(outcomes(ok(await report(grishaToken, [twice, twice])))).toEqual(["recorded", "duplicate"]);
    expect((await rowsOf([first.eventId, twice.eventId])).map((row) => row.user_id)).toEqual([String(userIds.grisha), String(userIds.grisha)]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses another person's page, a platform that does not take the source, and an unknown kind or action", async () => {
    // A page not assigned to the caller is refused by the page-scope policy before the route.
    const foreign = await report(svetaToken, [fact()]);
    expect(foreign.statusCode, foreign.body).toBe(403);
    expectRefused(await report(grishaToken, [fact()], { pageLabel: "lora-of" }), 409, "client_feature_disabled", "platform_unsupported");
    const fine = fact();
    expectRefused(await report(grishaToken, [fine, fact({ action: "moved" })]), 400, "bad_request");
    expectRefused(await report(grishaToken, [fine, fact({ noteKind: "post" })]), 400, "bad_request");
    expect(await rowsOf([fine.eventId])).toEqual([]);
    const ahead = fact({ observedAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    expect(outcomes(ok(await report(grishaToken, [ahead])))).toEqual(["out_of_range"]);
    expect(await rowsOf([ahead.eventId])).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("answers the agent who created a synced note and who wrote it last", async () => {
    const fanRef = "718588958";
    const noteRef = nextNote();
    const fan = await testDb!.pool.query<{ id: string }>(
      "insert into fans (platform, platform_user_id) values ('fansly', $1) returning id::text",
      [fanRef],
    );
    await testDb!.pool.query(
      `insert into page_fan_external_notes (platform_account_id, fan_id, provider, external_note_id, content_type, title, body,
         created_at_external, first_seen_at, last_seen_at, is_active)
       values ($1, $2, 'fansly', $3, 12000, 'grisha', 'просил напомнить про второй сет', now(), now(), now(), true)`,
      [pageIds["lora-fansly"], fan.rows[0]!.id, noteRef],
    );
    const created = fact({ fanRef, noteRef, observedAt: new Date(Date.now() - 60_000).toISOString() });
    expect(outcomes(ok(await report(grishaToken, [created])))).toEqual(["recorded"]);
    const edited = fact({ fanRef, noteRef, action: "edited", origin: "editor" });
    expect(outcomes(ok(await report(nikitaToken, [edited])))).toEqual(["recorded"]);
    await trap?.restore();
    trap = null;

    const window = { from: new Date(Date.now() - 24 * 60 * 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() };
    const query = (dataset: string) => server!.inject({
      method: "POST",
      url: `/api/v1/agent/pages/lora-fansly/datasets/${dataset}/query`,
      headers: { authorization: `Bearer ${AGENT_KEY_TOKEN}` },
      payload: window,
    });
    const notes = await query("fan_notes");
    expect(notes.statusCode, notes.body).toBe(200);
    const note = notes.json().items.find((item: { fanPlatformUserId: string | null }) => item.fanPlatformUserId === fanRef);
    expect(note.fields).toMatchObject({ createdBy: "grisha", lastEditedBy: "nikita" });

    const history = await query("note_attributions");
    expect(history.statusCode, history.body).toBe(200);
    const mine = history.json().items.filter((item: { fields: { platformNoteRef: string } }) => item.fields.platformNoteRef === noteRef);
    expect(mine.map((item: { fields: Record<string, unknown> }) => [item.fields.action, item.fields.authorLogin, item.fields.noteRef]))
      .toEqual([["edited", "nikita", note.fields.noteRef], ["created", "grisha", note.fields.noteRef]]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("erases a fan's rows with the fan and a page's with the page, keeping the rest", async () => {
    const fanA = "618588958";
    const a = fact({ fanRef: fanA });
    const b = fact({ fanRef: "618588959" });
    expect(outcomes(ok(await report(grishaToken, [a, b])))).toEqual(["recorded", "recorded"]);
    const mia = fact({ fanRef: fanA });
    expect(outcomes(ok(await report(svetaToken, [mia], { pageLabel: "mia-fansly" })))).toEqual(["recorded"]);
    await trap?.restore();
    trap = null;

    const scope = { scopeType: "fan", platform: "fansly", fanRef: fanA } as const;
    const plan = await planErasure(app, scope);
    expect(plan.targets.find((entry) => entry.target === "client_note_attributions")).toMatchObject({ rows: 2, action: "delete" });
    await executeErasure(app, scope, { initiatedBy: userIds.owner });
    expect((await rowsOf([a.eventId, b.eventId, mia.eventId])).map((row) => row.event_id)).toEqual([b.eventId]);

    await executeErasure(app, { scopeType: "page", pageLabel: "lora-fansly" }, { initiatedBy: userIds.owner });
    expect(await rowsOf([b.eventId])).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
