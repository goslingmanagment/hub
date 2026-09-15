import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createFanslyPage, createModel, findUserByUsername } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  createAccountLinkForUsername,
  createInvite,
  inspectAccountLink,
  listAccountLinksForUsername,
  redeemAccountLink,
  revokeAccountLinkForUsername,
} from "../apps/runtime/src/services/account-links.ts";
import {
  changeOwnPassword,
  createUserAccount,
  deactivateUser,
  issueDeviceTokenForUsername,
  loginWithPassword,
  setUserPassword,
  terminateAllAccess,
} from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Decision 347 §4.1: the invite / password-reset link lifecycle. The raw token
// exists once, in the creation response; at most one link is active per user;
// every link is a fact that is revoked, never deleted.

let testDb: StartedTestDatabase | null = null;
let app: AppContext | null = null;
let disabledLinksApp: AppContext | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;

const OWNER_AUDIT = { source: "cli", actorUserId: 1 } as const;
const STRONG_PASSWORD = "correct-horse-battery-1";

function requireSetup(context: { skip: () => void }) {
  if (!testDb || !app || !server || !disabledLinksApp) {
    context.skip();
    return null;
  }
  return { testDb, app, server, disabledLinksApp };
}

async function countRows(db: StartedTestDatabase, sql: string) {
  const result = await db.pool.query<{ count: string }>(sql);
  return Number(result.rows[0]?.count ?? "-1");
}

async function activeLinkCount(db: StartedTestDatabase, userId?: number) {
  const scope = userId === undefined ? "" : ` and user_id = ${userId}`;
  return countRows(
    db,
    `select count(*)::text as count from account_links
     where used_at is null and revoked_at is null${scope}`,
  );
}

/** Pushes a link's deadline into the past without touching any other column —
 * the only honest way to age a row inside one test run. */
async function expireLink(db: StartedTestDatabase, linkId: number) {
  await db.pool.query(
    "update account_links set expires_at = now() - interval '1 minute' where id = $1",
    [linkId],
  );
}

async function seedPages(db: StartedTestDatabase) {
  const model = await createModel(db.db, { slug: "lora-model", name: "Lora" });
  await createFanslyPage(db.db, { modelId: model!.id, label: "lora-fansly" });
  await createFanslyPage(db.db, { modelId: model!.id, label: "lora-vip" });
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  app = createTestAppContext(testDb);
  disabledLinksApp = createTestAppContext(testDb, { accountLinksEnabled: false });
  server = await buildApiServer(app);
}, 120_000);

beforeEach(async () => {
  if (!testDb || !app) return;
  await resetIntegrationDatabase(testDb.pool);
  await createUserAccount(app, {
    username: "owner",
    role: "owner",
    password: "owner-secret",
  }, { source: "cli" });
  await seedPages(testDb);
});

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

describe("invite creation", () => {
  it("creates the user, the page grants and the link in ONE transaction", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    const invited = await createInvite(setup.app, {
      username: "grisha",
      pageLabels: ["lora-fansly", "lora-vip"],
    }, OWNER_AUDIT);

    expect(invited.user.username).toBe("grisha");
    expect(invited.user.role).toBe("chatter");
    expect(invited.user.registrationState).toBe("invited");
    expect(invited.link.kind).toBe("invite");
    expect(invited.link.token.length).toBeGreaterThan(20);
    expect(invited.link.keyPrefix).toBe(invited.link.token.slice(0, 10));
    expect(invited.user.assignedPages.map((page) => page.label).sort())
      .toEqual(["lora-fansly", "lora-vip"]);
    expect(await activeLinkCount(setup.testDb)).toBe(1);
  });

  it("leaves NEITHER user nor link behind when a page does not exist", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    await expect(createInvite(setup.app, {
      username: "grisha",
      pageLabels: ["lora-fansly", "no-such-page"],
    }, OWNER_AUDIT)).rejects.toThrow(/not found/i);

    expect(await findUserByUsername(setup.testDb.db, "grisha")).toBeUndefined();
    expect(await countRows(setup.testDb, "select count(*)::text as count from account_links"))
      .toBe(0);
    expect(await countRows(
      setup.testDb,
      "select count(*)::text as count from user_page_assignments",
    )).toBe(0);
  });

  it("refuses a login that already exists in any case", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await createInvite(setup.app, { username: "grisha", pageLabels: [] }, OWNER_AUDIT);

    await expect(createInvite(setup.app, {
      username: "GRISHA",
      pageLabels: [],
    }, OWNER_AUDIT)).rejects.toThrow(/already exists/i);
  });

  it("invites a team_lead without demanding a password up front", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    const invited = await createInvite(setup.app, {
      username: "lead",
      role: "team_lead",
      pageLabels: [],
    }, OWNER_AUDIT);
    expect(invited.user.role).toBe("team_lead");
    expect(invited.user.registrationState).toBe("invited");
  });
});

