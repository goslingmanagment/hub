import {
  upsertFanProfileBodySchema,
  type ClientFanProfileFromGenerationResponse,
  type ClientGenerationNotEligibleReason,
} from "@agency_hub_core/contracts";
import {
  appendFanProfileVersion,
  findFanProfileVersionByBody,
  findOwnGenerationForProfile,
  findPageSummaryByLabel,
  hasAdmittedAiGatewayRequest,
  type FanProfileVersionRef,
  type OwnGenerationForProfile,
} from "@agency_hub_core/db";
import { isOutputExhausted } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { requireApiKeyUser, type HumanAuthPrincipal } from "./auth.ts";
import { requireClientFeature, type ClientFeatureRequest } from "./client-switches.ts";
import {
  ClientFeatureDisabledError,
  GenerationNotEligibleError,
  GenerationNotReadyError,
  NotFoundError,
} from "./errors.ts";
import { resolveOrCreateFanOnPage } from "./fan-profiles.ts";

/**
 * chat-extension H-5: saves a finished full recap as the fan's dossier, from
 * the generation the hub stored (`clientFanProfileFromGeneration`).
 *
 * The client names a generation; the hub copies its text. So the dossier is
 * exactly what the model wrote, and the hub decides what may become one:
 * - only the caller's own generation, of this page and this fan. Anything else
 *   reads as absent (404), another person's generation included;
 * - only a usable full recap: `usableFanSummaryPredicate("full")`, the rule the
 *   recap status, the Coach attach, the shared recaps and the dossier's
 *   generation proof share. A dossier saved here is therefore always one the
 *   prompts may use;
 * - on a page granted to the caller, behind the owner's `recap` switch.
 *
 * Database only: it generates nothing, spends nothing and asks no platform.
 * The older write (`PUT …/fans/:id/profile`, the text sent by the client)
 * stays as it is for the clients that use it.
 */

const RECAP_FLAG = "recap";
/** What the dossier rows of every writer carry: installed SDKs read the fan's
 *  profile with a closed `source` enum, so a new value would break them. */
const DOSSIER_SOURCE = "chatmuse";
/** The longest dossier body any writer stores: the cap of the older write. */
export const DOSSIER_BODY_MAX_CHARS = upsertFanProfileBodySchema.shape.body.maxLength ?? Number.POSITIVE_INFINITY;

const NOT_FOUND_MESSAGE = "Generation not found";

/**
 * Why a stored generation never becomes a dossier, or null when it may.
 *
 * The verdict is `usableFullSummary` alone, the database's reading of the one
 * shared predicate. The facts only name the reason, in the order a reader
 * would ask them, one per condition of the predicate. A refusal they cannot
 * name means the predicate gained a condition this list does not know: it
 * still refuses, as an internal error, and never invents a reason.
 */
export function generationRefusalReason(
  generation: Pick<
    OwnGenerationForProfile,
    "usableFullSummary" | "feature" | "summaryMode" | "outcome" | "stopReason" | "blank" | "contextScoped" | "completion"
  >,
): ClientGenerationNotEligibleReason | null {
  if (!generation.usableFullSummary) {
    if (generation.feature !== "fan-summary" || generation.summaryMode !== "full") {
      return "not_full_summary";
    }
    if (generation.outcome !== "completed") {
      return "not_completed";
    }
    if (generation.stopReason === null) {
      return "stop_reason_missing";
    }
    if (isOutputExhausted(generation.stopReason)) {
      return "output_exhausted";
    }
    if (generation.blank) {
      return "empty";
    }
    if (generation.contextScoped) {
      return "context_scope";
    }
    throw new Error("the usable-recap predicate refused a generation for a reason the dossier save cannot name");
  }
  return generation.completion.length > DOSSIER_BODY_MAX_CHARS ? "too_long" : null;
}

function toResponse(
  outcome: ClientFanProfileFromGenerationResponse["outcome"],
  profile: FanProfileVersionRef,
): ClientFanProfileFromGenerationResponse {
  return {
    outcome,
    profile: {
      version: profile.version,
      createdAt: profile.createdAt.toISOString(),
      sourceGeneratedAt: profile.sourceGeneratedAt?.toISOString() ?? null,
    },
  };
}

export async function saveClientFanProfileFromGeneration(
  app: AppContext,
  request: ClientFeatureRequest,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; fanRef: string; generationRef: string; clientRequestId: string | undefined },
): Promise<ClientFanProfileFromGenerationResponse> {
  // A cookie session → 403: the route is a client's, not the dashboard's.
  requireApiKeyUser(principal);
  const stored = await findPageSummaryByLabel(app.db, input.pageLabel);
  if (!stored) {
    // A missing page answers like one not granted: the refusal reveals nothing.
    throw new ClientFeatureDisabledError(RECAP_FLAG, "not_granted");
  }
  // The hub's own check, before anything is read: the page is granted to the
  // caller, the feature exists on its platform, the owner's `recap` switch is
  // on for it, and the extension is not outdated (409 `client_feature_disabled`).
  const page = await requireClientFeature(app, request, principal, { id: stored.id }, RECAP_FLAG);
  const userId = principal.user.id;

  const generation = await findOwnGenerationForProfile(app.db, { generationRef: input.generationRef, userId });
  if (!generation) {
    // The record is written after the stream's `done` frame. With the client's
    // own request id the hub can tell "not recorded yet" from "unknown".
    if (
      input.clientRequestId !== undefined
      && await hasAdmittedAiGatewayRequest(app.db, { userId, clientRequestId: input.clientRequestId, pageId: page.id })
    ) {
      throw new GenerationNotReadyError();
    }
    throw new NotFoundError(NOT_FOUND_MESSAGE);
  }
  // The feature exists only where the chat id IS the fan id (OnlyFans): a
  // generation that names no separate fan is about its conversation's fan.
  if (generation.pageId !== page.id || (generation.fanRef ?? generation.conversationRef) !== input.fanRef) {
    // The caller's own generation of another page or fan: not this fan's.
    throw new NotFoundError(NOT_FOUND_MESSAGE);
  }
  const refusal = generationRefusalReason(generation);
  if (refusal !== null) {
    throw new GenerationNotEligibleError(refusal);
  }

  // The fan as every dossier write resolves it (created on first sight on
  // OnlyFans; a fan flagged deleted stays a 404).
  const fan = await resolveOrCreateFanOnPage(app, page, input.fanRef);
  const dossier = { fanId: fan.fanId, platformAccountId: page.id, body: generation.completion };

  // Idempotent: a version that already has exactly this text is the answer,
  // however many versions were written since.
  const saved = await findFanProfileVersionByBody(app.db, dossier);
  if (saved) {
    return toResponse("existing", saved);
  }
  const appended = await appendFanProfileVersion(app.db, {
    ...dossier,
    source: DOSSIER_SOURCE,
    createdByUserId: userId,
    // The hub's own time of the generation, not a client's clock.
    sourceGeneratedAt: generation.createdAt,
  });
  if (!appended.profile) {
    throw new Error("fan profile append returned no version");
  }
  if (appended.created) {
    return toResponse("created", appended.profile);
  }
  if (appended.profile.body === generation.completion) {
    // A concurrent save of the same text won the write.
    return toResponse("existing", appended.profile);
  }
  // The write kept the fan's latest version: it is not older than this
  // generation. Unless the same text was saved meanwhile, this generation is
  // superseded for good.
  const savedMeanwhile = await findFanProfileVersionByBody(app.db, dossier);
  if (savedMeanwhile) {
    return toResponse("existing", savedMeanwhile);
  }
  throw new GenerationNotEligibleError("superseded");
}
