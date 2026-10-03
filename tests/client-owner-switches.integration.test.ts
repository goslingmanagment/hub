import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_FEATURE_FLAG_NAMES,
  clientBootstrapResponseSchema,
  errorResponseSchema,
  type ClientBootstrapResponse,
  type ClientFeatureFlagName,
} from "@agency_hub_core/contracts";
import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  deletePageByLabel,
  getConfigOverrides,
  listConfigAudit,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  assignPageToUser,
  authenticateDeviceToken,
  createUserAccount,
  setUserPassword,
} from "../apps/runtime/src/services/auth.ts";
import { requireClientFeature } from "../apps/runtime/src/services/client-switches.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { armNoOutboundTrap, type NoOutboundTrap } from "./helpers/no-outbound.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const PASSWORDS = { owner: "owner-secret", chatter: "chatter-secret" } as const;
const AUDIT = { source: "cli" } as const;
/**
 * A test-only probe of the server-side check, outside /api so it needs no
 * contract entry: no route behind a flag exists before the routes that need
 * one. It runs requireClientFeature exactly as a client route will, and the
 * real error handler serializes the refusal.
 */
const PROBE_URL = "/test-only/client-feature";

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: ApiServer | null = null;
let trap: NoOutboundTrap | null = null;
let ownerCookie = "";
let ownerToken = "";
let chatterToken = "";
let ownerId = 0;
const pageIds: Record<string, number> = {};

const PROFILE = { id: "om-2026-10", adapterVersion: "1.0.0", modules: { send: "sha256:ab12", receipt: "sha256:cd34" } };

async function bootstrapAs(token: string, headers: Record<string, string> = {}): Promise<ClientBootstrapResponse> {
  const response = await server!.inject({
    method: "GET",
    url: "/api/v1/client/bootstrap",
    headers: { authorization: `Bearer ${token}`, ...headers },
  });
  expect(response.statusCode, response.body).toBe(200);
  return clientBootstrapResponseSchema.parse(response.json());
}

async function patchConfig(patches: Array<{ key: string; value: unknown }>, note?: string) {
  return server!.inject({
    method: "PATCH",
    url: "/api/v1/admin/config",
    headers: { cookie: ownerCookie },
    payload: { patches, ...(note ? { note } : {}) },
  });
}

async function patchOk(patches: Array<{ key: string; value: unknown }>, note?: string) {
  const response = await patchConfig(patches, note);
  expect(response.statusCode, response.body).toBe(200);
}

async function probe(token: string, pageLabel: string, flag: ClientFeatureFlagName, clientVersion?: string) {
  return server!.inject({
    method: "GET",
    url: `${PROBE_URL}/${pageLabel}/${flag}`,
    headers: {
      authorization: `Bearer ${token}`,
      ...(clientVersion === undefined ? {} : { "x-client-version": clientVersion }),
    },
  });
}

async function expectRefused(
  response: Awaited<ReturnType<typeof probe>>,
  reason: string,
) {
  expect(response.statusCode, response.body).toBe(409);
  const body = errorResponseSchema.parse(response.json());
  expect(body).toMatchObject({ error: "client_feature_disabled", statusCode: 409, reason });
}

async function chatExtensionAuditIds(): Promise<number[]> {
  const rows = await testDb!.pool.query<{ id: string }>(
    `select id from config_audit_log where key like 'chatExtension%' order by id`,
  );
  return rows.rows.map((row) => Number(row.id));
}

const everyFeature = (reason: string) => Object.fromEntries(
  CLIENT_FEATURE_FLAG_NAMES.map((flag) => [flag, { available: false, reason }]),
);

