// Whether an IP address is a public one a page browser's proxy may sit at
// (Project Browser, the owner's proxy entry; Astra's review of PR #627,
// items 1 and 3). Hub connects to the proxy for the owner's check, and a
// page's container is made to reach that address alone: an address that is
// not globally reachable — loopback, private, link-local and the cloud
// metadata service, Hub's own Docker networks (pb-control 10.230.0.0/24,
// pb-egress 10.230.1.0/24, Docker's bridges in 172.16.0.0/12), shared,
// benchmarking, documentation, reserved, multicast — is refused, whatever
// name led to it.
//
// The blocks are every refused block of the page operator's own table of
// IANA's special-purpose registries (`apps/page-browser/src/policy/
// special-addresses.ts`; tests/global-address.test.ts holds them equal),
// and Hub is stricter for IPv6: only global unicast (2000::/3) is public,
// and a NAT64 address (64:ff9b::/96) is judged by the IPv4 one it embeds.
// Pure: no DNS here — the caller resolves once and judges every address.

interface Block {
  base: bigint;
  bits: number;
  width: 32 | 128;
  name: string;
}

/** The operator's refused IPv4 blocks (its `refused` and `inside` entries
 *  and its extras), and their names. */
export const NON_GLOBAL_IPV4_BLOCKS: ReadonlyArray<readonly [string, string]> = [
  ["0.0.0.0/8", "this network"],
  ["10.0.0.0/8", "private (Hub's Docker networks among them)"],
  ["100.64.0.0/10", "shared address space"],
  ["127.0.0.0/8", "loopback"],
  ["169.254.0.0/16", "link-local (the metadata service among them)"],
  ["172.16.0.0/12", "private (Docker's bridges among them)"],
  ["192.0.0.0/24", "IETF protocol assignments"],
  ["192.0.2.0/24", "documentation"],
  ["192.88.99.0/24", "deprecated 6to4 relay"],
  ["192.168.0.0/16", "private"],
  ["198.18.0.0/15", "benchmarking"],
  ["198.51.100.0/24", "documentation"],
  ["203.0.113.0/24", "documentation"],
  ["224.0.0.0/4", "multicast"],
  ["240.0.0.0/4", "reserved"],
];

/** The operator's refused IPv6 blocks that lie inside global unicast
 *  (2000::/3); everything outside it is refused anyway. */
export const NON_GLOBAL_IPV6_BLOCKS: ReadonlyArray<readonly [string, string]> = [
  ["2001::/23", "IETF protocol assignments"],
  ["2001:db8::/32", "documentation"],
  ["2002::/16", "6to4"],
  ["3fff::/20", "documentation"],
];

function ipv4Value(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function ipv6Value(ip: string): bigint | null {
  let text = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (text.includes("%")) return null;
  // An embedded IPv4 tail as two groups.
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail !== null) {
    const v4 = ipv4Value(tail[2]!);
    if (v4 === null) return null;
    text = `${tail[1]}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves.length === 2 ? (halves[1] === "" ? [] : halves[1]!.split(":")) : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? left.length !== 8 : missing < 1) return null;
  const groups = [...left, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"), ...right];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return value;
}

function blocksOf(list: ReadonlyArray<readonly [string, string]>, width: 32 | 128): Block[] {
  return list.map(([cidr, name]) => {
    const [address, bits] = cidr.split("/");
    const base = width === 32 ? ipv4Value(address!) : ipv6Value(address!);
    if (base === null) throw new Error(`Not a block: ${cidr}`);
    return { base, bits: Number(bits), width, name };
  });
}

const V4 = blocksOf(NON_GLOBAL_IPV4_BLOCKS, 32);
const V6 = blocksOf(NON_GLOBAL_IPV6_BLOCKS, 128);

const inBlock = (value: bigint, block: Block) => value >> BigInt(block.width - block.bits) === block.base >> BigInt(block.width - block.bits);

/** The IP address's kind when it is not a public one — or null: public. */
export function nonGlobalAddressReason(ip: string): string | null {
  const v4 = ipv4Value(ip);
  if (v4 !== null) return V4.find((block) => inBlock(v4, block))?.name ?? null;
  const v6 = ipv6Value(ip);
  if (v6 === null) return "not an IP address";
  // NAT64 (64:ff9b::/96): its IPv4 address decides.
  if (v6 >> 32n === 0x64ff9bn << 64n) {
    const embedded = v6 & 0xffffffffn;
    return nonGlobalAddressReason([24n, 16n, 8n, 0n].map((shift) => String((embedded >> shift) & 0xffn)).join("."));
  }
  if (v6 >> 125n !== 1n) return "not global unicast IPv6 (loopback, mapped IPv4, unique-local, link-local, multicast or reserved)";
  return V6.find((block) => inBlock(v6, block))?.name ?? null;
}
