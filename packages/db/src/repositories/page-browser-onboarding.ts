import { isIP } from "node:net";

import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import type { FanslySendHolderIdentity } from "./fansly-send-guard.ts";
import { SYNC_ROUTE_JOURNAL_SLACK_MS, SYNC_SEND_WINDOW_MS } from "./sync/attempts.ts";

// Project Browser (plan §3.2 «Подключение новой страницы через браузер», §3.4,
// §4.8; 0281; stage 3 PR 16): a new Fansly page connected through its own
// browser. `scripts/deploy-page-browser.sh add-profile` makes the profile's
// container and registers its row here — its page empty (or an existing
// page's, for a page that moves to a browser: plan §5, stage 4 step 1). The
// owner gives the proxy of the page to be and pins the exit IP; he logs the
// browser in through the form (`onboarding` login → open); the engine reads
// the account through the browser on request (`identity_*`); then Hub
// creates the page and binds the profile to it in one transaction
// (`bindOnboardedProfile`, with the page's own rows). A profile is one page's
// at most and a page has one profile at most (`page_browsers_page_key`); a
// bound profile is no onboarding's (`page_browsers_onboarding_unbound_check`).
//
// The engine's link to a profile no page has is fenced by its own
// generation (`link_generation`): every take raises it, so does the binding,
// and each write of a link is made under `lockOnboardingLink` of its own
// generation — an earlier link writes nothing.
//
// The onboarding itself has a generation too (`onboarding_generation`,
// Astra's review of PR 16, items 1–2): every change of `onboarding` raises it
// and voids the identity request and its answer. An account read proves the
// profile's account only under the generation it was read in, sent after the
// engine saw the automation back in that generation — and the binding takes
// it only while that generation still holds, the onboarding open.

export type PageBrowserOnboardingState = "off" | "login" | "open" | "closing";
export type OnboardingIdentitySource = "onboarding" | "credentials_verify";

/** The engine's answer to an identity request (`identity_result`). */
export type OnboardingIdentityResult =
  | {
    requestId: string;
    ok: true;
    accountId: string;
    username: string | null;
    displayName: string | null;
    /** When the request left the browser (ISO): the operator's own `sent`,
     *  never an instant unknown to the engine. */
    sentAt: string;
    /** The onboarding generation it was read in (decimal): it proves the
     *  account only while that generation holds. */
    onboardingGeneration: string;
    /** The live session the answer came under. */
    sessionFingerprint: string;
    observationId: number;
    /** The attempt id the operator knows the read by. */
    attemptId: number;
  }
  | {
    requestId: string;
    ok: false;
    error: string;
    httpStatus: number | null;
    at: string;
    /** The read it is the answer of (none: no read went for it). */
    attemptId?: number;
    /** Whether the read went is not known: its link ended before its answer
     *  (a new request reads anew). */
    indeterminate?: boolean;
  };

export interface OnboardingProfile {
  profileId: string;
  /** Bound already (null: no page yet). */
  pageId: number | null;
  container: string;
  onboarding: PageBrowserOnboardingState;
  onboardingChangedAt: Date | null;
  onboardingChangedBy: string | null;
  socksEndpoint: string | null;
  /** The proxy given for the page to be (its auth sealed). */
  proxy: { url: string; encryptedAuth: string | null; keyVersion: number | null } | null;
  linkGeneration: bigint;
  /** Raised at every change of `onboarding` (Astra's review of PR 16). */
  onboardingGeneration: bigint;
  pinnedExitIp: string | null;
  pinnedExitIpAt: Date | null;
  env: Record<string, unknown> | null;
  identityRequest: { id: string; source: OnboardingIdentitySource; requestedAt: Date } | null;
  identityResult: OnboardingIdentityResult | null;
  /** The attempt the request's one read was granted to (null: none yet). */
  identityAttemptId: number | null;
  /** The operator's last `state`, as recorded. */
  step: string | null;
  stopReason: string | null;
  mode: "automation" | "manual_login";
  exitOpen: boolean;
  sessionFingerprint: string | null;
  accountId: string | null;
  exitIp: string | null;
  selftestOk: boolean | null;
  selftestAt: Date | null;
  selftestFailed: string | null;
  lastStateAt: Date | null;
  linkError: string | null;
  encryptedEngineToken: string;
  encryptedApiToken: string;
  encryptedVncPassword: string;
  createdAt: Date;
}

