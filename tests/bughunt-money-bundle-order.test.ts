import { describe, expect, it } from "vitest";

import { decodeFanslyWsFrame } from "../apps/runtime/src/sync/fansly/ws/decode.ts";
import { routeWsItems, unknownRouteThread, type RouteContext } from "../apps/runtime/src/sync/fansly/ws/router.ts";
import { serviceFrame } from "./helpers/fansly-ws-fixtures.ts";

// Bug hunt 2026-10-09 (money): one PPV *bundle* sale on Fansly arrives as one
// `order` frame per media of the bundle (`type: 1`, accountMediaId = the
// member, accountMediaBundleId = the bundle) plus one bundle-level frame
// (`type: 2`, accountMediaId = the BUNDLE id, no accountMediaBundleId) —
// shape copied from production (ari-1, 2026-10-07 20:15:38, synthetic ids).
// The decoder ignores `order.type`, so the router asks for a `media:<bundle>`
// walk (Fansly answers 422 "error getting account media") and a `media:<m>`
// walk for every member (their own order history is empty: the sale is the
// bundle's). Only `bundle:<bundle>` carries the orders.

const NOW = Date.parse("2026-10-07T20:15:38.000Z");
const BUNDLE = "964308226982043648";
const MEMBERS = Array.from({ length: 10 }, (_, i) => String(964308226738778114n + BigInt(i)));
const ORDER = "964311501328363520";

const ctx: RouteContext = {
  pageId: 10,
  nowMs: NOW,
  thread: () => unknownRouteThread(),
  knownPendingTransaction: () => false,
  ownBroadcastActive: () => false,
};

function orderFrame(order: Record<string, unknown>): string {
  return serviceFrame({ type: 7, order }, 2);
}

describe("bug hunt: a bundle sale's order frames", () => {
  const frames = [
    ...MEMBERS.map((mediaId) => orderFrame({
      orderId: ORDER, accountMediaId: mediaId, correlationAccountId: "890375234929057792",
      accountId: "944314772046753793", accountMediaBundleId: BUNDLE, type: 1, orderMetadata: { accountMediaPrice: 61000 },
    })),
    orderFrame({
      orderId: ORDER, accountMediaId: BUNDLE, correlationAccountId: "890375234929057792",
      accountId: "944314772046753793", type: 2, orderMetadata: { accountMediaPrice: 61000 },
    }),
  ];
  const signals = routeWsItems(frames.flatMap((frame) => decodeFanslyWsFrame(frame, "890375234929057792").items), ctx);
  const walks = signals.filter((signal) => signal.resource === "purchases.targets").map((signal) => signal.subject);

  it("asks for exactly one purchase walk, the bundle's", () => {
    // Expected: ["bundle:<BUNDLE>"]. Actual: the bundle + 10 member media + media:<BUNDLE>.
    expect(walks).toEqual([`bundle:${BUNDLE}`]);
  });

  it("never names the bundle id as a media (Fansly 422s it)", () => {
    expect(walks).not.toContain(`media:${BUNDLE}`);
  });
});
