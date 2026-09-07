import { useState } from "react";
import { Link } from "react-router";
import { useAuthMe } from "@/api/queries";
import { useOfapiExportPages } from "@/api/ofapiExports";
import { ofapiMediaActions, useOfapiMedia } from "@/api/ofapiMedia";
const field =
  "rounded border border-border bg-card px-3 py-2 text-sm text-text-primary";
const button =
  "rounded border border-border px-3 py-2 text-sm text-text-primary hover:bg-hover disabled:opacity-40";
const ready = (value: boolean | null) =>
  value === true ? "Ready" : value === false ? "Still processing" : "Unknown";
export function OfapiMediaPage() {
  const auth = useAuthMe(),
    owner = auth.data?.user.role === "owner",
    pages = useOfapiExportPages();
  const [selectedPage, setSelectedPage] = useState(0),
    [offset, setOffset] = useState(0);
  const pageId = selectedPage || pages.data?.pages[0]?.id || 0;
  const saved = useOfapiMedia(pageId, offset);
  const [file, setFile] = useState<File | null>(null),
    [sourceId, setSourceId] = useState("");
  const [destination, setDestination] = useState<"vault" | "cdn">("vault"),
    [maxCredits, setMaxCredits] = useState(3),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<{
    body: Parameters<typeof ofapiMediaActions.upload>[0];
    pageLabel: string;
    sourceFilename: string;
    receipt: Awaited<ReturnType<typeof ofapiMediaActions.upload>>;
  } | null>(null);
  const [collectionPreview, setCollectionPreview] = useState<{
    selection: string[];
    revision: number;
    pageId: number;
    pageLabel: string;
  } | null>(null);
  const [handoff, setHandoff] = useState<Awaited<
    ReturnType<typeof ofapiMediaActions.handoff>
  > | null>(null);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await saved.refetch();
      await pages.refetch();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  function reset() {
    setPreview(null);
    setCollectionPreview(null);
    setHandoff(null);
  }
  async function saveSource() {
    if (!file) return;
    await run(async () => {
      if (file.size > 100000000)
        throw new Error("Choose a file up to 100 decimal MB.");
      const bytes = await file.arrayBuffer(),
        hash = await crypto.subtle.digest("SHA-256", bytes),
        expectedSha256 = Array.from(new Uint8Array(hash), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
      const fileBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]!);
        reader.onerror = () => reject(new Error("File could not be read"));
        reader.readAsDataURL(file);
      });
      const source = await ofapiMediaActions.source({
        pageId,
        filename: file.name,
        expectedSha256,
        fileBase64,
      });
      setSourceId(source.id);
      setMaxCredits(Math.max(1, Math.ceil((source.bytes * 3) / 1000000)));
      setNotice(
        "Source saved and checksum verified. Upload awaits your approval.",
      );
      setPreview(null);
    });
  }
  async function previewUpload() {
    await run(async () => {
      const body = {
        pageId,
        sourceId,
        destination,
        maxCredits,
        requestId: crypto.randomUUID(),
        expectedPolicyRevision: pages.data!.revision,
        dryRun: true,
      };
      const pageLabel =
        pages.data!.pages.find((page) => page.id === body.pageId)?.label ??
        `Page ${body.pageId}`;
      const sourceFilename =
        saved.data?.sources.find((source) => source.id === body.sourceId)
          ?.filename ?? body.sourceId;
      setPreview({
        body,
        pageLabel,
        sourceFilename,
        receipt: await ofapiMediaActions.upload(body),
      });
    });
  }
  async function copyMaterial(
    input: Parameters<typeof ofapiMediaActions.handoff>[0],
  ) {
    await run(async () => {
      const result = await ofapiMediaActions.handoff(input);
      setHandoff(result);
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(result.materialId);
        setNotice(
          "Verified media ID copied. Select this material in ChatGoose before sending.",
        );
      }
    });
  }
  const source = saved.data?.sources.find((value) => value.id === sourceId);
  return (
    <div className="max-w-7xl space-y-6">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold text-text-primary">
            OnlyFans media
          </h1>
          <p className="mt-1 text-sm text-text-muted">
            Owned sources, asynchronous uploads and saved vault metadata.
          </p>
        </div>
        <Link className="text-accent text-sm" to="/settings?tab=collection">
          Collection controls
        </Link>
      </div>
      <div className="flex flex-wrap gap-3 items-end">
        <label className="grid gap-1 text-sm text-text-muted">
          Page
          <select
            disabled={busy}
            className={field}
            value={pageId}
            onChange={(event) => {
              setSelectedPage(Number(event.target.value));
              setSourceId("");
              setFile(null);
              setOffset(0);
              reset();
            }}
          >
            {pages.data?.pages.map((page) => (
              <option key={page.id} value={page.id}>
                {page.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className={button}
          disabled={busy || !pageId}
          onClick={() =>
            void run(async () => {
              setNotice("Reloaded saved media.");
            })
          }
        >
          Reload saved data
        </button>
      </div>
      {(error || saved.error || pages.error) && (
        <p
          role="alert"
          className="rounded border border-red-500/40 p-3 text-red-400 text-sm"
        >
          {error || String(saved.error || pages.error)}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="rounded bg-hover p-3 text-sm text-text-primary"
        >
          {notice}
        </p>
      )}
      {busy && (
        <p role="status" className="text-sm text-text-muted">
          Saving the reviewed action…
        </p>
      )}
      {owner && (
        <section className="rounded-xl border border-border bg-card p-5 space-y-4">
          <h2 className="font-semibold text-text-primary">
            Upload owned media
          </h2>
          <p className="text-sm text-text-muted">
            Files up to 100 MB. Save a source once; reuse it for an explicitly
            approved upload. The server checks its type, size and checksum.
            Uploads cost 3 credits per decimal MB, minimum 1.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm text-text-muted">
              Owned image, video or audio
              <input
                disabled={busy}
                className={field}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,audio/mpeg,audio/wav,audio/mp4"
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  reset();
                }}
              />
            </label>
            <button
              className={button}
              disabled={busy || !file || !pageId}
              onClick={() => void saveSource()}
            >
              Save source
            </button>
            {file && (
              <span className="text-text-muted text-sm">
                {file.name} · {(file.size / 1000000).toFixed(2)} MB
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm text-text-muted">
              Saved source
              <select
                disabled={busy}
                className={field}
                value={sourceId}
                onChange={(event) => {
                  setSourceId(event.target.value);
                  const row = saved.data?.sources.find(
                    (source) => source.id === event.target.value,
                  );
                  if (row)
                    setMaxCredits(
                      Math.max(1, Math.ceil((row.bytes * 3) / 1000000)),
                    );
                  reset();
                }}
              >
                <option value="">Choose a source</option>
                {saved.data?.sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.filename} · {(source.bytes / 1000000).toFixed(2)} MB
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm text-text-muted">
              Destination
              <select
                disabled={busy}
                className={field}
                value={destination}
                onChange={(event) => {
                  setDestination(event.target.value as "vault" | "cdn");
                  reset();
                }}
              >
                <option value="vault">Reusable vault media</option>
                <option value="cdn">One-use message attachment</option>
              </select>
            </label>
            <label className="grid gap-1 text-sm text-text-muted">
              Maximum credits
              <input
                disabled={busy}
                className={field}
                type="number"
                min={1}
                max={300}
                value={maxCredits}
                onChange={(event) => {
                  setMaxCredits(Number(event.target.value));
                  reset();
                }}
              />
            </label>
            <button
              className={button}
              disabled={busy || !source || !pages.data}
              onClick={() => void previewUpload()}
            >
              Preview upload
            </button>
          </div>
          {source && (
            <p className="text-xs text-text-muted break-all">
              Verified {source.mimeType} · SHA256 {source.sha256}
            </p>
          )}
          {preview && (
            <div className="rounded border border-border p-3 text-sm text-text-secondary">
              <p className="font-medium">
                {preview.pageLabel} (page {preview.body.pageId}) ·{" "}
                {preview.sourceFilename}
              </p>
              <p className="break-all text-xs text-text-muted">
                Source {preview.body.sourceId} · SHA256 {preview.receipt.sha256}
              </p>
              <p>
                {preview.receipt.destination === "vault"
                  ? "Reusable vault"
                  : "One-use CDN"}{" "}
                upload · {(preview.receipt.bytes / 1000000).toFixed(2)} MB ·
                estimate {preview.receipt.estimatedCredits} credits · approved
                ceiling {preview.receipt.maxCredits}. Status checks are bounded
                to 99 calls.
              </p>
              <button
                className={`${button} mt-3`}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await ofapiMediaActions.upload({
                      ...preview.body,
                      dryRun: false,
                    });
                    setPreview(null);
                    setNotice("Upload queued. Its progress appears below.");
                  })
                }
              >
                Approve one upload
              </button>
            </div>
          )}
        </section>
      )}
      <section className="space-y-3">
        <h2 className="font-semibold text-text-primary">Uploads</h2>
        {!saved.data?.uploads.length && (
          <p className="text-sm text-text-muted">
            No upload tasks for this page.
          </p>
        )}
        {saved.data?.uploads.map((job) => (
          <div
            key={job.id}
            className="rounded-xl border border-border bg-card p-4 space-y-2 text-sm"
          >
            <div className="flex flex-wrap justify-between">
              <strong className="text-text-primary">
                {job.destination === "vault" ? "Vault" : "One-use attachment"} ·{" "}
                {job.reason === "indeterminate"
                  ? "Outcome unknown · review required"
                  : (job.uploadStatus ?? job.state)}
              </strong>
              <span className="text-text-muted">
                {new Date(job.createdAt).toLocaleString()}
              </span>
            </div>
            <p className="text-text-secondary">
              Transcoding: {ready(job.isReady)} · Vendor charge:{" "}
              {job.actualCredits === null
                ? "not established"
                : `${job.actualCredits} credits`}{" "}
              · Recorded allowance/spend: {job.spentCredits}
            </p>
            {job.reason && job.reason !== "upload_processing" && (
              <p className="text-text-muted">
                {job.reason.replaceAll("_", " ")}
              </p>
            )}
            {owner &&
              job.state === "blocked" &&
              [
                "background_paused",
                "job_unavailable",
                "collection_off",
                "on_demand_only",
              ].includes(job.reason ?? "") && (
                <button
                  className={button}
                  disabled={busy || !pages.data || pages.data.backgroundPaused}
                  onClick={() =>
                    void run(async () => {
                      await ofapiMediaActions.resume(job.id, {
                        expectedRowVersion: job.rowVersion,
                        expectedPolicyRevision: pages.data!.revision,
                        reason:
                          "Resume reviewed upload with original allowance",
                      });
                      setNotice(
                        "Upload resumed with the same source and allowance.",
                      );
                    })
                  }
                >
                  Resume approved upload
                </button>
              )}
            {owner && job.state === "complete" && (
              <div className="flex gap-2 flex-wrap">
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void copyMaterial({
                      pageId,
                      jobId: job.id,
                      expectedRowVersion: job.rowVersion,
                      reason: "Owner reviewed upload handoff",
                    })
                  }
                >
                  Copy verified media ID
                </button>
                {job.destination === "vault" && job.mediaRef && (
                  <button
                    className={button}
                    disabled={busy || !pages.data}
                    onClick={() =>
                      setCollectionPreview({
                        selection: [`vault_item:${job.mediaRef}`],
                        revision: pages.data!.revision,
                        pageId,
                        pageLabel:
                          pages.data!.pages.find((page) => page.id === pageId)
                            ?.label ?? `Page ${pageId}`,
                      })
                    }
                  >
                    Preview readiness refresh
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </section>
      {handoff && (
        <section className="rounded border border-border p-4 space-y-2">
          <p className="text-sm text-text-secondary">{handoff.note}</p>
          <input
            disabled={busy}
            aria-label="Verified media ID"
            className={`${field} w-full font-mono`}
            readOnly
            value={handoff.materialId}
          />
          <button className={button} onClick={() => setHandoff(null)}>
            Hide ID
          </button>
        </section>
      )}
      <section className="space-y-3">
        <div className="flex flex-wrap justify-between gap-3">
          <h2 className="font-semibold text-text-primary">
            Saved vault catalog ·{" "}
            {saved.data?.inventory.state ?? "never collected"}
          </h2>
          {owner && (
            <button
              className={button}
              disabled={busy || !pageId || !pages.data}
              onClick={() =>
                setCollectionPreview({
                  selection: [
                    "vault_inventory",
                    "vault_lists",
                    "release_forms",
                    "taggable_users",
                  ],
                  revision: pages.data!.revision,
                  pageId,
                  pageLabel:
                    pages.data!.pages.find((page) => page.id === pageId)
                      ?.label ?? `Page ${pageId}`,
                })
              }
            >
              Preview bounded catalog refresh
            </button>
          )}
        </div>
        <p className="text-sm text-text-muted">{saved.data?.inventory.note}</p>
        {collectionPreview && (
          <div className="rounded border border-border p-3 text-sm text-text-secondary">
            <p>
              {collectionPreview.pageLabel} (page {collectionPreview.pageId}) ·
              Read{" "}
              {collectionPreview.selection.length === 1
                ? "one selected item"
                : "vault media, lists, release forms and taggable users"}
              . Maximum 10 calls, 10 credits and 4 MiB. An interrupted traversal
              stays partial. Sources and binary media are not downloaded.
            </p>
            <button
              className={`${button} mt-2`}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await ofapiMediaActions.collect({
                    pageId: collectionPreview.pageId,
                    category: "vault_catalog",
                    expectedRevision: collectionPreview.revision,
                    maxCredits: 10,
                    maxCalls: 10,
                    maxBytes: 4 * 1024 * 1024,
                    from: null,
                    to: null,
                    selection: collectionPreview.selection,
                  });
                  setCollectionPreview(null);
                  setNotice(
                    "Bounded metadata collection queued. Large inventories may require a larger reviewed task in Collection controls.",
                  );
                })
              }
            >
              Approve metadata collection
            </button>
          </div>
        )}
        <div className="overflow-x-auto rounded border border-border">
          <table className="min-w-full text-sm text-left">
            <thead className="text-text-muted">
              <tr>
                <th className="p-3">Media</th>
                <th className="p-3">Readiness</th>
                <th className="p-3">Metadata</th>
                <th className="p-3">Release forms</th>
                <th className="p-3">Action</th>
              </tr>
            </thead>
            <tbody>
              {saved.data?.media.map((media) => (
                <tr
                  key={`${media.materialKind}:${media.mediaRef}`}
                  className="border-t border-border text-text-secondary"
                >
                  <td className="p-3">
                    {media.materialKind === "cdn"
                      ? "One-use attachment"
                      : media.mediaRef}
                    <p className="text-xs text-text-muted">
                      {media.filename ??
                        media.providerType ??
                        "No type observed"}
                    </p>
                  </td>
                  <td className="p-3">
                    {ready(media.isReady)}
                    {media.hasError && " · provider error"}
                  </td>
                  <td className="p-3">
                    {media.width ?? "?"}×{media.height ?? "?"} ·{" "}
                    {media.bytes === null
                      ? "size unknown"
                      : `${media.bytes} bytes`}
                  </td>
                  <td className="p-3">
                    {media.releaseForms.length
                      ? media.releaseForms
                          .map(
                            (form) =>
                              `${form.name ?? form.id}${form.status ? ` (${form.status})` : ""}`,
                          )
                          .join(", ")
                      : "None observed"}
                  </td>
                  <td className="p-3">
                    {owner && media.materialKind === "vault" && (
                      <button
                        className={button}
                        disabled={
                          busy ||
                          media.isReady !== true ||
                          media.hasError === true ||
                          media.canView === false
                        }
                        onClick={() =>
                          void copyMaterial({
                            pageId,
                            mediaRef: media.mediaRef,
                            expectedObservationId: media.observationId,
                            reason: "Owner reviewed vault material handoff",
                          })
                        }
                      >
                        Copy verified ID
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex gap-3 text-sm text-text-muted">
          <button
            className={button}
            disabled={busy || offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            Previous
          </button>
          <span>
            {offset + 1}–{Math.min(offset + 50, saved.data?.totalMedia ?? 0)} of{" "}
            {saved.data?.totalMedia ?? 0}
          </span>
          <button
            className={button}
            disabled={busy || offset + 50 >= (saved.data?.totalMedia ?? 0)}
            onClick={() => setOffset(offset + 50)}
          >
            Next
          </button>
        </div>
      </section>
    </div>
  );
}