type SqlRow = {
  profileId: string;
  pageId: string | null;
  container: string;
  onboarding: PageBrowserOnboardingState;
  onboardingChangedAt: Date | string | null;
  onboardingChangedBy: string | null;
  socksEndpoint: string | null;
  proxyUrl: string | null;
  proxyAuth: string | null;
  proxyKeyVersion: number | null;
  linkGeneration: string;
  onboardingGeneration: string;
  pinnedExitIp: string | null;
  pinnedExitIpAt: Date | string | null;
  env: unknown;
  identityRequestId: string | null;
  identityRequestSource: OnboardingIdentitySource | null;
  identityRequestedAt: Date | string | null;
  identityResult: unknown;
  identityAttemptId: string | null;
  step: string | null;
  stopReason: string | null;
  mode: "automation" | "manual_login";
  exitOpen: boolean;
  sessionFingerprint: string | null;
  accountId: string | null;
  exitIp: string | null;
  selftestOk: boolean | null;
  selftestAt: Date | string | null;
  selftestFailed: string | null;
  lastStateAt: Date | string | null;
  linkError: string | null;
  encryptedEngineToken: string;
  encryptedApiToken: string;
  encryptedVncPassword: string;
  createdAt: Date | string;
};

const columns = sql`
  b.profile_id::text as "profileId",
  b.page_id::text as "pageId",
  b.container,
  b.onboarding,
  b.onboarding_changed_at as "onboardingChangedAt",
  b.onboarding_changed_by as "onboardingChangedBy",
  b.socks_endpoint as "socksEndpoint",
  b.onboarding_proxy_url as "proxyUrl",
  b.onboarding_proxy_auth as "proxyAuth",
  b.onboarding_proxy_key_version as "proxyKeyVersion",
  b.link_generation::text as "linkGeneration",
  b.onboarding_generation::text as "onboardingGeneration",
  b.pinned_exit_ip as "pinnedExitIp",
  b.pinned_exit_ip_at as "pinnedExitIpAt",
  b.env,
  b.identity_request_id::text as "identityRequestId",
  b.identity_request_source as "identityRequestSource",
  b.identity_requested_at as "identityRequestedAt",
  b.identity_result as "identityResult",
  b.identity_attempt_id::text as "identityAttemptId",
  b.step,
  b.stop_reason as "stopReason",
  b.mode,
  b.exit_open as "exitOpen",
  b.session_fingerprint as "sessionFingerprint",
  b.account_id as "accountId",
  b.exit_ip as "exitIp",
  b.selftest_ok as "selftestOk",
  b.selftest_at as "selftestAt",
  b.selftest_failed as "selftestFailed",
  b.last_state_at as "lastStateAt",
  b.link_error as "linkError",
  b.encrypted_engine_token as "encryptedEngineToken",
  b.encrypted_api_token as "encryptedApiToken",
  b.encrypted_vnc_password as "encryptedVncPassword",
  b.created_at as "createdAt"
`;

function dateOf(value: Date | string | null): Date | null {
  return value === null ? null : value instanceof Date ? value : new Date(value);
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function resultOf(value: unknown): OnboardingIdentityResult | null {
  const object = objectOf(value);
  if (object === null || typeof object.requestId !== "string" || typeof object.ok !== "boolean") return null;
  return object as unknown as OnboardingIdentityResult;
}

function profileOf(row: SqlRow): OnboardingProfile {
  return {
    profileId: row.profileId,
    pageId: row.pageId === null ? null : Number(row.pageId),
    container: row.container,
    onboarding: row.onboarding,
    onboardingChangedAt: dateOf(row.onboardingChangedAt),
    onboardingChangedBy: row.onboardingChangedBy,
    socksEndpoint: row.socksEndpoint,
    proxy: row.proxyUrl === null ? null : { url: row.proxyUrl, encryptedAuth: row.proxyAuth, keyVersion: row.proxyKeyVersion },
    linkGeneration: BigInt(row.linkGeneration),
    onboardingGeneration: BigInt(row.onboardingGeneration),
    pinnedExitIp: row.pinnedExitIp,
    pinnedExitIpAt: dateOf(row.pinnedExitIpAt),
    env: objectOf(row.env),
    identityRequest: row.identityRequestId === null || row.identityRequestSource === null || row.identityRequestedAt === null
      ? null
      : { id: row.identityRequestId, source: row.identityRequestSource, requestedAt: dateOf(row.identityRequestedAt)! },
    identityResult: resultOf(row.identityResult),
    identityAttemptId: row.identityAttemptId === null ? null : Number(row.identityAttemptId),
    step: row.step,
    stopReason: row.stopReason,
    mode: row.mode,
    exitOpen: row.exitOpen,
    sessionFingerprint: row.sessionFingerprint,
    accountId: row.accountId,
    exitIp: row.exitIp,
    selftestOk: row.selftestOk,
    selftestAt: dateOf(row.selftestAt),
    selftestFailed: row.selftestFailed,
    lastStateAt: dateOf(row.lastStateAt),
    linkError: row.linkError,
    encryptedEngineToken: row.encryptedEngineToken,
    encryptedApiToken: row.encryptedApiToken,
    encryptedVncPassword: row.encryptedVncPassword,
    createdAt: dateOf(row.createdAt)!,
  };
}

// ── the profile's registration (add-profile) ───────────────────────────────

/** `ip:port` of a SOCKS5 as the container's rules name it. */
export function socksEndpointOf(ip: string, port: number): string {
  if (isIP(ip) !== 4) throw new Error(`Not an IPv4 address: ${ip}`);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Not a port: ${port}`);
  return `${ip}:${port}`;
}

export class PageBrowserRegistrationError extends Error {
  constructor(readonly reason: "profile_exists" | "profile_forgotten" | "container_taken" | "page_has_browser" | "no_page", message: string) {
    super(message);
    this.name = "PageBrowserRegistrationError";
  }
}

export interface RegisterPageBrowserInput {
  profileId: string;
  container: string;
  /** Each an encrypted JSON envelope (serialized), sealed with `keyVersion`. */
  encryptedEngineToken: string;
  encryptedApiToken: string;
  encryptedVncPassword: string;
  keyVersion: number;
  socksEndpoint: string;
  /** The browser's environment (`hello.env`), when given at the profile's
   *  making. */
  env?: Record<string, unknown> | null;
  /** An existing page that moves to its browser (bound now); absent: a new
   *  page's profile, bound at its onboarding. */
  pageId?: number | null;
}

/** A registration and a forget of one profile id, one at a time (a
 *  transaction advisory lock of the id). */
async function lockProfileId(tx: Database, profileId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`page_browser_profile:${profileId}`}, 0))`);
}

