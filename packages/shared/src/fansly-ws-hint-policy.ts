import { z } from "zod";
import type { AppConfig } from "./config.ts";
import { FANSLY_WS_HINT_TYPES, type FanslyWsHintType } from "./fansly-ws-hints.ts";

const policySchema = z.object({
  generation: z.string().regex(/^[0-9a-f]{64}$/),
  activationAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  attemptLimit24h: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  baselineAttempts24h: z.number().int().min(20).max(Number.MAX_SAFE_INTEGER),
  baselineReference: z.string().min(1).max(512),
}).strict().refine(policy => policy.expiresAt === undefined
  || Date.parse(policy.expiresAt) > Date.parse(policy.activationAt));

export type FanslyWsHintPolicy = z.infer<typeof policySchema> & {
  enabledTypes: ReadonlySet<FanslyWsHintType>;
  maxAttempts24h: number;
};

const labels = (value: string | undefined) => new Set((value ?? "").split(",")
  .map((label) => label.trim()).filter((label) => label !== "" && label !== "none"));

/** An absent/malformed baseline or an empty allowlist grants zero requests.
 * The baseline is frozen before activation; event traffic cannot inflate its
 * own allowance. Admission counts a rolling 24h across policy/generation changes.
 * The hints no longer also require the legacy B0 capture flags: that receiver
 * is gone (step 4, S4-12) and every page's socket runs in the engine. */
export function resolveFanslyWsHintPolicy(config: Pick<AppConfig,
  "fanslyWsHintsEnabled" | "fanslyWsHintsPageAllowlist" | "fanslyWsHintsTypeAllowlist" | "fanslyWsHintsPolicies"
>, pageLabel: string, now = new Date()): FanslyWsHintPolicy | null {
  if (config.fanslyWsHintsEnabled !== true || !labels(config.fanslyWsHintsPageAllowlist).has(pageLabel)) return null;
  const requestedTypes = labels(config.fanslyWsHintsTypeAllowlist);
  const enabledTypes = new Set(FANSLY_WS_HINT_TYPES.filter((type) => requestedTypes.has(type)));
  if (enabledTypes.size === 0) return null;
  let policies: unknown;
  try { policies = JSON.parse(config.fanslyWsHintsPolicies ?? "{}"); } catch { return null; }
  if (!policies || typeof policies !== "object" || Array.isArray(policies)
    || !Object.hasOwn(policies, pageLabel)) return null;
  const parsed = policySchema.safeParse((policies as Record<string, unknown>)[pageLabel]);
  if (!parsed.success) return null;
  if (parsed.data.expiresAt !== undefined
    && !(now.getTime() < Date.parse(parsed.data.expiresAt))) return null;
  return { ...parsed.data, enabledTypes, maxAttempts24h: Math.min(
    Math.floor(parsed.data.baselineAttempts24h / 20), parsed.data.attemptLimit24h ?? Number.MAX_SAFE_INTEGER,
  ) };
}
