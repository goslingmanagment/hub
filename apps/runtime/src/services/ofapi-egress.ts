import { findPageById } from "@agency_hub_core/db";
import type { Dispatcher } from "undici";

import type { AppContext } from "../bootstrap.ts";
import { ServiceUnavailableError } from "./errors.ts";
import { resolveEgress } from "./egress/resolver.ts";

export class OfapiBindingUnavailableError extends ServiceUnavailableError {
  constructor() {
    super("OFAPI account binding is unavailable");
  }
}

export interface OfapiEgressContext {
  dispatcher: Dispatcher | null;
  egressKey: string;
  close(): Promise<void>;
}

export async function resolveOfapiEgressContext(
  app: AppContext,
  input: {
    pageId: number;
    ofapiAccountId: string;
  },
): Promise<OfapiEgressContext> {
  const stored = await findPageById(app.db, input.pageId);
  if (
    !stored
    || stored.page.platform !== "onlyfans"
    || stored.page.ofapiAccountId !== input.ofapiAccountId
  ) {
    throw new OfapiBindingUnavailableError();
  }

  // Binding authorizes this account; the vendor owns its OnlyFans-side
  // identity. Hub -> OFAPI shares the vendor route with ordinary REST reads.
  // Do not expose pace: the OFAPI client already claims its one pacing slot.
  const egress = await resolveEgress(app, { kind: "vendor", vendor: "ofapi" });
  return {
    dispatcher: egress.dispatcher,
    egressKey: egress.egressKey,
    close: egress.close,
  };
}
