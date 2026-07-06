// Stage 18: OnlyMonster is retired. What survives here is platform-shaped,
// not vendor-shaped — avatar-URL hygiene and display-name resolution used by
// the OFAPI identity paths (onboarding + metadata backfill).

const ONLYFANS_SIGNED_AVATAR_QUERY_KEYS = new Set([
  "expires",
  "key-pair-id",
  "policy",
  "signature",
]);

function isOnlyFansHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  return normalized === "onlyfans.com" || normalized.endsWith(".onlyfans.com");
}

export function normalizeOnlyFansAvatarUrl(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" || !isOnlyFansHostname(url.hostname)) {
    return null;
  }

  for (const key of url.searchParams.keys()) {
    if (ONLYFANS_SIGNED_AVATAR_QUERY_KEYS.has(key.toLowerCase())) {
      return null;
    }
  }

  return url.toString();
}

function normalizeOnlyFansName(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function comparableOnlyFansName(value: string | null | undefined) {
  return normalizeOnlyFansName(value)?.replace(/^@+/, "").toLowerCase() ?? null;
}

function isGenericOnlyFansDisplayName(
  displayName: string | null | undefined,
  username: string | null | undefined,
) {
  const normalizedDisplayName = comparableOnlyFansName(displayName);
  if (!normalizedDisplayName) {
    return true;
  }

  const normalizedUsername = comparableOnlyFansName(username);
  return normalizedUsername !== null && normalizedDisplayName === normalizedUsername;
}

export function resolveOnlyFansDisplayName(
  account: {
    name?: string | null;
    username?: string | null;
  },
  existingPage?: {
    displayName?: string | null;
    username?: string | null;
  },
) {
  const nextDisplayName = normalizeOnlyFansName(account.name);
  if (!isGenericOnlyFansDisplayName(nextDisplayName, account.username)) {
    return nextDisplayName;
  }

  const existingDisplayName = normalizeOnlyFansName(existingPage?.displayName);
  if (!isGenericOnlyFansDisplayName(
    existingDisplayName,
    existingPage?.username ?? account.username,
  )) {
    return existingDisplayName;
  }

  return nextDisplayName ?? normalizeOnlyFansName(account.username);
}