/**
 * A new profile's row, as `add-profile` made its container: its secrets
 * sealed, the SOCKS5 its container's rules admit, its page empty (or the
 * existing page that moves to it). Refuses — and writes nothing — a profile
 * or a container that exists, a page that has a browser already, and a
 * profile Hub forgot (or said it never had): an add that commits late.
 */
export async function registerPageBrowserProfile(db: Database, input: RegisterPageBrowserInput): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(input.profileId)) throw new Error("A profile id is a UUID");
  if (!/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(input.socksEndpoint)) throw new Error("A SOCKS5 endpoint is ip:port");
  await db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await lockProfileId(tx, input.profileId);
    const clash = await tx.execute<{ profile: boolean; forgotten: boolean; container: boolean; page: boolean }>(sql`
      select exists (select 1 from page_browsers where profile_id = ${input.profileId}::uuid) as profile,
             exists (select 1 from page_browser_forgotten_profiles where profile_id = ${input.profileId}::uuid) as forgotten,
             exists (select 1 from page_browsers where container = ${input.container}) as container,
             exists (select 1 from page_browsers where ${input.pageId ?? null}::bigint is not null and page_id = ${input.pageId ?? null}::bigint) as page
    `);
    const found = clash.rows[0]!;
    if (found.profile) throw new PageBrowserRegistrationError("profile_exists", `Profile ${input.profileId} is registered already`);
    if (found.forgotten) throw new PageBrowserRegistrationError("profile_forgotten", `Profile ${input.profileId} was forgotten by Hub: it is never registered again (make a new one)`);
    if (found.container) throw new PageBrowserRegistrationError("container_taken", `Container ${input.container} has a profile already`);
    if (found.page) throw new PageBrowserRegistrationError("page_has_browser", `Page ${input.pageId} has a browser already`);
    if (input.pageId !== undefined && input.pageId !== null) {
      const page = await tx.execute(sql`select 1 from pages where id = ${input.pageId}::bigint and platform = 'fansly' and status = 'active'`);
      if (page.rows.length === 0) throw new PageBrowserRegistrationError("no_page", `No active Fansly page ${input.pageId}`);
    }
    await tx.execute(sql`
      insert into page_browsers (profile_id, page_id, container, encrypted_engine_token, encrypted_api_token,
                                 encrypted_vnc_password, key_version, socks_endpoint, env)
      values (${input.profileId}::uuid, ${input.pageId ?? null}::bigint, ${input.container}, ${input.encryptedEngineToken},
              ${input.encryptedApiToken}, ${input.encryptedVncPassword}, ${input.keyVersion}::integer, ${input.socksEndpoint},
              ${input.env === undefined || input.env === null ? null : JSON.stringify(input.env)}::jsonb)
    `);
  });
}

/** A profile no page has, removed (`remove-profile`: its container goes
 *  after). A bound profile is never removed here. True: removed. */
export async function deleteUnboundPageBrowser(db: Database, profileId: string): Promise<boolean> {
  const result = await db.execute(sql`
    delete from page_browsers where profile_id = ${profileId}::uuid and page_id is null returning profile_id
  `);
  return result.rows.length === 1;
}

/**
 * Hub forgets a profile (the deploy script's `remove-profile`, its clean-up
 * after an `add` whose answer was lost), in the caller's transaction: one no
 * page has is removed (`removed`); one Hub has not is recorded as forgotten
 * all the same (`absent`); either way it is never registered again — a
 * registration still under way is refused when it commits (Astra's review
 * of PR 16, round 2). A bound one is refused (`bound`), nothing written.
 */
