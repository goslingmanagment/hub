import type {
  FanProfileDocument,
  FanProfileResponse,
  FanProfileVersionListResponse,
} from "@agency_hub_core/contracts";
import {
  appendFanProfile,
  findFanOnPage,
  getFanProfileVersion,
  getLatestFanProfile,
  getLatestFanProfileForConversation,
  listFanProfileVersionSummaries,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  canAccessPage,
  requireApiKeyUser,
  requireDashboardUser,
  type AuthPrincipal,
} from "./auth.ts";
import { ForbiddenError, NotFoundError } from "./errors.ts";
import { getPageSummary } from "./reporting.ts";

function serializeTimestamp(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  return new Date(value).toISOString();
}

function serializeFan(input: {
  platform: "fansly" | "onlyfans";
  platformUserId: string;
  username: string | null;
  displayName: string | null;
  createdAtExternal: Date | string | null;
}): FanProfileResponse["fan"] {
  return {
    platform: input.platform,
    platformUserId: input.platformUserId,
    username: input.username,
    displayName: input.displayName,
    createdAtExternal: serializeTimestamp(input.createdAtExternal),
  };
}

function serializeProfile(
  input: {
    version: number;
    body: string;
    source: string;
    createdAt: Date | string;
    createdByUserId: number | null;
  },
): FanProfileDocument {
  return {
    version: input.version,
    body: input.body,
    source: input.source as FanProfileDocument["source"],
    createdAt: new Date(input.createdAt).toISOString(),
    createdByUserId: input.createdByUserId ?? null,
  };
}

async function resolveAccessiblePage(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
) {
  const page = await getPageSummary(app, pageLabel);
  if (!canAccessPage(principal, page.id)) {
    throw new ForbiddenError("Page access denied");
  }

  return page;
}

async function resolvePageFan(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
  platformUserId: string,
) {
  const page = await resolveAccessiblePage(app, principal, pageLabel);
  const fan = await findFanOnPage(app.db, page.id, platformUserId);
  if (!fan) {
    throw new NotFoundError(`Fan "${platformUserId}" not found on page "${pageLabel}"`);
  }

  return { page, fan };
}

export async function getPageFanProfile(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
  platformUserId: string,
): Promise<FanProfileResponse> {
  const { page, fan } = await resolvePageFan(app, principal, pageLabel, platformUserId);
  const profile = await getLatestFanProfile(app.db, {
    fanId: fan.fanId,
    platformAccountId: page.id,
  });

  return {
    fan: serializeFan(fan),
    profile: profile ? serializeProfile(profile) : null,
  };
}

export async function upsertPageFanProfile(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
  platformUserId: string,
  body: string,
): Promise<FanProfileDocument> {
  requireApiKeyUser(principal);

  const { page, fan } = await resolvePageFan(app, principal, pageLabel, platformUserId);
  const profile = await appendFanProfile(app.db, {
    fanId: fan.fanId,
    platformAccountId: page.id,
    body,
    source: "chatmuse",
    createdByUserId: principal.user.id,
  });

  return serializeProfile(profile);
}

export async function listPageFanProfileVersions(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
  platformUserId: string,
): Promise<FanProfileVersionListResponse> {
  requireDashboardUser(principal);

  const { page, fan } = await resolvePageFan(app, principal, pageLabel, platformUserId);
  const rows = await listFanProfileVersionSummaries(app.db, {
    fanId: fan.fanId,
    platformAccountId: page.id,
  });
  const currentVersion = rows[0]?.version ?? null;

  return {
    items: rows.map((row) => ({
      version: row.version,
      createdAt: new Date(row.createdAt).toISOString(),
      isCurrent: row.version === currentVersion,
    })),
  };
}

export async function getPageFanProfileVersion(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
  platformUserId: string,
  version: number,
): Promise<FanProfileDocument> {
  requireDashboardUser(principal);

  const { page, fan } = await resolvePageFan(app, principal, pageLabel, platformUserId);
  const profile = await getFanProfileVersion(app.db, {
    fanId: fan.fanId,
    platformAccountId: page.id,
    version,
  });
  if (!profile) {
    throw new NotFoundError(
      `Profile version "${version}" not found for fan "${platformUserId}" on page "${pageLabel}"`,
    );
  }

  return serializeProfile(profile);
}

export async function getPageConversationProfile(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
  conversationId: string,
): Promise<FanProfileResponse> {
  const page = await resolveAccessiblePage(app, principal, pageLabel);
  const result = await getLatestFanProfileForConversation(app.db, {
    platformAccountId: page.id,
    platformConversationId: conversationId,
  });
  if (!result) {
    throw new NotFoundError(
      `Conversation "${conversationId}" was not found on page "${pageLabel}"`,
    );
  }

  return {
    fan: serializeFan(result.fan),
    profile: result.profile ? serializeProfile(result.profile) : null,
  };
}
