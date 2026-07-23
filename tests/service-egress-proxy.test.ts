import { describe, expect, it } from "vitest";

import {
  hasServiceEgressProxy,
  resolveServiceEgressProxy,
  ServiceEgressProxyConfigError,
} from "../apps/runtime/src/services/egress/service-proxy.ts";

const complete = {
  serviceEgressProxyUrl: "socks5://proxy.example.internal:1080",
  serviceEgressProxyUsername: "fake-service-user",
  serviceEgressProxyPassword: "fake-service-password",
};

describe("service egress proxy config", () => {
  it("resolves the complete tuple without embedding credentials in the URL", () => {
    expect(hasServiceEgressProxy(complete)).toBe(true);
    expect(resolveServiceEgressProxy(complete)).toEqual({
      url: "socks5://proxy.example.internal:1080",
      username: "fake-service-user",
      password: "fake-service-password",
    });
  });

  it("returns null only when the entire tuple is absent", () => {
    const absent = {
      serviceEgressProxyUrl: null,
      serviceEgressProxyUsername: null,
      serviceEgressProxyPassword: null,
    };
    expect(hasServiceEgressProxy(absent)).toBe(false);
    expect(resolveServiceEgressProxy(absent)).toBeNull();
  });

  it("throws a bounded named error for partial or malformed tuples without leaking credentials", () => {
    const fakePassword = "fake-password-must-not-leak";
    for (const config of [
      {
        serviceEgressProxyUrl: "socks5://proxy.example.internal:1080",
        serviceEgressProxyUsername: null,
        serviceEgressProxyPassword: fakePassword,
      },
      {
        serviceEgressProxyUrl:
          "socks5://fake-user:fake-inline-password@proxy.example.internal:1080",
        serviceEgressProxyUsername: "fake-user",
        serviceEgressProxyPassword: fakePassword,
      },
      {
        serviceEgressProxyUrl: "socks5://127.0.0.1:1080",
        serviceEgressProxyUsername: "fake-user",
        serviceEgressProxyPassword: fakePassword,
      },
    ]) {
      const error = (() => {
        try {
          resolveServiceEgressProxy(config);
          return null;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(ServiceEgressProxyConfigError);
      expect(String(error)).not.toContain(fakePassword);
      expect(String(error)).not.toContain("fake-inline-password");
    }
  });
});
