import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  bindOnboardedProfile,
  closeUnfinishedBrowserProfileSends,
  countBrowserProfileSendsSince,
  deleteUnboundPageBrowser,
  endPageBrowserOnboarding,
  findOnboardingProfile,
  lastBrowserProfileSendAt,
  listOnboardingLinksWanted,
  listUnboundPageBrowsers,
  lockOnboardingForBinding,
  lockOnboardingLink,
  OnboardingLinkLostError,
  PageBrowserRegistrationError,
  recordOnboardingIdentity,
  registerPageBrowserProfile,
  requestOnboardingIdentity,
  setOnboardingProxy,
  setPageBrowserOnboarding,
  takeOnboardingLink,
  type Database,
} from "@agency_hub_core/db";

import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { bindProvenProfile, proveOnboardingAccount, type OnboardingProof } from "./helpers/page-browser-onboarding.ts";

// The data of a new page's onboarding through its browser (Project Browser
// plan §3.2, §3.4; 0281; stage 3 PR 16): a profile registered with its page
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

describe("a page browser profile's onboarding in the database (0281; PR 16)", () => {
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

  it("moves the onboarding only where the owner may: login, open, given up — closing is the engine's to end", async (context) => {
    if (!testDb) return context.skip();
    const profileId = await profile();
    expect(await move(profileId, "closing")).toMatchObject({ kind: "refused", state: "off" });
    expect(await move(profileId, "login")).toEqual({ kind: "changed", from: "off", to: "login" });
    expect(await move(profileId, "login")).toEqual({ kind: "unchanged", state: "login" });
    expect(await move(profileId, "open")).toEqual({ kind: "changed", from: "login", to: "open" });
    expect(await move(profileId, "login")).toEqual({ kind: "changed", from: "open", to: "login" });
    expect(await move(profileId, "closing")).toEqual({ kind: "changed", from: "login", to: "closing" });
    expect(await move(profileId, "open")).toMatchObject({ kind: "refused", state: "closing" });
    expect((await listOnboardingLinksWanted(db())).map((row) => row.profileId)).toEqual([profileId]);
  });

  it("fences the link by its generation: a take raises it, an earlier link's lock fails, the binding raises it too", async (context) => {
    if (!testDb) return context.skip();
    const profileId = await profile();
    expect(await takeOnboardingLink(db(), profileId)).toBe(1n);
    expect(await takeOnboardingLink(db(), profileId)).toBe(2n);
    await expect(db().transaction((tx) => lockOnboardingLink(tx as unknown as Database, { profileId, generation: 1n }))).rejects.toBeInstanceOf(OnboardingLinkLostError);
    await db().transaction((tx) => lockOnboardingLink(tx as unknown as Database, { profileId, generation: 2n }));
    const pageId = await page("eva-1");
    expect(await bindProvenProfile(db(), { profileId, pageId })).toBe(true);
    await expect(db().transaction((tx) => lockOnboardingLink(tx as unknown as Database, { profileId, generation: 2n }))).rejects.toBeInstanceOf(OnboardingLinkLostError);
    expect(await takeOnboardingLink(db(), profileId)).toBeNull();
  });

  it("takes an identity request only while the onboarding is open, and only its own answer", async (context) => {
    if (!testDb) return context.skip();
    const profileId = await profile();
    expect(await requestOnboardingIdentity(db(), { profileId, source: "onboarding" })).toMatchObject({ kind: "refused", why: "not_open", state: "off" });
    await move(profileId, "open");
    const first = await requestOnboardingIdentity(db(), { profileId, source: "onboarding" });
    const second = await requestOnboardingIdentity(db(), { profileId, source: "credentials_verify" });
    expect(first.kind === "requested" && second.kind === "requested").toBe(true);
    const ids = [first, second].map((request) => (request.kind === "requested" ? request.requestId : ""));
    // An answer of the first request is refused: the second is the one asked now.
    const write = (requestId: string) => db().transaction((tx) => recordOnboardingIdentity(tx as unknown as Database, { profileId, result: { requestId, ok: false, error: "x", httpStatus: null, at: new Date().toISOString() } }));
    expect(await write(ids[0]!)).toBe(false);
    expect(await write(ids[1]!)).toBe(true);
    expect((await findOnboardingProfile(db(), profileId))!.identityRequest).toMatchObject({ id: ids[1], source: "credentials_verify" });
  });

  it("reads the profile's last send from the journal: a send never completed counts at its capture", async (context) => {
    if (!testDb) return context.skip();
    const profileId = await profile();
    expect(await lastBrowserProfileSendAt(db(), { profileId, lookbackMs: 600_000 })).toBeNull();
    await testDb.pool.query(
      `insert into fansly_send_log (page_id, guard_token, source, operation, holder_host, holder_pid, holder_role, holder_instance, captured_at, browser_profile_id, browser_attempt_id)
       values (null, gen_random_uuid(), 'onboarding', 'login:auth.login', 'h', 1, 'sync', gen_random_uuid(), clock_timestamp() - interval '2 seconds', $1, 7)`,
      [profileId],
    );
    const last = await lastBrowserProfileSendAt(db(), { profileId, lookbackMs: 600_000 });
    expect(last).not.toBeNull();
    expect(Date.now() - last!.getTime()).toBeGreaterThanOrEqual(1_500);
  });

  it("raises the onboarding's generation at every change of it and voids the identity request and its answer (Astra's review of PR 16, items 1–2)", async (context) => {
    if (!testDb) return context.skip();
    const profileId = await profile();
    const generation = async () => (await findOnboardingProfile(db(), profileId))!.onboardingGeneration;
    expect(await generation()).toBe(0n);
    const proof = await proveOnboardingAccount(db(), profileId);
    expect(proof.onboardingGeneration).toBe(1n);
    expect((await findOnboardingProfile(db(), profileId))!.identityResult).toMatchObject({ ok: true, onboardingGeneration: "1" });
    // The owner opens the login again: the check and its answer are void.
    expect(await move(profileId, "login")).toMatchObject({ kind: "changed" });
    expect(await findOnboardingProfile(db(), profileId)).toMatchObject({ onboardingGeneration: 2n, identityRequest: null, identityResult: null });
    // An answer of the voided request is never written.
    const late = { ...(await proofResult(proof)), requestId: proof.requestId };
    expect(await db().transaction((tx) => recordOnboardingIdentity(tx as unknown as Database, { profileId, result: late }))).toBe(false);
    // Given up, then ended by the engine: each a change of its own.
    await move(profileId, "closing");
    expect(await db().transaction((tx) => endPageBrowserOnboarding(tx as unknown as Database, { profileId, by: "engine" }))).toBe(true);
    expect(await generation()).toBe(4n);
  });

  it("records an account only while the onboarding is open in the generation it was read in; a failure always", async (context) => {
    if (!testDb) return context.skip();
    const profileId = await profile();
    await move(profileId, "open");
    const requested = await requestOnboardingIdentity(db(), { profileId, source: "onboarding" });
    const requestId = requested.kind === "requested" ? requested.requestId : "";
    const ok = (onboardingGeneration: string) => ({ requestId, ok: true as const, accountId: "300000000000000777", username: null, displayName: null, sentAt: new Date().toISOString(), onboardingGeneration, sessionFingerprint: "f", observationId: 0, attemptId: 1 });
    const write = (result: Parameters<typeof recordOnboardingIdentity>[1]["result"]) => db().transaction((tx) => recordOnboardingIdentity(tx as unknown as Database, { profileId, result }));
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
});

/** The ok answer a proof stands for. */
async function proofResult(proof: OnboardingProof) {
  return { ok: true as const, accountId: "300000000000000777", username: null, displayName: null, sentAt: new Date().toISOString(), onboardingGeneration: proof.onboardingGeneration.toString(), sessionFingerprint: "f", observationId: 0, attemptId: 1 };
}
