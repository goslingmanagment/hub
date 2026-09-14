import { createHash } from "node:crypto";
import { z } from "zod";
import { readPrivateFile } from "./private-file.ts";
import { checkProbeGeneration } from "./generation-watch.ts";

type BindingRefusalReason = "invalid_binding_receipt" | "binding_snapshot_mismatch"
  | "binding_generation_changed" | "binding_generation_unavailable";
export class BindingRefusal extends Error {
  constructor(readonly reason: BindingRefusalReason, readonly receiptSha256?: string) {
    super(reason);
  }
}

/** Known pre-connect refusals are evidence; unknown exceptions stay private. */
export function bindingRefusalReceipt(error: unknown) {
  if (!(error instanceof BindingRefusal)) return null;
  if (!["invalid_binding_receipt", "binding_snapshot_mismatch", "binding_generation_changed",
    "binding_generation_unavailable"].includes(error.reason)) return null;
  const hash = error.receiptSha256;
  return {
    schemaVersion: 1, evidenceKind: "w0_binding_refusal", reason: error.reason,
    connectionAttempts: 0, restRequests: 0,
    ...(typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash) ? { bindingReceiptSha256: hash } : {}),
  };
}

const nativeId = z.string().regex(/^[1-9][0-9]{0,31}$/);
const receiptSchema = z.object({
  schemaVersion: z.literal(1), evidenceKind: z.literal("w0_rest_identity_preflight"),
  pageLabel: z.literal("lilly-1"), pageId: z.number().int().positive(),
  expectedAccountId: nativeId, observedAccountId: nativeId,
  credentialRouteGeneration: z.string().regex(/^[a-f0-9]{64}$/),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
  identityMatched: z.literal(true), reason: z.literal("matched"),
  restRequests: z.literal(1), httpStatus: z.literal(200),
}).strict().refine((value) => value.expectedAccountId === value.observedAccountId
  && Date.parse(value.finishedAt) >= Date.parse(value.startedAt));

export async function readBindingReceipt(path: string) {
  try {
    const bytes = await readPrivateFile(path, 16 * 1024);
    const receipt = receiptSchema.parse(JSON.parse(bytes.toString("utf8")));
    return { receipt, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch { throw new BindingRefusal("invalid_binding_receipt"); }
}

/** Compare with the receiver's newly read snapshot before it can connect.
 * Receipt timestamps remain observations, not continuous configuration history. */
export function verifyBindingReceipt(
  binding: Awaited<ReturnType<typeof readBindingReceipt>>,
  current: { pageId: number; expectedAccountId: string | null; generation: string },
  pageLabel: string,
) {
  const { receipt } = binding;
  if (receipt.pageLabel !== pageLabel || receipt.pageId !== current.pageId
    || receipt.expectedAccountId !== current.expectedAccountId
    || receipt.credentialRouteGeneration !== current.generation) {
    throw new BindingRefusal("binding_snapshot_mismatch", binding.sha256);
  }
  return {
    receiptSha256: binding.sha256, credentialRouteGeneration: current.generation,
    verifiedAt: receipt.finishedAt,
  };
}

export async function verifyBindingBeforeConnect(
  binding: Awaited<ReturnType<typeof readBindingReceipt>>,
  current: { pageId: number; expectedAccountId: string | null; generation: string },
  pageLabel: string,
  readGeneration: () => Promise<string>,
) {
  const evidence = verifyBindingReceipt(binding, current, pageLabel);
  const check = await checkProbeGeneration(readGeneration, current.generation);
  if (check.state !== "unchanged") {
    throw new BindingRefusal(check.state === "changed" ? "binding_generation_changed"
      : "binding_generation_unavailable", binding.sha256);
  }
  return { ...evidence, generationCheckedAt: check.finishedAt };
}
