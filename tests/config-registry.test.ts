import { describe, expect, it } from "vitest";

import {
  buildRunningSnapshot,
  CONFIG_DESCRIPTORS,
  getDescriptor,
} from "@agency_hub_core/shared";

describe("config registry", () => {
  it("never marks a secret/derived/complex value as editable", () => {
    const unsafe = CONFIG_DESCRIPTORS.filter(
      (d) => d.editability === "editable" && ["secret", "derived", "complex"].includes(d.kind),
    );
    expect(unsafe.map((d) => d.key)).toEqual([]);
  });

  it("masks secrets and complex values in the running snapshot", () => {
    const snapshot = buildRunningSnapshot({
      ofapiApiKey: "leak-me",
      anthropicApiKey: "also-leak",
      serviceEgressProxyUrl: "socks5://proxy.example.internal:1080",
      serviceEgressProxyUsername: "fake-service-user",
      serviceEgressProxyPassword: "fake-service-password",
      encryptionKeysByVersion: new Map([[1, Buffer.alloc(32)]]),
      chatMuseAiGatewayEnabled: true,
    } as never);

    expect(snapshot.values.ofapiApiKey).toMatchObject({ masked: true, value: null, state: "set" });
    expect(snapshot.values.encryptionKeyRing).toMatchObject({ masked: true, state: "set" });
    expect(snapshot.values.serviceEgressProxyUrl).toMatchObject({ masked: true, state: "set" });
    expect(snapshot.values.serviceEgressProxyUsername).toMatchObject({ masked: true, state: "set" });
    expect(snapshot.values.serviceEgressProxyPassword).toMatchObject({ masked: true, state: "set" });
    expect(snapshot.values.chatMuseAiGatewayEnabled).toEqual({ value: true });
    // Real secret material must never appear anywhere in the serialized snapshot.
    expect(JSON.stringify(snapshot)).not.toContain("leak");
  });

  it("keeps every credential/secret-bearing field masked (kind secret|complex)", () => {
    // Inverse of the "never editable" guard: buildRunningSnapshot masks by KIND (an allowlist —
    // only secret/complex are reduced to set/unset; every other kind serializes its real value).
    // So a credential-bearing field that is mis-kinded (boolean/number/string/url) would leak its
    // real value into the heartbeat row and the config view. Pin the known sensitive keys to
    // secret|complex so a future change can't silently downgrade one.
    const SENSITIVE_KEYS = [
      "databaseUrl",
      "encryptionKey",
      "encryptionKeyRing",
      "healthSyncMonitoringToken",
      "telegramBotToken",
      "telegramChatId",
      "ofapiApiKey",
      "anthropicApiKey",
      "anthropicApiKeys",
      "serviceEgressProxyUrl",
      "serviceEgressProxyUsername",
      "serviceEgressProxyPassword",
    ];
    for (const key of SENSITIVE_KEYS) {
      const descriptor = getDescriptor(key);
      expect(descriptor, `${key} descriptor missing`).toBeDefined();
      expect(
        ["secret", "complex"],
        `${key} must be masked (secret|complex) but is '${descriptor!.kind}'`,
      ).toContain(descriptor!.kind);
    }
  });
});
