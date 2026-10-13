// Special-purpose addresses a page may not reach (plan §4.5; spec §2.1):
// every entry of IANA's IPv4 and IPv6 Special-Purpose Address Registries,
// each with its decision — https://www.iana.org/assignments/iana-ipv4-special-registry/
// and https://www.iana.org/assignments/iana-ipv6-special-registry/ (both
// read on 2026-10-13; tests/fixtures/iana/ holds them as IANA's CSV of that day, and
// tests/page-browser-addresses.test.ts holds this table to them, row by row).
//
//   refused  "Globally Reachable: False" — or a reason given here: never a
//            destination for a page
//   inside   a more specific entry of a refused block: refused with it (a
//            reason given where the registry calls it reachable)
//   open     "Globally Reachable: True"
//
// The refused blocks are refused in both layers by the same text patterns
// (policy/operations.ts `isLocalAddress`, policy/rules.ts level 100):
// an IPv4 pattern is built from its block and is exact; an IPv6 pattern is
// written here over the canonical text of an address (RFC 5952 — lower
// case, no leading zeros, the first longest run of zero groups as `::`:
// what Chrome and WHATWG's URL write) — exact as well, but for the two said
// so, which close a little more, inside space IANA reserves (outside
// 2000::/3). Both layers judge the address as the request names it, never
// what the page's proxy resolves a name to (spec §2.1).

export type Reachable = "True" | "False" | "N/A" | "";

export interface SpecialEntry {
  /** The block as the registry writes it. */
  block: string;
  name: string;
  /** The registry's "Globally Reachable" ("" for a deprecated entry). */
  reachable: Reachable;
  decision: "refused" | "inside" | "open";
  /** Why, where the decision is not the registry's own word. */
  why?: string;
  /** IPv6, a refused block: the canonical text of its addresses, as an
   *  expression that matches a whole address (no `{n}`: counted repetitions
   *  cost Chrome's compiled expressions too much). */
  text?: string;
  /** Its text takes some addresses outside the block too: which, and why
   *  that is allowed (only space IANA reserves, outside 2000::/3). */
  wider?: string;
}

/** Not in the special-purpose registries, refused all the same. */
export interface ExtraEntry {
  block: string;
  name: string;
  why: string;
  text?: string;
}

export const SPECIAL_IPV4: readonly SpecialEntry[] = [
  { block: "0.0.0.0/8", name: '"This network"', reachable: "False", decision: "refused" },
  { block: "0.0.0.0/32", name: '"This host on this network"', reachable: "False", decision: "inside" },
  { block: "10.0.0.0/8", name: "Private-Use", reachable: "False", decision: "refused" },
  { block: "100.64.0.0/10", name: "Shared Address Space", reachable: "False", decision: "refused" },
  { block: "127.0.0.0/8", name: "Loopback", reachable: "False", decision: "refused" },
  { block: "169.254.0.0/16", name: "Link Local", reachable: "False", decision: "refused" },
  { block: "172.16.0.0/12", name: "Private-Use", reachable: "False", decision: "refused" },
  { block: "192.0.0.0/24", name: "IETF Protocol Assignments", reachable: "False", decision: "refused" },
  { block: "192.0.0.0/29", name: "IPv4 Service Continuity Prefix", reachable: "False", decision: "inside" },
  { block: "192.0.0.8/32", name: "IPv4 dummy address", reachable: "False", decision: "inside" },
  { block: "192.0.0.9/32", name: "Port Control Protocol Anycast", reachable: "True", decision: "inside", why: "a NAT's port-mapping service by anycast, no destination for a page: closed with its /24" },
  { block: "192.0.0.10/32", name: "Traversal Using Relays around NAT Anycast", reachable: "True", decision: "inside", why: "a TURN relay by anycast, no destination for a page: closed with its /24" },
  { block: "192.0.0.170/32, 192.0.0.171/32", name: "NAT64/DNS64 Discovery", reachable: "False", decision: "inside" },
  { block: "192.0.2.0/24", name: "Documentation (TEST-NET-1)", reachable: "False", decision: "refused" },
  { block: "192.31.196.0/24", name: "AS112-v4", reachable: "True", decision: "open" },
  { block: "192.52.193.0/24", name: "AMT", reachable: "True", decision: "open" },
  { block: "192.88.99.0/24", name: "Deprecated (6to4 Relay Anycast)", reachable: "", decision: "refused", why: "deprecated (RFC 7526) and not to be reassigned; what is left in it is the 6a44 relay below, not reachable" },
  { block: "192.88.99.2/32", name: "6a44-relay anycast address", reachable: "False", decision: "inside" },
  { block: "192.168.0.0/16", name: "Private-Use", reachable: "False", decision: "refused" },
  { block: "192.175.48.0/24", name: "Direct Delegation AS112 Service", reachable: "True", decision: "open" },
  { block: "198.18.0.0/15", name: "Benchmarking", reachable: "False", decision: "refused" },
  { block: "198.51.100.0/24", name: "Documentation (TEST-NET-2)", reachable: "False", decision: "refused" },
  { block: "203.0.113.0/24", name: "Documentation (TEST-NET-3)", reachable: "False", decision: "refused" },
  { block: "240.0.0.0/4", name: "Reserved", reachable: "False", decision: "refused" },
  { block: "255.255.255.255/32", name: "Limited Broadcast", reachable: "False", decision: "inside" },
];

