import { upsertFans } from "@fansly-connect/db";

import type { AppContext } from "../../bootstrap.ts";

export async function hydrateFans(
  app: AppContext,
  input: {
    requestContext: Parameters<AppContext["adapter"]["getAccountsByIdsPage"]>[0];
    platformUserIds: string[];
  },
) {
  if (input.platformUserIds.length === 0) {
    return new Map<string, number>();
  }

  const uniqueIds = Array.from(new Set(input.platformUserIds.filter(Boolean)));
  const accounts: Awaited<ReturnType<AppContext["adapter"]["getAccountsByIdsPage"]>>["parsed"] = [];

  for (let index = 0; index < uniqueIds.length; index += 100) {
    const chunk = uniqueIds.slice(index, index + 100);
    const response = await app.adapter.getAccountsByIdsPage(input.requestContext, chunk);
    accounts.push(...response.parsed);
  }

  const fallbackIds = uniqueIds.filter(
    (id) => !accounts.some((account) => account.id === id),
  );

  const fans = await upsertFans(app.db, [
    ...accounts.map((account) => ({
      platform: "fansly" as const,
      platformUserId: account.id,
      username: account.username,
      displayName: account.displayName,
      createdAtExternal: account.createdAt ? new Date(account.createdAt) : null,
      metadata: {},
    })),
    ...fallbackIds.map((id) => ({
      platform: "fansly" as const,
      platformUserId: id,
      metadata: {},
    })),
  ]);

  return new Map(fans.map((fan) => [fan.platformUserId, fan.id]));
}
