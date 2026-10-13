import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { localOrPrivate } from "../apps/page-browser/src/egress/proxy.ts";
import { classifyHost, decide, isLocalAddress } from "../apps/page-browser/src/policy/operations.ts";
import { buildRules, PRIORITY } from "../apps/page-browser/src/policy/rules.ts";
import { decimalRange, EXTRA_IPV4, EXTRA_IPV6, ipv4BlockText, SPECIAL_IPV4, SPECIAL_IPV6, type SpecialEntry } from "../apps/page-browser/src/policy/special-addresses.ts";
import { dnrBlocks, dnrRule } from "./helpers/page-browser-dnr.ts";

// The special-purpose addresses a page may not reach (Project Browser plan
// §4.5, spec §2.1; PR 6, Astra's review 2): the table is held to IANA's
// IPv4 and IPv6 Special-Purpose Address Registries row by row (their CSV of
// 2026-10-13 in tests/fixtures/iana/), and every block of it to the three
// places that refuse it — the proxy, the operator's table, the rules
// extension — by addresses at its edges and inside, against an exact
// reading of the blocks.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rules = buildRules();

interface RegistryRow {
  block: string;
  name: string;
  reachable: string;
}

/** IANA's CSV: quoted fields with doubled quotes; footnotes (` [n]`) dropped. */
function registry(file: string): RegistryRow[] {
  const text = readFileSync(path.join(root, "tests/fixtures/iana", file), "utf8");
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
    } else field += char;
  }
  if (field !== "" || row.length > 0) rows.push([...row, field]);
  const [header, ...body] = rows;
  const at = (name: string) => header!.indexOf(name);
  const clean = (value: string) => value.replace(/\s*\[\d+\]/g, "").trim();
  return body.map((cells) => ({ block: clean(cells[at("Address Block")]!), name: clean(cells[at("Name")]!), reachable: clean(cells[at("Globally Reachable")]!) }));
}

// ── an exact reading of the blocks ─────────────────────────────────────────

function ipv4(text: string): bigint {
  const octets = text.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) throw new Error(`not IPv4: ${text}`);
  return octets.reduce((value, octet) => value * 256n + BigInt(octet), 0n);
}

function ipv6(text: string): bigint {
  const [head, tail] = text.includes("::") ? text.split("::") : [text, null];
  const groups = (part: string | undefined) => (part ? part.split(":") : []);
  const left = groups(head);
  const right = tail === null ? [] : groups(tail);
  const all = tail === null ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  if (all.length !== 8) throw new Error(`not IPv6: ${text}`);
  return all.reduce((value, group) => value * 65536n + BigInt(parseInt(group, 16)), 0n);
}

const textOf4 = (value: bigint) => [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 255n)).join(".");
/** The canonical text of an IPv6 address, as URLs write it (RFC 5952). */
const textOf6 = (value: bigint) => {
  const raw = Array.from({ length: 8 }, (_, i) => ((value >> BigInt(112 - 16 * i)) & 0xffffn).toString(16)).join(":");
  return new URL(`http://[${raw}]/`).hostname.slice(1, -1);
};

interface Range {
  low: bigint;
  high: bigint;
}

function rangesOf(block: string, family: 4 | 6): Range[] {
  return block.split(",").map((part) => {
    const [base, bits] = part.trim().split("/");
    const width = family === 4 ? 32 : 128;
    const length = BigInt(bits!);
    const size = 1n << BigInt(width - Number(length));
    const low = ((family === 4 ? ipv4(base!) : ipv6(base!)) / size) * size;
    return { low, high: low + size - 1n };
  });
}

const within = (value: bigint, ranges: readonly Range[]) => ranges.some((range) => value >= range.low && value <= range.high);

const refusedRanges = (entries: readonly SpecialEntry[], extras: ReadonlyArray<{ block: string }>, family: 4 | 6) => [...entries.filter((entry) => entry.decision === "refused"), ...extras].flatMap((entry) => rangesOf(entry.block, family));
const REFUSED4 = refusedRanges(SPECIAL_IPV4, EXTRA_IPV4, 4);
const REFUSED6 = refusedRanges(SPECIAL_IPV6, EXTRA_IPV6, 6);
/** IANA's global unicast space: outside it, all is reserved. */
const GLOBAL_UNICAST6: Range[] = rangesOf("2000::/3", 6);

/** A deterministic random number source (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randomBig = (next: () => number, bits: number) => {
  let value = 0n;
  for (let i = 0; i < bits; i += 16) value = (value << 16n) | BigInt(Math.floor(next() * 65536));
  return value & ((1n << BigInt(bits)) - 1n);
};

/** Addresses of a range: its edges, its middle, and some at random. */
function samples(range: Range, next: () => number, count = 12): bigint[] {
  const size = range.high - range.low + 1n;
  const out = [range.low, range.high, range.low + size / 2n];
  if (size > 2n) out.push(range.low + 1n, range.high - 1n);
  for (let i = 0; i < count; i++) out.push(range.low + (randomBig(next, 128) % size));
  return out;
}