describe("owner switches of the chat extension", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, 120_000);

  beforeEach(async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await resetIntegrationDatabase(testDb.pool);
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "owner", role: "owner", password: PASSWORDS.owner }, AUDIT);
    await createUserAccount(app, { username: "chatter", role: "chatter" }, AUDIT);
    ownerId = await fixtureUserId(app, "owner");
    const chatterId = await fixtureUserId(app, "chatter");
    await setUserPassword(app, { userId: chatterId, password: PASSWORDS.chatter }, AUDIT);

    const lora = await createModel(app.db, { slug: "lora", name: "Lora" });
    const mia = await createModel(app.db, { slug: "mia", name: "Mia" });
    for (const [label, modelId, create] of [
      ["lora-of", lora!.id, createOnlyFansPage],
      ["lora-vip-of", lora!.id, createOnlyFansPage],
      ["lora-fansly", lora!.id, createFanslyPage],
      ["lora-old-of", lora!.id, createOnlyFansPage],
      // An OnlyFans page whose platform account id the hub does not know.
      ["nova-of", lora!.id, createOnlyFansPage],
      ["mia-of", mia!.id, createOnlyFansPage],
    ] as const) {
      const page = await create(app.db, { modelId, label });
      pageIds[label] = page!.id;
    }
    for (const [label, externalId] of [
      ["lora-of", "100000001"],
      ["lora-vip-of", "100000002"],
      ["lora-old-of", "100000004"],
      ["mia-of", "100000003"],
    ] as const) {
      await testDb.pool.query(`update pages set external_page_id = $2 where id = $1`, [pageIds[label], externalId]);
    }
    for (const label of ["lora-of", "lora-fansly", "lora-old-of", "nova-of"]) {
      await assignPageToUser(app, { userId: chatterId, pageLabel: label }, AUDIT);
    }
    await deletePageByLabel(app.db, "lora-old-of");

    ownerToken = (await issueDeviceTokenForUserId(app, { userId: ownerId, label: "owner client" })).token;
    chatterToken = (await issueDeviceTokenForUserId(app, { userId: chatterId, label: "chatter client" })).token;

    server = await buildApiServer(app);
    server.get(`${PROBE_URL}/:pageLabel/:flag`, async (request) => {
      const { pageLabel, flag } = request.params as { pageLabel: string; flag: ClientFeatureFlagName };
      const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
      const { principal } = await authenticateDeviceToken(app, token);
      if (!principal) {
        throw new Error("probe: the test token did not authenticate");
      }
      // A label that names no page resolves to an id no page has.
      const row = await requireClientFeature(app, request, principal, { id: pageIds[pageLabel] ?? 2_000_000_000 }, flag);
      return { pageLabel: row.label };
    });
    await server.ready();

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "owner", password: PASSWORDS.owner },
    });
    expect(login.statusCode, login.body).toBe(200);
    const header = login.headers["set-cookie"];
    ownerCookie = (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
    trap = await armNoOutboundTrap(testDb);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await trap?.restore();
    trap = null;
    await server?.close();
    server = null;
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it("an owner's PATCH moves the bootstrap: revision, flags, features, bindings, profiles, every change audited", async (context) => {
    if (!server) return context.skip();

    // At rest, and an unrelated setting does not move the revision.
    await patchOk([{ key: "transactionLookbackDays", value: 14 }]);
    const atRest = await bootstrapAs(chatterToken);
    expect(atRest.configRevision).toBe(0);
    expect(atRest.minVersion).toBe("0.0.0");
    expect(atRest.bindingsByHost).toEqual({});
    expect(atRest.pages.find((page) => page.pageLabel === "lora-of")?.features).toEqual(everyFeature("disabled"));

    const switches = {
      chatExtensionEnabled: true,
      chatExtensionFeatures: JSON.stringify({
        "*": { coach: true, recap: true, someFutureFlag: true },
        "lora-of": { coach: false, review: true },
      }),
      chatExtensionMinVersion: "1.2.0",
      chatExtensionHostBindings: JSON.stringify({
        "onlymonster:36409": "lora-of",
        // Not granted to the chatter: only the owner's bootstrap carries it.
        "onlymonster:36408": "lora-vip-of",
        // Assigned to the chatter but tombstoned, and a page that never existed.
        "onlymonster:1": "lora-old-of",
        "onlymonster:2": "ghost-of",
        // The chatter's own page, but an OnlyMonster account is an OnlyFans account.
        "onlymonster:3": "lora-fansly",
      }),
      chatExtensionPreviewSendReceiptProfiles: JSON.stringify([PROFILE]),
    };
    await patchOk(Object.entries(switches).map(([key, value]) => ({ key, value })), "pilot on lora-of");

    // One audit row per switch, by the owner, in one group.
    const auditRows = await Promise.all(Object.keys(switches).map(async (key) => {
      const rows = await listConfigAudit(app.db, { key });
      expect(rows, key).toHaveLength(1);
      return rows[0]!;
    }));
    expect(new Set(auditRows.map((row) => row.groupId)).size).toBe(1);
    for (const row of auditRows) {
      expect(row.userId, row.key).toBe(ownerId);
      expect(row.newValue, row.key).toEqual(switches[row.key as keyof typeof switches]);
      expect(row.note, row.key).toBe("pilot on lora-of");
    }
    const firstRevision = Math.max(...auditRows.map((row) => row.id));

    const chatter = await bootstrapAs(chatterToken);
    expect(chatter.configRevision).toBe(firstRevision);
    expect(chatter.minVersion).toBe("1.2.0");
    expect(chatter.flags).toEqual(Object.fromEntries(CLIENT_FEATURE_FLAG_NAMES.map((flag) => [flag, flag === "coach" || flag === "recap"])));
    expect(chatter.bindingsByHost).toEqual({ "onlymonster:36409": pageIds["lora-of"] });
    expect(chatter.limits.previewSendReceiptProfiles).toEqual([PROFILE]);
    const features = Object.fromEntries(chatter.pages.map((page) => [page.pageLabel, page.features]));
    expect(Object.keys(features)).toEqual(["lora-fansly", "lora-of", "nova-of"]);
    expect(features["lora-of"]).toMatchObject({
      coach: { available: false, reason: "flag_off" },
      review: { available: true },
      // The owner switched it on, but this hub does not serve recaps yet.
      recap: { available: false, reason: "hub_not_ready" },
      preview: { available: false, reason: "flag_off" },
    });
    expect(features["lora-fansly"]).toEqual(everyFeature("platform_unsupported"));
    expect(features["nova-of"]).toMatchObject({ coach: { available: false, reason: "binding_missing" } });

    const owner = await bootstrapAs(ownerToken);
    expect(owner.configRevision).toBe(firstRevision);
    expect(owner.bindingsByHost).toEqual({
      "onlymonster:36409": pageIds["lora-of"],
      "onlymonster:36408": pageIds["lora-vip-of"],
    });

    // An explicit binding makes the page without a platform account id usable.
    await patchOk([{
      key: "chatExtensionHostBindings",
      value: JSON.stringify({ "onlymonster:36409": "lora-of", "onlymonster:36410": "nova-of" }),
    }]);
    const bound = await bootstrapAs(chatterToken);
    expect(bound.configRevision).toBeGreaterThan(firstRevision);
    expect(bound.bindingsByHost).toEqual({
      "onlymonster:36409": pageIds["lora-of"],
      "onlymonster:36410": pageIds["nova-of"],
    });
    expect(bound.pages.find((page) => page.pageLabel === "nova-of")?.features.coach).toEqual({ available: true });

    // The master switch turns every feature and flag off at once.
    await patchOk([{ key: "chatExtensionEnabled", value: false }]);
    const off = await bootstrapAs(chatterToken);
    expect(off.configRevision).toBeGreaterThan(bound.configRevision);
    expect(Object.values(off.flags).every((on) => on === false)).toBe(true);
    expect(off.pages.find((page) => page.pageLabel === "lora-of")?.features).toEqual(everyFeature("disabled"));

    // Clearing an override restarts its config_settings version at 1; the
    // revision still grows, because it is an audit id.
    const cleared = await server.inject({
      method: "DELETE",
      url: "/api/v1/admin/config/chatExtensionMinVersion",
      headers: { cookie: ownerCookie },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    const afterClear = await bootstrapAs(chatterToken);
    expect(afterClear.configRevision).toBeGreaterThan(off.configRevision);
    expect(afterClear.minVersion).toBe("0.0.0");
    expect(afterClear.configRevision).toBe(Math.max(...await chatExtensionAuditIds()));

    await trap!.assertNoOutbound();
  });

  it("the write refuses broken JSON and a bad version, and stores and audits nothing", async (context) => {
    if (!server || !testDb) return context.skip();

    const refusals: Array<[Array<{ key: string; value: unknown }>, RegExp]> = [
      [[{ key: "chatExtensionFeatures", value: "{\"*\": {\"coach\": true}" }], /chatExtensionFeatures: the value is not valid JSON/],
      [[{ key: "chatExtensionFeatures", value: "{\"*\": {\"coach\": \"on\"}}" }], /must be true or false/],
      [[{ key: "chatExtensionHostBindings", value: "{\"onlymonster:36409\": 8}" }], /page label/],
      [[{ key: "chatExtensionPreviewSendReceiptProfiles", value: "{}" }], /must be a JSON array/],
      // One bad value refuses the whole patch: the master switch is not stored either.
      [[
        { key: "chatExtensionEnabled", value: true },
        { key: "chatExtensionMinVersion", value: "1.2" },
      ], /chatExtensionMinVersion: the value must read MAJOR\.MINOR\.PATCH/],
    ];
    for (const [patches, message] of refusals) {
      const response = await patchConfig(patches);
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().message).toMatch(message);
    }

    const overrides = await getConfigOverrides(app.db);
    expect([...overrides.keys()].filter((key) => key.startsWith("chatExtension"))).toEqual([]);
    expect(await chatExtensionAuditIds()).toEqual([]);
    const body = await bootstrapAs(chatterToken);
    expect(body.configRevision).toBe(0);
    expect(body.pages.find((page) => page.pageLabel === "lora-of")?.features).toEqual(everyFeature("disabled"));

    await trap!.assertNoOutbound();
  });

  it("requireClientFeature: the hub's own check of grant, switches, binding and version (critic 6)", async (context) => {
    if (!server) return context.skip();

    await patchOk([
      { key: "chatExtensionEnabled", value: true },
      { key: "chatExtensionFeatures", value: JSON.stringify({ "*": { coach: true, recap: true } }) },
      { key: "chatExtensionMinVersion", value: "1.2.0" },
    ]);

    const allowed = await probe(chatterToken, "lora-of", "coach", "chat-extension/1.2.0");
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.json()).toEqual({ pageLabel: "lora-of" });
    expect((await probe(chatterToken, "lora-of", "coach", "chat-extension/1.10.3")).statusCode).toBe(200);
    expect((await probe(ownerToken, "mia-of", "coach", "chat-extension/1.2.0")).statusCode).toBe(200);

    // Below the minimum, or a version the hub cannot read: refused, never passed.
    for (const version of ["chat-extension/1.1.9", undefined, "chatgoose-extension/2.7.1", "chat-extension/1.2"]) {
      await expectRefused(await probe(chatterToken, "lora-of", "coach", version), "client_outdated");
    }
    // The bootstrap is never refused for the version: it is how the client learns the minimum.
    expect((await bootstrapAs(chatterToken, { "x-client-version": "chat-extension/0.0.1" })).minVersion).toBe("1.2.0");

    const current = "chat-extension/1.2.0";
    // Not the caller's page, a tombstone, and a page that does not exist read the same.
    await expectRefused(await probe(chatterToken, "mia-of", "coach", current), "not_granted");
    await expectRefused(await probe(chatterToken, "lora-old-of", "coach", current), "not_granted");
    await expectRefused(await probe(chatterToken, "ghost-of", "coach", current), "not_granted");
    await expectRefused(await probe(chatterToken, "lora-fansly", "coach", current), "platform_unsupported");
    await expectRefused(await probe(chatterToken, "lora-of", "review", current), "flag_off");
    await expectRefused(await probe(chatterToken, "nova-of", "coach", current), "binding_missing");
    await expectRefused(await probe(chatterToken, "lora-of", "recap", current), "hub_not_ready");
    // The feature check answers before the version check.
    await expectRefused(await probe(chatterToken, "lora-of", "review", "chat-extension/0.0.1"), "flag_off");

    // No cache: the owner's off holds from the very next request.
    await patchOk([{ key: "chatExtensionEnabled", value: false }]);
    await expectRefused(await probe(chatterToken, "lora-of", "coach", current), "disabled");
    await patchOk([{ key: "chatExtensionEnabled", value: true }]);
    expect((await probe(chatterToken, "lora-of", "coach", current)).statusCode).toBe(200);
    await patchOk([{ key: "chatExtensionFeatures", value: JSON.stringify({ "*": { coach: true }, "lora-of": { coach: false } }) }]);
    await expectRefused(await probe(chatterToken, "lora-of", "coach", current), "flag_off");

    await trap!.assertNoOutbound();
  });

  it("a stored override that no longer validates turns the extension off and is logged once", async (context) => {
    if (!server || !testDb) return context.skip();

    await patchOk([
      { key: "chatExtensionEnabled", value: true },
      { key: "chatExtensionFeatures", value: JSON.stringify({ "*": { coach: true } }) },
      { key: "chatExtensionMinVersion", value: "1.2.0" },
    ]);
    expect((await probe(chatterToken, "lora-of", "coach", "chat-extension/1.2.0")).statusCode).toBe(200);
    await expectRefused(await probe(chatterToken, "lora-of", "coach", "chat-extension/1.1.0"), "client_outdated");

    // Past the write check: a hand-made SQL fix (or a parser a later PR makes
    // stricter). The live overlay skips the row, so the environment's 0.0.0
    // would admit every outdated client again; instead everything goes off.
    const errors = vi.spyOn(app.logger!, "error");
    const updated = await testDb.pool.query(
      `update config_settings set value = '"1.4"'::jsonb where key = 'chatExtensionMinVersion'`,
    );
    expect(updated.rowCount).toBe(1);

    for (let request = 0; request < 2; request += 1) {
      const body = await bootstrapAs(chatterToken);
      expect(Object.values(body.flags).every((on) => on === false)).toBe(true);
      expect(body.minVersion).toBe("0.0.0");
      expect(body.pages.find((page) => page.pageLabel === "lora-of")?.features).toEqual(everyFeature("disabled"));
      for (const version of ["chat-extension/1.2.0", "chat-extension/1.1.0"]) {
        await expectRefused(await probe(chatterToken, "lora-of", "coach", version), "disabled");
      }
    }
    const logged = errors.mock.calls.filter(([, message]) => typeof message === "string" && message.startsWith("chat-extension switch unreadable"));
    expect(logged).toHaveLength(1);
    expect(logged[0]![0]).toMatchObject({
      key: "chatExtensionMinVersion",
      error: expect.stringMatching(/^the stored override is refused: /),
    });

    // The owner's next valid write puts the extension back.
    await patchOk([{ key: "chatExtensionMinVersion", value: "1.2.0" }]);
    expect((await probe(chatterToken, "lora-of", "coach", "chat-extension/1.2.0")).statusCode).toBe(200);

    await trap!.assertNoOutbound();
  });

  it("a broken environment value turns the extension off and is logged once", async (context) => {
    if (!server) return context.skip();

    const errors = vi.spyOn(app.logger!, "error");
    app.config.chatExtensionEnabled = true;
    app.config.chatExtensionFeatures = "{\"*\": {\"coach\": true}";

    for (let request = 0; request < 2; request += 1) {
      const body = await bootstrapAs(chatterToken);
      expect(body.flags.coach).toBe(false);
      expect(body.pages.find((page) => page.pageLabel === "lora-of")?.features).toEqual(everyFeature("disabled"));
      await expectRefused(await probe(chatterToken, "lora-of", "coach", "chat-extension/1.0.0"), "disabled");
    }
    const logged = errors.mock.calls.filter(([, message]) => typeof message === "string" && message.startsWith("chat-extension switch unreadable"));
    expect(logged).toHaveLength(1);
    expect(logged[0]![0]).toMatchObject({ key: "chatExtensionFeatures" });

    await trap!.assertNoOutbound();
  });
});
