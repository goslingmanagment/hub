import {
  createOnlyFansPage,
  createFanslyPage,
  findModelBySlug,
  storePlatformCredentials,
  storeProxyConfig,
  updatePageMetadata,
} from "@fansly-connect/db";
import {
  encryptJson,
  toMills,
  type FanslySessionBundle,
  type OnlyMonsterTokenBundle,
  type ProxyConfig,
  type StoredPlatformCredentialBundle,
} from "@fansly-connect/shared";
import type { OnlyMonsterAccount } from "@fansly-connect/onlyfans";

import type { AppContext } from "../bootstrap.ts";
import { NotFoundError } from "./errors.ts";
import { buildOnlyFansMetadata, findOnlyFansAccountByUsername } from "./onlyfans.ts";

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
  app: Pick<AppContext, "config">,
  db: AppContext["db"],
  platformAccountId: number,
  proxy: ProxyConfig | null,
) {
  if (!proxy) {
    return;
  }

  const encryptedAuth = proxy.username || proxy.password
    ? JSON.stringify(
      encryptJson(
        {
          username: proxy.username ?? null,
          password: proxy.password ?? null,
        },
        app.config.encryptionKey,
        app.config.encryptionKeyVersion,
      ),
    )
    : null;

  await storeProxyConfig(db, platformAccountId, {
    url: proxy.url,
    encryptedAuth,
    keyVersion: encryptedAuth ? app.config.encryptionKeyVersion : null,
  });
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

  const proxy = input.proxy ?? null;
  const verification = await app.adapter.verifySession({
    session: input.session,
    proxy,
  });
  const verified = verification.parsed;

  const page = await app.db.transaction(async (tx) => {
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

    await storeProxyIfPresent(app, dbTx, created.id, proxy);

    await updatePageMetadata(dbTx, created.id, {
      platformAccountIdValue: verified.account.id,
      username: verified.account.username,
      displayName: verified.account.displayName,
      followerCount: verified.account.followCount,
      subscriberCount: verified.account.subscriberCount,
      earningsBalanceMills: toMills(verified.account.earningsWallet?.balance ?? 0),
      metadata: {
        walls: verified.account.walls ?? [],
        subscriptionTiers: verified.account.subscriptionTiers ?? [],
      },
      syncType: "light",
    });

    return created;
  });

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

  const proxy = input.proxy ?? null;
  const lookupContext = {
    auth: input.auth,
    proxy,
  };
  const account = await findOnlyFansAccountByUsername(
    app.onlyFansAdapter,
    lookupContext,
    input.username,
  );
  const verification = await app.onlyFansAdapter.getAccount(lookupContext, account.id);
  const verified = verification.parsed.account;

  const page = await app.db.transaction(async (tx) => {
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

    await storeProxyIfPresent(app, dbTx, created.id, proxy);

    await updatePageMetadata(dbTx, created.id, {
      platformAccountIdValue: verified.platform_account_id,
      username: verified.username,
      displayName: verified.name,
      followerCount: 0,
      subscriberCount: 0,
      earningsBalanceMills: 0n,
      metadata: buildOnlyFansMetadata(verified),
      syncType: "light",
    });

    return created;
  });

  return {
    page,
    verified,
  } satisfies {
    page: typeof page;
    verified: OnlyMonsterAccount;
  };
}
