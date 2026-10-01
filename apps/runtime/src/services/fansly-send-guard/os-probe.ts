import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";

import type { FanslySendHolderIdentity } from "@agency_hub_core/db";

// Who holds a Fansly page's send guard, and whether that holder is provably
// gone. Plan §2.5 p.1: an expired lease opens nothing; the page opens again
// only when the holder completes, or when the end of its process is confirmed
// at OS or Docker level. A lost database connection is never such a proof.
//
// In production every runtime role is its own container: the hostname is the
// container id and the pid namespace is the container's. Two processes are
// compared by pid only when both the hostname and the pid namespace match, and
// a pid counts as the same process only when its start token matches too (a
// restarted container reuses its hostname, and often its pids).
//
// A restarted container keeps its hostname but usually gets a new pid
// namespace. A holder recorded under this container's hostname with another
// pid namespace therefore ran in an earlier run of this container, and is gone
// with it — but only when the hostname provably IS this container's own id
// (`containerId`). A container whose hostname is set explicitly, or that shares
// the host's or another container's UTS namespace (`network_mode: host`,
// `--uts host`), fails that proof, and its holders under another pid namespace
// are never judged. A container that joins another's network namespace
// (`network_mode: container:<x>` / `service:<x>`) sees <x>'s hostname file and
// would pass it while <x> lives on in its own pid namespace: production compose
// declares none (tests/compose-config.test.ts pins it).

export interface FanslySendOsProbe {
  hostname(): string;
  /** The kernel boot id; null where the platform has none. */
  bootId(): string | null;
  /** This process's pid namespace; null where the platform has none. */
  pidNamespace(): string | null;
  /** A token that changes when `pid` is reused by another process, or null
   *  when the OS says no live process has that pid. Throws
   *  `FanslySendProbeUnknownError` when it cannot tell (a read error other
   *  than "no such process", an unparsable answer): that is never evidence of
   *  death. */
  processStartToken(pid: number): string | null;
  /** The id of the container whose /etc/hostname this process sees (see
   *  `containerIdFromMountinfo`); null outside a container. */
  containerId(): string | null;
}

function readTrimmed(path: string): string | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * The container id in /proc/self/mountinfo: Docker (and Podman) bind-mount
 * /etc/hostname from the container's own directory, named by its 64-hex id
 * (`/var/lib/docker/containers/<id>/hostname`). Null without such a mount.
 */
export function containerIdFromMountinfo(mountinfo: string): string | null {
  for (const line of mountinfo.split("\n")) {
    // mountinfo: mount id, parent id, major:minor, root, mount point, …
    const fields = line.split(" ");
    if (fields[4] !== "/etc/hostname") continue;
    const ids = (fields[3] ?? "").split("/").filter((segment) => /^[0-9a-f]{64}$/.test(segment));
    return ids.at(-1) ?? null;
  }
  return null;
}

/** Whether `host` is the id of the container `containerId` (Docker names a
 *  container's host by the first 12 hex digits of its id unless told
 *  otherwise): such a hostname belongs to that one container. */
export function hostnameIsContainerId(host: string, containerId: string | null): boolean {
  return containerId !== null && /^[0-9a-f]{12,64}$/.test(host) && containerId.startsWith(host);
}

/** The probe could not tell whether a process is alive. Never evidence of
 *  its death: the judge then confirms nothing. */
export class FanslySendProbeUnknownError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FanslySendProbeUnknownError";
  }
}

/** The errno codes by which the kernel says "no such process": /proc/<pid> is
 *  gone (ENOENT), or the process exited between the lookup and the read
 *  (ESRCH). Anything else (EACCES, EIO, EMFILE, …) says nothing about it. */
const PROC_GONE_CODES = new Set(["ENOENT", "ESRCH"]);

function errnoCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/** The start token in the text of /proc/<pid>/stat: field 22 (start time in
 *  clock ticks since boot). Null for a zombie or a dead task — it can send
 *  nothing. Throws on text that does not parse. */
