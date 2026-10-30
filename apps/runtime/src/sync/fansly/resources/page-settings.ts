import { upsertFanslyPageSettingsVersion } from "@agency_hub_core/db";

import { ApplyQuarantine } from "../../engine/commit.ts";
import type { ApplyInput, ApplyResult, RequestPlan, ResourceModule, StepPlan } from "../../engine/resource.ts";
import { PAGE_SETTINGS_STEPS, parsePageSettingsAnswer } from "../lib/page-settings.ts";

// `page-settings.daily` (0338): the page's settings and standing, once a day —
// eleven single reads, one a step, the position in the poll row's cursor (as
// `catalog.fixed`). Each answer is journaled first (its own kind); the apply
// keeps its version (`fansly_page_settings_versions`: the body without the
// account's e-mail, one line in Russian). The reads whose answers carry the
// page's secrets (managers, sign-ins, identity, payout documents, the stream
// key) and the ones that change state on a GET are not among them.

interface SettingsCursor {
  /** The step the next read is. */
  index: number;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function indexOf(value: unknown): number | null {
  const index = recordOf(value).index;
  return typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && index < PAGE_SETTINGS_STEPS.length ? index : null;
}

function parseCursor(value: unknown): SettingsCursor {
  return { index: indexOf(value) ?? 0 };
}

export const pageSettingsModule: ResourceModule = {
  async plan(work): Promise<StepPlan> {
    const { index } = parseCursor(work.cursor);
    return { kind: "request", request: { spec: PAGE_SETTINGS_STEPS[index]!, params: {}, step: { index } } as RequestPlan };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const index = indexOf(input.request.step);
    if (index === null || PAGE_SETTINGS_STEPS[index] !== input.request.spec) {
      throw new ApplyQuarantine("page_settings_step_mismatch", { spec: input.request.spec });
    }
    const answer = parsePageSettingsAnswer(input.request.spec, input.response);
    await upsertFanslyPageSettingsVersion(tx, {
      pageId: input.pageId,
      route: input.request.spec,
      observationId: input.observation.id,
      capturedAt: input.observation.receivedAt,
      bodySha256: answer.bodySha256,
      body: answer.body,
      summary: answer.summary,
    });
    const next = index + 1;
    return next >= PAGE_SETTINGS_STEPS.length
      ? {
        work: { satisfiesRevision: true, close: "done", closeReason: "settings_read", cursor: { index: 0 }, result: { completedAt: input.now.toISOString() } },
        followups: [],
        counters: { page_settings_sweeps: 1 },
      }
      : { work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { index: next } }, followups: [] };
  },
};
