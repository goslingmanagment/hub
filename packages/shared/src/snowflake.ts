const FOLLOW_RELATION_EPOCH_MS = 1561494359900;
const DECIMAL_ID = /^\d+$/;

export function fanslyFollowIdToDate(id: string | bigint): Date {
  return fanslySnowflakeToDate(id);
}

/** The creation instant encoded in any Fansly snowflake id (accounts, chats,
 *  messages and follows share the epoch and the 22-bit shift). Throws on a
 *  string that is not an integer, like `BigInt`. */
export function fanslySnowflakeToDate(id: string | bigint): Date {
  const numeric = typeof id === "bigint" ? id : BigInt(id);
  const timestampMs = Number((numeric >> 22n) + BigInt(FOLLOW_RELATION_EPOCH_MS));

  return new Date(timestampMs);
}

/** Orders two follow ids by their snowflake value, so an older follow sorts
 *  lower; null when either id is not a plain decimal and no order is known. */
export function compareFanslyFollowIds(a: string, b: string): -1 | 0 | 1 | null {
  if (!DECIMAL_ID.test(a) || !DECIMAL_ID.test(b)) {
    return null;
  }
  const left = BigInt(a);
  const right = BigInt(b);
  return left === right ? 0 : left < right ? -1 : 1;
}
