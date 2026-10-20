import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  bindIdentityAttempt,
  bindOnboardedProfile,
  closeUnfinishedBrowserProfileSends,
  countBrowserProfileSendsSince,
  deleteUnboundPageBrowser,
  findOnboardingProfile,
  listUnboundPageBrowsers,
  lockOnboardingForBinding,
  PageBrowserRegistrationError,
  recordOnboardingIdentity,
  registerPageBrowserProfile,
  requestOnboardingIdentity,
  setOnboardingProxy,
  setPageBrowserOnboarding,
  type Database,
} from "@agency_hub_core/db";

import { removeBrowserProfile } from "../apps/runtime/src/sync/browser-profile-cli.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { proveOnboardingAccount, type OnboardingProof } from "./helpers/page-browser-onboarding.ts";

// The data of a new page's onboarding through its browser (Project Browser
// plan §3.2, §3.4; 0280; stage 3 PR 16): a profile registered with its page
// empty, the owner's moves of its onboarding, the identity request and its
// answer, the link's fence, the binding — and the database's own word that a
// profile serves one page at most, a page has one profile at most, and a
// bound profile is no onboarding's.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (!testDb) return;
  await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

const SEALED = { encryptedEngineToken: "{\"sealed\":1}", encryptedApiToken: "{\"sealed\":2}", encryptedVncPassword: "{\"sealed\":3}", keyVersion: 1 };

async function profile(input: { container?: string; pageId?: number | null } = {}): Promise<string> {
  const profileId = randomUUID();
  await registerPageBrowserProfile(db(), { profileId, container: input.container ?? `page-browser-p-${profileId.slice(0, 8)}`, ...SEALED, socksEndpoint: "203.0.113.50:1080", ...(input.pageId === undefined ? {} : { pageId: input.pageId }) });
  return profileId;
}

async function page(label: string): Promise<number> {
  const model = await testDb!.pool.query<{ id: string }>("insert into models (slug, name) values ($1, $1) on conflict (slug) do update set name = excluded.name returning id", [`m-${label}`]);
  const created = await testDb!.pool.query<{ id: string }>("insert into pages (model_id, platform, label) values ($1, 'fansly', $2) returning id", [model.rows[0]!.id, label]);
  return Number(created.rows[0]!.id);
}

async function move(profileId: string, to: "login" | "open" | "closing") {
  return db().transaction((tx) => setPageBrowserOnboarding(tx as unknown as Database, { profileId, to, by: "owner:1" }));
}

