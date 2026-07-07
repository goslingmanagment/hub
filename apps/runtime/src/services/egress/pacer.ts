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

  // Shadow decisions live under their own rows: plan() must never move the
  // horizons pace() enforces (Stage 26: the vendor row only ever holds
  // imminent sends — decision #100).
  const shadowEgressKey = `shadow:${vendorEgressKey}`;

  const ensured: Record<string, Promise<void> | null> = {};
  function ensureRows(egressKey: string) {
    let pending = ensured[egressKey] ?? null;
    if (!pending) {
      pending = ensureSyncProviderRateLimitProfile(app.db, {
        provider,
        egressKey,
        scopes: [
          { scope: "vendor_global", minSpacingMs: capSpacingMs },
          { scope: "class:interactive", minSpacingMs: 0, priorityClass: "interactive" },
          { scope: "class:commands", minSpacingMs: 0, priorityClass: "commands" },
          { scope: "class:bulk", minSpacingMs: capSpacingMs, priorityClass: "bulk" },
        ],
      }).catch((error) => {
        ensured[egressKey] = null;
        throw error;
      });
      ensured[egressKey] = pending;
    }
    return pending;
  }

  async function reserveScopes(egressKey: string, scopes: string[], now: Date) {
    return reserveSyncProviderRateLimit(app.db, {
      scopes: scopes.map((scope) => ({ provider, scope, egressKey })),
      now,
    });
  }

  /** Shadow decision under shadow-scoped rows. Bulk claims ONLY its class
   * slot: in enforce, bulk's vendor claim happens at send time and the class
   * row's identical spacing already models bulk's serialization; pre-claiming
   * the vendor here would rebuild the single-pass horizon drag decision #100
   * rejected. Interactive shadow waits may undercount by at most the 1-2
   * imminent bulk vendor claims (≤ 2×spacing). */
  async function plan(priorityClass: EgressPriorityClass): Promise<EgressPaceDecision> {
    await ensureRows(shadowEgressKey);
    const now = new Date();
    const scheduledAt = priorityClass === "bulk"
      ? await reserveScopes(shadowEgressKey, ["class:bulk"], now)
      : await reserveScopes(shadowEgressKey, ["vendor_global", `class:${priorityClass}`], now);
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
      await ensureRows(vendorEgressKey);
      const startedAt = Date.now();
      if (priorityClass === "bulk") {
        // Phase 1: wait out bulk's own backlog on its class row.
        const classAt = await reserveScopes(vendorEgressKey, ["class:bulk"], new Date());
        await sleepUntil(classAt);
        // Phase 2: the send is imminent — claim the vendor slot now.
        const vendorAt = await reserveScopes(vendorEgressKey, ["vendor_global"], new Date());
        await sleepUntil(vendorAt);
        return Math.max(0, Date.now() - startedAt);
      }
      const scheduledAt = await reserveScopes(
        vendorEgressKey,
        ["vendor_global", `class:${priorityClass}`],
        new Date(),
      );
      await sleepUntil(scheduledAt);
      return Math.max(0, Date.now() - startedAt);
    },
  };
}
