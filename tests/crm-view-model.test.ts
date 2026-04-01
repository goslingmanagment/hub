import { describe, expect, it } from "vitest";

import { mapRetentionRowVm } from "../apps/dashboard/src/pages/crm/viewModel.ts";

describe("CRM retention view model", () => {
  it("renders a placeholder when subscription expiry is missing", () => {
    const vm = mapRetentionRowVm("lana", {
      fan: {
        platformUserId: "fan-1",
        pageAlias: null,
        username: "fan_1",
        displayName: "Fan One",
      },
      spend: {
        creatorNetAmountMills: 12_300,
      },
      conversation: {
        lastMessageAt: null,
        lastMessageSenderRole: null,
        unreadCount: 0,
      },
      platformConversationId: null,
      subscription: {
        subscriptionExpiresAt: null,
        autoRenew: null,
      },
      touchpointCode: "3d",
      touchpointLabel: "3d",
      isSoftTouchpoint: false,
      isHandled: false,
    } as never);

    expect(vm.expiryLabel).toBe("—");
    expect(vm.expiryRelativeLabel).toBeNull();
  });
});
