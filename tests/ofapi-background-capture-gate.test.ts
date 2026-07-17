import { describe, expect, it } from "vitest";

import { isOfapiBackgroundCaptureRunnable } from "../apps/runtime/src/services/ofapi-capture-jobs.ts";

describe("isOfapiBackgroundCaptureRunnable", () => {
  it("allows governed background work beside atomically-capped legacy lanes", () => {
    const config = {
      ofapiMirrorBackgroundCaptureEnabled: true,
      ofapiAudienceSyncEnabled: true,
      ofapiChargebacksReconcileEnabled: true,
      ofapiFanIdentitiesSyncEnabled: true,
    } as const;

    expect(isOfapiBackgroundCaptureRunnable(config)).toBe(true);
  });

  it("still keeps the executor dark when the mirror flag is off", () => {
    expect(isOfapiBackgroundCaptureRunnable({
      ofapiMirrorBackgroundCaptureEnabled: false,
    })).toBe(false);
  });
});
