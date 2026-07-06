import {
  DuplicatePageLabelError,
  PlatformAccountIdentityConflictError,
  PlatformAccountIdentityImmutableError,
  createFanslyPage,
  createOnlyFansPage,
  findModelBySlug,
  setPageOfapiAccountId,
  storePlatformCredentials,
  updateOnlyFansPageIdentityFromOfapi,
  updatePageMetadata,
} from "@agency_hub_core/db";
import {
  buildProxyEgressKey,
  encryptJson,
  normalizeProxyConfig,
  redactSensitiveText,
  millsFromInteger,
  type FanslySessionBundle,
  type ProxyConfig,
  type StoredPlatformCredentialBundle,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import { buildFanslyMetadata } from "./fansly.ts";
import { normalizeOnlyFansAvatarUrl } from "./onlyfans.ts";
import { saveProxy } from "./page-context.ts";
import { assertAllowedProxyTarget } from "./proxy-validation.ts";
import { createSyncRateLimitWaiter } from "./sync/rate-limiter.ts";

type FanslyOnboardingContext = Pick<AppContext, "db" | "config"> & {
  adapter: Pick<AppContext["adapter"], "verifySession">;
};

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

async function storeProxyIfPresent(
  app: Pick<AppContext, "config" | "db">,
  platformAccountId: number,
  proxy: ProxyConfig | null,
) {
  if (!proxy) {
    return;
  }

  await saveProxy(app, platformAccountId, proxy);
}

function rethrowPageIdentityConflict(error: unknown): never {
  if (
    error instanceof DuplicatePageLabelError ||
    error instanceof PlatformAccountIdentityConflictError ||
    error instanceof PlatformAccountIdentityImmutableError
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

export async function onboardFanslyPage(
  app: FanslyOnboardingContext,
  input: {
    modelSlug: string;
    label: string;
    session: FanslySessionBundle;
    proxy?: ProxyConfig | null;
  },
) {
  const model = await findModelBySlug(app.db, input.modelSlug);
  if (!model) {
    throw new NotFoundError(`Model "${input.modelSlug}" does not exist`);
  }

  const proxy = input.proxy ? normalizeProxyInput(input.proxy) : null;
  if (proxy) {
    await assertAllowedProxyTarget(proxy);
  }
  const egressKey = buildProxyEgressKey(proxy);
  const rateLimitWaiter = createSyncRateLimitWaiter(app, { egressKey });
  const verification = await app.adapter.verifySession({
    session: input.session,
    proxy,
    egressKey,
    rateLimitWaiter,
  });
  const verified = verification.parsed;

  let page;
  try {
    page = await app.db.transaction(async (tx) => {
      const dbTx = tx as unknown as typeof app.db;
      const created = await createFanslyPage(dbTx, {
        modelId: model.id,
        label: input.label,
      });

      await storePlatformCredentials(dbTx, {
        platformAccountId: created.id,
        encryptedSession: encryptCredentials({
          platform: "fansly",
          session: input.session,
        }, app),
        keyVersion: app.config.encryptionKeyVersion,
      });

      await storeProxyIfPresent({ ...app, db: dbTx }, created.id, proxy);

      await updatePageMetadata(dbTx, created.id, {
        platformAccountIdValue: verified.account.id,
        username: verified.account.username,
        displayName: verified.account.displayName,
        followerCount: verified.account.followCount,
        subscriberCount: verified.account.subscriberCount,
        earningsBalanceMills: millsFromInteger(verified.account.earningsWallet?.balance ?? 0),
        metadata: buildFanslyMetadata(verified.account),
        syncType: "light",
      });

      return created;
    });
  } catch (error) {
    rethrowPageIdentityConflict(error);
  }

  return { page, verified };
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

  let page;
  try {
    page = await app.db.transaction(async (tx) => {
      const dbTx = tx as unknown as typeof app.db;
      const created = await createOnlyFansPage(dbTx, {
        modelId: model.id,
        label: input.label,
      });
      await setPageOfapiAccountId(dbTx, { pageId: created.id, ofapiAccountId: account.id });
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