/** What each of the three places says of an address literal. */
function layers(host: string) {
  const url = `https://${host.includes(":") ? `[${host}]` : host}/`;
  return {
    proxy: localOrPrivate(host, 443),
    map: decide({ method: "GET", url }, "automation").action === "refuse",
    extension: dnrBlocks(rules, { method: "GET", url }),
    rule: dnrRule(rules, { method: "GET", url })?.priority ?? null,
  };
}

describe("the table and IANA's registries", () => {
  for (const [family, file, table] of [
    [4, "iana-ipv4-special-registry.2026-10-13.csv", SPECIAL_IPV4],
    [6, "iana-ipv6-special-registry.2026-10-13.csv", SPECIAL_IPV6],
  ] as const) {
    it(`IPv${family}: one entry for every row of the registry, as it names it and says how reachable it is`, () => {
      const rows = registry(file);
      expect(rows.length).toBeGreaterThan(20);
      expect(table.map((entry) => ({ block: entry.block, name: entry.name, reachable: entry.reachable }))).toEqual(rows);
    });

    it(`IPv${family}: every decision is the registry's — or says why`, () => {
      const refused = table.filter((entry) => entry.decision === "refused").flatMap((entry) => rangesOf(entry.block, family));
      for (const entry of table) {
        const ranges = rangesOf(entry.block, family);
        const inRefused = ranges.every((range) => refused.some((outer) => range.low >= outer.low && range.high <= outer.high));
        switch (entry.decision) {
          case "refused":
            if (entry.reachable !== "False") expect(entry.why, entry.block).toBeTruthy();
            if (family === 6) expect(entry.text, entry.block).toBeTruthy();
            break;
          case "inside":
            // Refused with the block it lies in: said why, unless the registry
            // calls it unreachable itself.
            expect(inRefused, entry.block).toBe(true);
            if (entry.reachable !== "False") expect(entry.why, entry.block).toBeTruthy();
            break;
          case "open":
            expect(entry.reachable, entry.block).toBe("True");
            expect(ranges.some((range) => refused.some((outer) => range.high >= outer.low && range.low <= outer.high)), entry.block).toBe(false);
            break;
        }
        // An entry the registry calls unreachable is never open.
        if (entry.reachable === "False") expect(entry.decision, entry.block).not.toBe("open");
      }
    });
  }

  it("decides the entries Astra and the review named as said", () => {
    const decision = (table: readonly SpecialEntry[], block: string) => table.find((entry) => entry.block === block)?.decision;
    expect(decision(SPECIAL_IPV6, "64:ff9b::/96")).toBe("open"); // RFC 6052 §3.1: global IPv4 only
    expect(decision(SPECIAL_IPV6, "64:ff9b:1::/48")).toBe("refused");
    expect(decision(SPECIAL_IPV6, "2001::/23")).toBe("refused");
    expect(SPECIAL_IPV6.filter((entry) => entry.block.startsWith("2001:") && entry.block !== "2001:db8::/32" && entry.block !== "2001::/23").every((entry) => entry.decision === "inside")).toBe(true);
    expect(decision(SPECIAL_IPV6, "2001:2::/48")).toBe("inside");
    expect(decision(SPECIAL_IPV6, "2002::/16")).toBe("refused");
    expect(decision(SPECIAL_IPV6, "3fff::/20")).toBe("refused");
    expect(decision(SPECIAL_IPV6, "5f00::/16")).toBe("refused");
    expect(decision(SPECIAL_IPV4, "192.88.99.0/24")).toBe("refused");
    expect(decision(SPECIAL_IPV4, "192.31.196.0/24")).toBe("open");
    expect(EXTRA_IPV4.map((entry) => entry.block)).toEqual(["224.0.0.0/4"]);
    expect(EXTRA_IPV6.map((entry) => entry.block)).toEqual(["ff00::/8"]);
  });
});

