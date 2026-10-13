// The capture at the operating system's level (plan §4.5, "Независимая
// проверка при приёмке"; stage 2 criterion "нет трафика мимо прокси по
// захвату на уровне ОС"). The operator's journal sees only what passed its
// proxy, so the page container's own interfaces are watched apart: a
// tcpdump in the container's network namespace (capture/capture.sh) writes
// every packet that is not loopback, one line each:
//
//   1760390000.123456 eth1  Out IP 10.233.1.21.43210 > 10.233.1.10.1080: Flags [S], …
//
// What may leave the page container: to its SOCKS5 (the egress network),
// and the operator's RPC answers to the engine (the control network, from
// port 7700). Anything else that left is traffic past the proxy.
//
// An empty capture is no evidence: a tcpdump that stopped, or one in a
// network namespace the page has left (its container started again), writes
// nothing — and "nothing left" would follow. So the runner sends the page a
// sentinel when a run begins and when it ends: a UDP datagram to a port of
// the run's own (the page's rules drop it; the capture sees it arrive). Only
// a capture that holds both sentinels, addressed to this page, covered the
// run in the page's own namespace.

import { createSocket } from "node:dgram";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Packet {
  atWall: number;
  iface: string;
  direction: string;
  proto: string;
  src: string;
  srcPort: number | null;
  dst: string;
  dstPort: number | null;
  line: string;
}

export interface CaptureRules {
  /** The page container's addresses. */
  pageIps: readonly string[];
  socks: { ip: string; port: number };
  /** The engine (the runner) and the operator's RPC port. */
  engineIp: string;
  rpcPort: number;
}

function endpoint(text: string): { ip: string; port: number | null } {
  const parts = text.replace(/[:,]$/, "").split(".");
  if (parts.length === 5) return { ip: parts.slice(0, 4).join("."), port: Number(parts[4]) };
  return { ip: parts.slice(0, 4).join("."), port: null };
}

/** One line of `tcpdump -i any -nn -tt`; null for what is not a packet line. */
export function parsePacket(line: string): Packet | null {
  const fields = line.trim().split(/\s+/);
  if (fields.length < 4 || !/^\d+\.\d+$/.test(fields[0]!)) return null;
  const [ts, iface, direction, proto] = fields as [string, string, string, string];
  const base = { atWall: Number(ts) * 1000, iface, direction, proto: proto.replace(/,$/, ""), line };
  if (proto !== "IP" || fields.length < 7 || fields[5] !== ">") return { ...base, src: "", srcPort: null, dst: "", dstPort: null };
  const src = endpoint(fields[4]!);
  const dst = endpoint(fields[6]!);
  return { ...base, src: src.ip, srcPort: src.port, dst: dst.ip, dstPort: dst.port };
}

/** Every packet of the files under `dir` inside [fromWall, toWall]. */
export function readCapture(dir: string, fromWall: number, toWall: number): { packets: Packet[]; files: number } {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".txt"));
  } catch {
    return { packets: [], files: 0 };
  }
  const packets: Packet[] = [];
  for (const name of names) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      const packet = parsePacket(line);
      if (packet && packet.atWall >= fromWall && packet.atWall <= toWall) packets.push(packet);
    }
  }
  packets.sort((a, b) => a.atWall - b.atWall);
  return { packets, files: names.length };
}

/** What left the page container that may not: the criterion's violations. */
export function pastTheProxy(packets: readonly Packet[], rules: CaptureRules): string[] {
  const violations: string[] = [];
  const pageIps = new Set(rules.pageIps);
  for (const packet of packets) {
    // Loopback (the container talking to itself — a refusal of its own
    // rules comes back this way) never leaves it.
    if (packet.direction !== "Out" || packet.proto !== "IP" || packet.iface === "lo") continue;
    if (!pageIps.has(packet.src)) {
      violations.push(`a packet left from an address that is not the page's: ${packet.line}`);
      continue;
    }
    const toSocks = packet.dst === rules.socks.ip && packet.dstPort === rules.socks.port;
    const rpcAnswer = packet.dst === rules.engineIp && packet.srcPort === rules.rpcPort;
    if (!toSocks && !rpcAnswer) violations.push(`traffic past the proxy: ${packet.line}`);
  }
  return violations;
}

/** The sentinel ports of a run: its start's and its end's. */
export function sentinelPorts(seed: number): { start: number; end: number } {
  const start = 20_000 + (Math.abs(seed) % 20_000);
  return { start, end: start + 20_001 };
}

/** A sentinel: one datagram from the runner to the page's control address. */
export function sendSentinel(pageIp: string, port: number): Promise<void> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    socket.send(Buffer.from("pb-suite sentinel"), port, pageIp, () => {
      socket.close();
      resolve();
    });
    socket.on("error", () => resolve());
  });
}

/** The capture is live, in the page's namespace, and covers the run: each
 *  sentinel the runner sent the page is in it. */
export function captureCovers(packets: readonly Packet[], pageIp: string, engineIp: string, ports: readonly number[]): string[] {
  const seen = new Set(packets.filter((packet) => packet.proto === "IP" && packet.direction === "In" && packet.src === engineIp && packet.dst === pageIp && packet.dstPort !== null).map((packet) => packet.dstPort!));
  const missing = ports.filter((port) => !seen.has(port));
  return missing.length === 0 ? [] : [`no live capture of the page covers the run: ${missing.length} of its ${ports.length} sentinel(s) to ${pageIp} are not in it (ports ${missing.slice(0, 5).join(", ")}) — nothing can be said about what left`];
}
