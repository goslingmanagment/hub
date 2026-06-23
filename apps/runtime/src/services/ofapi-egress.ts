import { findPageById } from "@agency_hub_core/db";
import { createProxyRequestDispatcher } from "@agency_hub_core/shared";
import type { Dispatcher } from "undici";

import type { AppContext } from "../bootstrap.ts";
import { ServiceUnavailableError } from "./errors.ts";
import {
  resolveStoredProxyConfig,
  resolveStoredProxyEgressKey,
} from "./page-context.ts";

export interface OfapiEgressContext {
  dispatcher: Dispatcher;
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
    throw new ServiceUnavailableError("OFAPI account egress mapping is unavailable");
  }

  const proxy = resolveStoredProxyConfig(app, stored.proxy);
  if (!proxy) {
    throw new ServiceUnavailableError(
      `OFAPI account "${input.ofapiAccountId}" requires a configured page proxy`,
    );
  }

  const dispatcher = createProxyRequestDispatcher(proxy);
  return {
    dispatcher,
    egressKey: resolveStoredProxyEgressKey(stored.proxy),
    close: async () => {
      await dispatcher.close();
    },
  };
}
