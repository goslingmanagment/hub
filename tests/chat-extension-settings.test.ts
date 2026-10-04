import { describe, expect, it } from "vitest";

import {
  CONFIG_DESCRIPTORS,
  compareClientSemver,
  configStringFormatError,
  getDescriptor,
  parseChatExtensionClientVersion,
  parseChatExtensionFeatures,
  parseChatExtensionHostBindings,
  parseChatExtensionReceiptProfiles,
  parseClientSemver,
  validateConfigOverride,
} from "@agency_hub_core/shared";

const CHAT_EXTENSION_KEYS = [
  "chatExtensionEnabled",
  "chatExtensionFeatures",
  "chatExtensionMinVersion",
  "chatExtensionHostBindings",
  "chatExtensionPreviewSendReceiptProfiles",
];

describe("chat-extension switch descriptors", () => {
  it("are five live, editable Core keys that rest off", () => {
    const keys = CONFIG_DESCRIPTORS.filter((descriptor) => descriptor.key.startsWith("chatExtension")).map((d) => d.key);
    expect(keys).toEqual(CHAT_EXTENSION_KEYS);
    expect(CHAT_EXTENSION_KEYS.map((key) => getDescriptor(key)!.default)).toEqual(["false", "{}", "0.0.0", "{}", "[]"]);
    for (const key of CHAT_EXTENSION_KEYS) {
      const descriptor = getDescriptor(key)!;
      expect(descriptor.editability, key).toBe("editable");
      expect(descriptor.runtimeApply, key).toBe("live");
      expect(descriptor.subsystem, key).toBe("Core");
    }
  });

  it("every resting value passes its own write check", () => {
    for (const key of CHAT_EXTENSION_KEYS) {
      const descriptor = getDescriptor(key)!;
      const value = descriptor.kind === "boolean" ? descriptor.default === "true" : descriptor.default;
      expect(validateConfigOverride(key, value), key).toEqual({ ok: true, value });
    }
  });

  it("only string keys declare a format", () => {
    for (const descriptor of CONFIG_DESCRIPTORS) {
      if (descriptor.format !== undefined) {
        expect(descriptor.kind, descriptor.key).toBe("string");
      }
    }
  });
});

