import {
  createOnlyFansPage,
  createFanslyPage,
  DuplicatePageLabelError,
  findModelBySlug,
  PlatformAccountIdentityConflictError,
  PlatformAccountIdentityImmutableError,
  storePlatformCredentials,
  updatePageMetadata,
} from "@agency_hub_core/db";
import {
  buildProxyEgressKey,
  encryptJson,
  normalizeProxyConfig,
  redactSensitiveText,
  toMills,
  type FanslySessionBundle,
  type OnlyMonsterTokenBundle,
  type ProxyConfig,
  type StoredPlatformCredentialBundle,
} from "@agency_hub_core/shared";
import type { OnlyMonsterAccount } from "@agency_hub_core/onlyfans";

import type { AppContext } from "../bootstrap.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import { buildFanslyMetadata } from "./fansly.ts";
import {
  buildOnlyFansMetadata,
  findOnlyFansAccountByUsername,
  resolveOnlyFansDisplayName,
} from "./onlyfans.ts";
import { saveProxy } from "./page-context.ts";
import { assertAllowedProxyTarget } from "./proxy-validation.ts";
import { createSyncRateLimitWaiter } from "./sync/rate-limiter.ts";

type FanslyOnboardingContext = Pick<AppContext, "db" | "config"> & {
  adapter: Pick<AppContext["adapter"], "verifySession">;
};

type OnlyFansOnboardingContext = Pick<AppContext, "db" | "config"> & {
  onlyFansAdapter: Pick<AppContext["onlyFansAdapter"], "listAccountsPage" | "getAccount">;
};

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
        earningsBalanceMills: toMills(verified.account.earningsWallet?.balance ?? 0),
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
    auth: OnlyMonsterTokenBundle;
    username: string;
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
  const lookupContext = {
    auth: input.auth,
    proxy,
    egressKey,
    rateLimitWaiter,
  };
  const account = await findOnlyFansAccountByUsername(
    app.onlyFansAdapter,
    lookupContext,
    input.username,
  );
  const verification = await app.onlyFansAdapter.getAccount(lookupContext, account.id);
  const verified = verification.parsed.account;

  let page;
  try {
    page = await app.db.transaction(async (tx) => {
      const dbTx = tx as unknown as typeof app.db;
      const created = await createOnlyFansPage(dbTx, {
        modelId: model.id,
        label: input.label,
      });

      await storePlatformCredentials(dbTx, {
        platformAccountId: created.id,
        encryptedSession: encryptCredentials({
          platform: "onlyfans",
          auth: input.auth,
        }, app),
        keyVersion: app.config.encryptionKeyVersion,
      });

      await storeProxyIfPresent({ ...app, db: dbTx }, created.id, proxy);

      await updatePageMetadata(dbTx, created.id, {
        platformAccountIdValue: verified.platform_account_id,
        username: verified.username,
        displayName: resolveOnlyFansDisplayName(verified),
        followerCount: null,
        subscriberCount: null,
        earningsBalanceMills: 0n,
        metadata: buildOnlyFansMetadata(verified),
        syncType: "light",
      });

      return created;
    });
  } catch (error) {
    rethrowPageIdentityConflict(error);
  }

  return {
    page,
    verified,
  } satisfies {
    page: typeof page;
    verified: OnlyMonsterAccount;
  };
}
