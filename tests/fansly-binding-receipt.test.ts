import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BindingRefusal, bindingRefusalReceipt, readBindingReceipt, verifyBindingBeforeConnect } from "../scripts/fansly-ws/binding-receipt.ts";
import { parseBindingPreflightArgs } from "../scripts/fansly-ws/binding-preflight.ts";
import { parseProbeArgs } from "../scripts/fansly-ws/probe.ts";
import { bindingGeneration, bindingReceipt } from "./helpers/fansly-binding-fixtures.ts";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "binding-receipt-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function read(value: unknown = bindingReceipt, mode = 0o600) {
  const path = join(directory, "receipt.json");
  await writeFile(path, JSON.stringify(value), { mode });
  return readBindingReceipt(path);
}
const current = { pageId: 7, expectedAccountId: "123", generation: bindingGeneration };

describe("W0 REST identity receipts", () => {
  it("binds strict private evidence to the current page and generation, retaining timestamps as observations", async () => {
    const binding = await read();
    const evidence = await verifyBindingBeforeConnect(binding, current, "lilly-1", async () => bindingGeneration);
    expect(evidence).toMatchObject({ receiptSha256: binding.sha256,
      credentialRouteGeneration: bindingGeneration, verifiedAt: bindingReceipt.finishedAt });
    expect(evidence.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    { identityMatched: false }, { reason: "account_mismatch" }, { observedAccountId: "456" },
    { restRequests: 0 }, { httpStatus: 429 }, { pageLabel: "lora-1" }, { expectedAccountId: "secret" },
    { raw: { checkToken: "SYNTHETIC_SECRET" } }, { finishedAt: "2026-09-14T19:00:00.000Z" },
  ])("rejects failed or ambiguous receipts without exporting input %#", async (patch) => {
    await expect(read({ ...bindingReceipt, ...patch })).rejects.toThrow(/^invalid_binding_receipt$/);
  });

  it("rejects public permissions, links and oversized files", async () => {
    await expect(read(bindingReceipt, 0o644)).rejects.toThrow(/^invalid_binding_receipt$/);
    const alias = join(directory, "alias");
    await symlink(join(directory, "receipt.json"), alias);
    await expect(readBindingReceipt(alias)).rejects.toThrow(/^invalid_binding_receipt$/);
    const large = join(directory, "large");
    await writeFile(large, "x".repeat(16 * 1024 + 1), { mode: 0o600 });
    await expect(readBindingReceipt(large)).rejects.toThrow(/^invalid_binding_receipt$/);
  });

  it.each([{ pageId: 8 }, { expectedAccountId: "456" }, { generation: "b".repeat(64) }])(
    "refuses a foreign snapshot before the later generation read %#", async (patch) => {
      const later = vi.fn(async () => bindingGeneration);
      await expect(verifyBindingBeforeConnect(await read(), { ...current, ...patch }, "lilly-1", later))
        .rejects.toThrow(/^binding_snapshot_mismatch$/);
      expect(later).not.toHaveBeenCalled();
    },
  );

  it.each(["changed", "unavailable"])("refuses a %s generation immediately before connect", async (state) => {
    const later = state === "changed" ? async () => "b".repeat(64)
      : async () => { throw new Error("SYNTHETIC_SECRET"); };
    await expect(verifyBindingBeforeConnect(await read(), current, "lilly-1", later))
      .rejects.toThrow(state === "changed" ? /^binding_generation_changed$/ : /^binding_generation_unavailable$/);
  });

  it("exports only allowlisted refusal fields and distinguishes generation loss from change", () => {
    for (const reason of ["invalid_binding_receipt", "binding_snapshot_mismatch",
      "binding_generation_changed", "binding_generation_unavailable"] as const) {
      expect(bindingRefusalReceipt(new BindingRefusal(reason, "a".repeat(64))))
        .toEqual({ schemaVersion: 1, evidenceKind: "w0_binding_refusal", reason,
          connectionAttempts: 0, restRequests: 0, bindingReceiptSha256: "a".repeat(64) });
    }
    expect(bindingRefusalReceipt(new Error("SYNTHETIC_SECRET"))).toBeNull();
    expect(bindingRefusalReceipt(new BindingRefusal("SYNTHETIC_SECRET" as never))).toBeNull();
    expect(bindingRefusalReceipt(new BindingRefusal("invalid_binding_receipt", "SYNTHETIC_SECRET")))
      .not.toHaveProperty("bindingReceiptSha256");
  });

  it("keeps the original bounded short invocation and accepts only file-based optional binding", () => {
    expect(parseProbeArgs(["--page", "lilly-1", "--seconds", "5"]))
      .toEqual({ pageLabel: "lilly-1", durationMs: 5_000 });
    expect(parseProbeArgs(["--page", "lilly-1", "--seconds", "120", "--binding-receipt-file", "receipt.json"]))
      .toMatchObject({ durationMs: 120_000, bindingReceiptFile: "receipt.json" });
    expect(() => parseBindingPreflightArgs(["--page", "lora-1"])).toThrow();
    expect(() => parseBindingPreflightArgs(["--page", "lilly-1", "--token", "secret"])).toThrow();
  });
});