export async function forgetPageBrowserProfile(
  tx: Database,
  input: { profileId: string; by: string },
): Promise<{ outcome: "removed"; profile: OnboardingProfile } | { outcome: "absent" } | { outcome: "bound"; pageId: number }> {
  await lockProfileId(tx, input.profileId);
  const profile = await findOnboardingProfile(tx, input.profileId);
  if (profile !== null && profile.pageId !== null) return { outcome: "bound", pageId: profile.pageId };
  if (profile !== null && !(await deleteUnboundPageBrowser(tx, input.profileId))) {
    throw new Error(`Profile ${input.profileId} could not be removed`);
  }
  await tx.execute(sql`
    insert into page_browser_forgotten_profiles (profile_id, forgotten_by, was_registered)
    values (${input.profileId}::uuid, ${input.by}, ${profile !== null})
    on conflict (profile_id) do nothing
  `);
  return profile === null ? { outcome: "absent" } : { outcome: "removed", profile };
}

/** Whether Hub forgot a profile (or said it never had it). */
export async function isPageBrowserProfileForgotten(db: Database, profileId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(profileId)) return false;
  const result = await db.execute(sql`select 1 from page_browser_forgotten_profiles where profile_id = ${profileId}::uuid`);
  return result.rows.length === 1;
}

// ── reads ──────────────────────────────────────────────────────────────────

/** A profile by its id, bound or not (null: none). */
export async function findOnboardingProfile(db: Database, profileId: string): Promise<OnboardingProfile | null> {
  if (!/^[0-9a-f-]{36}$/i.test(profileId)) return null;
  const result = await db.execute<SqlRow>(sql`select ${columns} from page_browsers b where b.profile_id = ${profileId}::uuid`);
  const row = result.rows[0];
  return row === undefined ? null : profileOf(row);
}

/** A profile's row locked until the caller's transaction ends: whether a
 *  page has it (null: no such profile). */
export async function lockPageBrowserProfile(tx: Database, profileId: string): Promise<{ pageId: number | null } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(profileId)) return null;
  const result = await tx.execute<{ pageId: string | null }>(sql`
    select page_id::text as "pageId" from page_browsers where profile_id = ${profileId}::uuid for no key update
  `);
  const row = result.rows[0];
  return row === undefined ? null : { pageId: row.pageId === null ? null : Number(row.pageId) };
}

/** Every profile no page has yet, the oldest first. */
export async function listUnboundPageBrowsers(db: Database): Promise<OnboardingProfile[]> {
  const result = await db.execute<SqlRow>(sql`select ${columns} from page_browsers b where b.page_id is null order by b.created_at, b.profile_id`);
  return result.rows.map(profileOf);
}

/** The profiles no page has whose engine link is wanted: an onboarding under
 *  way, or an identity request not answered. */
export async function listOnboardingLinksWanted(db: Database): Promise<OnboardingProfile[]> {
  const result = await db.execute<SqlRow>(sql`
    select ${columns} from page_browsers b
     where b.page_id is null
       and (b.onboarding <> 'off'
            or (b.identity_request_id is not null
                and (b.identity_result is null or b.identity_result->>'requestId' is distinct from b.identity_request_id::text)))
     order by b.created_at, b.profile_id
  `);
  return result.rows.map(profileOf);
}

// ── the owner's levers (API) ───────────────────────────────────────────────

/** The proxy the owner gives for the page to be (its auth sealed by the
 *  caller). Only a profile no page has. True: written. */
export async function setOnboardingProxy(
  db: Database,
  input: { profileId: string; url: string; encryptedAuth: string | null; keyVersion: number | null },
): Promise<boolean> {
  if ((input.encryptedAuth === null) !== (input.keyVersion === null)) throw new Error("A sealed auth goes with its key version");
  const result = await db.execute(sql`
    update page_browsers
       set onboarding_proxy_url = ${input.url},
           onboarding_proxy_auth = ${input.encryptedAuth},
           onboarding_proxy_key_version = ${input.keyVersion}::integer,
           updated_at = clock_timestamp()
     where profile_id = ${input.profileId}::uuid and page_id is null
    returning profile_id
  `);
  return result.rows.length === 1;
}

export type SetOnboardingResult =
  | { kind: "changed"; from: PageBrowserOnboardingState; to: PageBrowserOnboardingState }
  | { kind: "unchanged"; state: PageBrowserOnboardingState }
  | { kind: "refused"; state: PageBrowserOnboardingState; why: string }
  | { kind: "bound"; pageId: number }
  | { kind: "no_profile" };

/** A change of `onboarding`: its generation raised, the identity request and
 *  its answer void. */
const voidedIdentity = sql`
  onboarding_generation = onboarding_generation + 1,
  identity_request_id = null, identity_request_source = null, identity_requested_at = null,
  identity_result = null, identity_attempt_id = null`;

/** Where the owner may move the onboarding from (`closing` is the engine's
 *  to end). */
