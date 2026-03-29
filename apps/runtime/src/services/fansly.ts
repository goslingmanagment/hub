import type { FanslyAccountMeResponse } from "@agency_hub_core/fansly";

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
    walls: account.walls ?? [],
    subscriptionTiers: account.subscriptionTiers ?? [],
  };
}

export function parseFanslyMetadataAccountCreatedAt(metadata: Record<string, unknown>) {
  return parseMetadataDate(metadata, FANSLY_ACCOUNT_CREATED_AT_METADATA_KEY);
}
