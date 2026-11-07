import type { KernelOperationResponse, ShiftReviewChat } from "@agency_hub_core/contracts";

import { isDemoReply, rng, type DemoHandlers, type DemoReply, type DemoRequest } from "../core.ts";
import { teamShiftReview as inventedReview } from "./team-review.ts";
import { teamWorld, workedPages } from "./team-world.ts";

/**
 * «Разбор смены» in the demo, with its money. team-review.ts invents the chats
 * of a shift around its numbers but leaves the shift's sales at $0; here the
 * sales the shift journal shows for that very shift (team-world.ts) land in its
 * chats: a bought PPV on the chatter's message before it, a tip on the fan's,
 * the shift's total on the shift. And two AI texts carry the long dash the
 * screen marks. Same answers otherwise, typed by the contract.
 */

type Response = KernelOperationResponse<"teamShiftReview">;

/** The chat of the page that was busiest around the sale: the fan's own when the chatter wrote to him. */
function chatOf(chats: readonly ShiftReviewChat[], pageLabel: string, fanRef: string, at: number): ShiftReviewChat | null {
  const onPage = chats.filter((chat) => chat.pageLabel === pageLabel && chat.messages.some((message) => message.inShift && message.mine !== null && message.mine.composedWith !== "hi"));
  const own = onPage.find((chat) => chat.fanRef === fanRef);
  if (own) return own;
  let best: ShiftReviewChat | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const chat of onPage) {
    for (const message of chat.messages) {
      if (!message.inShift) continue;
      const gap = Math.abs(Date.parse(message.at) - at);
      if (gap < distance) {
        distance = gap;
        best = chat;
      }
    }
  }
  return best;
}

function withMoney(review: Response, request: DemoRequest): Response {
  const start = Date.parse(review.shift.startedAt);
  const shift = teamWorld(request.now).shifts.find((one) => one.user.id === review.shift.userId && one.startedAt === start);
  if (!shift) return review;
  const pages = workedPages(shift);
  const sales = shift.sales.filter((sale) => pages.includes(sale.pageLabel));
  // A PPV is bought only where a sale of the shift says so: the invented ones stay unbought.
  for (const chat of review.chats) for (const message of chat.messages) if (message.bought === true) message.bought = false;
  for (const sale of sales) {
    const chat = chatOf(review.chats, sale.pageLabel, sale.fan.platformUserId, sale.at);
    if (!chat) continue;
    chat.shiftNetMills += sale.netMills;
    // What the fan brought all time holds this shift's sale too.
    chat.fanLifetimeNetMills = (chat.fanLifetimeNetMills ?? 0) + sale.netMills;
    if (sale.kind === "ppv") {
      const offer = [...chat.messages].reverse().find((message) => message.inShift && message.mine !== null && Date.parse(message.at) <= sale.at)
        ?? chat.messages.find((message) => message.inShift && message.mine !== null);
      if (offer) {
        offer.priceMills = sale.priceMills;
        offer.bought = true;
        offer.media = Math.max(1, offer.media);
      }
    } else if (sale.kind === "tip") {
      const fan = [...chat.messages].reverse().find((message) => message.inShift && message.side === "fan" && Date.parse(message.at) <= sale.at)
        ?? chat.messages.find((message) => message.inShift && message.side === "fan");
      if (fan) fan.tipMills = (fan.tipMills ?? 0) + sale.priceMills;
    }
  }
  review.shift.salesNetMills = sales.reduce((sum, sale) => sum + sale.netMills, 0);

  // The long dash, an AI tell the screen marks, in two of the AI's texts.
  const random = rng(`wb-review:${shift.user.id}:${shift.startedAt}`);
  let dashed = 0;
  for (const chat of review.chats) {
    for (const message of chat.messages) {
      if (dashed >= 2 || message.mine === null || message.mine.origin !== "ai" || message.mine.composedWith === "hi" || !message.text.includes(", ")) continue;
      if (random() > 0.25) continue;
      message.text = message.text.replace(", ", " — ");
      if (message.mine.aiText !== null) message.mine.aiText = message.mine.aiText.replace(", ", " — ");
      message.mine.marks = [...message.mine.marks, "dash"];
      dashed += 1;
    }
  }
  return review;
}

export function teamShiftReview(request: DemoRequest): Response | DemoReply {
  const review = inventedReview(request);
  return isDemoReply(review) ? review : withMoney(review, request);
}

export const wbReviewHandlers: DemoHandlers = { teamShiftReview };
