import { describe, expect, it } from "vitest";

import { nonGlobalAddressReason } from "@agency_hub_core/shared";

import { EXTRA_IPV4, EXTRA_IPV6, SPECIAL_IPV4, SPECIAL_IPV6 } from "../apps/page-browser/src/policy/special-addresses.ts";

// A page browser's proxy is at a public address, or Hub neither connects to
// it nor makes a container for it (Astra's review of PR #627, items 1 and
// 3): every refused block of the operator's IANA table is refused here too,
// and Hub's own networks with them.

/** The first and the last address of a block. */
function ends(block: string): [string, string] {
  const [address, bitsText] = block.split("/");
  const bits = Number(bitsText);
  if (address!.includes(":")) {
    const value = BigInt(`0x${expand(address!)}`);
    const span = (1n << BigInt(128 - bits)) - 1n;
    const base = (value >> BigInt(128 - bits)) << BigInt(128 - bits);
    return [text6(base), text6(base | span)];
  }
  const value = address!.split(".").reduce((sum, octet) => (sum << 8n) | BigInt(Number(octet)), 0n);
  const span = (1n << BigInt(32 - bits)) - 1n;
  const base = (value >> BigInt(32 - bits)) << BigInt(32 - bits);
  const text4 = (v: bigint) => [24n, 16n, 8n, 0n].map((shift) => String((v >> shift) & 0xffn)).join(".");
  return [text4(base), text4(base | span)];
}

function expand(address: string): string {
  const [left, right = ""] = address.split("::");
  const l = left === "" ? [] : left!.split(":");
  const r = right === "" ? [] : right.split(":");
  const groups = address.includes("::") ? [...l, ...Array(8 - l.length - r.length).fill("0"), ...r] : l;
  return groups.map((group) => group.padStart(4, "0")).join("");
}

function text6(value: bigint): string {
  const hex = value.toString(16).padStart(32, "0");
  return hex.match(/.{4}/g)!.map((group) => group.replace(/^0+(?=.)/, "")).join(":");
}

describe("public addresses only (Project Browser: the owner's proxy)", () => {
  it("refuses every block the operator's IANA table refuses, both ends of each", () => {
    const refused = [
      ...SPECIAL_IPV4.filter((entry) => entry.decision !== "open").flatMap((entry) => entry.block.split(", ")),
      ...EXTRA_IPV4.map((entry) => entry.block),
      ...SPECIAL_IPV6.filter((entry) => entry.decision !== "open").map((entry) => entry.block),
      ...EXTRA_IPV6.map((entry) => entry.block),
    ];
    expect(refused.length).toBeGreaterThan(30);
    for (const block of refused) {
      for (const address of ends(block)) expect(nonGlobalAddressReason(address), `${block}: ${address}`).not.toBeNull();
    }
  });

  it("refuses Hub's own networks, Docker's bridges, loopback, link-local and the metadata service, mapped and NAT64 forms of them", () => {
    for (const address of [
      "10.230.0.2", "10.230.1.10", "172.17.0.1", "172.18.5.4", "127.0.0.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "192.168.1.1",
      "::1", "::", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1", "64:ff9b::10.230.0.2", "fe80::1", "fd00::1", "ff02::1", "2001:db8::1",
    ]) {
      expect(nonGlobalAddressReason(address), address).not.toBeNull();
    }
    expect(nonGlobalAddressReason("10.230.0.2")).toMatch(/Docker/);
    expect(nonGlobalAddressReason("169.254.169.254")).toMatch(/metadata/);
  });

  it("takes public unicast addresses; refuses what is not an address", () => {
    for (const address of ["93.184.216.34", "185.220.101.42", "1.1.1.1", "8.8.8.8", "2a00:1450:4001:82a::200e", "64:ff9b::808:808", "192.31.196.1"]) {
      expect(nonGlobalAddressReason(address), address).toBeNull();
    }
    for (const address of ["proxy.example.com", "1.2.3", "01.2.3.4", "1.2.3.4.5", "fe80::1%eth0", ""]) {
      expect(nonGlobalAddressReason(address), address).toBe("not an IP address");
    }
  });
});
