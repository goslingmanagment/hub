// The voice notes' daily character budgets (a page's own and the account's)
// and what is left of them. The one place their defaults live: the render's
// admission (createVoiceNote) reserves against these ceilings, and the
// allowance the clients show (getVoiceNoteAllowance) reports them. Pure: the
// caller reads the live config and the day's counters.

import { voiceCharBudgetDay, type VoiceCharBudgetSpent } from "@agency_hub_core/db";
import type { AppConfig } from "@agency_hub_core/shared";

import { resolveVoiceScriptMaxChars } from "./voice-script-validation.ts";

// Fallbacks that mirror the config-registry defaults. In production the boot
// AppConfig always carries these (zod defaults), so they only guard test
// contexts that construct config by hand.
const DEFAULT_PAGE_BUDGET = 5000;
const DEFAULT_GLOBAL_BUDGET = 20000;

export interface VoiceDailyCharBudgets {
  /** One page's ceiling per UTC day (`voiceNotesDailyCharBudget`). */
  pageBudget: number;
  /** Every page together, per UTC day (`voiceNotesGlobalDailyCharBudget`). */
  globalBudget: number;
}

/**
 * The live daily character ceilings a render reserves against
 * (reserveVoiceCharBudget). Pass the effective config, never the boot one.
 */
export function resolveVoiceDailyCharBudgets(
  config: Pick<AppConfig, "voiceNotesDailyCharBudget" | "voiceNotesGlobalDailyCharBudget">,
): VoiceDailyCharBudgets {
  return {
    pageBudget: config.voiceNotesDailyCharBudget ?? DEFAULT_PAGE_BUDGET,
    globalBudget: config.voiceNotesGlobalDailyCharBudget ?? DEFAULT_GLOBAL_BUDGET,
  };
}

/** A page's voice-note allowance, as `GET …/voice-notes/allowance` answers it. */
export interface VoiceNoteAllowanceView {
  scriptMaxChars: number;
  dailyChars: number;
  remainingChars: number;
  resetsAt: string;
}

/**
 * A page's allowance at `now`, from the effective config and the day's two
 * counters (readVoiceCharBudgetSpent at the same `now`):
 * - `scriptMaxChars`: the cap the render validates a script against;
 * - `dailyChars`: the page's own ceiling for the day;
 * - `remainingChars`: what a render could still reserve, the smaller headroom
 *   of the page's counter and the account's, never below zero. A counter can
 *   stand above its ceiling (a render settled to the vendor's actual count, a
 *   ceiling lowered live): then nothing is left;
 * - `resetsAt`: the next UTC midnight, where the day's counters end.
 */
export function computeVoiceNoteAllowance(input: {
  effective: Pick<
    AppConfig,
    "voiceNotesScriptMaxChars" | "voiceNotesDailyCharBudget" | "voiceNotesGlobalDailyCharBudget"
  >;
  spent: VoiceCharBudgetSpent;
  now: Date;
}): VoiceNoteAllowanceView {
  const { pageBudget, globalBudget } = resolveVoiceDailyCharBudgets(input.effective);
  return {
    scriptMaxChars: resolveVoiceScriptMaxChars(input.effective),
    dailyChars: pageBudget,
    remainingChars: Math.max(0, Math.min(
      pageBudget - input.spent.pageSpentChars,
      globalBudget - input.spent.globalSpentChars,
    )),
    resetsAt: voiceCharBudgetDay(input.now).resetsAt.toISOString(),
  };
}
