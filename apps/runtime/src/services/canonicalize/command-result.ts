// Command-result family canonicalizer (Stage 8). Producer 5 journals every
// finalizeOfapiCommand outcome as kind `command.<state>` with the
// `cmd:<id>:<state>` idempotency key; the canonical vocabulary collapses all
// terminal states into command.settled (state travels in data).

import {
  asString,
  isRecord,
  type CanonicalEventDraft,
  type CanonicalizableObservation,
} from "./types.ts";

export const COMMAND_RESULT_CANONICALIZER_VERSION = 1;

/** Kind-prefix family: every command_result observation is `command.<state>`. */
export const COMMAND_RESULT_KIND_PREFIX = "command.";

export function canonicalizeCommandResultObservation(
  observation: CanonicalizableObservation,
): CanonicalEventDraft[] {
  if (!observation.kind.startsWith(COMMAND_RESULT_KIND_PREFIX)) {
    return [];
  }
  if (!isRecord(observation.payload)) {
    return [];
  }
  const commandId = asString(observation.payload.commandId);
  const state = asString(observation.payload.state) ??
    observation.kind.slice(COMMAND_RESULT_KIND_PREFIX.length);
  if (!commandId || !state) {
    return [];
  }
  return [{
    type: "command.settled",
    occurredAt: observation.observedAt ?? observation.receivedAt,
    conversationRef: asString(observation.payload.conversationId),
    data: {
      commandId,
      commandKind: asString(observation.payload.commandKind),
      state,
      platformMessageId: asString(observation.payload.platformMessageId),
      errorCode: asString(observation.payload.errorCode),
    },
    schemaVersion: 1,
    dedupKey: `cmd:${commandId}:${state}`,
  }];
}