export function parseProcStatStartToken(stat: string): string | null {
  // `comm` (field 2) is parenthesised and may hold spaces or parentheses.
  const close = stat.lastIndexOf(")");
  if (close < 0) throw new FanslySendProbeUnknownError("unparsable /proc stat: no comm field");
  const fields = stat.slice(close + 2).trim().split(" ");
  const state = fields[0];
  if (state === "Z" || state === "X") return null;
  const startTime = fields[19];
  if (startTime === undefined || !/^\d+$/.test(startTime)) {
    throw new FanslySendProbeUnknownError("unparsable /proc stat: no start time");
  }
  return startTime;
}

export interface ProcFanslySendOsProbeDeps {
  /** fs.readFileSync(path, "utf8"); tests inject read errors. */
  readFile?: (path: string) => string;
}

/** Linux: /proc. The start token is field 22 of /proc/<pid>/stat. Only
 *  ENOENT/ESRCH mean the pid is gone; any other read error, or a stat that
 *  does not parse, is "cannot tell". */
export function createProcFanslySendOsProbe(deps: ProcFanslySendOsProbeDeps = {}): FanslySendOsProbe {
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  return {
    hostname: () => hostname(),
    containerId: () => {
      const mountinfo = readTrimmed("/proc/self/mountinfo");
      return mountinfo === null ? null : containerIdFromMountinfo(mountinfo);
    },
    bootId: () => readTrimmed("/proc/sys/kernel/random/boot_id"),
    pidNamespace: () => {
      try {
        return readlinkSync("/proc/self/ns/pid");
      } catch {
        return null;
      }
    },
    processStartToken(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new FanslySendProbeUnknownError(`not a pid: ${pid}`);
      }
      let stat: string;
      try {
        stat = readFile(`/proc/${pid}/stat`);
      } catch (error) {
        if (PROC_GONE_CODES.has(errnoCode(error) ?? "")) return null;
        throw new FanslySendProbeUnknownError(`cannot read /proc/${pid}/stat (${errnoCode(error) ?? "unknown error"})`, {
          cause: error,
        });
      }
      return parseProcStatStartToken(stat);
    },
  };
}

export interface PortableFanslySendOsProbeDeps {
  /** execFileSync("ps", args) with utf8 output; tests inject failures. */
  ps?: (args: string[]) => string;
}

/** Elsewhere (macOS development and tests): `ps`, whose start time has a
 *  one-second resolution. No boot id, no pid namespace and no container. Only
 *  `ps` exiting 1 with no output means "no such process"; a `ps` that cannot
 *  run, or fails otherwise, is "cannot tell". */
export function createPortableFanslySendOsProbe(deps: PortableFanslySendOsProbeDeps = {}): FanslySendOsProbe {
  const ps = deps.ps ?? ((args: string[]) => execFileSync("ps", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }));
  return {
    hostname: () => hostname(),
    bootId: () => null,
    pidNamespace: () => null,
    containerId: () => null,
    processStartToken(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new FanslySendProbeUnknownError(`not a pid: ${pid}`);
      }
      let started: string;
      try {
        started = ps(["-o", "lstart=", "-p", String(pid)]).trim();
      } catch (error) {
        const failed = error as { status?: unknown; stdout?: unknown };
        const output = typeof failed.stdout === "string" ? failed.stdout.trim() : "";
        // ps selects no process: exit status 1, nothing printed.
        if (failed.status === 1 && output === "") return null;
        throw new FanslySendProbeUnknownError(`ps failed for pid ${pid}`, { cause: error });
      }
      if (started.length === 0) throw new FanslySendProbeUnknownError(`ps printed nothing for pid ${pid}`);
      return started;
    },
  };
}

export function createDefaultFanslySendOsProbe(): FanslySendOsProbe {
  return existsSync("/proc/self/stat") ? createProcFanslySendOsProbe() : createPortableFanslySendOsProbe();
}

