import type { AiStreamCapability } from "@agency_hub_core/contracts";
import { sql } from "drizzle-orm";

import type { AppContext } from "../../../bootstrap.ts";
import { BadRequestError } from "../../../services/errors.ts";
import type { OperationFeature } from "../prompts/index.ts";

// Who the fan is, in the prompts that write to him (the owner, 2026-10-30: «и
// дефолт имя и кастом»). Reply and Fix had no name of the fan at all, so a name
// the transcript no longer showed was lost: a draft's «Коко» became "Koko" for
// a fan saved as «Coco/37/France», and the model's own sent "Koko" then fed
// every later answer.
//
// The saved name: on Fansly the hub holds the page's own (`page_alias`,
// fansly-fan-identity.ts). On OnlyFans it holds none: the chatter's name for
// the fan lives in ChatSpace (OnlyMonster's `customName`), and the extension
// sends it as `fanCustomName` with `fan-custom-name-v1`.

/** The features whose prompt shows the saved name. */
export const FAN_CUSTOM_NAME_FEATURES: readonly OperationFeature[] = ["fast-reply", "improve-draft", "hi-greeting", "ping"];

/**
 * Refuses `fanCustomName` where it can never be read: a feature whose prompt
 * shows no saved name, beside `clientContext` (which carries its own), on a
 * page that is not OnlyFans, or from a caller that did not advertise
 * `fan-custom-name-v1`. A client bug: a 400 with a machine reason. A request
 * without it passes.
 */
export function assertFanCustomNameRequestShape(input: {
  feature: OperationFeature;
  platform: string;
  hasClientContext: boolean;
  capabilities: ReadonlySet<AiStreamCapability> | undefined;
  fanCustomName: string | undefined;
}): void {
  if (input.fanCustomName === undefined) {
    return;
  }
  if (!FAN_CUSTOM_NAME_FEATURES.includes(input.feature)) {
    throw new BadRequestError(`${input.feature} does not accept fanCustomName`, { reason: "fan_custom_name_not_allowed" });
  }
  if (input.hasClientContext) {
    throw new BadRequestError("fanCustomName cannot be combined with clientContext", { reason: "fan_custom_name_not_allowed" });
  }
  if (input.platform !== "onlyfans") {
    throw new BadRequestError("fanCustomName is only accepted for onlyfans pages", { reason: "fan_custom_name_not_allowed" });
  }
  if (!input.capabilities?.has("fan-custom-name-v1")) {
    throw new BadRequestError("fanCustomName requires the fan-custom-name-v1 capability", { reason: "capability_required" });
  }
}

/** The body's saved name as the prompt takes it: trimmed, absent when empty. */
export function presentFanCustomName(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The fan's own two names on OnlyFans, as the sync stored them; null when absent. */
export async function loadFanProfileNames(
  app: Pick<AppContext, "db">,
  input: { fanRef: string; platform: "fansly" | "onlyfans" },
): Promise<{ displayName: string | null; username: string | null }> {
  const result = await app.db.execute<{ display_name: string | null; username: string | null }>(sql`
    select display_name, username from fans
    where platform_user_id = ${input.fanRef} and platform = ${input.platform}
    limit 1
  `);
  const row = result.rows[0];
  return { displayName: row?.display_name ?? null, username: row?.username ?? null };
}
