import {
  createFanslyPage,
  findModelBySlug,
  storeFanslySession,
  storeProxyConfig,
  updatePageMetadata,
} from "@fansly-connect/db";
import {
  encryptJson,
  toMills,
  type FanslySessionBundle,
  type ProxyConfig,
} from "@fansly-connect/shared";

import type { AppContext } from "../bootstrap.ts";

type PageOnboardingContext = Pick<AppContext, "db" | "config"> & {
  adapter: Pick<AppContext["adapter"], "verifySession">;
};

export async function onboardFanslyPage(
  app: PageOnboardingContext,
  input: {
    modelSlug: string;
    label: string;
    session: FanslySessionBundle;
    proxy?: ProxyConfig | null;
  },
) {
  const model = await findModelBySlug(app.db, input.modelSlug);
  if (!model) {
    throw new Error(`Model "${input.modelSlug}" does not exist`);
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

    const encryptedSession = JSON.stringify(
      encryptJson(
        input.session,
        app.config.encryptionKey,
        app.config.encryptionKeyVersion,
      ),
    );
    await storeFanslySession(
      dbTx,
      created.id,
      encryptedSession,
      app.config.encryptionKeyVersion,
    );

    if (proxy) {
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

      await storeProxyConfig(dbTx, created.id, {
        url: proxy.url,
        encryptedAuth,
        keyVersion: encryptedAuth ? app.config.encryptionKeyVersion : null,
      });
    }

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
