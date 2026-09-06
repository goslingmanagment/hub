import type * as DnsPromises from "node:dns/promises";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadOfapiExportArtifact, validateOfapiExportDownloadUrl } from "../apps/runtime/src/services/egress/ofapi-export-artifact.ts";
vi.mock("node:dns/promises", async importOriginal => ({ ...await importOriginal<typeof DnsPromises>(), lookup: vi.fn() }));
const url = "https://exports.s3.eu-west-1.amazonaws.com/data-exports/team/data_export_test.csv?X-Amz-Signature=synthetic";
const args = { url, exportId: "data_export_test", teamSlug: "team", maxBytes: 20 };
beforeEach(() => { vi.mocked(lookup).mockResolvedValue([{ address: "52.216.1.1", family: 4 }] as never); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("bounded vendor export artifact egress", () => {
  it("accepts only HTTPS S3 storage with frozen team/export path", () => {
    expect(validateOfapiExportDownloadUrl(url, args.exportId, args.teamSlug).hostname).toBe("exports.s3.eu-west-1.amazonaws.com");
    for (const value of [url.replace("https:", "http:"), url.replace("exports.s3.eu-west-1.amazonaws.com", "evil.example"), url.replace("/team/", "/other/"), url.replace("data_export_test.csv", "data_export_other.csv"), url.replace("https://", "https://user:pass@"), `${url}#fragment`, "https://127.0.0.1/data-exports/team/data_export_test.csv"]) expect(() => validateOfapiExportDownloadUrl(value, args.exportId, args.teamSlug)).toThrow();
  });
  it("rejects private, local and mixed DNS answers before fetch", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fc00::1", "::ffff:127.0.0.1"]) {
      vi.mocked(lookup).mockResolvedValue([{ address: "52.216.1.1", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }] as never);
      await expect(downloadOfapiExportArtifact(args)).rejects.toThrow("prohibited address");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("pins the validated resolver, omits credentials, streams SHA256 and refuses redirects", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("a,b\n1,2\n")); vi.stubGlobal("fetch", fetch);
    expect(await downloadOfapiExportArtifact(args)).toMatchObject({ byteSize: 8, sha256: createHash("sha256").update("a,b\n1,2\n").digest("hex") });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual", dispatcher: expect.anything() });
    expect((fetch.mock.calls[0]?.[1] as RequestInit).headers).toBeUndefined();
    fetch.mockImplementation(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } }));
    await expect(downloadOfapiExportArtifact(args)).rejects.toThrow("redirects");
  });
  it("enforces both declared and streamed body ceilings", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("small", { headers: { "content-length": "9999" } })); vi.stubGlobal("fetch", fetch);
    await expect(downloadOfapiExportArtifact(args)).rejects.toThrow("byte ceiling");
    fetch.mockImplementation(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(10)); controller.enqueue(new Uint8Array(11)); controller.close(); } })));
    await expect(downloadOfapiExportArtifact(args)).rejects.toThrow("byte ceiling");
  });
});
