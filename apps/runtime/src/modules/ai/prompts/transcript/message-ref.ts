// chat-extension R20 HF-8a — a platform message id stays the exact string its
// store keeps, from the store to the prompt and the context frame. Not a file
// migrated from the desktop: the hub's own rule for the migrated normalizer.
//
// The transcript used to key a message by `Number(ref)`. Fansly ids are 18-19
// digits and pass 2^53, where a double rounds: around 9·10^17 its step is 128,
// so `Number("900000000000000001") === Number("900000000000000002")`, and even
// ids exactly 128 apart can meet (`…999936` and `…000064`, rounded to even).
// The transcript kept one of two such messages and dropped the other. OnlyFans
// ids are 13-14 digits, far below 2^53, so for them the order of the strings
// below is the order their numbers had, and no OnlyFans byte changes.

const DECIMAL_REF = /^[0-9]+$/;

/** Whether the transcript can key and order a message by this ref: a decimal
 *  id, kept as the string its store holds. */
export function isTranscriptMessageRef(ref: string): boolean {
  return DECIMAL_REF.test(ref);
}

/**
 * A total order of message refs that never goes through a double. Decimal refs
 * compare by their exact value, and two spellings of one value ("7", "007") by
 * the string; any other ref sorts after every decimal one, by the string. Two
 * refs compare equal only when they are the same string.
 */
export function compareMessageRefs(left: string, right: string): number {
  const leftDecimal = DECIMAL_REF.test(left);
  const rightDecimal = DECIMAL_REF.test(right);
  if (leftDecimal !== rightDecimal) {
    return leftDecimal ? -1 : 1;
  }
  if (leftDecimal) {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    if (leftValue !== rightValue) {
      return leftValue < rightValue ? -1 : 1;
    }
  }
  return left < right ? -1 : left > right ? 1 : 0;
}