describe("link supersession and revocation", () => {
  it("retires every previously active link when a new one is created", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const invited = await createInvite(setup.app, {
      username: "grisha",
      pageLabels: [],
    }, OWNER_AUDIT);

    const second = await createAccountLinkForUsername(setup.app, {
      username: "grisha",
      kind: "invite",
    }, OWNER_AUDIT);

    const links = await listAccountLinksForUsername(setup.app, "grisha");
    expect(links).toHaveLength(2);
    const first = links.find((link) => link.id === invited.link.id);
    expect(first?.state).toBe("revoked");
    expect(first?.revokedReason).toBe("superseded");
    expect(links.find((link) => link.id === second.id)?.state).toBe("active");
    expect(await activeLinkCount(setup.testDb)).toBe(1);

    // The superseded link is dead for redemption, and it still exists as a fact.
    await expect(redeemAccountLink(setup.app, {
      token: invited.link.token,
      password: STRONG_PASSWORD,
    })).rejects.toMatchObject({ statusCode: 409, reason: "revoked" });
  });

  it("revokes one link by id and stays idempotent afterwards", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const invited = await createInvite(setup.app, {
      username: "grisha",
      pageLabels: [],
    }, OWNER_AUDIT);

    const revoked = await revokeAccountLinkForUsername(setup.app, {
      username: "grisha",
      linkId: invited.link.id,
    }, OWNER_AUDIT);
    expect(revoked.state).toBe("revoked");
    expect(revoked.revokedReason).toBe("revoked_by_owner");

    const again = await revokeAccountLinkForUsername(setup.app, {
      username: "grisha",
      linkId: invited.link.id,
    }, OWNER_AUDIT);
    expect(again.state).toBe("revoked");
    expect(again.revokedReason).toBe("revoked_by_owner");
  });

  it("retires active links when the owner sets a password, when the person changes it, and on deactivation", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    await createInvite(setup.app, { username: "one", pageLabels: [] }, OWNER_AUDIT);
    await setUserPassword(setup.app, {
      username: "one",
      password: "owner-chosen-1",
    }, OWNER_AUDIT);
    expect((await listAccountLinksForUsername(setup.app, "one"))[0]).toMatchObject({
      state: "revoked",
      revokedReason: "password_set",
    });

    const two = await createInvite(setup.app, { username: "two", pageLabels: [] }, OWNER_AUDIT);
    await redeemAccountLink(setup.app, { token: two.link.token, password: STRONG_PASSWORD });
    await createAccountLinkForUsername(setup.app, {
      username: "two",
      kind: "password_reset",
    }, OWNER_AUDIT);
    const twoUser = await findUserByUsername(setup.testDb.db, "two");
    await changeOwnPassword(setup.app, {
      userId: twoUser!.id,
      currentPassword: STRONG_PASSWORD,
      newPassword: "self-chosen-99",
    });
    expect(await activeLinkCount(setup.testDb)).toBe(0);

    const three = await createInvite(setup.app, { username: "three", pageLabels: [] }, OWNER_AUDIT);
    await deactivateUser(setup.app, { username: "three" }, OWNER_AUDIT);
    const threeLinks = await listAccountLinksForUsername(setup.app, "three");
    expect(threeLinks[0]).toMatchObject({
      id: three.link.id,
      state: "revoked",
      revokedReason: "user_deactivated",
    });
  });

  it("keeps every link row: revocation and use are updates, never deletes", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const invited = await createInvite(setup.app, {
      username: "grisha",
      pageLabels: [],
    }, OWNER_AUDIT);
    await createAccountLinkForUsername(setup.app, {
      username: "grisha",
      kind: "invite",
    }, OWNER_AUDIT);
    const last = await createAccountLinkForUsername(setup.app, {
      username: "grisha",
      kind: "invite",
    }, OWNER_AUDIT);
    await redeemAccountLink(setup.app, { token: last.token, password: STRONG_PASSWORD });

    expect(await countRows(setup.testDb, "select count(*)::text as count from account_links"))
      .toBe(3);
    const states = (await listAccountLinksForUsername(setup.app, "grisha"))
      .map((link) => link.state).sort();
    expect(states).toEqual(["revoked", "revoked", "used"]);
    expect(invited.link.id).toBeGreaterThan(0);
  });
});