const OWNER_MOVES: Record<"login" | "open" | "closing", readonly PageBrowserOnboardingState[]> = {
  // His login: from nothing, or again after it was closed.
  login: ["off", "open"],
  // The login closed (the automation back), or an onboarding opened again
  // to check a profile logged in before.
  open: ["off", "login"],
  // Given up.
  closing: ["login", "open"],
};

/** The owner moves the onboarding of a profile no page has. Locked with the
 *  row: one move at a time. Every move raises the onboarding generation and
 *  voids the identity request and its answer: what the browser's account was
 *  before it proves nothing after (a person may log it in again). */
export async function setPageBrowserOnboarding(
  tx: Database,
  input: { profileId: string; to: "login" | "open" | "closing"; by: string },
): Promise<SetOnboardingResult> {
  const current = await tx.execute<{ pageId: string | null; onboarding: PageBrowserOnboardingState }>(sql`
    select page_id::text as "pageId", onboarding from page_browsers where profile_id = ${input.profileId}::uuid for no key update
  `);
  const row = current.rows[0];
  if (row === undefined) return { kind: "no_profile" };
  if (row.pageId !== null) return { kind: "bound", pageId: Number(row.pageId) };
  if (row.onboarding === input.to) return { kind: "unchanged", state: row.onboarding };
  if (!OWNER_MOVES[input.to].includes(row.onboarding)) {
    return { kind: "refused", state: row.onboarding, why: `the onboarding is ${row.onboarding}: it does not go to ${input.to} from there` };
  }
  await tx.execute(sql`
    update page_browsers
       set onboarding = ${input.to}, onboarding_changed_at = clock_timestamp(), onboarding_changed_by = ${input.by},
           ${voidedIdentity},
           updated_at = clock_timestamp()
     where profile_id = ${input.profileId}::uuid
  `);
  return { kind: "changed", from: row.onboarding, to: input.to };
}

/** An identity request of the owner (one `GET /account/me` through the
 *  browser). Only a profile no page has whose onboarding is open (the
 *  automation back: the operator sends no Hub request while a person is in
 *  the page). */
export async function requestOnboardingIdentity(
  db: Database,
  input: { profileId: string; source: OnboardingIdentitySource },
): Promise<{ kind: "requested"; requestId: string } | { kind: "refused"; why: "no_profile" | "bound" | "not_open"; state: PageBrowserOnboardingState | null }> {
  const result = await db.execute<{ requestId: string }>(sql`
    update page_browsers
       set identity_request_id = gen_random_uuid(), identity_request_source = ${input.source},
           identity_requested_at = clock_timestamp(), identity_attempt_id = null, updated_at = clock_timestamp()
     where profile_id = ${input.profileId}::uuid and page_id is null and onboarding = 'open'
    returning identity_request_id::text as "requestId"
  `);
  const row = result.rows[0];
  if (row !== undefined) return { kind: "requested", requestId: row.requestId };
  const profile = await findOnboardingProfile(db, input.profileId);
  if (profile === null) return { kind: "refused", why: "no_profile", state: null };
  if (profile.pageId !== null) return { kind: "refused", why: "bound", state: profile.onboarding };
  return { kind: "refused", why: "not_open", state: profile.onboarding };
}

// ── the engine's link to a profile no page has ─────────────────────────────

/** The link of an earlier take (or a binding, a removal) holds the profile
 *  now: nothing of this link is written. */
export class OnboardingLinkLostError extends Error {
  constructor(readonly profileId: string, readonly generation: bigint) {
    super(`Page browser profile ${profileId}: link generation ${generation} no longer holds it`);
    this.name = "OnboardingLinkLostError";
  }
}

/** The engine takes the link to a profile no page has: its generation,
 *  raised (null: no such profile, or bound). */
export async function takeOnboardingLink(db: Database, profileId: string): Promise<bigint | null> {
  const result = await db.execute<{ generation: string }>(sql`
    update page_browsers set link_generation = link_generation + 1, updated_at = clock_timestamp()
     where profile_id = ${profileId}::uuid and page_id is null
    returning link_generation::text as generation
  `);
  const row = result.rows[0];
  return row === undefined ? null : BigInt(row.generation);
}

/** The link's fence: the profile is still no page's and still this link's
 *  (locked until the caller's transaction ends). Throws
 *  `OnboardingLinkLostError` otherwise. */
export async function lockOnboardingLink(tx: Database, input: { profileId: string; generation: bigint }): Promise<OnboardingProfile> {
  const result = await tx.execute<SqlRow>(sql`
    select ${columns} from page_browsers b
     where b.profile_id = ${input.profileId}::uuid and b.page_id is null and b.link_generation = ${input.generation.toString()}::bigint
       for no key update of b
  `);
  const row = result.rows[0];
  if (row === undefined) throw new OnboardingLinkLostError(input.profileId, input.generation);
  return profileOf(row);
}

