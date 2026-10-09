// OnlyFans link ↔ fan (plan 2026-10-08, PR 8): the vocabulary shared by the
// projection (migration 0260, repositories/link-fans.ts), the sweep that feeds
// it and, later, Hub's own money per link (PR 13) and its datasets.

/**
 * The attribution rule Hub's own money per link is computed under, and the
 * rule the link ↔ fan periods are projected under. It names one fixed
 * definition; a different definition is a new name.
 *
 * PERIOD (decided by the coordinator on 2026-10-09 against the production
 * journal). A link's subscriber list is its claim history, not its current
 * subscribers, and the vendor's subscription dates on a list item describe the
 * fan ↔ creator relation, not the link. So a period of (link, fan):
 *   - is open while the fan is in the link's subscriber list and the vendor
 *     flags him active there (`subscribedOnExpiredNow === false`);
 *   - opens at the sighting that shows him active while no period is open: at
 *     the one `subscription.started` webhook of the fan between the link's last
 *     finished walk and that sighting, else at the sighting; before the link's
 *     floor (its first finished walk that may count absence) it opens as
 *     "before floor" and counts from the floor;
 *   - closes at the start of the first finished walk that shows him not
 *     active, or at the start of the first of two finished walks in a row that
 *     miss him (counted only once the page's lists under that walk's OFAPI
 *     account have returned someone);
 *   - an unfinished walk closes nothing; a fan first seen not active opens no
 *     period; a later active sighting opens a new one.
 *
 * MONEY (PR 13). A transaction of the fan counts for every link whose period
 * holds its time, split equally between them (the vendor's own "link
 * stacking" rule).
 */
export const LINK_ATTRIBUTION_RULE = "ofapi_subscription_period_equal_split.v1" as const;
export type LinkAttributionRule = typeof LINK_ATTRIBUTION_RULE;

/** The sweep's journal kinds the projection applies, one per vendor route. */
export const LINK_FAN_JOURNAL_ENDPOINTS = [
  "link_fans_tracking_subscribers",
  "link_fans_tracking_spenders",
  "link_fans_trial_subscribers",
] as const;
export type LinkFanJournalEndpoint = (typeof LINK_FAN_JOURNAL_ENDPOINTS)[number];

export const linkFanListKinds = ["subscribers", "spenders"] as const;
export type LinkFanListKind = (typeof linkFanListKinds)[number];

export type LinkFanPeriodStartSource = "before_floor" | "hub_subscription_event" | "first_seen";
export type LinkFanPeriodCloseReason = "not_active" | "absent";

/** Which link kind and list a journal kind carries. */
export function linkFanJournalEndpointShape(endpoint: string): {
  linkKind: "tracking" | "trial";
  listKind: LinkFanListKind;
} | null {
  switch (endpoint) {
    case "link_fans_tracking_subscribers":
      return { linkKind: "tracking", listKind: "subscribers" };
    case "link_fans_tracking_spenders":
      return { linkKind: "tracking", listKind: "spenders" };
    case "link_fans_trial_subscribers":
      return { linkKind: "trial", listKind: "subscribers" };
    default:
      return null;
  }
}