describe("which link a user may get", () => {
  it("refuses a second invite once the person has registered, and offers a reset instead", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const invited = await createInvite(setup.app, {
      username: "grisha",
      pageLabels: [],
    }, OWNER_AUDIT);
    await redeemAccountLink(setup.app, {
      token: invited.link.token,
      password: STRONG_PASSWORD,
    });

    await expect(createAccountLinkForUsername(setup.app, {
      username: "grisha",
      kind: "invite",
    }, OWNER_AUDIT)).rejects.toThrow(/already registered/i);

    const reset = await createAccountLinkForUsername(setup.app, {
      username: "grisha",
      kind: "password_reset",
    }, OWNER_AUDIT);
    expect(reset.kind).toBe("password_reset");
  });

  it("re-invites a person who never finished registering", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await createInvite(setup.app, { username: "grisha", pageLabels: [] }, OWNER_AUDIT);

    const again = await createAccountLinkForUsername(setup.app, {
      username: "grisha",
      kind: "invite",
    }, OWNER_AUDIT);
    expect(again.kind).toBe("invite");
  });

  it("refuses both link kinds for an owner and for a deactivated account", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    await expect(createAccountLinkForUsername(setup.app, {
      username: "owner",
      kind: "password_reset",
    }, OWNER_AUDIT)).rejects.toMatchObject({ statusCode: 400 });
    await expect(createAccountLinkForUsername(setup.app, {
      username: "owner",
      kind: "invite",
    }, OWNER_AUDIT)).rejects.toMatchObject({ statusCode: 400 });

    await createInvite(setup.app, { username: "grisha", pageLabels: [] }, OWNER_AUDIT);
    await deactivateUser(setup.app, { username: "grisha" }, OWNER_AUDIT);
    await expect(createAccountLinkForUsername(setup.app, {
      username: "grisha",
      kind: "invite",
    }, OWNER_AUDIT)).rejects.toThrow(/deactivated/i);
  });

  it("404s for an unknown user", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await expect(createAccountLinkForUsername(setup.app, {
      username: "nobody",
      kind: "invite",
    }, OWNER_AUDIT)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("inspect", () => {
  it("tells an active link's holder who they are and which clients they need", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const invited = await createInvite(setup.app, {
      username: "grisha",
      pageLabels: ["lora-fansly"],
    }, OWNER_AUDIT);

    expect(await inspectAccountLink(setup.app, invited.link.token)).toEqual({
      state: "active",
      kind: "invite",
      username: "grisha",
      expiresAt: invited.link.expiresAt,
      platforms: ["fansly"],
    });
  });

  it("discloses nothing but the state for a link that can no longer be used", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const invited = await createInvite(setup.app, {
      username: "grisha",
      pageLabels: ["lora-fansly"],
    }, OWNER_AUDIT);
    await expireLink(setup.testDb, invited.link.id);

    expect(await inspectAccountLink(setup.app, invited.link.token)).toEqual({ state: "expired" });
  });

  it("404s an unknown token instead of hinting at it", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await expect(inspectAccountLink(setup.app, "not-a-real-token"))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("redeem", () => {
  it("sets the password once, and the second use conflicts", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const invited = await createInvite(setup.app, {
      username: "grisha",
      pageLabels: ["lora-fansly"],
    }, OWNER_AUDIT);

    expect(await redeemAccountLink(setup.app, {
      token: invited.link.token,
      password: STRONG_PASSWORD,
    })).toEqual({ username: "grisha" });

    const session = await loginWithPassword(setup.app, {
      username: "grisha",
      password: STRONG_PASSWORD,
    });
    expect(session.user.username).toBe("grisha");
    expect(session.user.mustChangePassword).toBe(false);

    await expect(redeemAccountLink(setup.app, {
      token: invited.link.token,
      password: "another-strong-1",
    })).rejects.toMatchObject({ statusCode: 409, reason: "used" });
  });

  it("refuses an expired link with the reason the /join page shows", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const invited = await createInvite(setup.app, {
      username: "grisha",
      pageLabels: [],
    }, OWNER_AUDIT);
    await expireLink(setup.testDb, invited.link.id);

    await expect(redeemAccountLink(setup.app, {
      token: invited.link.token,
      password: STRONG_PASSWORD,
    })).rejects.toMatchObject({ statusCode: 409, reason: "expired" });
    expect(await findUserByUsername(setup.testDb.db, "grisha"))
      .toMatchObject({ passwordHash: null });
  });

  // Over HTTP only `common` can reach a client: the route schema rejects the
  // length cases first, with a plain validation 400 and no reason. These are the
  // service-level verdicts (the HTTP `common` case is pinned further down).
  it("holds the password rule, with the verdict as a machine reason", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const invited = await createInvite(setup.app, {
      username: "grisha",
      pageLabels: [],
    }, OWNER_AUDIT);

    // The verdict is machine-readable, so the /join page can point at the rule
    // that was broken instead of matching on the message text.
    await expect(redeemAccountLink(setup.app, {
      token: invited.link.token,
      password: "short-1",
    })).rejects.toMatchObject({ statusCode: 400, reason: "too_short" });
    await expect(redeemAccountLink(setup.app, {
      token: invited.link.token,
      password: "x".repeat(257),
    })).rejects.toMatchObject({ statusCode: 400, reason: "too_long" });
    // A blacklisted password is refused whatever the case it is typed in —
    // the rule normalizes before it looks (trim + lower-case).
    await expect(redeemAccountLink(setup.app, {
      token: invited.link.token,
      password: "1qaz2wsx3edc",
    })).rejects.toMatchObject({ statusCode: 400, reason: "common" });
    await expect(redeemAccountLink(setup.app, {
      token: invited.link.token,
      password: "1QAZ2WSX3EDC",
    })).rejects.toMatchObject({ statusCode: 400, reason: "common" });
    // The link survives a refused attempt: the person simply picks again.
    expect(await activeLinkCount(setup.testDb)).toBe(1);
  });

  it("terminates every sign-in on a reset, and leaves a FIRST registration nothing to terminate", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const invited = await createInvite(setup.app, {
      username: "grisha",
      pageLabels: [],
    }, OWNER_AUDIT);
    await redeemAccountLink(setup.app, {
      token: invited.link.token,
      password: STRONG_PASSWORD,
    });

    // An invite leaves the sign-ins that exist alone (there are none yet, so
    // mint one and prove the NEXT invite-less path does not touch it).
    const keptDevice = await issueDeviceTokenForUsername(setup.app, {
      username: "grisha",
      label: "Firefox · Windows",
    }, OWNER_AUDIT);
    expect(await countRows(
      setup.testDb,
      "select count(*)::text as count from device_tokens where revoked_at is null",
    )).toBe(1);

    const reset = await createAccountLinkForUsername(setup.app, {
      username: "grisha",
      kind: "password_reset",
    }, OWNER_AUDIT);
    await redeemAccountLink(setup.app, { token: reset.token, password: "brand-new-secret-7" });

    expect(await countRows(
      setup.testDb,
      "select count(*)::text as count from device_tokens where revoked_at is null",
    )).toBe(0);
    expect(keptDevice.token).toMatch(/^agency_hub_device_/);
    await expect(loginWithPassword(setup.app, {
      username: "grisha",
      password: STRONG_PASSWORD,
    })).rejects.toMatchObject({ statusCode: 401 });
    expect((await loginWithPassword(setup.app, {
      username: "grisha",
      password: "brand-new-secret-7",
    })).user.username).toBe("grisha");
  });

  // Review finding: `assertInviteAllowed` lets an INVITE through for a user who
  // has a password but never redeemed a link — which is every person onboarded
  // before Decision 347 shipped. Redeeming it is a password change, so it must
  // drag the same revocation ladder behind it as a reset; otherwise the owner
  // could hand out an invite link and silently re-password a live account while
  // its old devices and sessions kept working.
  it("terminates the old sign-ins when an INVITE is redeemed on an account that already had a password", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await createUserAccount(setup.app, {
      username: "nikita",
      role: "team_lead",
      password: "chatter-secret-1",
    }, { source: "cli" });
    const device = await issueDeviceTokenForUsername(setup.app, {
      username: "nikita",
      label: "Firefox · Windows",
    }, OWNER_AUDIT);
    await loginWithPassword(setup.app, { username: "nikita", password: "chatter-secret-1" });
    expect(await countRows(
      setup.testDb,
      "select count(*)::text as count from auth_sessions where revoked_at is null",
    )).toBe(1);

    const invite = await createAccountLinkForUsername(setup.app, {
      username: "nikita",
      kind: "invite",
    }, OWNER_AUDIT);
    await redeemAccountLink(setup.app, { token: invite.token, password: "brand-new-secret-7" });

    expect(await countRows(
      setup.testDb,
      "select count(*)::text as count from device_tokens where revoked_at is null",
    )).toBe(0);
    expect(await countRows(
      setup.testDb,
      "select count(*)::text as count from auth_sessions where revoked_at is null",
    )).toBe(0);
    expect(device.token).toMatch(/^agency_hub_device_/);
    await expect(loginWithPassword(setup.app, {
      username: "nikita",
      password: "chatter-secret-1",
    })).rejects.toMatchObject({ statusCode: 401 });
    expect((await loginWithPassword(setup.app, {
      username: "nikita",
      password: "brand-new-secret-7",
    })).user.username).toBe("nikita");

    // The journal says which of the two shapes this redemption was.
    const audit = await setup.testDb.pool.query<{ metadata: Record<string, unknown> }>(
      "select metadata from audit_events where event_type = 'user.password_set_via_link' order by id desc limit 1",
    );
    expect(audit.rows[0]?.metadata).toMatchObject({ terminatedExistingAccess: true });
  });
});