export const EXTRA_IPV4: readonly ExtraEntry[] = [{ block: "224.0.0.0/4", name: "Multicast", why: "IANA's multicast registry: never a unicast destination" }];

const ANY = "[0-9a-f:]*";
const GROUP = "[0-9a-f]";

export const SPECIAL_IPV6: readonly SpecialEntry[] = [
  { block: "::1/128", name: "Loopback Address", reachable: "False", decision: "refused", text: "::1" },
  { block: "::/128", name: "Unspecified Address", reachable: "False", decision: "refused", text: "::" },
  { block: "::ffff:0:0/96", name: "IPv4-mapped Address", reachable: "False", decision: "refused", text: `::ffff:${ANY}`, wider: "`::ffff:` starts the text of a few addresses of ::/96 too (`::ffff:a`), which IANA reserves" },
  { block: "64:ff9b::/96", name: "IPv4-IPv6 Translat.", reachable: "True", decision: "open" },
  { block: "64:ff9b:1::/48", name: "IPv4-IPv6 Translat.", reachable: "False", decision: "refused", text: `64:ff9b:1:${ANY}` },
  { block: "100::/64", name: "Discard-Only Address Block", reachable: "False", decision: "refused", text: `100::${ANY}`, wider: "`100::` starts the text of some addresses of 100::/16 outside it (100:0:0:2:5:0:0:6 is `100::2:5:0:0:6`), which IANA reserves" },
  // Its other spellings (`100::1:a:b:c:d`) start with `100::`, above.
  { block: "100:0:0:1::/64", name: "Dummy IPv6 Prefix", reachable: "False", decision: "refused", text: `100:0:0:1:${ANY}` },
  // The second group 0–1ff: compressed, or one to three hex digits.
  { block: "2001::/23", name: "IETF Protocol Assignments", reachable: "False", decision: "refused", text: `2001:(:|${GROUP}${GROUP}?:|1${GROUP}${GROUP}:)${ANY}` },
  { block: "2001::/32", name: "TEREDO", reachable: "N/A", decision: "inside", why: "Teredo tunnels (RFC 4380, obsolete): an address whose reachability is its tunnel's, no destination for a page — closed with its /23" },
  { block: "2001:1::1/128", name: "Port Control Protocol Anycast", reachable: "True", decision: "inside", why: "a NAT's port-mapping service by anycast — closed with its /23" },
  { block: "2001:1::2/128", name: "Traversal Using Relays around NAT Anycast", reachable: "True", decision: "inside", why: "a TURN relay by anycast — closed with its /23" },
  { block: "2001:1::3/128", name: "DNS-SD Service Registration Protocol Anycast", reachable: "True", decision: "inside", why: "a DNS-SD registration service by anycast — closed with its /23" },
  { block: "2001:2::/48", name: "Benchmarking", reachable: "False", decision: "inside" },
  { block: "2001:3::/32", name: "AMT", reachable: "True", decision: "inside", why: "multicast tunnelling relays — closed with its /23" },
  { block: "2001:4:112::/48", name: "AS112-v6", reachable: "True", decision: "inside", why: "DNS sink servers — closed with its /23 (the IPv4 AS112 blocks and 2620:4f:8000::/48 stand alone and stay open)" },
  { block: "2001:10::/28", name: "Deprecated (previously ORCHID)", reachable: "", decision: "inside", why: "deprecated identifiers — closed with its /23" },
  { block: "2001:20::/28", name: "ORCHIDv2", reachable: "True", decision: "inside", why: "cryptographic identifiers, not locators (RFC 7343) — closed with its /23" },
  { block: "2001:30::/28", name: "Drone Remote ID Protocol Entity Tags (DETs) Prefix", reachable: "True", decision: "inside", why: "drone identifiers (RFC 9374) — closed with its /23" },
  { block: "2001:db8::/32", name: "Documentation", reachable: "False", decision: "refused", text: `2001:db8:${ANY}` },
  { block: "2002::/16", name: "6to4", reachable: "N/A", decision: "refused", text: `2002:${ANY}`, why: "6to4 (deprecated for new use, RFC 7526): an address embeds an IPv4 one, a private or loopback one too, and is reachable only as that is" },
  { block: "2620:4f:8000::/48", name: "Direct Delegation AS112 Service", reachable: "True", decision: "open" },
  // The second group 0–fff: compressed, or one to three hex digits.
  { block: "3fff::/20", name: "Documentation", reachable: "False", decision: "refused", text: `3fff:(:|${GROUP}${GROUP}?${GROUP}?:)${ANY}` },
  { block: "5f00::/16", name: "Segment Routing (SRv6) SIDs", reachable: "False", decision: "refused", text: `5f00:${ANY}` },
  { block: "fc00::/7", name: "Unique-Local", reachable: "False", decision: "refused", text: `f[cd]${GROUP}${GROUP}:${ANY}` },
  { block: "fe80::/10", name: "Link-Local Unicast", reachable: "False", decision: "refused", text: `fe[89ab]${GROUP}:${ANY}` },
];

