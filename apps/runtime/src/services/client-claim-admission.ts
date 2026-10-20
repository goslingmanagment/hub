import {
  CLIENT_SEND_PURPOSES,
  type ClientClaimSendGroup,
  type ClientFeatureFlagName,
  type ClientSendPurpose,
} from "@agency_hub_core/contracts";
import {
  CLIENT_GREETING_SEND_RATE,
  CLIENT_PREVIEW_SEND_RATE,
  type ClientSendRate,
} from "@agency_hub_core/db";
import type { Platform } from "@agency_hub_core/shared";

import { clientFeatureExistsOn } from "./client-features.ts";

/**
 * Which sends the greeting custody admits, by platform (chat-extension R20
 * architecture §11.1, the matrix `(platform, purpose, action)`; HF-3).
 *
 * ONE table, read by every action of the claim route that names a send:
 * - `dispatch`: the purpose and group the platform takes, the owner's flags it
 *   waits for (read inside its transaction, client-claim.ts), and the rate it
 *   counts toward;
 * - `registerNativeSend`: the purpose and group only; no flag (it reports a
 *   send that already happened);
 * - the status read: whether the custody exists on the platform at all.
 * `claim` and `renew` wait for `newcomers` on every platform, `release`,
 * `sent` and `failed` for the page grant alone: they name no send.
 *
 * The table is the only place that tells OnlyFans and Fansly apart here, so a
 * handler holds no platform branch.
 *
 * WHERE THE CUSTODY EXISTS. A send of a purpose exists on a platform when the
 * platform has its rule AND every flag of the rule exists there
 * (CLIENT_FEATURE_REQUIREMENTS, client-features.ts). Fansly's greeting waits
 * for `newcomers`, which exists on Fansly since R20 HF-2: the custody exists
 * on both platforms, and on a Fansly page the owner's switch is the page's own
 * `newcomers` row (the `"*"` row never reaches a Fansly page). A reply from
 * the preview has no Fansly rule and stays `platform_unsupported` there.
 */

/** What a send's group names: an AI generation's parts, or a text the chatter wrote or edited (`manual-greeting-v1`). */
export type ClientClaimGroupKind = "generation" | "manual";

export interface ClientSendAdmissionRule {
  /** The owner's flags a dispatch waits for, in the order a refusal names them. */
  flags: readonly ClientFeatureFlagName[];
  /** The groups a dispatch and a registered native send may name. */
  groups: readonly ClientClaimGroupKind[];
  /** The rate a dispatch counts toward (per person and platform). */
  rate: ClientSendRate;
}

type PlatformSendRules = Readonly<Partial<Record<ClientSendPurpose, ClientSendAdmissionRule>>>;

export const CLIENT_SEND_ADMISSIONS: Readonly<Partial<Record<Platform, PlatformSendRules>>> = {
  // Sending from the preview (X8, H-7b): both purposes under `previewSend`, a
  // greeting under `newcomers` too, one rate. The text an AI generation's part
  // or the chatter's own (an AI part edited, or typed in the preview: a manual
  // group, audit 2026-10-20 row 1), as on Fansly.
  onlyfans: {
    greeting: { flags: ["previewSend", "newcomers"], groups: ["generation", "manual"], rate: CLIENT_PREVIEW_SEND_RATE },
    "preview-reply": { flags: ["previewSend"], groups: ["generation", "manual"], rate: CLIENT_PREVIEW_SEND_RATE },
  },
  // Fansly's «Новые» (the extension's own HTTP send): a greeting and nothing
  // else, under `newcomers` WITHOUT `previewSend`; the text an AI generation's
  // or the chatter's own; a greeting rate of its own. A reply has no rule: 409.
  fansly: {
    greeting: { flags: ["newcomers"], groups: ["generation", "manual"], rate: CLIENT_GREETING_SEND_RATE },
  },
};

/** The flag a send of a purpose belongs to where the platform has no rule for it: how the refusal names it. */
const PURPOSE_FEATURE: Readonly<Record<ClientSendPurpose, ClientFeatureFlagName>> = {
  greeting: "newcomers",
  "preview-reply": "previewSend",
};
/** How a refusal names a group the platform does not take: the capability that brought it. */
const MANUAL_GROUP_FEATURE = "manual-greeting-v1";

/** Whether a flag exists on a platform; a test passes its own to read the table under another one. */
export type ClientFlagExistsOn = (flag: ClientFeatureFlagName, platform: Platform) => boolean;

export type ClientSendAdmission =
  | { admitted: true; rule: ClientSendAdmissionRule }
  | { admitted: false; feature: string; reason: "platform_unsupported" };

export function clientClaimGroupKind(group: ClientClaimSendGroup): ClientClaimGroupKind {
  return "kind" in group ? "manual" : "generation";
}

/**
 * Whether the platform takes a send of this purpose and group, and on which
 * terms. Pure. A refusal is `platform_unsupported`, naming the flag the send
 * would have waited for (or the manual group's capability): no switch can lift
 * it.
 */
export function admitClientSend(
  input: { platform: Platform; purpose: ClientSendPurpose; group: ClientClaimGroupKind },
  existsOn: ClientFlagExistsOn = clientFeatureExistsOn,
): ClientSendAdmission {
  const rule = CLIENT_SEND_ADMISSIONS[input.platform]?.[input.purpose];
  if (rule === undefined) {
    return { admitted: false, feature: PURPOSE_FEATURE[input.purpose], reason: "platform_unsupported" };
  }
  const missing = rule.flags.find((flag) => !existsOn(flag, input.platform));
  if (missing !== undefined) {
    return { admitted: false, feature: missing, reason: "platform_unsupported" };
  }
  if (!rule.groups.includes(input.group)) {
    return { admitted: false, feature: MANUAL_GROUP_FEATURE, reason: "platform_unsupported" };
  }
  return { admitted: true, rule };
}

/**
 * Whether the greeting custody exists on a platform: some send is admitted
 * there. The status read and a registered native send ask it first.
 */
export function clientCustodyExistsOn(platform: Platform, existsOn: ClientFlagExistsOn = clientFeatureExistsOn): boolean {
  return CLIENT_SEND_PURPOSES.some((purpose) => {
    const rule = CLIENT_SEND_ADMISSIONS[platform]?.[purpose];
    return rule !== undefined && rule.flags.every((flag) => existsOn(flag, platform));
  });
}
