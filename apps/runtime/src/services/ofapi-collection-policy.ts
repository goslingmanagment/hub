import { classifyOfapiCollectionOperation, type OfapiCollectionContext } from "@agency_hub_core/shared";
import { OfapiCollectionPolicyError, reserveOfapiCollectionRequest, settleOfapiCollectionRequest, releaseOfapiCollectionRequest, type Database } from "@agency_hub_core/db";

export interface OfapiCollectionDispatch {
  operation: string; method: string; accountId: string; pageId?: number | null | undefined;
  requestId: string; reservedCredits?: number; context?: OfapiCollectionContext | undefined;
  interactive?: boolean;
}
/** Every transport seam calls this hook; policy read errors deliberately propagate. */
export function ofapiCollectionPolicyHooks(db: Database, onSettlementError?: (error: unknown) => void) {
  return {
    beforeCollectionRequest: async (input: OfapiCollectionDispatch) => {
      const classification = classifyOfapiCollectionOperation(input.operation);
      if (classification === "command" || (classification === "diagnostic" && input.context?.purpose !== "one_off")) return;
      if (!input.pageId) throw new OfapiCollectionPolicyError("page_required");
      const context = input.context;
      await reserveOfapiCollectionRequest(db, { operation: input.operation, pageId: input.pageId, requestId: input.requestId,
        ...(context ? { context } : {}), purpose: input.interactive ? "interactive" : "background", reservedCredits: context?.reservedCredits ?? input.reservedCredits ?? 1 });
    },
    onCollectionResponse: async (requestId: string, actualCredits: number | null) => {
      await settleOfapiCollectionRequest(db, requestId, actualCredits).catch(error => { onSettlementError?.(error); });
    },
    onCollectionCancelled: async (requestId: string) => {
      await releaseOfapiCollectionRequest(db, requestId).catch(error => { onSettlementError?.(error); });
    },
  };
}