/** A closing onboarding ends (`off`): the engine stopped the browser, or it
 *  cannot be reached. Under the caller's `lockOnboardingLink`. True: ended. */
export async function endPageBrowserOnboarding(tx: Database, input: { profileId: string; by: string }): Promise<boolean> {
  const result = await tx.execute(sql`
    update page_browsers
       set onboarding = 'off', onboarding_changed_at = clock_timestamp(), onboarding_changed_by = ${input.by},
           ${voidedIdentity},
           updated_at = clock_timestamp()
     where profile_id = ${input.profileId}::uuid and page_id is null and onboarding = 'closing'
    returning profile_id
  `);
  return result.rows.length === 1;
}

/** The engine's answer to an identity request, under its link's lock. Only
 *  the request it answers (a newer one waits for its own; a move voided it).
 *  An account only while the onboarding is open in the generation it was
 *  read in. True: written. */
export async function recordOnboardingIdentity(
  tx: Database,
  input: { profileId: string; result: OnboardingIdentityResult },
): Promise<boolean> {
  const fresh = input.result.ok
    ? sql`and onboarding = 'open' and onboarding_generation = ${input.result.onboardingGeneration}::bigint`
    : sql``;
  // The answer of a read is the bound attempt's only.
  const attempt = input.result.attemptId === undefined ? sql`` : sql`and identity_attempt_id = ${input.result.attemptId}::bigint`;
  const result = await tx.execute(sql`
    update page_browsers
       set identity_result = ${JSON.stringify(input.result)}::jsonb, updated_at = clock_timestamp()
     where profile_id = ${input.profileId}::uuid and page_id is null
       and identity_request_id = ${input.result.requestId}::uuid
       ${fresh}
       ${attempt}
    returning profile_id
  `);
  return result.rows.length === 1;
}

/**
 * The identity request's one read bound to its attempt, under the caller's
 * `lockOnboardingLink`, in the transaction that gives the read its grant —
 * before it may go (Astra's review of PR 16, round 6). False: the request
 * is gone, or its read was granted to another attempt already — this one
 * never goes.
 */
export async function bindIdentityAttempt(tx: Database, input: { profileId: string; requestId: string; attemptId: number }): Promise<boolean> {
  const result = await tx.execute(sql`
    update page_browsers set identity_attempt_id = ${input.attemptId}::bigint, updated_at = clock_timestamp()
     where profile_id = ${input.profileId}::uuid and page_id is null and identity_request_id = ${input.requestId}::uuid
       and (identity_attempt_id is null or identity_attempt_id = ${input.attemptId}::bigint)
    returning profile_id
  `);
  return result.rows.length === 1;
}

/**
 * A request whose read was granted (to `attemptId`) and never answered — its
 * link ended before the answer: answered as not known, under the caller's
 * `lockOnboardingLink`, unless an answer of it is there already. It is never
 * read again; a new request reads anew. True: written.
 */
export async function recordIdentityIndeterminate(
  tx: Database,
  input: { profileId: string; requestId: string; attemptId: number; why: string },
): Promise<boolean> {
  const answer: OnboardingIdentityResult = { requestId: input.requestId, ok: false, error: input.why, httpStatus: null, at: new Date().toISOString(), attemptId: input.attemptId, indeterminate: true };
  const result = await tx.execute(sql`
    update page_browsers set identity_result = ${JSON.stringify(answer)}::jsonb, updated_at = clock_timestamp()
     where profile_id = ${input.profileId}::uuid and page_id is null
       and identity_request_id = ${input.requestId}::uuid and identity_attempt_id = ${input.attemptId}::bigint
       and (identity_result is null or identity_result->>'requestId' is distinct from ${input.requestId})
    returning profile_id
  `);
  return result.rows.length === 1;
}

/** The attempt id of a send through a profile's browser: drawn from the
 *  engine's attempts' sequence, so the operator — which keeps every attempt
 *  id it saw, across restarts — never sees it again from the page's own
 *  attempts once the profile is bound. */
export async function nextBrowserAttemptId(db: Database): Promise<number> {
  const result = await db.execute<{ id: string }>(sql`select nextval(pg_get_serial_sequence('sync_attempts', 'id'))::text as id`);
  return Number(result.rows[0]!.id);
}

/** A send through the browser of a profile no page has, journaled before it
 *  may go (`fansly_send_log`, page null, as the check of a session without a
 *  page is): its pause's setting and jitter, the profile and its attempt. */