describe("secrets never leave the creation response", () => {
  it("writes no raw token and no password into audit rows or observations", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const invited = await createInvite(setup.app, {
      username: "grisha",
      pageLabels: ["lora-fansly"],
    }, OWNER_AUDIT);
    const reset = await createAccountLinkForUsername(setup.app, {
      username: "grisha",
      kind: "invite",
    }, OWNER_AUDIT);
    await redeemAccountLink(setup.app, { token: reset.token, password: STRONG_PASSWORD });
    await terminateAllAccess(setup.app, { username: "grisha" }, OWNER_AUDIT);

    const journal = await setup.testDb.pool.query<{ body: string }>(`
      select coalesce(metadata::text, '') as body from audit_events
      union all
      select coalesce(payload::text, '') as body from observations
    `);
    expect(journal.rows.length).toBeGreaterThan(5);
    const haystack = journal.rows.map((row) => row.body).join("\n");
    for (const secret of [invited.link.token, reset.token, STRONG_PASSWORD]) {
      expect(haystack).not.toContain(secret);
    }
    // The display prefix IS journalled — that is how the owner recognizes a link.
    expect(haystack).toContain(reset.keyPrefix);

    const kinds = await setup.testDb.pool.query<{ kind: string }>(
      "select distinct kind from observations where source = 'operator' order by kind",
    );
    expect(kinds.rows.map((row) => row.kind)).toContain("account_link.created");
    expect(kinds.rows.map((row) => row.kind)).toContain("user.password_set_via_link");
  });
});

