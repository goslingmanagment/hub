import { describe, expect, it } from "vitest";

import {
  buildFanslyDmConversationMetadata,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
  getFanslyDmMessageSyncExcludedReason,
  isFanslyDmMessageSyncExcluded,
  resolveFanLabel,
} from "@agency_hub_core/shared";

describe("resolveFanLabel", () => {
  it("prefers displayName over username", () => {
    expect(resolveFanLabel({
      platformUserId: "123456789",
      username: "username",
      displayName: "Display Name",
    })).toMatchObject({
      label: "Display Name",
      username: "username",
      displayName: "Display Name",
      isDeletedFallback: false,
    });
  });

  it("uses username when displayName is blank", () => {
    expect(resolveFanLabel({
      platformUserId: "123456789",
      username: "user_name",
      displayName: "   ",
    })).toMatchObject({
      label: "user_name",
      username: "user_name",
      displayName: null,
      isDeletedFallback: false,
    });
  });

  it("renders deleted users with a short id suffix", () => {
    expect(resolveFanLabel({
      platformUserId: "9876543212345678",
      username: null,
      displayName: "",
    })).toMatchObject({
      label: "Deleted user · 12345678",
      username: null,
      displayName: null,
      isDeletedFallback: true,
    });
  });

  it("treats whitespace-only name values as missing", () => {
    expect(resolveFanLabel({
      platformUserId: "1234",
      username: "   ",
      displayName: "\n\t ",
    })).toMatchObject({
      label: "Deleted user · 1234",
      username: null,
      displayName: null,
      isDeletedFallback: true,
    });
  });

  it("keeps deleted users distinguishable by platform user id", () => {
    const first = resolveFanLabel({
      platformUserId: "deleted-user-11111111",
      username: null,
      displayName: null,
    });
    const second = resolveFanLabel({
      platformUserId: "deleted-user-22222222",
      username: null,
      displayName: null,
    });

    expect(first.label).toBe("Deleted user · 11111111");
    expect(second.label).toBe("Deleted user · 22222222");
    expect(first.label).not.toBe(second.label);
  });
});

describe("Fansly dm message exclusion helpers", () => {
  it("recognizes the unresolvable account lookup exclusion reason", () => {
    const metadata = buildFanslyDmConversationMetadata({
      messageSyncExcludedReason:
        FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
    });

    expect(getFanslyDmMessageSyncExcludedReason(metadata)).toBe(
      FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
    );
    expect(isFanslyDmMessageSyncExcluded(metadata)).toBe(true);
  });
});
