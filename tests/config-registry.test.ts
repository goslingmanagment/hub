import { describe, expect, it } from "vitest";

import {
  buildRunningSnapshot,
  CONFIG_DESCRIPTORS,
  ENV_CONFIG_KEYS,
  getDescriptor,
  loadConfig,
} from "@agency_hub_core/shared";

// Minimal hermetic env: only the required fields, .env merging disabled so defaults
// are exactly what the schema declares.
const MINIMAL_ENV = {
  DATABASE_URL: "postgres://localhost/test",
  APP_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
} as unknown as NodeJS.ProcessEnv;

describe("config registry", () => {
  it("covers every env schema key exactly once", () => {
    const envKeys = new Set<string>(ENV_CONFIG_KEYS);
    const descriptorEnvNames = CONFIG_DESCRIPTORS.filter((d) => d.kind !== "derived").map(
      (d) => d.envName,
    );
    const descriptorEnvSet = new Set(descriptorEnvNames);

    expect([...envKeys].filter((key) => !descriptorEnvSet.has(key))).toEqual([]);
    expect(descriptorEnvNames.filter((key) => !envKeys.has(key))).toEqual([]);
    expect(descriptorEnvNames.length).toBe(descriptorEnvSet.size);
  });

  it("has unique descriptor keys", () => {
    const keys = CONFIG_DESCRIPTORS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("never marks a secret/derived/complex/alias value as editable", () => {
    const unsafe = CONFIG_DESCRIPTORS.filter(
      (d) => d.editability === "editable" && ["secret", "derived", "complex", "alias"].includes(d.kind),
    );
    expect(unsafe.map((d) => d.key)).toEqual([]);
  });

  it("gives every editable numeric value a bound", () => {
    const unbounded = CONFIG_DESCRIPTORS.filter(
      (d) => d.editability === "editable" && d.kind === "number" && d.min === undefined && d.max === undefined,
    );
    expect(unbounded.map((d) => d.key)).toEqual([]);
  });

  it("declared defaults match what loadConfig actually produces", () => {
    const config = loadConfig(MINIMAL_ENV, { loadDotEnv: false });
    const plainValue = /^[\w.\-:/]+$/;
    const source = config as unknown as Record<string, unknown>;

    const mismatches: string[] = [];
    for (const descriptor of CONFIG_DESCRIPTORS) {
      if (!descriptor.configField) continue;
      if (!["boolean", "number", "string", "url"].includes(descriptor.kind)) continue;
      // Skip non-literal defaults ("(required)", "(unset)", fallback notes).
      if (!plainValue.test(descriptor.default)) continue;

      const actual = source[descriptor.configField as string];
      if (actual === undefined || actual === null) continue;
      if (String(actual) !== descriptor.default) {
        mismatches.push(`${descriptor.key}: loadConfig=${String(actual)} registry=${descriptor.default}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  // Allowlist guard for the Stage C wiring class. Exactly these keys are wired to the
  // live runtime overlay; exactly these staged flags are boot-applied; everything else
  // is 'none' (not overridable via the DB). A new 'live'/'boot' key must update this set
  // deliberately — it can't slip in unnoticed.
  const LIVE_KEYS = [
    "ofapiCreditAlertThreshold",
    "ofapiWebhookSilenceThresholdMinutes",
    "ofapiBurnAlertCreditsPerHour",
    "healthSyncLightMaxAgeMinutes",
    "healthSyncFollowerMaxAgeMinutes",
    "transactionLookbackDays",
    "transactionRescanCapDays",
    "ofapiDmReconcileIntervalMinutes",
    // Stage 16 ramp gates (live so ramp flips need no restart).
    "fanslyFanEarningsSyncEnabled",
    "fanslyPurchaseHistorySyncEnabled",
    "fanslyNewStreamPageAllowlist",
    "fanslyDeepBackfillIgnoreRetentionLimit",
    // Fast-reply freshness PR3: union-read mode, read per generation.
    "aiTranscriptFreshUnionMode",
    // Decision #136: fan-dossier context, read per generation.
    "chatMuseAiFanProfileContextFeatures",
    // Decision #140 (+ addendum): fleet-wide prompt-echo kill-switch, read per generation.
    "chatMuseAiPromptDebugEchoEnabled",
    // W3.2 (decision #125): queued-command TTL, read live per sweep.
    "ofapiQueuedCommandTtlMs",
    // Voice notes (ElevenLabs TTS): kill switches + budgets, read live per request.
    "voiceNotesEnabled",
    "voiceNotesRetrievalEnabled",
    "voiceNotesPageAllowlist",
    "voiceNotesDailyCharBudget",
    "voiceNotesGlobalDailyCharBudget",
    "voiceNotesScriptMaxChars",
    "voiceNotesMaxConcurrentSyntheses",
    // Agent Read Plane (slice 0a): read per request / per cycle so the owner's
    // ramp needs no restart. Every one of them rests at off/false.
    "agentReadPlaneMode",
    "agentObservationsEnabled",
    "agentSearchBackend",
    "agentHydrationMode",
    "agentExportPolicyValue",
    "fanslyReplayMode",
    "retentionTieringEnabled",
  ];
  const BOOT_KEYS = [
    "ofapiDmProjectionEnabled",
    "ofapiDmSyncEnabled",
    "ofapiDmColdArchiveEnabled",
    "ofapiAccountHealthEnabled",
    "ofapiCreditLedgerEnabled",
    "ofapiBalancePingEnabled",
    "ofapiAudienceSyncEnabled",
    "ofapiPresenceProjectionEnabled",
    "ofapiSpendProjectionShadowEnabled",
    "ofapiSpendTransactionIngestEnabled",
    "ofapiDesktopReadGatewayEnabled",
    "ofapiMirrorInteractiveCaptureEnabled",
    "ofapiMirrorBackgroundCaptureEnabled",
    "ofapiMessageHistoryShadowEnabled",
    "ofapiMessageHistoryDbFallbackEnabled",
    "ofapiDesktopCommandOutboxEnabled",
    "ofapiDesktopCommandExecutionEnabled",
    "chatMuseAiGatewayEnabled",
    "onlyFansTopSpendersEnabled",
    // Stage 14: per-job flags (boot-apply per rollback plan).
    "ofapiChargebacksReconcileEnabled",
    "ofapiLinkStatsReconcileEnabled",
    "ofapiFanIdentitiesSyncEnabled",
    // Fast-reply freshness PR4: readthrough reconcile (own window).
    "ofapiDmReadthroughReconcileEnabled",
    // Wave 2 corrections reconciler (OFF until the fingerprint backfill).
    "ofapiDmCorrectionsReconcileEnabled",
  ];

  it("wires exactly the thirty live keys, the twenty-four boot keys, and nothing else", () => {
    const live = CONFIG_DESCRIPTORS.filter((d) => d.runtimeApply === "live").map((d) => d.key);
    const boot = CONFIG_DESCRIPTORS.filter((d) => d.runtimeApply === "boot").map((d) => d.key);
    const none = CONFIG_DESCRIPTORS.filter((d) => d.runtimeApply === "none").map((d) => d.key);

    expect(new Set(live)).toEqual(new Set(LIVE_KEYS));
    expect(new Set(boot)).toEqual(new Set(BOOT_KEYS));
    // No key carries an unexpected wiring class, and no overlap between the sets.
    expect(live.length).toBe(LIVE_KEYS.length);
    expect(boot.length).toBe(BOOT_KEYS.length);
    expect(none.length).toBe(CONFIG_DESCRIPTORS.length - LIVE_KEYS.length - BOOT_KEYS.length);
    for (const key of [...LIVE_KEYS, ...BOOT_KEYS]) {
      expect(none, `${key} must not be 'none'`).not.toContain(key);
    }
  });

  it("declares the staged dependency chain in #49→#50 enable order", () => {
    const req = (key: string) => getDescriptor(key)!.requires ?? [];
    expect(req("ofapiDmProjectionEnabled")).toEqual([]);
    expect(req("ofapiDmSyncEnabled")).toEqual(["ofapiDmProjectionEnabled"]);
    expect(req("ofapiDmColdArchiveEnabled")).toEqual(["ofapiDmProjectionEnabled"]);
    expect(req("ofapiAccountHealthEnabled")).toEqual(["ofapiDmSyncEnabled"]);
    expect(req("ofapiCreditLedgerEnabled")).toEqual(["ofapiAccountHealthEnabled"]);
    // One-way: ledger does NOT require ping (ping is an optional branch).
    expect(req("ofapiBalancePingEnabled")).toEqual(["ofapiCreditLedgerEnabled"]);
    expect(req("ofapiCreditLedgerEnabled")).not.toContain("ofapiBalancePingEnabled");
    expect(req("ofapiAudienceSyncEnabled")).toEqual(["ofapiCreditLedgerEnabled"]);
    expect(req("ofapiPresenceProjectionEnabled")).toEqual(["ofapiAudienceSyncEnabled"]);
    expect(req("ofapiSpendProjectionShadowEnabled")).toEqual(["ofapiCreditLedgerEnabled"]);
    expect(req("ofapiSpendTransactionIngestEnabled")).toEqual(["ofapiSpendProjectionShadowEnabled"]);
    expect(req("ofapiDesktopReadGatewayEnabled")).toEqual(["ofapiCreditLedgerEnabled"]);
    expect(req("ofapiMessageHistoryShadowEnabled")).toEqual([
      "ofapiMirrorInteractiveCaptureEnabled",
    ]);
    expect(req("ofapiMessageHistoryDbFallbackEnabled")).toEqual([
      "ofapiMessageHistoryShadowEnabled",
    ]);
    expect(req("ofapiDesktopCommandOutboxEnabled")).toEqual(["ofapiDesktopReadGatewayEnabled"]);
    expect(req("ofapiDesktopCommandExecutionEnabled")).toEqual([
      "ofapiDesktopCommandOutboxEnabled",
    ]);
    expect(req("onlyFansTopSpendersEnabled")).toEqual(["ofapiPresenceProjectionEnabled"]);
  });

  it("only boot descriptors declare `requires`, and every requires target is an existing boot key", () => {
    // Guards the boot-only filter in transitiveDependents (staged-config.ts): if a non-boot
    // key ever declared a `requires` on a boot key, the disable rule would silently skip it
    // (fail-open). Pin the invariant so that can't slip in.
    for (const descriptor of CONFIG_DESCRIPTORS) {
      if ((descriptor.requires?.length ?? 0) === 0) continue;
      expect(descriptor.runtimeApply, `${descriptor.key} declares requires but is not 'boot'`).toBe("boot");
      for (const target of descriptor.requires!) {
        const dep = getDescriptor(target);
        expect(dep, `${descriptor.key} requires unknown key ${target}`).toBeDefined();
        expect(dep!.runtimeApply, `${descriptor.key} requires non-boot key ${target}`).toBe("boot");
      }
    }
  });

  it("orders #26, #50, #51, #52, #54, #55, and the #56 command-execution slice", () => {
    const order = (key: string) => getDescriptor(key)!.stagedOrder;
    expect(order("ofapiDmProjectionEnabled")).toBe(1);
    expect(order("ofapiDmSyncEnabled")).toBe(2);
    expect(order("ofapiAccountHealthEnabled")).toBe(3);
    expect(order("ofapiCreditLedgerEnabled")).toBe(1);
    expect(order("ofapiBalancePingEnabled")).toBe(2);
    expect(order("ofapiAudienceSyncEnabled")).toBe(3);
    expect(order("ofapiPresenceProjectionEnabled")).toBe(4);
    expect(order("onlyFansTopSpendersEnabled")).toBe(5);
    expect(order("ofapiSpendProjectionShadowEnabled")).toBe(1);
    expect(order("ofapiSpendTransactionIngestEnabled")).toBe(2);
    expect(order("ofapiDmColdArchiveEnabled")).toBe(1);
    expect(order("ofapiDesktopReadGatewayEnabled")).toBe(1);
    expect(order("ofapiMessageHistoryShadowEnabled")).toBe(3);
    expect(order("ofapiMessageHistoryDbFallbackEnabled")).toBe(4);
    expect(order("ofapiDesktopCommandOutboxEnabled")).toBe(1);
    expect(order("ofapiDesktopCommandExecutionEnabled")).toBe(1);
    expect(order("chatMuseAiGatewayEnabled")).toBe(1);
  });

  it("masks secrets and complex values in the running snapshot", () => {
    const snapshot = buildRunningSnapshot({
      ofapiApiKey: "leak-me",
      anthropicApiKey: "also-leak",
      serviceEgressProxyUrl: "socks5://proxy.example.internal:1080",
      serviceEgressProxyUsername: "fake-service-user",
      serviceEgressProxyPassword: "fake-service-password",
      encryptionKeysByVersion: new Map([[1, Buffer.alloc(32)]]),
      ofapiDmSyncEnabled: true,
    } as never);

    expect(snapshot.values.ofapiApiKey).toMatchObject({ masked: true, value: null, state: "set" });
    expect(snapshot.values.encryptionKeyRing).toMatchObject({ masked: true, state: "set" });
    expect(snapshot.values.serviceEgressProxyUrl).toMatchObject({ masked: true, state: "set" });
    expect(snapshot.values.serviceEgressProxyUsername).toMatchObject({ masked: true, state: "set" });
    expect(snapshot.values.serviceEgressProxyPassword).toMatchObject({ masked: true, state: "set" });
    expect(snapshot.values.ofapiDmSyncEnabled).toEqual({ value: true });
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
