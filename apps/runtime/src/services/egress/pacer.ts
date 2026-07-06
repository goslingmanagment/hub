import { setTimeout as delay } from "node:timers/promises";

import {
  ensureSyncProviderRateLimitProfile,
  reserveSyncProviderRateLimit,
} from "@agency_hub_core/db";
import type { EgressPriorityClass } from "@agency_hub_core/platform-core";
import type { Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";

// Kernel Stage 26: class-aware pacing on the existing DB-backed waiter
// (sync_rate_limits rows, claim-at-reservation semantics).
//
// Row layout per vendor (all under egress_key = "vendor:<vendor>"):
// - scope "vendor_global"  — the shared cap every request pays immediately
//   before sending (preserves today's effective vendor rate: no request
//   leaves faster than ofapi's 500 ms; fansly 0 — there is NO cross-proxy
//   Fansly cap today and seeding one would newly serialize proxies, so the
//   row exists as a knob at 0).
// - scope "class:<class>"  — the class's own spacing. interactive/commands
//   ride at 0; bulk self-paces at the vendor rate on its OWN row.
//
// TWO-PHASE BULK (the priority mechanism): bulk first waits out its class
// slot, and only THEN claims the vendor row — an imminent send. The reserve
// primitive pushes every locked row to scheduledAt+spacing, so a single-pass
// [vendor, class:bulk] reservation would drag the vendor horizon out to
// bulk's backlog; splitting the phases keeps the entire bulk queue in
// class:bulk while the vendor row only ever holds imminent sends. An
// interactive caller therefore pays at most the few in-flight vendor claims
// — NEVER bulk's backlog (pinned by tests). Aging floor: bulk's class slot
// is claimed at reservation, and its final vendor claim is bounded by
// in-flight higher-class sends — later arrivals can never push scheduled
// bulk work into starvation.

export type EgressPacerMode = "off" | "shadow" | "enforce";

export interface EgressPaceDecision {
  scheduledAt: Date;
  waitMs: number;
}

export interface EgressPacer {
  mode: EgressPacerMode;
  /** Reserve the next slot for the class WITHOUT sleeping (shadow diffing). */
  plan(priorityClass: EgressPriorityClass): Promise<EgressPaceDecision>;
  /** Reserve and sleep until the slot. Returns the milliseconds waited. */
  pace(priorityClass: EgressPriorityClass): Promise<number>;
}

const EGRESS_VENDOR_PROVIDERS: Record<string, Platform> = {
  ofapi: "onlyfans",
  fansly: "fansly",
};

export function egressVendorProvider(vendor: string): Platform {
  const provider = EGRESS_VENDOR_PROVIDERS[vendor];
  if (!provider) {
    throw new Error(`Unknown egress vendor "${vendor}"`);
  }
  return provider;
}

export function egressVendorCapSpacingMs(
  app: Pick<AppContext, "config">,
  vendor: string,
): number {
  switch (vendor) {
    case "ofapi":
      // Preserves the OFAPI client's process-global slot rate on day one.
      return Math.max(0, app.config.ofapiRestDelayMs ?? 500);
    case "fansly":
      return 0;
    default:
      throw new Error(`Unknown egress vendor "${vendor}"`);
  }
}

export function createEgressPacer(
  app: Pick<AppContext, "config" | "db">,
  input: {
    vendor: string;
    mode?: EgressPacerMode;
  },
): EgressPacer {
  const mode = input.mode ?? app.config.egressPacerMode ?? "off";
  const provider = egressVendorProvider(input.vendor);
  const vendorEgressKey = `vendor:${input.vendor}`;
  const capSpacingMs = egressVendorCapSpacingMs(app, input.vendor);

  let ensured: Promise<void> | null = null;
  function ensureRows() {
    if (!ensured) {
      ensured = ensureSyncProviderRateLimitProfile(app.db, {
        provider,
        egressKey: vendorEgressKey,
        scopes: [
          { scope: "vendor_global", minSpacingMs: capSpacingMs },
          { scope: "class:interactive", minSpacingMs: 0, priorityClass: "interactive" },
          { scope: "class:commands", minSpacingMs: 0, priorityClass: "commands" },
          { scope: "class:bulk", minSpacingMs: capSpacingMs, priorityClass: "bulk" },
        ],
      }).catch((error) => {
        ensured = null;
        throw error;
      });
    }
    return ensured;
  }

  async function reserveScopes(scopes: string[], now: Date) {
    return reserveSyncProviderRateLimit(app.db, {
      scopes: scopes.map((scope) => ({ provider, scope, egressKey: vendorEgressKey })),
      now,
    });
  }

  /** Shadow decision: models the enforce path without sleeping — the class
   * slot and the imminent-send vendor claim are both taken at real now (the
   * caller IS about to send under the legacy policy). */
  async function plan(priorityClass: EgressPriorityClass): Promise<EgressPaceDecision> {
    await ensureRows();
    const now = new Date();
    if (priorityClass === "bulk") {
      const classAt = await reserveScopes(["class:bulk"], now);
      const vendorAt = await reserveScopes(["vendor_global"], now);
      const scheduledAt = classAt > vendorAt ? classAt : vendorAt;
      return {
        scheduledAt,
        waitMs: Math.max(0, scheduledAt.getTime() - now.getTime()),
      };
    }
    const scheduledAt = await reserveScopes(
      ["vendor_global", `class:${priorityClass}`],
      now,
    );
    return {
      scheduledAt,
      waitMs: Math.max(0, scheduledAt.getTime() - now.getTime()),
    };
  }

  async function sleepUntil(scheduledAt: Date) {
    const waitMs = scheduledAt.getTime() - Date.now();
    if (waitMs > 0) {
      await delay(waitMs);
    }
  }

  return {
    mode,
    plan,
    async pace(priorityClass) {
      await ensureRows();
      const startedAt = Date.now();
      if (priorityClass === "bulk") {
        // Phase 1: wait out bulk's own backlog on its class row.
        const classAt = await reserveScopes(["class:bulk"], new Date());
        await sleepUntil(classAt);
        // Phase 2: the send is imminent — claim the vendor slot now.
        const vendorAt = await reserveScopes(["vendor_global"], new Date());
        await sleepUntil(vendorAt);
        return Math.max(0, Date.now() - startedAt);
      }
      const scheduledAt = await reserveScopes(
        ["vendor_global", `class:${priorityClass}`],
        new Date(),
      );
      await sleepUntil(scheduledAt);
      return Math.max(0, Date.now() - startedAt);
    },
  };
}
