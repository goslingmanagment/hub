import {
  DuplicatePageLabelError,
  OfapiAccountCustodyConflictError,
  PlatformAccountIdentityConflictError,
  PlatformAccountIdentityImmutableError,
  bindOnboardedProfile,
  createFanslyPage,
  createLiveSyncPage,
  findModelBySlug,
  findObservationEnvelopesByIds,
  findOnboardingProfile,
  insertAuditEvent,
  lockOnboardingForBinding,
  requestOnboardingIdentity,
  upsertDemands,
  type Database,
  type OnboardingIdentityResult,
  type OnboardingBindingRefusal,
  type OnboardingIdentitySource,
  type OnboardingProfile,
} from "@agency_hub_core/db";
import { fanslyWireSpec, readFanslyWireResponse, type FanslyAccountMe } from "@agency_hub_core/fansly";
import { decryptJsonWithKeyVersion } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { fanslyNewPageWork } from "../sync/fansly/registry.ts";
import { applyAccountMeToPage } from "../sync/fansly/resources/account.ts";
import { AppError, BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import { saveProxy } from "./page-context.ts";

// A new Fansly page connected through its own server browser (Project
// Browser plan §3.2 «Подключение новой страницы через браузер», steps 3–4;
// stage 3 PR 16) — the two entry points of today's onboarding, through the
// browser for a profile that has one:
//
// - the owner's credentials check (`POST /api/v1/admin/credentials/verify`
//   with `browserProfileId`): the engine reads the account the browser's live
//   session belongs to — one `GET /account/me` through the browser, journaled
//   without a page and its answer in `observations` — and the answer is the
//   account, or why not, as the check of a pasted session answers;
// - the page's creation (`POST /api/v1/admin/pages` with `browserProfileId`):
//   that check again, then in ONE transaction the page, its proxy (the one
//   given for it), the account the check proved (applied from its
//   observation), its engine row born on its browser, the profile bound to it
//   and its history walks — no copy of the profile (its volumes are named by
//   it), no session in Hub. A refused creation writes nothing: the profile
//   stays unbound. The creation takes the profile's row lock first and goes
//   on only while the check still proves the account — the onboarding open,
//   the check the profile's, in the onboarding generation it was read in: an
//   onboarding given up, or a login opened again, since the check refuses the
//   whole creation (Astra's review of PR 16, item 2).
//
// The API never talks to the engine but through the database: it writes the
// request (`identity_request_id`), the engine's onboarding link answers
// (`identity_result`), the API waits for it up to `BROWSER_IDENTITY_WAIT_MS`.
//
// The page is born untrusted (`credentials_generation` null): nothing
// ordinary goes before the engine's own account check through the browser
// under the page's own hello (checks-only, G2) — the operator confirms the
// session to the page's expected account only then (plan §4.1, step 9).

export const PAGE_BROWSER_ONBOARDING_AUDIT_EVENT = "admin.page_browser_onboarding";

/** How long the API waits for the engine's answer to an identity request. */
export const BROWSER_IDENTITY_WAIT_MS = 30_000;
const IDENTITY_POLL_MS = 200;

type OnboardingContext = Pick<AppContext, "db" | "config" | "logger">;

/** The page label a profile was made for: its container's name. */
export function profilePageName(profile: Pick<OnboardingProfile, "container">): string {
  return profile.container.replace(/^page-browser-/, "");
}

/** The proxy given for a page to be, opened (its auth decrypted). */
export function onboardingProxyOf(app: Pick<AppContext, "config">, profile: OnboardingProfile): { url: string; username: string | null; password: string | null } | null {
  if (profile.proxy === null) return null;
  const auth = profile.proxy.encryptedAuth === null
    ? null
    : decryptJsonWithKeyVersion<{ username: string | null; password: string | null }>(profile.proxy.encryptedAuth, app.config.encryptionKeysByVersion);
  return { url: profile.proxy.url, username: auth?.username ?? null, password: auth?.password ?? null };
}

/** A profile no page has, or the API's refusal. */
async function unboundProfile(db: Database, profileId: string): Promise<OnboardingProfile> {
  const profile = await findOnboardingProfile(db, profileId);
  if (profile === null) throw new NotFoundError(`No page browser profile ${profileId}`);
  if (profile.pageId !== null) throw new ConflictError(`Page browser profile ${profileId} is bound to a page already`);
  return profile;
}

/**
 * Ask the engine for the account the browser's live session belongs to and
 * wait for its answer. Throws `BadRequestError` with the reason when the
 * check failed (as the check of a pasted session does), 409 when the
 * onboarding is not open (the owner's login under way, or none) or the
 * engine has not answered in time.
 */
export async function checkFanslyIdentityThroughBrowser(
  app: OnboardingContext,
  input: { profileId: string; source: OnboardingIdentitySource; waitMs?: number },
): Promise<Extract<OnboardingIdentityResult, { ok: true }>> {
  const requested = await requestOnboardingIdentity(app.db, { profileId: input.profileId, source: input.source });
  if (requested.kind === "refused") {
    switch (requested.why) {
      case "no_profile":
        throw new NotFoundError(`No page browser profile ${input.profileId}`);
      case "bound":
        throw new ConflictError(`Page browser profile ${input.profileId} is bound to a page already`);
      case "not_open":
        throw new AppError(
          requested.state === "login"
            ? "The login of the browser is still open: finish it first, then the account is checked through the browser"
            : "The browser's onboarding is not open: log the browser in first",
          409,
          "onboarding_not_open",
        );
    }
  }
  const deadline = Date.now() + (input.waitMs ?? BROWSER_IDENTITY_WAIT_MS);
  for (;;) {
    const profile = await findOnboardingProfile(app.db, input.profileId);
    if (profile === null) throw new NotFoundError(`No page browser profile ${input.profileId}`);
    const result = profile.identityResult;
    if (result !== null && result.requestId === requested.requestId) {
      if (!result.ok) throw new BadRequestError(`Credential verification failed: ${result.error}`);
      return result;
    }
    if (profile.pageId !== null) throw new ConflictError(`Page browser profile ${input.profileId} was bound meanwhile`);
    if (profile.identityRequest?.id !== requested.requestId) {
      // A move of the onboarding voided it (a login opened again, given up).
      throw new AppError("The browser's onboarding changed while its account was checked: check again", 409, "onboarding_changed");
    }
    if (Date.now() >= deadline) {
      throw new AppError(
        "The engine has not read the account through the browser yet: try again in a few seconds (is the sync process running?)",
        409,
        "browser_identity_pending",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, IDENTITY_POLL_MS));
  }
}

/** The account an identity check journaled, read back from its observation
 *  through the route's contract (capture before parse). */
async function accountOfObservation(db: Database, observationId: number): Promise<FanslyAccountMe["account"]> {
  const envelopes = await findObservationEnvelopesByIds(db, [observationId]);
  const envelope = envelopes.get(observationId);
  if (envelope === undefined) throw new Error(`The identity check's observation ${observationId} is gone`);
  const spec = fanslyWireSpec("account.me");
  const read = readFanslyWireResponse(spec, {}, { status: 200, headers: {}, bodyText: JSON.stringify({ success: true, response: envelope.payload }) });
  if (read.kind !== "accepted") throw new Error(`The identity check's observation ${observationId} is not an account`);
  return read.value.account;
}

const BINDING_REFUSALS: Record<OnboardingBindingRefusal, string> = {
  no_profile: "is gone",
  bound: "is bound to a page already",
  not_open: "is no longer open (given up, or its login opened again)",
  identity_changed: "was checked again, or its login opened again, since its account was read",
};

/**
 * A new Fansly page on its own browser: the account checked through the
 * browser, then the page born bound to the profile, in one transaction.
 */
export async function onboardFanslyPageThroughBrowser(
  app: OnboardingContext,
  input: { modelSlug: string; label: string; profileId: string; by: string; actorUserId?: number | null },
) {
  const model = await findModelBySlug(app.db, input.modelSlug);
  if (!model) throw new NotFoundError(`Model "${input.modelSlug}" does not exist`);
  const profile = await unboundProfile(app.db, input.profileId);
  assertPageLabel(profile, input);
  if (profile.proxy === null) throw new AppError("No proxy is given for the new page's browser", 409, "browser_not_ready");
  const identity = await checkFanslyIdentityThroughBrowser(app, { profileId: input.profileId, source: "onboarding" });
  return bindNewFanslyPageThroughBrowser(app, { ...input, modelId: model.id, identity });
}

/** The page's label must be the name the server knows its container by
 *  (to-node, up, down). */
function assertPageLabel(profile: OnboardingProfile, input: { profileId: string; label: string }): void {
  const name = profilePageName(profile);
  if (input.label !== name) {
    throw new BadRequestError(`The browser of profile ${input.profileId} was made for the page "${name}": its label must be "${name}"`);
  }
}

/**
 * The page born bound to the profile, in one transaction, on the proof of
 * the identity check `identity` — re-read under the profile's row lock taken
 * first: the onboarding still open, that check still the profile's, in the
 * generation it was read in; its proxy as stored now. Anything else refuses
 * the whole creation: nothing is written, the profile stays unbound.
 */
export async function bindNewFanslyPageThroughBrowser(
  app: OnboardingContext,
  input: { modelId: number; label: string; profileId: string; by: string; actorUserId?: number | null; identity: Extract<OnboardingIdentityResult, { ok: true }> },
) {
  const account = await accountOfObservation(app.db, input.identity.observationId);
  if (account.id !== input.identity.accountId) throw new Error("The identity check's observation names another account");
  let born;
  try {
    born = await app.db.transaction(async (raw) => {
      const tx = raw as unknown as Database;
      const locked = await lockOnboardingForBinding(tx, { profileId: input.profileId, requestId: input.identity.requestId });
      if (!locked.ok) {
        if (locked.why === "no_profile") throw new NotFoundError(`No page browser profile ${input.profileId}`);
        throw new ConflictError(`The onboarding of page browser profile ${input.profileId} ${BINDING_REFUSALS[locked.why]}: nothing was created`);
      }
      const { profile, identity } = locked;
      assertPageLabel(profile, input);
      const proxy = onboardingProxyOf(app, profile);
      if (proxy === null) throw new AppError("No proxy is given for the new page's browser", 409, "browser_not_ready");
      if (identity.accountId !== account.id) throw new ConflictError("The account the browser named changed meanwhile: check again");
      const created = await createFanslyPage(tx, { modelId: input.modelId, label: input.label });
      if (!created) throw new Error(`Page "${input.label}" was not created`);
      // No session of the page in Hub: it lives in the browser's profile.
      await saveProxy({ ...app, db: tx }, created.id, proxy);
      await applyAccountMeToPage(tx, { pageId: created.id, account, syncType: "light" });
      await createLiveSyncPage(tx, {
        pageId: created.id,
        by: `onboarding:${input.by}`,
        identityAccountId: account.id,
        identityCheckedAt: new Date(identity.sentAt),
        // Untrusted until the engine's own check under the page's hello.
        credentialsGeneration: null,
      });
      const bound = await bindOnboardedProfile(tx, {
        profileId: input.profileId,
        pageId: created.id,
        requestId: identity.requestId,
        onboardingGeneration: profile.onboardingGeneration,
      });
      if (!bound) throw new ConflictError(`Page browser profile ${input.profileId} was bound or removed meanwhile`);
      const work = fanslyNewPageWork({ pageId: created.id, now: new Date() });
      await upsertDemands(tx, work);
      await insertAuditEvent(tx, {
        actorUserId: input.actorUserId ?? null,
        platformAccountId: created.id,
        source: "api",
        eventType: PAGE_BROWSER_ONBOARDING_AUDIT_EVENT,
        metadata: { step: "bind", profileId: input.profileId, pageLabel: input.label, accountId: account.id, observationId: identity.observationId },
      });
      return { created, queuedAtBirth: work.map((row) => row.resource) };
    });
  } catch (error) {
    if (
      error instanceof DuplicatePageLabelError ||
      error instanceof PlatformAccountIdentityConflictError ||
      error instanceof PlatformAccountIdentityImmutableError ||
      error instanceof OfapiAccountCustodyConflictError
    ) {
      throw new ConflictError(error.message);
    }
    throw error;
  }
  return { page: born.created, account, queuedAtBirth: born.queuedAtBirth, profileId: input.profileId };
}