/** `script`: an operator script in a container of its own (the W0 probes).
 *  `sync`: the Fansly Sync Engine's process. It never holds this guard; it
 *  records the same identity as a page owner (`sync_pages.owner_*`) and judges
 *  its predecessors with `judgeFanslySendHolderTermination` (design §3.6, §14 F4). */
export const FANSLY_SEND_HOLDER_ROLES = ["api", "worker", "scheduler", "cli", "script", "test", "sync"] as const;
export type FanslySendHolderRole = (typeof FANSLY_SEND_HOLDER_ROLES)[number];

/** One per process start: the uuid tells this process apart from an earlier
 *  one with the same host and pid. */
const PROCESS_INSTANCE = randomUUID();

/** This process's start token; null when the probe cannot tell (the holder
 *  is then compared by pid only, and a pid reuse is not provable). */
function ownStartToken(probe: FanslySendOsProbe): string | null {
  try {
    return probe.processStartToken(process.pid);
  } catch {
    return null;
  }
}

export function buildFanslySendHolderIdentity(
  probe: FanslySendOsProbe,
  role: FanslySendHolderRole,
): FanslySendHolderIdentity {
  return {
    host: probe.hostname(),
    pid: process.pid,
    pidStart: ownStartToken(probe),
    pidNs: probe.pidNamespace(),
    bootId: probe.bootId(),
    instance: PROCESS_INSTANCE,
    role,
  };
}

export type FanslySendTerminationEvidence =
  | "boot_id_changed"
  | "pid_namespace_replaced"
  | "pid_gone"
  | "pid_reused";

/**
 * Whether the holder recorded on a guard row is provably no longer running,
 * judged from THIS process's host. Never true for this very process, for a
 * holder on another host, for a holder in another pid namespace unless this
 * hostname is this container's own id (then the holder ran in an earlier run
 * of this container), for a live pid whose start token matches (or cannot
 * be compared), or when the probe cannot tell whether the pid is alive.
 */
export function judgeFanslySendHolderTermination(
  holder: {
    holderHost: string | null;
    holderPid: number | null;
    holderPidStart: string | null;
    holderPidNs: string | null;
    holderBootId: string | null;
    holderInstance: string | null;
  },
  local: { identity: FanslySendHolderIdentity; probe: FanslySendOsProbe },
): FanslySendTerminationEvidence | null {
  if (holder.holderPid === null || holder.holderHost === null) return null;
  if (holder.holderInstance !== null && holder.holderInstance === local.identity.instance) return null;
  // A different kernel boot of this (single) host: everything that ran
  // before the reboot is gone.
  if (holder.holderBootId !== null && local.identity.bootId !== null
    && holder.holderBootId !== local.identity.bootId) {
    return "boot_id_changed";
  }
  if (holder.holderHost !== local.identity.host) return null;
  const holderPidNs = holder.holderPidNs ?? null;
  const localPidNs = local.identity.pidNs ?? null;
  if (holderPidNs !== localPidNs) {
    // This container under another pid namespace: an earlier run of it. A
    // container has one pid namespace at a time, and Docker starts it again
    // only after that namespace's init has exited — and the kernel kills every
    // process of a namespace before its init's exit completes.
    if (holderPidNs !== null && localPidNs !== null
      && hostnameIsContainerId(local.identity.host, local.probe.containerId())) {
      return "pid_namespace_replaced";
    }
    return null;
  }
  let startToken: string | null;
  try {
    startToken = local.probe.processStartToken(holder.holderPid);
  } catch {
    // The probe cannot tell (a /proc read error other than "no such
    // process"): no evidence, so nothing is released.
    return null;
  }
  if (startToken === null) return "pid_gone";
  if (holder.holderPidStart !== null && startToken !== holder.holderPidStart) return "pid_reused";
  return null;
}
