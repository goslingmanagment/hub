import { useQuery } from "@tanstack/react-query";
import { moscowToday } from "@agency_hub_core/ui/moscow";
import { kernel } from "./hub.js";

/**
 * Whether the person's right «видит свои деньги» is on (people registry `sees_own_pay`): `accountPay` of today answers
 * `enabled`, and asks the ledger nothing while it is off. The menu lists «Деньги» for anyone but the owner only while it
 * is on (screens.ts `when: "money"`). The owner reads nothing here: «Деньги» is always theirs.
 */
export function useOwnPayOn(ask: boolean): boolean {
  const today = moscowToday();
  const query = useQuery({
    queryKey: ["own-pay-on", today],
    queryFn: () => kernel.accountPay({ query: { from: today, to: today } }),
    enabled: ask,
    staleTime: 5 * 60_000,
    retry: false,
    meta: { suppressGlobalError: true },
  });
  return query.data?.enabled === true;
}
