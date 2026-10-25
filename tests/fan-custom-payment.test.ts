import { describe, expect, it } from "vitest";

import { paymentTaken } from "../apps/runtime/src/services/fan-card.ts";
import { ConflictError } from "../apps/runtime/src/services/errors.ts";

// A tip two chatters write into customs at once: the unique index refuses the
// second, and drizzle wraps the driver's error — the 23505 is in its cause.
// The second chatter gets 409 `not_suggested`, never a 500.

describe("a payment taken by another custom", () => {
  it("answers 409 for a unique violation wrapped by drizzle, and passes any other error on", async () => {
    const wrapped = Object.assign(new Error("Failed query: insert into fan_customs"), { cause: Object.assign(new Error("duplicate key"), { code: "23505" }) });
    await expect(paymentTaken(() => Promise.reject(wrapped))).rejects.toBeInstanceOf(ConflictError);
    await expect(paymentTaken(() => Promise.reject(wrapped))).rejects.toMatchObject({ statusCode: 409, reason: "not_suggested" });
    const other = new Error("connection reset");
    await expect(paymentTaken(() => Promise.reject(other))).rejects.toBe(other);
    await expect(paymentTaken(() => Promise.resolve(true))).resolves.toBe(true);
  });
});