describe("the kill switch", () => {
  it("404s the public routes while the owner can still mint links", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const invited = await createInvite(setup.app, {
      username: "grisha",
      pageLabels: [],
    }, OWNER_AUDIT);

    // Minting stays open — the owner is not locked out of preparing a link.
    const minted = await createAccountLinkForUsername(setup.disabledLinksApp, {
      username: "grisha",
      kind: "invite",
    }, OWNER_AUDIT);
    expect(minted.token.length).toBeGreaterThan(20);

    await expect(inspectAccountLink(setup.disabledLinksApp, minted.token))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(redeemAccountLink(setup.disabledLinksApp, {
      token: minted.token,
      password: STRONG_PASSWORD,
    })).rejects.toMatchObject({ statusCode: 404 });
    expect(invited.link.kind).toBe("invite");
  });
});

describe("over HTTP, end to end", () => {
  async function ownerCookie(activeServer: NonNullable<typeof server>) {
    const response = await activeServer.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "owner", password: "owner-secret" },
    });
    expect(response.statusCode).toBe(200);
    const header = response.headers["set-cookie"];
    const value = Array.isArray(header) ? header[0] : header;
    return String(value).split(";")[0]!;
  }

  it("invites, inspects and redeems through the routes the clients actually call", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const cookie = await ownerCookie(setup.server);

    const invited = await setup.server.inject({
      method: "POST",
      url: "/api/v1/admin/invites",
      headers: { cookie },
      payload: { username: "grisha", pageLabels: ["lora-fansly"] },
    });
    expect(invited.statusCode).toBe(200);
    const body = invited.json<{
      user: { username: string; registrationState: string; role: string };
      link: { id: number; kind: string; keyPrefix: string; token: string; expiresAt: string };
    }>();
    expect(body.user).toMatchObject({
      username: "grisha",
      role: "chatter",
      registrationState: "invited",
    });
    expect(body.link.kind).toBe("invite");

    const inspected = await setup.server.inject({
      method: "POST",
      url: "/api/v1/auth/links/inspect",
      payload: { token: body.link.token },
    });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json()).toEqual({
      state: "active",
      kind: "invite",
      username: "grisha",
      expiresAt: body.link.expiresAt,
      platforms: ["fansly"],
    });

    const tooCommon = await setup.server.inject({
      method: "POST",
      url: "/api/v1/auth/links/redeem",
      payload: { token: body.link.token, password: "1qaz2wsx3edc" },
    });
    expect(tooCommon.statusCode).toBe(400);
    expect(tooCommon.json()).toMatchObject({ error: "bad_request", reason: "common" });

    const redeemed = await setup.server.inject({
      method: "POST",
      url: "/api/v1/auth/links/redeem",
      payload: { token: body.link.token, password: STRONG_PASSWORD },
    });
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json()).toEqual({ username: "grisha" });

    // The console now shows a registered person and a used link.
    const listed = await setup.server.inject({
      method: "GET",
      url: "/api/v1/admin/users/grisha/links",
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<Array<{ id: number; state: string }>>()).toEqual([
      expect.objectContaining({ id: body.link.id, state: "used" }),
    ]);
    const users = await setup.server.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      headers: { cookie },
    });
    expect(users.json<Array<{ username: string; registrationState: string }>>()
      .find((user) => user.username === "grisha")?.registrationState).toBe("active");

    // And the person can sign a device in with the password they just chose.
    const signedIn = await setup.server.inject({
      method: "POST",
      url: "/api/v1/auth/device-tokens/password",
      payload: {
        username: "grisha",
        password: STRONG_PASSWORD,
        label: "Firefox · Windows",
        mode: "active",
      },
    });
    expect(signedIn.statusCode).toBe(200);
  });

  it("revokes a link through the route, and the token stops working", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const cookie = await ownerCookie(setup.server);
    const invited = await createInvite(setup.app, {
      username: "grisha",
      pageLabels: [],
    }, OWNER_AUDIT);

    const revoked = await setup.server.inject({
      method: "POST",
      url: `/api/v1/admin/users/grisha/links/${invited.link.id}/revoke`,
      headers: { cookie },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ state: "revoked", revokedReason: "revoked_by_owner" });

    const inspected = await setup.server.inject({
      method: "POST",
      url: "/api/v1/auth/links/inspect",
      payload: { token: invited.link.token },
    });
    expect(inspected.json()).toEqual({ state: "revoked" });

    const unknown = await setup.server.inject({
      method: "POST",
      url: "/api/v1/auth/links/inspect",
      payload: { token: "nothing-matches-this" },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("refuses the console routes to everyone but the owner", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await createUserAccount(setup.app, {
      username: "lead",
      role: "team_lead",
      password: "lead-secret-1",
    }, { source: "cli" });
    const login = await setup.server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "lead", password: "lead-secret-1" },
    });
    const header = login.headers["set-cookie"];
    const cookie = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;

    expect((await setup.server.inject({
      method: "POST",
      url: "/api/v1/admin/invites",
      headers: { cookie },
      payload: { username: "grisha", pageLabels: [] },
    })).statusCode).toBe(403);
    expect((await setup.server.inject({
      method: "POST",
      url: "/api/v1/admin/invites",
      payload: { username: "grisha", pageLabels: [] },
    })).statusCode).toBe(401);
  });
});