describe("validateConfigOverride on the chat-extension switches", () => {
  it("rejects invalid JSON and a bad version instead of trimming them into shape", () => {
    const rejected: Array<[string, unknown, RegExp]> = [
      ["chatExtensionFeatures", "{\"*\": {\"coach\": true}", /chatExtensionFeatures: the value is not valid JSON/],
      ["chatExtensionFeatures", "[]", /must be a JSON object/],
      ["chatExtensionFeatures", "{\"*\": true}", /scope "\*" must be a JSON object/],
      ["chatExtensionFeatures", "{\"*\": {\"coach\": 1}}", /scope "\*" flag "coach" must be true or false/],
      ["chatExtensionFeatures", "{\"\": {}}", /non-empty string/],
      ["chatExtensionFeatures", "{\"__proto__\": {\"coach\": true}}", /__proto__/],
      ["chatExtensionMinVersion", "1.4", /chatExtensionMinVersion: the value must read MAJOR\.MINOR\.PATCH/],
      ["chatExtensionMinVersion", "v1.4.0", /MAJOR\.MINOR\.PATCH/],
      ["chatExtensionMinVersion", "1.4.0-beta", /MAJOR\.MINOR\.PATCH/],
      ["chatExtensionMinVersion", "01.4.0", /MAJOR\.MINOR\.PATCH/],
      ["chatExtensionHostBindings", "{\"onlymonster:36408\": 9}", /page label must be a non-empty string/],
      ["chatExtensionHostBindings", "{\"36408\": \"lora-of\"}", /<host>:<account id>/],
      ["chatExtensionHostBindings", "{\"onlymonster:36408\": \" lora-of\"}", /without surrounding spaces/],
      ["chatExtensionHostBindings", "not json", /not valid JSON/],
      ["chatExtensionPreviewSendReceiptProfiles", "{}", /must be a JSON array/],
      ["chatExtensionPreviewSendReceiptProfiles", "[{\"id\": \"a\", \"adapterVersion\": \"1\"}]", /profile 0 modules must be a JSON object/],
      ["chatExtensionPreviewSendReceiptProfiles", "[{\"id\": \"a\", \"adapterVersion\": \"1\", \"modules\": {}, \"code\": \"x\"}]", /unknown keys: code/],
      [
        "chatExtensionPreviewSendReceiptProfiles",
        JSON.stringify([
          { id: "a", adapterVersion: "1", modules: {} },
          { id: "a", adapterVersion: "2", modules: {} },
        ]),
        /repeats the id "a"/,
      ],
      [
        "chatExtensionPreviewSendReceiptProfiles",
        JSON.stringify(Array.from({ length: 33 }, (_, index) => ({ id: `p${index}`, adapterVersion: "1", modules: {} }))),
        /more than 32 profiles/,
      ],
      // The generic checks still run first.
      ["chatExtensionFeatures", "   ", /non-empty string/],
      ["chatExtensionFeatures", { "*": {} }, /expects a string/],
      ["chatExtensionEnabled", "true", /expects a boolean/],
    ];
    for (const [key, value, error] of rejected) {
      const result = validateConfigOverride(key, value);
      expect(result.ok, `${key} ${JSON.stringify(value)}`).toBe(false);
      if (!result.ok) expect(result.error, `${key} ${JSON.stringify(value)}`).toMatch(error);
    }
  });

  it("accepts a well-formed value as the owner wrote it (trimmed)", () => {
    const features = " {\"*\": {\"coach\": true}, \"lora-of\": {\"coach\": false, \"futureFlag\": true}} ";
    expect(validateConfigOverride("chatExtensionFeatures", features)).toEqual({ ok: true, value: features.trim() });
    expect(validateConfigOverride("chatExtensionMinVersion", "1.10.0")).toEqual({ ok: true, value: "1.10.0" });
    expect(validateConfigOverride("chatExtensionHostBindings", "{\"onlymonster:36408\": \"lora-vip-of\"}"))
      .toEqual({ ok: true, value: "{\"onlymonster:36408\": \"lora-vip-of\"}" });
    const profiles = JSON.stringify([{ id: "om-1", adapterVersion: "1.0.0", modules: { send: "sha256:ab" } }]);
    expect(validateConfigOverride("chatExtensionPreviewSendReceiptProfiles", profiles)).toEqual({ ok: true, value: profiles });
    expect(validateConfigOverride("chatExtensionEnabled", true)).toEqual({ ok: true, value: true });
  });
});

describe("chat-extension parsers", () => {
  it("rebuild records without a prototype path and keep unknown flag names", () => {
    const parsed = parseChatExtensionFeatures("{\"*\": {\"someFutureFlag\": true}, \"constructor\": {\"coach\": false}}");
    expect(parsed).toEqual({ ok: true, value: { "*": { someFutureFlag: true }, constructor: { coach: false } } });
    expect(parseChatExtensionHostBindings("{}")).toEqual({ ok: true, value: {} });
    expect(parseChatExtensionReceiptProfiles("[]")).toEqual({ ok: true, value: [] });
    expect(parseChatExtensionReceiptProfiles("[{\"id\": \"a\", \"adapterVersion\": \"1\", \"modules\": {\"__proto__\": \"x\"}}]").ok)
      .toBe(false);
    expect(configStringFormatError("semver", "1.2.3")).toBeNull();
  });

  it("compare versions numerically and read only chat-extension/<version>", () => {
    expect(parseClientSemver("0.0.0")).toEqual([0, 0, 0]);
    expect(parseClientSemver("1.2.3")).toEqual([1, 2, 3]);
    expect(parseClientSemver("1234567890.0.0")).toBeNull();
    expect(compareClientSemver([1, 10, 0], [1, 9, 9])).toBeGreaterThan(0);
    expect(compareClientSemver([1, 9, 9], [1, 10, 0])).toBeLessThan(0);
    expect(compareClientSemver([1, 2, 3], [1, 2, 3])).toBe(0);
    expect(parseChatExtensionClientVersion("chat-extension/1.2.3")).toEqual([1, 2, 3]);
    expect(parseChatExtensionClientVersion("chatgoose-extension/1.2.3")).toBeNull();
    expect(parseChatExtensionClientVersion("harvest-1.2.3")).toBeNull();
    expect(parseChatExtensionClientVersion(undefined)).toBeNull();
  });
});
