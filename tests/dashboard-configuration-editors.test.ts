import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigItem } from "@agency_hub_core/contracts";
import { validateConfigOverride } from "@agency_hub_core/shared";

const apiMocks = vi.hoisted(() => ({ useAdminConfig: vi.fn(), useUpdateConfig: vi.fn(), useClearConfig: vi.fn() }));
vi.mock("../apps/dashboard/src/api/adminConfig.ts", () => apiMocks);
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({
  KernelApiError: class KernelApiError extends Error {
    status: number;
    constructor(message: string, _category: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

import {
  BooleanConfigEditor,
  ConfigEditor,
  captureConfigSnapshot,
  configReceiptState,
  configSnapshotChanged,
  parseScalarInput,
  prepareScalarSave,
  seedValue,
  savedConfigReceipt,
  type ConfigWriteReceipt,
} from "../apps/dashboard/src/pages/settings/ConfigurationEditors.tsx";
import { KernelApiError } from "../apps/dashboard/src/api/sdk.ts";

function item(overrides: Partial<ConfigItem> = {}): ConfigItem {
  return {
    key: "fanslyLiveOverlayReadPages",
    envName: "FANSLY_LIVE_OVERLAY_READ_PAGES",
    configField: "fanslyLiveOverlayReadPages",
    kind: "string",
    subsystem: "Fansly",
    label: "Fansly live overlay readers",
    default: "",
    editability: "editable",
    runtimeApply: "live",
    comparable: true,
    secret: false,
    note: null,
    costWarning: null,
    destructive: false,
    stagedGroup: null,
    stagedOrder: null,
    requires: [],
    source: "override",
    desired: "lora-1",
    desiredEffective: null,
    runningState: "off",
    overrideVersion: 5,
    pendingApply: false,
    drift: false,
    live: true,
    running: [{
      role: "worker", instanceId: "worker-1", value: "lora-1", masked: false,
      state: null, lastSeenAt: "2026-09-10T10:00:00.000Z",
    }],
    ...overrides,
  };
}

beforeEach(() => {
  const idle = () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null });
  apiMocks.useAdminConfig.mockReturnValue({ isFetching: false, refetch: vi.fn() });
  apiMocks.useUpdateConfig.mockReturnValue(idle());
  apiMocks.useClearConfig.mockReturnValue(idle());
});

describe("configuration scalar edits", () => {
  it("rejects empty allowlist overrides like the real server validator", () => {
    const setting = item();
    for (const input of ["", "   "]) {
      expect(validateConfigOverride(setting.key, input).ok).toBe(false);
      expect(parseScalarInput("string", input).valid).toBe(false);
      expect(prepareScalarSave(setting, captureConfigSnapshot(setting), input).kind).toBe("invalid");
    }
    const valid = prepareScalarSave(setting, captureConfigSnapshot(setting), " lora-2 ");
    expect(valid).toEqual({
      kind: "save",
      body: { patches: [{ key: setting.key, value: "lora-2", expectedVersion: 5 }] },
    });
    if (valid.kind === "save") {
      expect(validateConfigOverride(setting.key, valid.body.patches[0]!.value)).toEqual({ ok: true, value: "lora-2" });
    }
  });

  it("refuses empty and non-finite numbers instead of coercing them to zero or null", () => {
    for (const input of ["", "  ", "Infinity", "1e999", "not a number"]) {
      expect(parseScalarInput("number", input).valid).toBe(false);
    }
    expect(parseScalarInput("number", "0")).toEqual({ valid: true, value: 0 });
  });

  it("rejects fractional numbers like the real server validator", () => {
    const setting = item({ key: "sessionTtlDays", kind: "number", desired: 14, default: "14" });
    for (const input of ["1.5", "-0.5", "1e-1"]) {
      expect(validateConfigOverride(setting.key, Number(input)).ok).toBe(false);
      expect(parseScalarInput("number", input).valid).toBe(false);
      expect(prepareScalarSave(setting, captureConfigSnapshot(setting), input).kind).toBe("invalid");
    }
    const valid = prepareScalarSave(setting, captureConfigSnapshot(setting), "30");
    expect(valid.kind).toBe("save");
    if (valid.kind === "save") {
      expect(validateConfigOverride(setting.key, valid.body.patches[0]!.value)).toEqual({ ok: true, value: 30 });
    }
  });

  it("does not silently use a new version when polling observes another operator's edit", () => {
    const initial = item();
    const snapshot = captureConfigSnapshot(initial);
    const refreshed = item({ desired: "lora-2", overrideVersion: 6 });
    expect(prepareScalarSave(refreshed, snapshot, "lora-3")).toEqual({ kind: "conflict" });
    // An explicit review can capture the new baseline; only then can this draft save.
    expect(prepareScalarSave(refreshed, captureConfigSnapshot(refreshed), "lora-3")).toEqual({
      kind: "save",
      body: { patches: [{ key: refreshed.key, value: "lora-3", expectedVersion: 6 }] },
    });
  });

  it("invalidates a confirmation even when another writer saves the same value", () => {
    const initial = item();
    expect(configSnapshotChanged(captureConfigSnapshot(initial), item({ overrideVersion: 6 }))).toBe(true);
  });

  it("keeps a draft valid when only the worker heartbeat changes", () => {
    const initial = item();
    const refreshed = item({ running: [{ ...initial.running[0]!, lastSeenAt: "2026-09-10T10:01:00.000Z" }] });
    expect(configSnapshotChanged(captureConfigSnapshot(initial), refreshed)).toBe(false);
    expect(prepareScalarSave(refreshed, captureConfigSnapshot(initial), "lora-2").kind).toBe("save");
  });

  it("requires review when the environment baseline changes without an override", () => {
    const initial = item({ source: "env", desired: null, overrideVersion: null });
    const refreshed = item({ source: "env", desired: null, overrideVersion: null, running: [{ ...initial.running[0]!, value: "lora-2" }] });
    expect(prepareScalarSave(refreshed, captureConfigSnapshot(initial), "lora-3")).toEqual({ kind: "conflict" });
  });

  it("keeps an empty environment allowlist visible without treating it as a valid override", () => {
    const setting = item({ source: "env", desired: null, overrideVersion: null, running: [] });
    expect(seedValue(setting)).toBe("");
    expect(prepareScalarSave(setting, captureConfigSnapshot(setting), "").kind).toBe("invalid");
  });
});

describe("configuration editor feedback", () => {
  it("describes reset as inheriting server environment, rather than code defaults", () => {
    const html = renderToStaticMarkup(createElement(ConfigEditor, { item: item() }));
    expect(html).toContain("Вернуть настройку сервера");
    expect(html).not.toContain("Сбросить к значению по умолчанию");
  });

  it("keeps a conflict visible with an explicit review action", () => {
    apiMocks.useUpdateConfig.mockReturnValue({
      mutate: vi.fn(), reset: vi.fn(), isPending: false,
      error: new KernelApiError("Version conflict", "conflict", 409, null, null),
    });
    const html = renderToStaticMarkup(createElement(ConfigEditor, { item: item() }));
    expect(html).toContain("Пока вы редактировали, настройку изменили");
    expect(html).toContain("Оставить значение сервера");
    expect(html).toContain("Сохранено на сервере:");
  });

  it("announces saved but unapplied state separately from the displayed boolean switch", () => {
    const html = renderToStaticMarkup(createElement(BooleanConfigEditor, {
      item: item({ kind: "boolean", desired: true, desiredEffective: true, pendingApply: true }),
    }));
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("Ждём, пока настройку подхватят все части Hub");
    expect(html).toContain('role="status"');
  });
});

describe("configuration write reconciliation", () => {
  it("retains the actual clamped PATCH result until the read model confirms it", () => {
    const previous = item({ key: "sessionTtlDays", kind: "number", desired: 14, overrideVersion: 5 });
    const stored = validateConfigOverride(previous.key, 1_000_000);
    expect(stored).toEqual({ ok: true, value: 365 });
    if (!stored.ok) throw new Error(stored.error);
    const receipt = savedConfigReceipt({ key: previous.key, value: stored.value, version: 6 });
    // PATCH succeeded but the refetch failed: only the old item is available. The
    // response value is retained and another write must wait for reconciliation.
    expect(receipt).toMatchObject({ action: "save", value: 365, version: 6 });
    expect(configReceiptState(receipt, previous)).toBe("waiting");
    expect(configReceiptState(receipt, { ...previous, desired: 1_000_000, overrideVersion: 6 })).toBe("waiting");
    expect(configReceiptState(receipt, { ...previous, desired: 365, overrideVersion: 6 })).toBe("current");
  });

  it("stops showing a boolean success when a later write changes its value", () => {
    const receipt = savedConfigReceipt({ key: "retentionTieringEnabled", value: true, version: 6 });
    const confirmed = item({ key: receipt.key, kind: "boolean", desired: true, desiredEffective: true, overrideVersion: 6 });
    expect(configReceiptState(receipt, confirmed)).toBe("current");
    expect(configReceiptState({ ...receipt, observed: true }, { ...confirmed, desired: false, desiredEffective: false, overrideVersion: 7 })).toBe("replaced");
    // A newer version also settles the receipt when our own version was never polled.
    expect(configReceiptState(receipt, { ...confirmed, desired: false, overrideVersion: 7 })).toBe("replaced");
  });

  it("requires an explicit fresh read to distinguish stale env from a later clear", () => {
    const before = item({ source: "env", desired: null, overrideVersion: null });
    const receipt = savedConfigReceipt({ key: before.key, value: "lora-2", version: 1 });
    expect(configReceiptState(receipt, before)).toBe("waiting");
    // An explicit successful GET confirms env again (another operator cleared the
    // saved override); this must unblock without pretending the receipt is current.
    const verified = { key: before.key, source: before.source, desired: before.desired, overrideVersion: before.overrideVersion };
    expect(configReceiptState({ ...receipt, verified }, before)).toBe("replaced");
    // Until the parent renders that fresh read, even a cached receipt match is stale.
    expect(configReceiptState({ ...receipt, verified }, { ...before, source: "override", desired: "lora-2", overrideVersion: 1 })).toBe("waiting");
  });

  it("confirms clear by source without inventing the environment value", () => {
    const before = item();
    const receipt: ConfigWriteReceipt = { action: "clear", key: before.key, previousVersion: 5 };
    expect(configReceiptState(receipt, before)).toBe("waiting");
    const cleared = item({ source: "env", desired: null, desiredEffective: null, overrideVersion: null, running: [] });
    expect(configReceiptState(receipt, cleared)).toBe("current");
    expect(receipt).not.toHaveProperty("value");
    expect(configReceiptState({ ...receipt, observed: true }, item({ desired: "lora-2", overrideVersion: 1 }))).toBe("replaced");
  });
});
