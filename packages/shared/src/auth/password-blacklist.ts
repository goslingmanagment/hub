// Decision 349 (§4.2): the agreed import path for the common-password
// blacklist, shared by the kernel (authoritative, on redeem) and the dashboard's
// /join form (early feedback), so the two never drift apart.
//
// The list itself lives in ../password-policy.ts next to the length bounds and
// the verdict type — one copy, one normalization (trim + lower-case). This
// module exists so a caller that only wants the membership question gets it
// under a stable name.

export { COMMON_PASSWORDS, isCommonPassword as isBlacklistedPassword } from "../password-policy.ts";