describe("a page browser profile's onboarding in the database (0280; PR 16)", () => {
  it("registers a profile with its page empty, refuses a second one of the same container or page", async (context) => {
    if (!testDb) return context.skip();
    const profileId = await profile({ container: "page-browser-ari-2" });
    expect(await findOnboardingProfile(db(), profileId)).toMatchObject({ pageId: null, container: "page-browser-ari-2", onboarding: "off", socksEndpoint: "203.0.113.50:1080", linkGeneration: 0n, proxy: null });
    await expect(profile({ container: "page-browser-ari-2" })).rejects.toThrow(PageBrowserRegistrationError);
    const pageId = await page("lilly-1");
    await profile({ pageId });
    await expect(profile({ pageId })).rejects.toMatchObject({ reason: "page_has_browser" });
    expect((await listUnboundPageBrowsers(db())).map((row) => row.profileId)).toEqual([profileId]);
  });

  it("keeps a page to one profile and a bound profile out of any onboarding — the database's own constraints", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await page("ari-2");
    const a = await profile();
    const b = await profile();
    const proof = await proveOnboardingAccount(db(), a);
    await db().transaction(async (tx) => expect(await bindOnboardedProfile(tx as unknown as Database, { profileId: a, pageId, ...proof })).toBe(true));
    // Bound once only.
    await db().transaction(async (tx) => expect(await bindOnboardedProfile(tx as unknown as Database, { profileId: a, pageId, ...proof })).toBe(false));
    // A second profile on the same page: the unique key refuses it.
    await expect(testDb.pool.query("update page_browsers set page_id = $1 where profile_id = $2", [pageId, b])).rejects.toThrow(/page_browsers_page_key/);
    // A bound profile with an onboarding: the check refuses it.
    await expect(testDb.pool.query("update page_browsers set onboarding = 'login' where profile_id = $1", [a])).rejects.toThrow(/page_browsers_onboarding_unbound_check/);
    await expect(testDb.pool.query("update page_browsers set onboarding = 'lost' where profile_id = $1", [b])).rejects.toThrow(/page_browsers_onboarding_check/);
    // The owner's moves of a bound profile are refused, its proxy too.
    expect(await move(a, "login")).toEqual({ kind: "bound", pageId });
    expect(await setOnboardingProxy(db(), { profileId: a, url: "socks5://203.0.113.50:1080", encryptedAuth: null, keyVersion: null })).toBe(false);
    // A bound profile is never removed by remove-profile; an unbound one is.
    expect(await deleteUnboundPageBrowser(db(), a)).toBe(false);
    expect(await deleteUnboundPageBrowser(db(), b)).toBe(true);
  });

  it("records an account only while the onboarding is open in the generation it was read in; a failure always", async (context) => {
    if (!testDb) return context.skip();
    const profileId = await profile();
    await move(profileId, "open");
    const requested = await requestOnboardingIdentity(db(), { profileId, source: "onboarding" });
    const requestId = requested.kind === "requested" ? requested.requestId : "";
    const ok = (onboardingGeneration: string) => ({ requestId, ok: true as const, accountId: "300000000000000777", username: null, displayName: null, sentAt: new Date().toISOString(), onboardingGeneration, sessionFingerprint: "f", observationId: 0, attemptId: 1 });
    const write = (result: Parameters<typeof recordOnboardingIdentity>[1]["result"]) => db().transaction((tx) => recordOnboardingIdentity(tx as unknown as Database, { profileId, result }));
    // Not the read the request was bound to: not written.
    expect(await write(ok("1"))).toBe(false);
    await db().transaction((tx) => bindIdentityAttempt(tx as unknown as Database, { profileId, requestId, attemptId: 1 }));
    // Read in the generation before this one: not written.
    expect(await write(ok("0"))).toBe(false);
    expect(await write(ok("1"))).toBe(true);
    expect(await write({ requestId, ok: false, error: "x", httpStatus: null, at: new Date().toISOString() })).toBe(true);
  });

  it("binds only on the check that still proves the account: not after the onboarding was given up, its login opened again, or another check asked (Astra's review of PR 16, item 2)", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await page("ari-2");
    const bind = (profileId: string, proof: OnboardingProof) => db().transaction(async (tx) => ({
      locked: await lockOnboardingForBinding(tx as unknown as Database, { profileId, requestId: proof.requestId }),
      bound: await bindOnboardedProfile(tx as unknown as Database, { profileId, pageId, ...proof }),
    }));
    // Given up after the check.
    const gaveUp = await profile();
    const gaveUpProof = await proveOnboardingAccount(db(), gaveUp);
    await move(gaveUp, "closing");
    expect(await bind(gaveUp, gaveUpProof)).toEqual({ locked: { ok: false, why: "not_open" }, bound: false });
    // Its login opened and closed again after the check: the proof is of before.
    const again = await profile();
    const againProof = await proveOnboardingAccount(db(), again);
    await move(again, "login");
    await move(again, "open");
    expect(await bind(again, againProof)).toEqual({ locked: { ok: false, why: "identity_changed" }, bound: false });
    // Another check asked since (not answered yet).
    const asked = await profile();
    const askedProof = await proveOnboardingAccount(db(), asked);
    await requestOnboardingIdentity(db(), { profileId: asked, source: "credentials_verify" });
    expect(await bind(asked, askedProof)).toEqual({ locked: { ok: false, why: "identity_changed" }, bound: false });
    // An account recorded under a generation that no longer holds (written
    // around the repository): neither the lock nor the binding take it.
    const forged = await profile();
    const forgedProof = await proveOnboardingAccount(db(), forged);
    await testDb.pool.query("update page_browsers set identity_result = jsonb_set(identity_result, '{onboardingGeneration}', '\"0\"') where profile_id = $1", [forged]);
    expect(await bind(forged, forgedProof)).toEqual({ locked: { ok: false, why: "identity_changed" }, bound: false });
    for (const profileId of [gaveUp, again, asked, forged]) expect((await findOnboardingProfile(db(), profileId))!.pageId).toBeNull();
    // The proof that still holds binds.
    const fresh = await profile();
    const freshProof = await proveOnboardingAccount(db(), fresh);
    const bound = await bind(fresh, freshProof);
    expect(bound.locked.ok && bound.bound).toBe(true);
  });

  it("counts every send of the profile's last hour that may have gone — one never completed, one closed as unknown — and leaves out only what never went (Astra's review of PR 16, item 5)", async (context) => {
    if (!testDb) return context.skip();
    const profileId = await profile();
    const send = (captured: string, completion: string) => testDb!.pool.query(
      `insert into fansly_send_log (page_id, guard_token, source, operation, holder_host, holder_pid, holder_role, holder_instance, captured_at,
                                    sent_at, completed_at, outcome, browser_profile_id, browser_attempt_id)
       select null, gen_random_uuid(), 'onboarding', 'site:site.other', 'h', 1, 'sync', gen_random_uuid(), ${captured}, ${completion}, $1, 7`,
      [profileId],
    );
    const since = new Date(Date.now() - 3_600_000);
    const count = () => countBrowserProfileSendsSince(db(), { profileId, since });
    // Sent and answered; never sent; sent more than an hour ago.
    await send("clock_timestamp() - interval '10 minutes'", "clock_timestamp() - interval '10 minutes', clock_timestamp() - interval '10 minutes', 'response'");
    await send("clock_timestamp() - interval '9 minutes'", "null, clock_timestamp() - interval '9 minutes', 'aborted_before_send'");
    await send("clock_timestamp() - interval '2 hours'", "clock_timestamp() - interval '2 hours', clock_timestamp() - interval '2 hours', 'response'");
    expect(await count()).toBe(1);
    // Admitted, its outcome never written (the process died after it went).
    await send("clock_timestamp() - interval '1 minute'", "null, null, null");
    expect(await count()).toBe(2);
    // The next link closes it as unknown: it still counts.
    expect(await closeUnfinishedBrowserProfileSends(db(), profileId)).toBe(1);
    expect(await count()).toBe(2);
  });

  it("forgets for the deploy script's clean-up only a profile no page has, or says Hub has none (`--absent-ok`); a bound one is refused (Astra's review of PR 16, item 6)", async (context) => {
    if (!testDb) return context.skip();
    const unbound = await profile();
    const bound = await profile({ pageId: await page("lilly-1") });
    const remove = (profileId: string, absentOk: boolean) => removeBrowserProfile(db(), { profileId, actor: "cli:test", absentOk });
    await expect(remove(bound, true)).rejects.toThrow(/is bound to page/);
    expect(await findOnboardingProfile(db(), bound)).not.toBeNull();
    expect(await remove(unbound, true)).toMatchObject({ profileId: unbound, outcome: "removed" });
    expect(await remove(unbound, true)).toEqual({ profileId: unbound, container: null, outcome: "absent" });
    await expect(remove(unbound, false)).rejects.toThrow(/no profile/);
  });

  it("never registers again a profile Hub forgot or said it never had: an add whose answer was lost and that commits late is refused (Astra's review of PR 16, round 2)", async (context) => {
    if (!testDb) return context.skip();
    const register = (profileId: string, container: string) => registerPageBrowserProfile(db(), { profileId, container, ...SEALED, socksEndpoint: "203.0.113.50:1080" });
    // Hub said it had none (the owner's remove-profile after an unknown add) …
    const late = randomUUID();
    expect(await removeBrowserProfile(db(), { profileId: late, actor: "cli:test", absentOk: true })).toMatchObject({ outcome: "absent" });
    // … then the add that was still under way commits: refused, nothing written.
    await expect(register(late, "page-browser-late-1")).rejects.toMatchObject({ reason: "profile_forgotten" });
    expect(await findOnboardingProfile(db(), late)).toBeNull();
    // A profile removed is never registered again either.
    const removed = await profile();
    await removeBrowserProfile(db(), { profileId: removed, actor: "cli:test" });
    await expect(register(removed, "page-browser-late-2")).rejects.toMatchObject({ reason: "profile_forgotten" });
    expect((await testDb.pool.query("select profile_id::text, was_registered from page_browser_forgotten_profiles order by was_registered")).rows).toEqual([
      { profile_id: late, was_registered: false },
      { profile_id: removed, was_registered: true },
    ]);
  });
});

