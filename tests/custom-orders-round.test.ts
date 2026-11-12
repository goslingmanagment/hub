import { describe, expect, it } from "vitest";

import { roundOf, stateByMessages, type CustomPart, type RoundMessage } from "../apps/runtime/src/services/custom-orders/rules.ts";

// Заказ кастома, the readiness of an order by its current round, per part (final review, round 2). Twice a delivery
// counted where it should not: a whole delivery of one part closed the other part's request, and the delivery that had
// been sent back for revision made the order «снят» again once its replacement was taken back.

const HOUR = 3_600_000;
const at = (hour: number) => new Date(Date.parse("2026-11-10T00:00:00Z") + hour * HOUR);
const delivery = (id: number, part: CustomPart, hour: number, extra: Partial<RoundMessage> = {}): RoundMessage =>
  ({ id, kind: "delivery", part, at: at(hour), complete: true, retracted: false, done: false, doneByDelivery: false, ...extra });
const request = (id: number, part: CustomPart | null, hour: number, extra: Partial<RoundMessage> = {}): RoundMessage =>
  ({ id, kind: "revision", part, at: at(hour), complete: null, retracted: false, done: false, doneByDelivery: false, ...extra });
const BOTH: CustomPart[] = ["video", "photos"];

describe("the round of a custom order", () => {
  it("counts a whole delivery only when it is newer than the last request about its part", () => {
    const sentBack = [delivery(1, "video", 10), request(2, null, 12)];
    expect(roundOf({ wanted: ["video"], partsDone: ["video"], messages: sentBack, questioned: ["video"] }))
      .toMatchObject({ partsDone: [], open: [2], answered: [], reopened: [], whole: false });
    // The new version answers the request; a piece of it, or a delivery taken back, does not.
    expect(roundOf({ wanted: ["video"], partsDone: [], messages: [...sentBack, delivery(3, "video", 13)] }))
      .toMatchObject({ partsDone: ["video"], open: [], answered: [2], reopened: [], whole: true });
    for (const not of [{ complete: false }, { retracted: true }]) {
      expect(roundOf({ wanted: ["video"], partsDone: [], messages: [...sentBack, delivery(3, "video", 13, not)] }).open).toEqual([2]);
    }
  });

  it("fixes a request about one part with that part alone, and leaves the other part as it is", () => {
    const messages = [delivery(1, "video", 9), delivery(2, "photos", 10), request(3, "video", 12), request(4, "photos", 12), delivery(5, "video", 14)];
    // The video's new version: the video's request is fixed, the photos' one is open and the photos are waited for.
    expect(roundOf({ wanted: BOTH, partsDone: [], messages }))
      .toMatchObject({ partsDone: ["video"], open: [4], answered: [3], reopened: [], whole: false });
    // A request about the photos alone never sends the video back.
    expect(roundOf({ wanted: BOTH, partsDone: BOTH, messages: messages.filter((message) => message.id !== 3 && message.id !== 5), questioned: ["photos"] }))
      .toMatchObject({ partsDone: ["video"], open: [4], answered: [], reopened: [], whole: false });
  });

  it("fixes a request about the whole order only when every wanted part came after it", () => {
    const messages = [delivery(1, "video", 9), delivery(2, "photos", 10), request(3, null, 12), delivery(4, "video", 14)];
    expect(roundOf({ wanted: BOTH, partsDone: [], messages })).toMatchObject({ partsDone: ["video"], open: [3], whole: false });
    expect(roundOf({ wanted: BOTH, partsDone: ["video"], messages: [...messages, delivery(5, "photos", 15)] }))
      .toMatchObject({ partsDone: BOTH, open: [], answered: [3], reopened: [], whole: true });
    // A request that names a part the card does not order is about what it does order.
    expect(roundOf({ wanted: ["video"], partsDone: [], messages: [delivery(1, "video", 9), request(2, "photos", 12)] }).open).toEqual([2]);
  });

  it("opens the request again when the delivery that answered it is taken back, never one fixed by a word", () => {
    const taken = [delivery(1, "video", 10), request(2, null, 12, { done: true, doneByDelivery: true }), delivery(3, "video", 13, { retracted: true })];
    // The delivery sent back for revision is still there and whole, and it does not count.
    expect(roundOf({ wanted: ["video"], partsDone: ["video"], messages: taken, questioned: ["video"] }))
      .toMatchObject({ partsDone: [], open: [2], answered: [], reopened: [2], whole: false });
    const byWord = taken.map((message) => (message.id === 2 ? { ...message, doneByDelivery: false } : message));
    expect(roundOf({ wanted: ["video"], partsDone: ["video"], messages: byWord, questioned: ["video"] }))
      .toMatchObject({ partsDone: [], open: [], answered: [], reopened: [], whole: false });
    // A newer request about the same part sends the part back once more; the older one, answered by a delivery
    // that stays, stays fixed.
    const again = [delivery(1, "video", 10), request(2, null, 12, { done: true, doneByDelivery: true }), delivery(3, "video", 13), request(4, null, 15)];
    expect(roundOf({ wanted: ["video"], partsDone: ["video"], messages: again, questioned: ["video"] }))
      .toMatchObject({ partsDone: [], open: [4], answered: [], reopened: [], whole: false });
  });

  it("lets a person's word stand for a part until a step questions it", () => {
    // «Снят» by hand, no delivery recorded: the part is ready by the word the order keeps.
    expect(roundOf({ wanted: BOTH, partsDone: BOTH, messages: [delivery(1, "video", 9)] }).whole).toBe(true);
    expect(roundOf({ wanted: BOTH, partsDone: BOTH, messages: [delivery(1, "video", 9)], questioned: ["photos"] }))
      .toMatchObject({ partsDone: ["video"], whole: false });
  });

  it("keeps a person's «снят» through a delivery taken back, until a request newer than their word", () => {
    // «Снят» by hand at 14:00, after the request of 12:00; the delivery linked later is taken back.
    const messages = [delivery(1, "video", 10), request(2, null, 12, { done: true }), delivery(3, "video", 15, { retracted: true })];
    expect(roundOf({ wanted: ["video"], partsDone: ["video"], messages, questioned: ["video"], saidWholeAt: at(14) }))
      .toMatchObject({ partsDone: ["video"], open: [], reopened: [], whole: true });
    // Without that word the part goes with the delivery (the reader's «снят», an imported part).
    expect(roundOf({ wanted: ["video"], partsDone: ["video"], messages, questioned: ["video"] })).toMatchObject({ partsDone: [], whole: false });
    // A request after the word opens a new round: the word no longer stands for the part it is about.
    expect(roundOf({ wanted: BOTH, partsDone: BOTH, messages: [...messages, request(4, "video", 16)], questioned: ["video"], saidWholeAt: at(14) }))
      .toMatchObject({ partsDone: ["photos"], open: [4], whole: false });
    // A request reported late but sent before the word is answered by it for good.
    expect(roundOf({ wanted: ["video"], partsDone: ["video"], messages: [request(5, null, 13)], questioned: ["video"], saidWholeAt: at(14) }))
      .toMatchObject({ partsDone: ["video"], open: [], answered: [5], whole: true });
  });

  it("puts an order where its kept messages say, from the states a delivery moves it from", () => {
    // A delivery the import kept without its part is of the first part the card orders, and whole.
    const imported = roundOf({ wanted: ["video"], partsDone: [], messages: [delivery(1, "video", 10, { part: null, complete: null })] });
    expect(imported).toMatchObject({ partsDone: ["video"], whole: true, liveDeliveries: 1 });
    expect(stateByMessages("at_model", imported)).toBe("shot");
    expect(stateByMessages("given", imported)).toBe("given");
    const piece = roundOf({ wanted: BOTH, partsDone: [], messages: [delivery(1, "video", 10)] });
    expect(stateByMessages("at_model", piece)).toBe("partly");
    const asked = roundOf({ wanted: ["video"], partsDone: [], messages: [delivery(1, "video", 10), request(2, null, 12)] });
    expect(stateByMessages("partly", asked)).toBe("revision");
    // Nothing delivered, nothing asked: the state stays; a revision whose requests are closed waits for its part.
    const nothing = roundOf({ wanted: ["video"], partsDone: [], messages: [] });
    expect(stateByMessages("paid", nothing)).toBe("paid");
    expect(stateByMessages("revision", nothing)).toBe("revision");
  });

  it("reads «newer» by the message's own time, then by the order the hub kept them in", () => {
    // Reported after the request (a later id), sent before it: old.
    expect(roundOf({ wanted: ["video"], partsDone: [], messages: [request(1, null, 12), delivery(2, "video", 11)] }).open).toEqual([1]);
    // A request reported late, whose part came whole after it, is fixed already.
    expect(roundOf({ wanted: ["video"], partsDone: ["video"], messages: [delivery(1, "video", 13), request(2, null, 12)], questioned: ["video"] }))
      .toMatchObject({ partsDone: ["video"], open: [], answered: [2], reopened: [], whole: true });
    // The same moment: the one the hub kept later is the newer.
    expect(roundOf({ wanted: ["video"], partsDone: [], messages: [request(1, null, 12), delivery(2, "video", 12)] }).whole).toBe(true);
    expect(roundOf({ wanted: ["video"], partsDone: [], messages: [delivery(1, "video", 12), request(2, null, 12)] }).whole).toBe(false);
  });
});
