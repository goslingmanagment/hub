import { randomUUID } from "node:crypto";

import {
  completeFanslySendAttempt,
  journalUnpacedFanslySend,
  markFanslySendAttemptSent,
} from "@agency_hub_core/db";
import {
  buildFanslyWireRequest,
  FanslyApiError,
  fanslyWireSpec,
  readFanslyWireResponse,
  sendFanslyWireRequest,
  type FanslyAccountMe,
  type FanslyEnvelope,
  type FanslySendSource,
  type FanslyWireOutcome,
} from "@agency_hub_core/fansly";
import {
  normalizeProxyConfig,
  parseRetryAfterInstant,
  redactSensitiveText,
  type FanslySessionBundle,
  type ProxyConfig,
} from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { resolveEgress } from "../../services/egress/resolver.ts";
import { BadRequestError } from "../../services/errors.ts";
import { getFanslySendGuards } from "../../services/fansly-send-guard/index.ts";
import { REQUEST_TIMEOUT_MS } from "../engine/pacer.ts";

// The identity check of a Fansly session that belongs to no page yet (step 4
// S4-05; step-2 design §11.4, senders #8 and #9): onboarding's check before
// the page exists, and the dashboard's create-page check
// (`POST /api/v1/admin/credentials/verify`), which the create-page modal needs
// before it may create. One `GET /account/me`:
//
// - through the wire layer's single-request send (`sendFanslyWireRequest`:
//   one physical request, no retry, no redirect followed — a retry is the
//   owner's next click);
// - over the proxy the page will be given, never direct: the egress
//   resolver's `fansly_candidate` scope (a proxy required, its target checked
//   before any byte leaves);
// - unpaced but journaled (owner decision №4: a session whose account is not
//   known yet is paced against no page): one `fansly_send_log` row with
//   `page_id` null and the caller's source, written before the send and
//   completed with its outcome.
//
// The answer is the account the session belongs to, or the error the legacy
// adapter's verify threw for the same answer (`FanslyApiError`: an
// authorization failure, a failed request, an unsuccessful envelope, an
// account without an id), so both callers answer as they always have.

/** The two callers of the no-page check. */
export type FanslyNoPageIdentitySource = Extract<FanslySendSource, "onboarding" | "credentials_verify">;

export interface FanslyNoPageIdentity {
  /** `/account/me` as its contract accepts it. */
  account: FanslyAccountMe["account"];
  /** When the request went out (undici `onRequestStart`): the instant the
   *  identity was proved. */
  sentAt: Date;
}

/** The provider's text of a failure the legacy adapter also kept. */
const RESPONSE_SNIPPET_MAX_CHARS = 400;
const ERROR_DETAILS_MAX_CHARS = 200;

/**
 * Check which Fansly account `session` belongs to, through `proxy`. Throws a
 * `BadRequestError` before anything is journaled or sent for a missing or
 * refused proxy; otherwise one journaled request, then the account or the
 * answer's error.
 */
export async function checkFanslyIdentityWithoutPage(
  app: Pick<AppContext, "db" | "config" | "logger" | "fanslySendGuards">,
  input: {
    session: FanslySessionBundle;
    proxy: ProxyConfig | null | undefined;
    source: FanslyNoPageIdentitySource;
  },
): Promise<FanslyNoPageIdentity> {
  if (!input.proxy) {
    throw new BadRequestError("A Fansly identity check needs the proxy the page will use; it never goes direct");
  }
  let proxy: ProxyConfig;
  try {
    proxy = normalizeProxyConfig(input.proxy);
  } catch (error) {
    throw new BadRequestError(
      `Invalid proxy URL: ${redactSensitiveText(error instanceof Error ? error.message : "Invalid proxy URL")}`,
    );
  }
  const egress = await resolveEgress(app, { kind: "fansly_candidate", proxy });
  try {
    if (egress.dispatcher === null) {
      throw new Error("The Fansly candidate egress has no proxy dispatcher; nothing is sent");
    }
    const spec = fanslyWireSpec("account.me");
    const request = buildFanslyWireRequest(spec.id, {}, {
      baseUrl: app.config.fanslyBaseUrl,
      session: input.session,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const token = randomUUID();
    const issuedAt = performance.now();
    await journalUnpacedFanslySend(app.db, {
      token,
      source: input.source,
      operation: spec.legacyOperation,
      holder: getFanslySendGuards(app).holderIdentity(),
    });
    const sent: { at: Date | null; offsetMs: number | null; marking: Promise<void> } = {
      at: null,
      offsetMs: null,
      marking: Promise.resolve(),
    };
    const outcome = await sendFanslyWireRequest(egress.dispatcher, request, {
      check: () => {
        const at = new Date();
        const offsetMs = Math.max(0, Math.ceil(performance.now() - issuedAt));
        sent.at = at;
        sent.offsetMs = offsetMs;
        // The send moment as soon as the headers go (the completion writes
        // it too): a process that dies mid-request still shows it was sent.
        sent.marking = markFanslySendAttemptSent(app.db, { token, sentAt: at, sendOffsetMs: offsetMs }).catch((error: unknown) => {
          app.logger.warn({ component: "fansly_send_guard", source: input.source, err: error },
            "Fansly identity check could not record its send moment yet; the completion will");
        });
        return null;
      },
    }, new AbortController().signal);
    await sent.marking;
    await completeFanslySendAttempt(app.db, {
      pageId: null,
      token,
      nextU: 0,
      outcome: outcome.kind,
      outcomeDetail: outcome.kind === "aborted_before_send" ? outcome.refusal : null,
      httpStatus: outcome.kind === "response" ? outcome.status : null,
      sentAt: sent.at,
      sendOffsetMs: sent.offsetMs,
    });
    const account = accountOf(outcome);
    // An accepted answer always carries its send mark (`request_start`);
    // the completion instant is the safe upper bound otherwise.
    return { account, sentAt: sent.at ?? new Date() };
  } finally {
    await egress.close().catch(() => undefined);
  }
}

/** The account of an answer, or the legacy adapter's error for it. */
function accountOf(outcome: FanslyWireOutcome): FanslyAccountMe["account"] {
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
