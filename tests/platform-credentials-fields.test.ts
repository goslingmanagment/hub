import { describe, expect, it } from "vitest";

import { buildCredentialsBody } from "../apps/dashboard/src/pages/settings/PlatformCredentialsFields.tsx";

const baseFanslyValues = {
  authorization: "fansly-token",
  fanslyClientId: "",
  fanslyClientCheck: "",
  fanslySessionId: "",
  onlyFansToken: "",
  onlyFansUsername: "",
  proxyRaw: "",
};

describe("buildCredentialsBody", () => {
  it("does not treat an invalid non-empty proxy as an intentional removal", () => {
    expect(() => buildCredentialsBody({
      platform: "fansly",
      values: {
        ...baseFanslyValues,
        proxyRaw: "http://",
      },
      hadStoredProxy: true,
      initialStoredProxy: {
        url: "socks5://proxy.example:1080",
        hasAuth: true,
      },
      requireCredentials: false,
    })).toThrow("Invalid proxy URL");
  });

  it("still sends null when a stored proxy is intentionally cleared", () => {
    expect(buildCredentialsBody({
      platform: "fansly",
      values: baseFanslyValues,
      hadStoredProxy: true,
      initialStoredProxy: {
        url: "socks5://proxy.example:1080",
        hasAuth: true,
      },
      requireCredentials: false,
    })).toMatchObject({
      platform: "fansly",
      proxy: null,
    });
  });
});
