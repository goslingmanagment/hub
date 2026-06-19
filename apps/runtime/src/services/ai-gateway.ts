import type { AiGatewayStreamBody } from "@agency_hub_core/contracts";
import { findPageSummaryByLabel } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { canAccessPage, type AuthPrincipal } from "./auth.ts";
import { NotFoundError, ServiceUnavailableError } from "./errors.ts";

export function isChatMuseAiGatewayEnabled(
  config?: Pick<AppContext["config"], "chatMuseAiGatewayEnabled">,
) {
  return config?.chatMuseAiGatewayEnabled === true;
}

export async function prepareAiGatewayStream(
  app: AppContext,
  principal: AuthPrincipal,
  input: AiGatewayStreamBody,
) {
  if (!isChatMuseAiGatewayEnabled(app.config)) {
    throw new ServiceUnavailableError("ChatMuse AI gateway is disabled");
  }

  const page = await findPageSummaryByLabel(app.db, input.pageLabel);
  if (!page || !canAccessPage(principal, page.id) || page.platform !== input.platform) {
    throw new NotFoundError("Page not found");
  }

  // Provider execution, quota reservation, durable gateway ledger rows, and SSE
  // streaming land in the next R4b slices. Until then, enabling the flag still
  // cannot reach Anthropic/OpenRouter or persist prompt text.
  throw new ServiceUnavailableError("ChatMuse AI gateway provider execution is not implemented");
}
