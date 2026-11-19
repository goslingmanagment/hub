import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { ofapiConfigQuery, ofapiStatusOf } from "@agency_hub_core/ui/console/ofapiStatus";

import type { OfapiStatus } from "@/lib/statusWords";
import { useAuthMe } from "./queries.js";
import { kernel } from "./sdk.js";

/**
 * Whether the OnlyFans API is on, with the read behind it (design/screens/system.md
 * §0.2). `off` is said only when every process reported the key unset; a process
 * that does not know makes the answer `unknown`, and so does no answer. A team lead
 * cannot read the config: always `unknown`, without a request.
 *
 * The config is a large read and the key changes by the owner's hand (a change in
 * the console refreshes it): a screen reads it when it opens, not on a timer.
 */
export function useOfapiStatusQuery(role: string): { status: OfapiStatus; isLoading: boolean; refetch: () => void } {
  // A test owner may not read the config either: the answer is `unknown`, without a request (as for a team lead).
  const testRealm = useAuthMe().data?.test === true;
  const config = useQuery(ofapiConfigQuery(kernel, testRealm ? "team_lead" : role));
  const { refetch } = config;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  return { status: ofapiStatusOf(config.data), isLoading: config.isLoading, refetch: retry };
}

/** The one answer every screen asks: `on`, `off`, or `unknown` when it cannot be said. */
export function useOfapiStatus(role: string): OfapiStatus {
  return useOfapiStatusQuery(role).status;
}
