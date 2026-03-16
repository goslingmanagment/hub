export interface FanLabelInput {
  platformUserId: string;
  username?: string | null;
  displayName?: string | null;
}

export interface ResolvedFanLabel {
  label: string;
  username: string | null;
  displayName: string | null;
  isDeletedFallback: boolean;
}

function normalizeFanNamePart(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function deletedUserLabel(platformUserId: string) {
  const shortId = platformUserId.length > 8
    ? platformUserId.slice(-8)
    : platformUserId;
  return `Deleted user · ${shortId}`;
}

export function resolveFanLabel(input: FanLabelInput): ResolvedFanLabel {
  const displayName = normalizeFanNamePart(input.displayName);
  const username = normalizeFanNamePart(input.username);

  if (displayName) {
    return {
      label: displayName,
      username,
      displayName,
      isDeletedFallback: false,
    };
  }

  if (username) {
    return {
      label: username,
      username,
      displayName,
      isDeletedFallback: false,
    };
  }

  return {
    label: deletedUserLabel(input.platformUserId),
    username,
    displayName,
    isDeletedFallback: true,
  };
}