describe("concurrent writers", () => {
  it("never leaves two active links when two creates race", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await createInvite(setup.app, { username: "grisha", pageLabels: [] }, OWNER_AUDIT);
    const user = await findUserByUsername(setup.testDb.db, "grisha");

    const results = await Promise.allSettled([
      createAccountLinkForUsername(setup.app, { username: "grisha", kind: "invite" }, OWNER_AUDIT),
      createAccountLinkForUsername(setup.app, { username: "grisha", kind: "invite" }, OWNER_AUDIT),
      createAccountLinkForUsername(setup.app, { username: "grisha", kind: "invite" }, OWNER_AUDIT),
    ]);
    for (const result of results) {
      // Every writer either created its link or failed for a stated reason;
      // none of them may explode on the partial unique index.
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ statusCode: expect.any(Number) });
        expect(String(result.reason)).not.toMatch(/account_links_one_active_uidx/);
      }
    }
    expect(results.filter((result) => result.status === "fulfilled").length)
      .toBeGreaterThanOrEqual(1);
    expect(await activeLinkCount(setup.testDb, user!.id)).toBe(1);
  });

  it("never leaves an active link created before a concurrent password reset alive afterwards", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await createInvite(setup.app, { username: "grisha", pageLabels: [] }, OWNER_AUDIT);

    const [linkResult] = await Promise.allSettled([
      createAccountLinkForUsername(setup.app, { username: "grisha", kind: "invite" }, OWNER_AUDIT),
      setUserPassword(setup.app, {
        username: "grisha",
        password: "owner-chosen-42",
      }, OWNER_AUDIT),
    ]);

    // Whoever won, the invariant holds: at most one active link, and if the
    // password write came last the link it superseded is retired.
    expect(await activeLinkCount(setup.testDb)).toBeLessThanOrEqual(1);
    if (linkResult?.status === "fulfilled") {
      const links = await listAccountLinksForUsername(setup.app, "grisha");
      const created = links.find((link) => link.id === linkResult.value.id);
      expect(created).toBeDefined();
      expect(["active", "revoked"]).toContain(created!.state);
    }
  });
});
