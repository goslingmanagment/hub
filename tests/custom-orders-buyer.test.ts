import { describe, expect, it } from "vitest";

import { buyerNamesFan } from "../apps/runtime/src/services/custom-orders/rules.ts";

// Заказ кастома, the buyer's string of an order no fan was matched for, and the fan it names (a fan's erasure takes
// such an order with him). A name that only looks like a login names nobody. Every name and number is made up.

const fan = { platform: "onlyfans", platformUserId: "100000001", username: "sam_handle" };
const names = (buyer: string) => buyerNamesFan(buyer, fan);

describe("a buyer's string and the fan it names", () => {
  it("names him by the platform's number, his alone by itself", () => {
    for (const buyer of ["100000001", "Sam (100000001)", "https://onlyfans.com/u100000001", "https://chat.onlymonster.ai/accounts/5/chats/100000001"]) {
      expect(names(buyer), buyer).toBe("number");
    }
    expect(names("100000002")).toBeNull();
    expect(names("https://onlyfans.com/u100000002")).toBeNull();
  });

  it("names him by his login through an explicit reference in any letter case, or a bare word that is the username letter for letter", () => {
    for (const buyer of ["@sam_handle", "@Sam_Handle", "https://onlyfans.com/Sam_Handle", "Sam (@SAM_HANDLE)", "sam_handle", "Sam (sam_handle)"]) {
      expect(names(buyer), buyer).toBe("login");
    }
    // A bare word in another spelling is a name; so are words, and another platform's link.
    for (const buyer of ["Sam_Handle", "Sam (Sam_Handle)", "Sam", "sam handle", "Том", "sam_handle + ещё один", "https://fansly.com/sam_handle/posts"]) {
      expect(names(buyer), buyer).toBeNull();
    }
    expect(buyerNamesFan("@sam_handle", { ...fan, username: null })).toBeNull();
  });
});
