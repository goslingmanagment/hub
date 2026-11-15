import type { KernelClient } from "@kernel/sdk";
import type { OfapiStatus } from "./statusWords.js";

type AdminConfig = Awaited<ReturnType<KernelClient["adminConfig"]>>;

/** The owner's configuration, read for the OnlyFans API's flag (a team lead's and a chatter's is unknown). */
export function ofapiConfigQuery(kernel: KernelClient, role: string | null) {
  return {
    queryKey: ["admin", "config"],
    queryFn: () => kernel.adminConfig(),
    enabled: role === "owner",
    meta: { suppressGlobalError: true },
  };
}

/** `on`, `off`, or `unknown` when it cannot be said: the secret's own state, not `runningState` (always `unknown` for a secret). */
export function ofapiStatusOf(config: AdminConfig | undefined): OfapiStatus {
  const states = config?.subsystems.flatMap((subsystem) => subsystem.items).find((item) => item.key === "ofapiApiKey")?.running.map((entry) => entry.state) ?? [];
  return states.length === 0 || states.some((state) => state !== "set" && state !== "unset")
    ? "unknown"
    : states.every((state) => state === "unset") ? "off" : "on";
}
