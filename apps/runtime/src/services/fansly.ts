import type { FanslyAccountMeResponse } from "@agency_hub_core/fansly";
import { sanitizeLoneSurrogatesDeep } from "@agency_hub_core/shared";

export const FANSLY_ACCOUNT_CREATED_AT_METADATA_KEY = "accountCreatedAt";

function parseMetadataDate(
  metadata: Record<string, unknown>,
  key: string,
) {
  const value = metadata[key];
  if (typeof value !== "string") {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function buildFanslyMetadata(
  account: FanslyAccountMeResponse["account"],
  existingMetadata?: Record<string, unknown> | null,
) {
  const accountCreatedAt = Number.isFinite(account.createdAt)
    ? new Date(account.createdAt).toISOString()
    : existingMetadata?.[FANSLY_ACCOUNT_CREATED_AT_METADATA_KEY];

  return {
    ...(existingMetadata ?? {}),
    ...(accountCreatedAt === undefined ? {} : {
      [FANSLY_ACCOUNT_CREATED_AT_METADATA_KEY]: accountCreatedAt,
    }),
    // Served text straight into `pages.metadata` (jsonb), which refuses an
    // unpaired UTF-16 surrogate: without this belt one broken emoji in a wall
    // or tier description would fail every metadata refresh of the page
    // (sync/journal-lone-surrogates.ts). A copy; the served account is kept.
    walls: sanitizeLoneSurrogatesDeep(account.walls ?? []),
    subscriptionTiers: sanitizeLoneSurrogatesDeep(account.subscriptionTiers ?? []),
  };
}

export function parseFanslyMetadataAccountCreatedAt(metadata: Record<string, unknown>) {
  return parseMetadataDate(metadata, FANSLY_ACCOUNT_CREATED_AT_METADATA_KEY);
}

export function resolveFanslyPlatformAccountId(page: {
  label: string;
  platformAccountId: string | null;
  metadata: Record<string, unknown>;
}) {
  const platformAccountId = page.platformAccountId ??
    (typeof page.metadata.platformAccountId === "string" ? page.metadata.platformAccountId : null);

  if (!platformAccountId) {
    throw new Error(`Page "${page.label}" is missing a Fansly platform account id`);
  }

  return platformAccountId;
}
