import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";
import { isDisallowedProxyHostname } from "@agency_hub_core/shared";

/** Documented vendor export storage only. No bearer headers follow signed URLs. */
export function validateOfapiExportDownloadUrl(value: string, exportId: string, teamSlug: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443") || isIP(url.hostname)) throw new Error("Unsafe export download URL");
  if (!/^[a-z0-9][a-z0-9.-]*\.s3(?:\.[a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname)) throw new Error("Export download host is outside the documented S3 allowlist");
  if (!/^[A-Za-z0-9_-]+$/.test(teamSlug) || !/^data_export_[A-Za-z0-9_-]+$/.test(exportId) || decodeURIComponent(url.pathname) !== `/data-exports/${teamSlug}/${exportId}.csv`) throw new Error("Export download path does not match the frozen team and export");
  return url;
}
export async function downloadOfapiExportArtifact(input: { url: string; exportId: string; teamSlug: string; maxBytes: number }) {
  const url = validateOfapiExportDownloadUrl(input.url, input.exportId, input.teamSlug);
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(row => !isIP(row.address) || isDisallowedProxyHostname(row.address))) throw new Error("Export download resolved to a prohibited address");
  const pinned = addresses[0]!;
  const dispatcher = new Agent({ connect: { lookup: (_hostname, options, callback) => {
    if (options.all) callback(null, addresses);
    else callback(null, pinned.address, pinned.family);
  } } });
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(60_000), dispatcher } as RequestInit);
    if (response.status !== 200 || response.headers.has("location")) { await response.body?.cancel(); throw new Error("Export download refused redirects or non-success response"); }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > input.maxBytes)) { await response.body?.cancel(); throw new Error("Export download exceeds the approved byte ceiling"); }
    if (!response.body) throw new Error("Export download body is unavailable");
    const reader = response.body.getReader(); const hash = createHash("sha256"); const chunks: Buffer[] = []; let byteSize = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        byteSize += value.byteLength;
        if (byteSize > input.maxBytes) { await reader.cancel(); throw new Error("Export download exceeds the approved byte ceiling"); }
        const chunk = Buffer.from(value); chunks.push(chunk); hash.update(chunk);
      }
    } finally { reader.releaseLock(); }
    return { bytes: Buffer.concat(chunks, byteSize), sha256: hash.digest("hex"), byteSize };
  } finally { await dispatcher.close(); }
}
