import type { ClientConversationRecapsResponse, ClientRecapBody } from "@agency_hub_core/contracts";
import {
  findFanOnPage,
  findPageSummaryByLabel,
  getFreshestUsableRecapBodies,
  getLatestFanProfile,
  type UsableRecapBody,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { requireApiKeyUser, type HumanAuthPrincipal } from "./auth.ts";
import { requireClientFeature, type ClientFeatureRequest } from "./client-switches.ts";
import { ClientFeatureDisabledError } from "./errors.ts";

/**
 * chat-extension H-13: the shared recaps of one fan on one page, with their
 * text (`clientConversationRecaps`).
 *
 * A recap is shared (chat-extension architecture §19, decision 1): every
 * chatter granted the page reads the same full and short recap, whoever
 * generated them. This is the one read of the restricted generation records
 * that is not the owner's, so it is kept narrow on every side:
 * - only `fan-summary` rows, only usable ones, never one with a `contextScope`
 *   (usableFanSummaryPredicate: the same two rows `aiRecapStatus` describes
 *   and Coach attaches);
 * - only on a page granted to the caller, behind the owner's `recap` switch;
 * - only the recap's text and provenance: no prompt block, no author, no
 *   context manifest (getFreshestUsableRecapBodies names its columns).
 *
 * Database only: it generates nothing, spends nothing and asks no platform.
 */

const RECAP_FLAG = "recap";
/** The length bound of an open token on the wire (`clientOpenToken`). */
const OPEN_TOKEN_MAX_LENGTH = 64;

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function openTokenOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= OPEN_TOKEN_MAX_LENGTH ? value : null;
}

function integerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/**
 * A stored recap as the wire carries it. The provenance comes from JSON the
 * gateway wrote into `params`; a value of the wrong type or size reads as
 * "not recorded" (null), never as a response the client's frozen schema
 * refuses.
 */
export function toClientRecapBody(row: UsableRecapBody): ClientRecapBody {
  return {
    generationRef: row.generationRef,
    generatedAt: row.createdAt.toISOString(),
    personaDefinitionId: stringOrNull(row.personaDefinitionId),
    coverage: {
      transcriptCoverage: openTokenOrNull(row.transcriptCoverage),
      requestedCount: integerOrNull(row.requestedCount),
      keptCount: integerOrNull(row.keptCount),
    },
    text: row.completion,
  };
}

/** Whether the fan's latest dossier on the page has exactly this text: the
 *  same fan and document `pageFanProfile` reads, compared as the dossier write
 *  itself compares bodies (exact equality). */
async function latestDossierHasText(app: AppContext, pageId: number, fanRef: string, text: string): Promise<boolean> {
  const fan = await findFanOnPage(app.db, pageId, fanRef);
  if (!fan) {
    return false;
  }
  const profile = await getLatestFanProfile(app.db, { fanId: fan.fanId, platformAccountId: pageId });
  return profile?.body === text;
}

export async function getClientConversationRecaps(
  app: AppContext,
  request: ClientFeatureRequest,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; fanRef: string; personaDefinitionId: string | undefined },
): Promise<ClientConversationRecapsResponse> {
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

  const found = await getFreshestUsableRecapBodies(app.db, {
    pageId: page.id,
    // The feature exists only where the chat id IS the fan id (OnlyFans), so
    // the fan names the conversation. A platform whose conversations have ids
    // of their own needs the conversation in the request before it gets the
    // feature.
    conversationRefs: [input.fanRef],
    ...(input.personaDefinitionId ? { personaDefinitionId: input.personaDefinitionId } : {}),
  });
  return {
    full: found.full ? toClientRecapBody(found.full) : null,
    short: found.short ? toClientRecapBody(found.short) : null,
    fullSavedToProfile: found.full !== null
      && await latestDossierHasText(app, page.id, input.fanRef, found.full.completion),
  };
}
