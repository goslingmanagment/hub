import { describe, expect, it } from "vitest";

import {
  buildRunningSnapshot,
  CONFIG_DESCRIPTORS,
  ENV_CONFIG_KEYS,
  FANSLY_PAUSE_MAX_MS,
  FANSLY_PAUSE_MIN_MS,
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
    // Decision 349: the public invite/reset link kill switch.
    "accountLinksEnabled",
    // Fansly Sync Engine step 1: the live overlay readers, page by page.
    "fanslyLiveOverlayReadPages",
    "fanslyWsHintsEnabled",
    "fanslyWsHintsPageAllowlist",
    "fanslyWsHintsTypeAllowlist",
    "fanslyWsHintsPolicies",
    // Fansly Sync Engine plan §2.1: the owner's one pace setting, editable live and
    // rejected (never clamped) outside 2000..60000 ms.
    "fanslyDefaultDelayMs",
    "ofapiCreditAlertThreshold",
    "ofapiWebhookSilenceThresholdMinutes",
    "ofapiBurnAlertCreditsPerHour",
    // H2 (amends #265): billed auto-redelivery switch and its UTC-day cap, read
    // per sweep so the coordinator enables it after deploy without a restart.
    "ofapiWebhookAutoRedeliveryEnabled",
    "ofapiWebhookAutoRedeliveryDailyCap",
    "healthSyncLightMaxAgeMinutes",
    "healthSyncFollowerMaxAgeMinutes",
    "ofapiDmReconcileIntervalMinutes",
    // The engine's post-replies walk: the cycle decides WHICH posts it reads.
    // (The legacy content lanes' flags, allowlists and budgets were retired
    // at step 4 and are applied nowhere.)
    "fanslyRepliesRewalkCycleDays",
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
    // AI media describer: master switch, page policies, model, caps and source policy, read per sweep/generation.
    "aiMediaDescribeEnabled",
    "aiMediaDescribePagePolicies",
    "aiMediaDescribeModel",
    "aiMediaDescribeDailyImageLimit",
    "aiMediaDescribeDailyMicroUsdLimit",
    "aiMediaDescribeLiveChatOnly",
    "aiMediaDescribeModelMedia",
    "aiMediaDescribeLoopEnabled",
    // Agent Read Plane (slice 0a): read per request / per cycle so the owner's
    // ramp needs no restart. Every one of them rests at off/false.
    "agentReadPlaneMode",
    "agentObservationsEnabled",
    "agentSearchBackend",
    "agentHydrationMode",
    "agentExportPolicyValue",
    "fanslyReplayMode",
    "retentionTieringEnabled",
    // G5 slice 1: the CAS dual-write canary bound. Live so the ramp needs no
    // restart; rests at "" (fully off).
    "captureCasDualWritePages",
    // G5 slice 2: the payload read seam's byte source. Live so the staged
    // inline->shadow->serve ramp (and any rollback) needs no restart; rests at
    // "inline", where readers behave exactly as they did before the slice.
    "captureCasReadMode",
    // G5 slice 3c-1: the pointer-only bound. Live for the same reason as the
    // canary it is subordinate to, and it rests at "" (fully off) — but note
    // that unlike every other live key here, turning this one back off does not
    // undo the rows written while it was on.
    "captureCasPointerOnlyPages",
    // Chat extension (hub-pr-plan H-2b): the owner's switches for the third
    // client, read per request by the bootstrap and the client routes' check.
    // Every one rests off.
    "chatExtensionEnabled",
    "chatExtensionFeatures",
    "chatExtensionMinVersion",
    "chatExtensionHostBindings",
    "chatExtensionPreviewSendReceiptProfiles",
  ];
  const BOOT_KEYS = [
    "ofapiDmProjectionEnabled",
    "ofapiDmSyncEnabled",
    "ofapiDmColdArchiveEnabled",
    "ofapiAccountHealthEnabled",
    "ofapiBindingReconcileEnabled",
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

  it("wires exactly the live keys, the boot keys, and nothing else", () => {
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

  it("keeps the Fansly pause live, bounded by the shared constants and in reject mode", () => {
    const descriptor = getDescriptor("fanslyDefaultDelayMs")!;
    expect(descriptor.runtimeApply).toBe("live");
    expect(descriptor.editability).toBe("editable");
    expect(descriptor.min).toBe(FANSLY_PAUSE_MIN_MS);
    expect(descriptor.max).toBe(FANSLY_PAUSE_MAX_MS);
    expect(FANSLY_PAUSE_MIN_MS).toBe(2000);
    expect(FANSLY_PAUSE_MAX_MS).toBe(60_000);
    // A floor that is the owner's rule is never silently raised: out-of-range is refused.
    expect(descriptor.outOfRange).toBe("reject");
    expect(descriptor.belowMinError).toContain("2000 мс");
    expect(descriptor.aboveMaxError).toContain("60000 мс");
    expect(descriptor.costWarning).toBeTruthy();
    // Every other key keeps the historical clamp behaviour unless it opts in explicitly.
    expect(CONFIG_DESCRIPTORS.filter((d) => d.outOfRange === "reject").map((d) => d.key))
      .toEqual(["fanslyDefaultDelayMs"]);
    for (const d of CONFIG_DESCRIPTORS) {
      if (d.belowMinError || d.aboveMaxError) {
        expect(d.outOfRange, `${d.key} carries rejection text without reject mode`).toBe("reject");
      }
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
