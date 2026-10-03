import {
  DuplicatePageLabelError,
  OfapiAccountCustodyConflictError,
  PlatformAccountIdentityConflictError,
  PlatformAccountIdentityImmutableError,
  createFanslyPage,
  createLiveSyncPage,
  createOnlyFansPage,
  findModelBySlug,
  setPageOfapiAccountId,
  storePlatformCredentials,
  updateOnlyFansPageIdentityFromOfapi,
} from "@agency_hub_core/db";
import {
  encryptJson,
  normalizeProxyConfig,
  redactSensitiveText,
  type FanslySessionBundle,
  type ProxyConfig,
  type StoredPlatformCredentialBundle,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { applyAccountMeToPage } from "../sync/fansly/resources/account.ts";
import { checkFanslyIdentityWithoutPage } from "../sync/fansly/identity-without-page.ts";
import { readFanslyPageGeneration } from "./egress/fansly-probe-context.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import { normalizeOnlyFansAvatarUrl } from "./onlyfans.ts";
import { saveProxy } from "./page-context.ts";

type FanslyOnboardingContext = Pick<AppContext, "db" | "config" | "logger" | "fanslySendGuards">;

type OnlyFansOnboardingContext = Pick<AppContext, "db" | "config" | "ofapi">;

function encryptCredentials(
  input: StoredPlatformCredentialBundle,
  app: Pick<AppContext, "config">,
) {
  return JSON.stringify(
    encryptJson(
      input,
      app.config.encryptionKey,
      app.config.encryptionKeyVersion,
    ),
  );
}

function rethrowPageIdentityConflict(error: unknown): never {
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

function normalizeProxyInput(proxy: ProxyConfig) {
  try {
    return normalizeProxyConfig(proxy);
  } catch (error) {
    throw new BadRequestError(
      `Invalid proxy URL: ${redactSensitiveText(error instanceof Error ? error.message : "Invalid proxy URL")}`,
    );
  }
}

/**
 * A new Fansly page (step 4 S4-05): its session is checked through the proxy
 * it will get — one journaled `/account/me` that belongs to no page yet
 * (owner decision №4) — and only then are the page, its credentials, its
 * proxy, the account the check proved and its engine row created, in ONE
 * transaction. The page is born `live` on the Fansly Sync Engine
 * (`createLiveSyncPage`): the sync host adopts it on its next pass, its first
 * request ≥ 1.2 × S after that; the legacy engine never runs it.
 */
export async function onboardFanslyPage(
  app: FanslyOnboardingContext,
  input: {
    modelSlug: string;
    label: string;
    session: FanslySessionBundle;
    proxy: ProxyConfig;
    /** Who onboards the page (the engine row's `mode_changed_by`). */
    by: string;
  },
) {
  // Keep the service boundary fail-closed even when a non-contract caller
  // reaches it (CLI/tests/internal code). Verification must never get a
  // chance to fall back to the Hub's direct address.
  if (!input.proxy) {
    throw new BadRequestError("Fansly onboarding requires a non-null proxy");
  }

  const model = await findModelBySlug(app.db, input.modelSlug);
  if (!model) {
    throw new NotFoundError(`Model "${input.modelSlug}" does not exist`);
  }

  const proxy = normalizeProxyInput(input.proxy);
  const identity = await checkFanslyIdentityWithoutPage(app, {
    session: input.session,
    proxy,
    source: "onboarding",
  });

  let page;
  try {
    page = await app.db.transaction(async (tx) => {
      const dbTx = tx as unknown as typeof app.db;
      const created = await createFanslyPage(dbTx, {
        modelId: model.id,
        label: input.label,
      });
      if (!created) throw new Error(`Page "${input.label}" was not created`);

      await storePlatformCredentials(dbTx, {
        platformAccountId: created.id,
        encryptedSession: encryptCredentials({
          platform: "fansly",
          session: input.session,
        }, app),
        keyVersion: app.config.encryptionKeyVersion,
      });

      await saveProxy({ ...app, db: dbTx }, created.id, proxy);

      // The engine's own write of an applied `/account/me` (identity,
      // counters, balance, metadata, `last_verified_at`).
      await applyAccountMeToPage(dbTx, { pageId: created.id, account: identity.account, syncType: "light" });

      await createLiveSyncPage(dbTx, {
        pageId: created.id,
        by: `onboarding:${input.by}`,
        identityAccountId: identity.account.id,
        identityCheckedAt: identity.sentAt,
        // The digest of exactly the session and proxy the check proved,
        // as stored: the engine trusts them without a verify of its own.
        credentialsGeneration: await readFanslyPageGeneration(dbTx, created.label),
      });

      return created;
    });
  } catch (error) {
    rethrowPageIdentityConflict(error);
  }

  return { page, account: identity.account };
}

export async function onboardOnlyFansPage(
  app: OnlyFansOnboardingContext,
  input: {
    modelSlug: string;
    label: string;
    username: string;
  },
) {
  // Stage 18: OnlyMonster retired — OnlyFans pages onboard against the OFAPI
  // vendor: the account must already be connected at onlyfansapi.com, and the
  // page is created pre-mapped (no pasted credentials, no per-page proxy —
  // egress is vendor-side).
  const model = await findModelBySlug(app.db, input.modelSlug);
  if (!model) {
    throw new NotFoundError(`Model "${input.modelSlug}" does not exist`);
  }
  if (!app.ofapi) {
    throw new BadRequestError("OFAPI is not configured (OFAPI_API_KEY) — OnlyFans onboarding requires it");
  }

  await app.ofapi.assertCredentialReady?.();
  const needle = input.username.trim().toLowerCase().replace(/^@/, "");
  const accounts = await app.ofapi.listAccounts();
  const matches = accounts.filter((account) =>
    (account.username ?? "").toLowerCase().replace(/^@/, "") === needle
    || (account.onlyfansName ?? "").toLowerCase() === needle,
  );
  if (matches.length === 0) {
    throw new NotFoundError(
      `No connected OFAPI account matches "${input.username}" — connect the account at the vendor first`,
    );
  }
  if (matches.length > 1) {
    throw new ConflictError(`Multiple OFAPI accounts match "${input.username}" — resolve manually`);
  }
  const account = matches[0]!;
  if (!account.onlyfansUserId || account.identityStatus === "conflict") {
    throw new ConflictError("OFAPI creator identity is unverified; username alone cannot establish a page binding");
  }

  let page;
  try {
    page = await app.db.transaction(async (tx) => {
      const dbTx = tx as unknown as typeof app.db;
      const created = await createOnlyFansPage(dbTx, {
        modelId: model.id,
        label: input.label,
      });
      await setPageOfapiAccountId(dbTx, { pageId: created.id, ofapiAccountId: account.id, creatorId: account.onlyfansUserId,
        evidence: { source: "onboarding", username: account.username } });
      await updateOnlyFansPageIdentityFromOfapi(dbTx, created.id, {
        ofapiAccountId: account.id,
        username: account.username,
        displayName: account.displayName ?? account.onlyfansName,
        metadata: {
          ...(normalizeOnlyFansAvatarUrl(account.avatarUrl)
            ? { avatarUrl: normalizeOnlyFansAvatarUrl(account.avatarUrl) }
            : {}),
          ...(account.onlyfansUserId ? { onlyfansUserId: account.onlyfansUserId } : {}),
        },
      });
      return created;
    });
  } catch (error) {
    rethrowPageIdentityConflict(error);
  }

  return {
    page,
    verified: account,
  };
}
