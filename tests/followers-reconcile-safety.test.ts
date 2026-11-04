import { describe, expect, it } from "vitest";

import { followersReconcileBacklogCeiling } from "../apps/runtime/src/sync/fansly/lib/followers-reconcile-safety.ts";

describe("followersReconcileBacklogCeiling", () => {
  const base = { activeFollowerCount: 6009, deactivationLimit: 60 };

  it("lets a proven sweep retire piled-up churn up to a tenth of the page while Fansly's count grows", () => {
    expect(followersReconcileBacklogCeiling({ ...base, sourceFollowerCount: 4777, previousSourceFollowerCount: 4643 })).toBe(600);
  });

  it("holds when Fansly's count fell by more than the limit: the list may have shrunk", () => {
    expect(followersReconcileBacklogCeiling({ ...base, sourceFollowerCount: 4500, previousSourceFollowerCount: 4643 })).toBeNull();
    expect(followersReconcileBacklogCeiling({ ...base, sourceFollowerCount: 4590, previousSourceFollowerCount: 4643 })).toBe(600);
  });

  it("holds without a previous stated count or a count now", () => {
    expect(followersReconcileBacklogCeiling({ ...base, sourceFollowerCount: 4777, previousSourceFollowerCount: null })).toBeNull();
    expect(followersReconcileBacklogCeiling({ ...base, sourceFollowerCount: null, previousSourceFollowerCount: 4643 })).toBeNull();
  });
});