export async function journalBrowserProfileSend(
  db: Database,
  input: {
    token: string;
    source: "onboarding" | "credentials_verify";
    operation: string;
    holder: FanslySendHolderIdentity;
    profileId: string;
    attemptId: number;
    settingMs: number;
    jitterU: number;
    pauseMs: number;
  },
): Promise<void> {
  await db.execute(sql`
    insert into fansly_send_log (
      page_id, guard_token, source, operation, holder_host, holder_pid, holder_role, holder_instance, captured_at,
      setting_ms, jitter_u, pause_ms, browser_profile_id, browser_attempt_id
    ) values (
      null, ${input.token}::uuid, ${input.source}, ${input.operation}, ${input.holder.host}, ${input.holder.pid},
      ${input.holder.role}, ${input.holder.instance}::uuid, clock_timestamp(),
      ${Math.round(input.settingMs)}::integer, ${input.jitterU}, ${Math.round(input.pauseMs)}::integer,
      ${input.profileId}::uuid, ${input.attemptId}::bigint
    )
  `);
}

/** A new link's start: the sends of the profile's earlier links that never
 *  completed are closed as unknown (they may have gone: their capture still
 *  counts for the pause). The number closed. */
export async function closeUnfinishedBrowserProfileSends(db: Database, profileId: string): Promise<number> {
  const result = await db.execute(sql`
    update fansly_send_log
       set completed_at = clock_timestamp(), outcome = 'transport_error',
           outcome_detail = 'unknown: a link of the profile ended before its outcome'
     where browser_profile_id = ${profileId}::uuid and completed_at is null
    returning id
  `);
  return result.rows.length;
}

/** The latest send of a profile's browser the journal knows of — its send,
 *  its completion, or the capture of one never completed (it may still be
 *  sending) — within `lookbackMs`; null: none. A new link's first send waits
 *  for 1.2 × S after it (plan §4.7, as a page's takeover). */
export async function lastBrowserProfileSendAt(db: Database, input: { profileId: string; lookbackMs: number }): Promise<Date | null> {
  const result = await db.execute<{ at: Date | string | null }>(sql`
    select max(greatest(sent_at, completed_at, case when completed_at is null then captured_at end)) as at
      from fansly_send_log
     where browser_profile_id = ${input.profileId}::uuid
       and captured_at >= clock_timestamp() - (${Math.max(0, Math.round(input.lookbackMs))}::text || ' milliseconds')::interval
  `);
  return dateOf(result.rows[0]?.at ?? null);
}

/** The profile's sends the journal holds since `since` that may have gone
 *  (the hour's ceiling of the site's requests, spec §3): every one but what
 *  never went (`aborted_before_send`) — one still unfinished, or closed as
 *  unknown when its link ended before its outcome, counts (Astra's review of
 *  PR 16, item 5). */
export async function countBrowserProfileSendsSince(db: Database, input: { profileId: string; since: Date }): Promise<number> {
  const result = await db.execute<{ n: string }>(sql`
    select count(*)::text as n from fansly_send_log
     where browser_profile_id = ${input.profileId}::uuid and captured_at >= ${input.since.toISOString()}::timestamptz
       and (sent_at is not null or outcome is distinct from 'aborted_before_send')
  `);
  return Number(result.rows[0]?.n ?? 0);
}

/** A route hold an answer put on the profile (a 429, a 5xx naming its own
 *  deadline), as its send's completion records it in `outcome_detail`. */
export function browserProfileRouteHoldDetail(holdMs: number): string {
  return `route_hold_ms=${Math.max(0, Math.ceil(holdMs))}`;
}

/**
 * The profile's route clocks' journal read (Astra's review of PR 16, item
 * 4), as `readRouteJournal` reads a page's: per operation, the newest send
 * of the profile whose capture lies within `withinMs` +
 * `SYNC_ROUTE_JOURNAL_SLACK_MS` — its actual send; without one, a send that
 * may have gone counts at its completion, else its capture + the send window
 * (an unknown outcome consumes budget); only what never went
 * (`aborted_before_send`) does not count. And per operation, the latest end
 * of a route hold an answer put on it within `holdsWithinMs`
 * (`browserProfileRouteHoldDetail`): a new link (a restart) is held as the
 * one before was.
 */
export async function readBrowserProfileRouteJournal(
  db: Database,
  input: { profileId: string; withinMs: number; holdsWithinMs: number },
): Promise<{ sends: Array<{ operation: string; lastAt: Date }>; holds: Array<{ operation: string; until: Date }> }> {
  const scanMs = Math.max(0, input.withinMs) + SYNC_ROUTE_JOURNAL_SLACK_MS;
  const sends = await db.execute<{ operation: string; lastAt: Date | string }>(sql`
    select operation,
           max(coalesce(sent_at, completed_at, lease_until,
             captured_at + ${SYNC_SEND_WINDOW_MS}::double precision * interval '1 millisecond')) as "lastAt"
      from fansly_send_log
     where browser_profile_id = ${input.profileId}::uuid
       and captured_at > statement_timestamp() - ${scanMs}::double precision * interval '1 millisecond'
       and (sent_at is not null or outcome is distinct from 'aborted_before_send')
     group by operation
  `);
  const holds = await db.execute<{ operation: string; until: Date | string }>(sql`
    select operation,
           max(completed_at + (substring(outcome_detail from '^route_hold_ms=([0-9]+)$'))::double precision * interval '1 millisecond') as until
      from fansly_send_log
     where browser_profile_id = ${input.profileId}::uuid
       and captured_at > statement_timestamp() - ${Math.max(0, input.holdsWithinMs) + SYNC_ROUTE_JOURNAL_SLACK_MS}::double precision * interval '1 millisecond'
       and completed_at is not null
       and outcome_detail ~ '^route_hold_ms=[0-9]+$'
     group by operation
  `);
  return {
    sends: sends.rows.map((row) => ({ operation: row.operation, lastAt: dateOf(row.lastAt)! })),
    holds: holds.rows.map((row) => ({ operation: row.operation, until: dateOf(row.until)! })),
  };
}