export const EXTRA_IPV6: readonly ExtraEntry[] = [{ block: "ff00::/8", name: "Multicast", why: "IANA's multicast registry: never a unicast destination", text: `ff${GROUP}${GROUP}:${ANY}` }];

// ── IPv4 blocks as expressions ─────────────────────────────────────────────

/** Alternatives matching the decimal numbers from `low` to `high` (each 0–255,
 *  written without leading zeros). */
export function decimalRange(low: number, high: number): string[] {
  const out: string[] = [];
  for (const digits of [1, 2, 3]) {
    const from = Math.max(low, digits === 1 ? 0 : 10 ** (digits - 1));
    const to = Math.min(high, 10 ** digits - 1);
    if (from <= to) out.push(...sameLength(String(from), String(to)));
  }
  return out;
}

function sameLength(a: string, b: string): string[] {
  if (a.length === 1) return [a === b ? a : `[${a}-${b}]`];
  if (a[0] === b[0]) return sameLength(a.slice(1), b.slice(1)).map((rest) => `${a[0]}${rest}`);
  const restLength = a.length - 1;
  const zeros = "0".repeat(restLength);
  const nines = "9".repeat(restLength);
  const out: string[] = [];
  const lowWhole = a.slice(1) === zeros;
  const highWhole = b.slice(1) === nines;
  if (!lowWhole) out.push(...sameLength(a.slice(1), nines).map((rest) => `${a[0]}${rest}`));
  const first = Number(a[0]) + (lowWhole ? 0 : 1);
  const last = Number(b[0]) - (highWhole ? 0 : 1);
  if (first <= last) out.push(`${first === last ? first : `[${first}-${last}]`}${"[0-9]".repeat(restLength)}`);
  if (!highWhole) out.push(...sameLength(zeros, b.slice(1)).map((rest) => `${b[0]}${rest}`));
  return out;
}

/** An IPv4 block as an expression matching its addresses' dotted text,
 *  whole. */
export function ipv4BlockText(block: string): string {
  const [base, bits] = block.split("/");
  const octets = (base ?? "").split(".").map(Number);
  const length = Number(bits);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255) || !Number.isInteger(length) || length < 1 || length > 32) {
    throw new Error(`not an IPv4 block: ${block}`);
  }
  const parts: string[] = [];
  let tail = "";
  for (let i = 0; i < 4; i++) {
    const fixed = Math.max(0, Math.min(8, length - 8 * i));
    if (fixed === 8) {
      parts.push(String(octets[i]));
      continue;
    }
    if (fixed > 0) {
      const size = 2 ** (8 - fixed);
      const low = octets[i]! & ~(size - 1);
      const alternatives = decimalRange(low, low + size - 1);
      parts.push(alternatives.length === 1 ? alternatives[0]! : `(${alternatives.join("|")})`);
    }
    // The octets after it are free: the rest of the canonical dotted text.
    if ((fixed > 0 ? 3 - i : 4 - i) > 0) tail = "\\.[0-9.]*";
    break;
  }
  return `${parts.join("\\.")}${tail}`;
}

// ── what both layers refuse ────────────────────────────────────────────────

const refusedBlocks = (entries: readonly SpecialEntry[]) => entries.filter((entry) => entry.decision === "refused");

/** The refused IPv4 blocks' expressions, each matching a whole address. */
export const REFUSED_IPV4_TEXT: readonly string[] = [...refusedBlocks(SPECIAL_IPV4), ...EXTRA_IPV4].map((entry) => ipv4BlockText(entry.block));

/** The refused IPv6 blocks' expressions over canonical text, each matching a
 *  whole address. */
export const REFUSED_IPV6_TEXT: readonly string[] = [...refusedBlocks(SPECIAL_IPV6), ...EXTRA_IPV6].map((entry) => {
  if (!entry.text) throw new Error(`a refused IPv6 block without its text: ${entry.block}`);
  return entry.text;
});
