import { OfapiProviderOperationRefused } from "@agency_hub_core/db";

import { OfapiCreditAccountingUnavailableError, OfapiCredentialNotReadyError } from "./ofapi.ts";
import { OfapiKeyPermissionDeniedError, OfapiKeyScopeUnavailableError } from "./ofapi-vendor-usage.ts";

/** The command was claimed, but its local guard refused any vendor dispatch. */
export class OfapiLocalDispatchRefusal extends Error {
  constructor(
    readonly reason: "account_unavailable" | "binding_replaced" | "auth_action_required" | "credential_not_verified" | "credit_accounting_unavailable" | "key_scope_denied" | "key_scope_unavailable" | "provider_replay_unavailable" | "media_token_already_used",
    readonly detail: string | null = null,
  ) {
    super(`OFAPI command refused before dispatch: ${reason}`);
    this.name = "OfapiLocalDispatchRefusal";
  }
}

/** Typed pre-dispatch refusals raised inside the vendor client, mapped to the
 * executor's local verdict. Every one of them is thrown BEFORE any HTTP request,
 * so none may ever read as an indeterminate vendor outcome. Null = not local. */
export function localDispatchRefusalFrom(error: unknown): OfapiLocalDispatchRefusal | null {
  if (error instanceof OfapiLocalDispatchRefusal) return error;
  if (error instanceof OfapiProviderOperationRefused) return new OfapiLocalDispatchRefusal(error.reason === "replay_unavailable" ? "provider_replay_unavailable" : error.reason);
  if (error instanceof OfapiCredentialNotReadyError) return new OfapiLocalDispatchRefusal("credential_not_verified", error.reason ?? error.preflightStatus);
  if (error instanceof OfapiCreditAccountingUnavailableError) return new OfapiLocalDispatchRefusal("credit_accounting_unavailable");
  if (error instanceof OfapiKeyPermissionDeniedError) return new OfapiLocalDispatchRefusal("key_scope_denied");
  // A key-scope lookup the kernel could not complete (DB blip) is not a policy
  // verdict and not a vendor outcome: the command never left the process.
  if (error instanceof OfapiKeyScopeUnavailableError) return new OfapiLocalDispatchRefusal("key_scope_unavailable", "key_declaration_lookup_failed");
  return null;
}
