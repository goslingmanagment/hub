const FOLLOW_RELATION_EPOCH_MS = 1561494359900;

export function fanslyFollowIdToDate(id: string | bigint): Date {
  const numeric = typeof id === "bigint" ? id : BigInt(id);
  const timestampMs = Number((numeric >> 22n) + BigInt(FOLLOW_RELATION_EPOCH_MS));

  return new Date(timestampMs);
}