describe("the three places refuse exactly the refused blocks", () => {
  it("IPv4: every address sampled in a refused block is refused by all three, and none sampled outside", () => {
    const next = random(4);
    const checked = { refused: 0, open: 0 };
    const look = (value: bigint) => {
      const host = textOf4(value);
      const expected = within(value, REFUSED4);
      const seen = layers(host);
      expect({ host, ...seen, rule: undefined }, host).toEqual({ host, proxy: expected, map: expected, extension: expected, rule: undefined });
      if (expected) expect(seen.rule, host).toBe(PRIORITY.local);
      checked[expected ? "refused" : "open"] += 1;
    };
    for (const entry of [...SPECIAL_IPV4, ...EXTRA_IPV4]) {
      for (const range of rangesOf(entry.block, 4)) {
        for (const value of samples(range, next)) look(value);
        // Just outside its edges.
        if (range.low > 0n) look(range.low - 1n);
        if (range.high < 0xffffffffn) look(range.high + 1n);
      }
    }
    for (let i = 0; i < 3000; i++) look(randomBig(next, 32));
    expect(checked.refused).toBeGreaterThan(300);
    expect(checked.open).toBeGreaterThan(2000);
  });

  it("IPv6: every address sampled in a refused block is refused by all three; outside them only what IANA reserves outside 2000::/3 may be, never a global unicast one", () => {
    const next = random(6);
    const checked = { refused: 0, open: 0, wider: 0 };
    const look = (value: bigint) => {
      const host = textOf6(value);
      const exact = within(value, REFUSED6);
      const seen = layers(host);
      // One answer from the three places.
      expect([seen.proxy, seen.map], host).toEqual([seen.extension, seen.extension]);
      if (exact) {
        expect(seen.extension, `${host} lies in a refused block`).toBe(true);
        expect(seen.rule, host).toBe(PRIORITY.local);
        checked.refused += 1;
      } else if (seen.extension) {
        // Closed a little more than the block — only by an entry that says
        // so, and only in space IANA reserves.
        expect(within(value, GLOBAL_UNICAST6), `${host} is refused outside every refused block`).toBe(false);
        const by = [...SPECIAL_IPV6, ...EXTRA_IPV6].filter((entry) => entry.text !== undefined && new RegExp(`^(${entry.text})$`).test(host));
        expect(by.length > 0 && by.every((entry) => "wider" in entry && typeof entry.wider === "string"), `${host} is taken by ${by.map((entry) => entry.block).join(", ")}, which do not say they are wider`).toBe(true);
        checked.wider += 1;
      } else checked.open += 1;
    };
    for (const entry of [...SPECIAL_IPV6, ...EXTRA_IPV6]) {
      for (const range of rangesOf(entry.block, 6)) {
        for (const value of samples(range, next, 24)) look(value);
        if (range.low > 0n) look(range.low - 1n);
        if (range.high < (1n << 128n) - 1n) look(range.high + 1n);
      }
    }
    // Where the two wider texts reach past their blocks.
    for (const text of ["::ffff:a", "::ffff", "100:0:0:2:5:0:0:6", "100:0:0:ffff::1:2"]) look(ipv6(text));
    // Global unicast at random, and addresses with zero groups in every
    // place (their canonical text compresses them differently).
    for (let i = 0; i < 3000; i++) look(GLOBAL_UNICAST6[0]!.low + (randomBig(next, 128) % (1n << 125n)));
    for (let i = 0; i < 3000; i++) {
      let value = randomBig(next, 128);
      for (let group = 0; group < 8; group++) if (next() < 0.5) value &= ~(0xffffn << BigInt(16 * group));
      look(value);
    }
    expect(checked.refused).toBeGreaterThan(500);
    expect(checked.open).toBeGreaterThan(3000);
    // The wider texts were met, and judged.
    expect(checked.wider).toBeGreaterThan(0);
  });

  it("reads a literal in any spelling a request can carry: non-canonical IPv6, IPv4 in other forms, a zone, brackets", () => {
    for (const host of ["2001:0db8:0000::0001", "2001:DB8::1", "[2001:db8::1]", "3FFF:0FFF::1", "2001:2:0:0:0:0:0:1", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1", "fe80::1%eth0", "64:FF9B:1::a00:1", "0x7f.1", "127.1", "2130706433", "0300.0250.0.1"]) {
      expect(isLocalAddress(host), host).toBe(true);
      expect(localOrPrivate(host.replace(/^\[|\]$/g, ""), 443), host).toBe(true);
      expect(classifyHost(host), host).toBe("denied");
    }
    for (const host of ["2606:4700:4700::1111", "64:ff9b::808:808", "2620:4f:8000::1", "192.31.196.1", "1.1.1.1", "3fff:1000::1", "2001:200::1"]) expect(isLocalAddress(host), host).toBe(false);
  });
});

describe("the expressions", () => {
  it("of a decimal range match its numbers and no other, from 0 to 255", () => {
    for (const [low, high] of [
      [0, 255],
      [64, 127],
      [16, 31],
      [224, 239],
      [240, 255],
      [18, 19],
      [7, 7],
      [100, 199],
      [9, 10],
      [99, 101],
    ] as const) {
      const expression = new RegExp(`^(${decimalRange(low, high).join("|")})$`);
      for (let value = 0; value <= 300; value++) expect(expression.test(String(value)), `${low}-${high}: ${value}`).toBe(value >= low && value <= high);
      expect(expression.test(`0${low}`)).toBe(false);
    }
  });

  it("of an IPv4 block match its addresses' text, whole", () => {
    expect(ipv4BlockText("172.16.0.0/12")).toBe("172\\.(1[6-9]|2[0-9]|3[0-1])\\.[0-9.]*");
    expect(ipv4BlockText("192.0.0.8/32")).toBe("192\\.0\\.0\\.8");
    expect(ipv4BlockText("192.0.0.0/29")).toBe("192\\.0\\.0\\.[0-7]");
    expect(ipv4BlockText("240.0.0.0/4")).toBe("(24[0-9]|25[0-5])\\.[0-9.]*");
    expect(() => ipv4BlockText("300.0.0.0/8")).toThrow();
  });
});