/** Where the intake of the profile's buffer stands (0276's columns, the
 *  profile's: the page's intake goes on from it once bound). */
export async function readProfileIntakePosition(db: Database, profileId: string): Promise<{ bufferId: string | null; ackedSeq: number } | null> {
  const result = await db.execute<{ bufferId: string | null; ackedSeq: string }>(sql`
    select events_buffer_id::text as "bufferId", events_acked_seq::text as "ackedSeq" from page_browsers where profile_id = ${profileId}::uuid
  `);
  const row = result.rows[0];
  return row === undefined ? null : { bufferId: row.bufferId, ackedSeq: Number(row.ackedSeq) };
}

// ── the binding ────────────────────────────────────────────────────────────

export type OnboardingBindingRefusal = "no_profile" | "bound" | "not_open" | "identity_changed";

/**
 * The profile's row locked for its binding (`for update`, until the caller's
 * transaction ends: the owner's moves and the engine's grants wait), and
 * whether the identity check `requestId` still proves its account: no page
 * yet, the onboarding open, that request the profile's and answered with an
 * account in the onboarding generation that still holds (Astra's review of
 * PR 16, item 2). The profile as locked, or why not.
 */
export async function lockOnboardingForBinding(
  tx: Database,
  input: { profileId: string; requestId: string },
): Promise<{ ok: true; profile: OnboardingProfile; identity: Extract<OnboardingIdentityResult, { ok: true }> } | { ok: false; why: OnboardingBindingRefusal }> {
  if (!/^[0-9a-f-]{36}$/i.test(input.profileId)) return { ok: false, why: "no_profile" };
  const locked = await tx.execute<SqlRow>(sql`select ${columns} from page_browsers b where b.profile_id = ${input.profileId}::uuid for update of b`);
  const row = locked.rows[0];
  if (row === undefined) return { ok: false, why: "no_profile" };
  const profile = profileOf(row);
  if (profile.pageId !== null) return { ok: false, why: "bound" };
  if (profile.onboarding !== "open") return { ok: false, why: "not_open" };
  const identity = profile.identityResult;
  if (
    profile.identityRequest?.id !== input.requestId || identity === null || !identity.ok || identity.requestId !== input.requestId
    || identity.onboardingGeneration !== profile.onboardingGeneration.toString()
  ) {
    return { ok: false, why: "identity_changed" };
  }
  return { ok: true, profile, identity };
}

/**
 * Bind a profile no page has to the page just created (plan §3.2, step 4),
 * in the caller's transaction with the page's own rows, after
 * `lockOnboardingForBinding`: its onboarding off, its link fenced off
 * (`link_generation` raised), the proxy it carried for the page cleared (the
 * page keeps it now). No copy: the volumes are named by the profile. Only
 * while the identity check `requestId` still proves its account, in the
 * generation `onboardingGeneration`, the onboarding open. False: not so —
 * the caller rolls back.
 */
export async function bindOnboardedProfile(
  tx: Database,
  input: { profileId: string; pageId: number; requestId: string; onboardingGeneration: bigint },
): Promise<boolean> {
  const result = await tx.execute(sql`
    update page_browsers
       set page_id = ${input.pageId}::bigint,
           onboarding = 'off', onboarding_changed_at = clock_timestamp(), onboarding_changed_by = 'binding',
           link_generation = link_generation + 1,
           onboarding_generation = onboarding_generation + 1,
           onboarding_proxy_url = null, onboarding_proxy_auth = null, onboarding_proxy_key_version = null,
           identity_request_id = null, identity_request_source = null, identity_requested_at = null,
           identity_attempt_id = null,
           updated_at = clock_timestamp()
     where profile_id = ${input.profileId}::uuid and page_id is null and onboarding = 'open'
       and onboarding_generation = ${input.onboardingGeneration.toString()}::bigint
       and identity_request_id = ${input.requestId}::uuid
       and identity_result->>'requestId' = ${input.requestId}
       and identity_result->>'ok' = 'true'
       and identity_result->>'onboardingGeneration' = onboarding_generation::text
    returning profile_id
  `);
  return result.rows.length === 1;
}
