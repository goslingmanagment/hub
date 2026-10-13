// What the parts of the stand agree on: the names of its Fansly are Fansly's
// own (src/egress/hosts.ts — the operator and the rules extension name them),
// everything else here is the stand's.

/** What the stand's exit-IP service answers: the address the runner pins. */
export const STAND_EXIT_IP = "203.0.113.7";
/** Another address, for "the exit IP changed". */
export const STAND_OTHER_EXIT_IP = "203.0.113.99";
/** The account the stand's API answers as. */
export const STAND_ACCOUNT_ID = "100000000000000001";
/** The SOCKS5 login of the stand's page (its password is made per stand). */
export const STAND_SOCKS_USER = "pb-suite";
/** The exit-IP service the operator asks (src/egress/exit-ip.ts). */
export const IPIFY_HOST = "api.ipify.org";

/** CLOCK_MONOTONIC, ms: one clock for every container of the stand. */
export function mono(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
