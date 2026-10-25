import { FanslyApiError, fanslyWireSpec, readFanslyWireResponse, type FanslyAccountMe, type FanslyEnvelope, type FanslyWireOutcome } from "@agency_hub_core/fansly";
import { parseRetryAfterInstant, redactSensitiveText } from "@agency_hub_core/shared";

// The answer of a Fansly session's `GET /account/me` that belongs to no page
// yet — the browser's check of a profile no page has (Project Browser PR 16):
// the account it names, or the error the legacy adapter's verify threw for
// the same answer (`FanslyApiError`: an authorization failure, a failed
// request, an unsuccessful envelope, an account without an id).

/** The provider's text of a failure the legacy adapter also kept. */
const RESPONSE_SNIPPET_MAX_CHARS = 400;
const ERROR_DETAILS_MAX_CHARS = 200;

/** The account of an answer, or the legacy adapter's error for it. */
export function accountOf(outcome: FanslyWireOutcome): FanslyAccountMe["account"] {
  if (outcome.kind === "aborted_before_send") {
    throw new Error(`Fansly identity check was not sent (${outcome.refusal})`);
  }
  if (outcome.kind !== "response") {
    throw new Error(outcome.message);
  }
  const read = readFanslyWireResponse(fanslyWireSpec("account.me"), {}, outcome);
  const snippet = redactSensitiveText(outcome.bodyText).slice(0, RESPONSE_SNIPPET_MAX_CHARS);
  switch (read.kind) {
    case "accepted":
      return read.value.account;
    case "contract_violation":
      throw new FanslyApiError("Fansly session verification returned an invalid account", read.status, undefined, snippet);
    case "envelope_unsuccessful":
      throw new FanslyApiError(
        failureMessage(read.envelope, "Fansly response envelope was unsuccessful"),
        read.status,
        read.envelope?.error?.code,
        snippet,
      );
    case "http_error": {
      const fallback = read.status === 401 || read.status === 403
        ? `Fansly authorization failed (${read.status})`
        : `Fansly request failed (${read.status})`;
      throw new FanslyApiError(
        failureMessage(read.envelope, fallback),
        read.status,
        read.envelope?.error?.code,
        snippet,
        parseRetryAfterInstant(read.retryAfter),
      );
    }
  }
}

/** The provider's message when it sent one; otherwise ours, with the
 *  provider's details after it (redacted before they are cut). */
function failureMessage(envelope: FanslyEnvelope | null, fallback: string): string {
  const message = envelope?.error?.message;
  if (message !== undefined) return redactSensitiveText(message);
  const details = envelope?.error?.details?.trim();
  return details === undefined || details.length === 0
    ? fallback
    : `${fallback}: ${redactSensitiveText(details).slice(0, ERROR_DETAILS_MAX_CHARS)}`;
}
