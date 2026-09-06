import { materializeOfapiVaultCatalog } from "./ofapi-media-catalog.ts";
import { planOfapiReadCollection, planOfapiProfileVisitorCollection, type OfapiCollectionHandlers } from "./ofapi-collection-runner.ts";
import { materializeOfapiProfileVisitorsRest } from "./ofapi-profile-visitors.ts";

/** Runtime composition: each optional category retains the same policy and capture fences. */
export const ofapiCollectionHandlers: OfapiCollectionHandlers = {
  vault_catalog: { plan: planOfapiReadCollection, materialize: materializeOfapiVaultCatalog },
  visitors: {
    plan: planOfapiProfileVisitorCollection,
    materialize: async (app, { job, step, body, observationId, observationReceivedAt }) => {
      const type = step.query.type;
      if (type !== "total" && type !== "users" && type !== "guests") throw new Error("Unsupported visitor type");
      await materializeOfapiProfileVisitorsRest(app.db, {
        pageId: Number(job.page_id), accountId: step.pathname.split("/")[1]!,
        startDate: step.query.start_date!, endDate: step.query.end_date!, type,
        body, observationId, observationReceivedAt,
      });
    },
  },
};
