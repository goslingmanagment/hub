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
   *  when no live process has that pid. */
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

/** Linux: /proc. The start token is field 22 of /proc/<pid>/stat (start time
 *  in clock ticks since boot); a zombie counts as gone — it can send nothing. */
export function createProcFanslySendOsProbe(): FanslySendOsProbe {
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
      const stat = readTrimmed(`/proc/${pid}/stat`);
      if (stat === null) return null;
      // `comm` (field 2) is parenthesised and may hold spaces or parentheses.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const state = fields[0];
      if (state === "Z" || state === "X") return null;
      return fields[19] ?? null;
    },
  };
}

/** Elsewhere (macOS development and tests): `ps`, whose start time has a
 *  one-second resolution. No boot id, no pid namespace and no container. */
export function createPortableFanslySendOsProbe(): FanslySendOsProbe {
  return {
    hostname: () => hostname(),
    bootId: () => null,
    pidNamespace: () => null,
    containerId: () => null,
    processStartToken(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) return null;
      try {
        const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return started.length > 0 ? started : null;
      } catch {
        // ps exits non-zero when no process has the pid.
        return null;
      }
    },
  };
}

export function createDefaultFanslySendOsProbe(): FanslySendOsProbe {
  return existsSync("/proc/self/stat") ? createProcFanslySendOsProbe() : createPortableFanslySendOsProbe();
}

export const FANSLY_SEND_HOLDER_ROLES = ["api", "worker", "scheduler", "cli", "test"] as const;
export type FanslySendHolderRole = (typeof FANSLY_SEND_HOLDER_ROLES)[number];

/** One per process start: the uuid tells this process apart from an earlier
 *  one with the same host and pid. */
const PROCESS_INSTANCE = randomUUID();

export function buildFanslySendHolderIdentity(
  probe: FanslySendOsProbe,
  role: FanslySendHolderRole,
): FanslySendHolderIdentity {
  return {
    host: probe.hostname(),
    pid: process.pid,
    pidStart: probe.processStartToken(process.pid),
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
 * of this container), or for a live pid whose start token matches (or cannot
 * be compared).
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
  const startToken = local.probe.processStartToken(holder.holderPid);
  if (startToken === null) return "pid_gone";
  if (holder.holderPidStart !== null && startToken !== holder.holderPidStart) return "pid_reused";
  return null;
}
