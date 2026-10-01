#!/usr/bin/env node
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  }
  return value;
}

// Compose resolves interpolation, anchors, defaults and resource names first.
// Only a digest leaves this process: resolved env values must never enter logs.
export function infrastructureFingerprint(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)
    || typeof config.name !== "string" || !config.name
    || !config.services?.postgres || typeof config.services.postgres !== "object"
    || Array.isArray(config.services.postgres)) {
    throw new Error("Invalid resolved Compose configuration: expected project and postgres service");
  }
  // The runtime image's services. An app-scope deploy may add, change or drop
  // any of them; everything else (PostgreSQL first) must stay byte-identical.
  const appServices = new Set(["api", "worker", "scheduler", "sync"]);
  const services = Object.fromEntries(Object.entries(config.services).filter(([name]) => !appServices.has(name)));
  const infrastructure = { name: config.name, services };
  for (const key of ["networks", "volumes", "configs", "secrets"]) {
    const value = config[key] ?? {};
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Invalid Compose infrastructure section: ${key}`);
    }
    infrastructure[key] = value;
  }
  return createHash("sha256").update(JSON.stringify(sorted(infrastructure))).digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  try {
    console.log(infrastructureFingerprint(JSON.parse(input)));
  } catch {
    // JSON parse errors can include fragments of the input, including secrets.
    console.error("Unable to fingerprint resolved Compose infrastructure");
    process.exitCode = 1;
  }
}
