import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { OFAPI_TYPED_EXPORT_PROFILES, type OfapiTypedExportProfile } from "@agency_hub_core/shared";
import { useAuthMe } from "@/api/queries";
import { ofapiExportActions, ofapiExportJobsQueryOptions, readOfapiExportJobsForRecovery, useOfapiExportPages, useOfapiExportInventory, useOfapiExportRows, useOfapiExports, useOfapiVisitors } from "@/api/ofapiExports";
import { isUncertainActionFailure } from "./ofapi-actions/form-values.ts";
const labels: Record<OfapiTypedExportProfile, string> = { profile_visitors: "Profile visitors", fans: "Fans", tracking_links: "Tracking links", trial_links: "Trial links", smart_links: "Smart links" };
const field = "rounded border border-border bg-card px-3 py-2 text-sm text-text-primary";
const button = "rounded border border-border px-3 py-2 text-sm text-text-primary hover:bg-hover disabled:opacity-40";
const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
const metric = (value: number | string | null) => value === null ? "No data" : String(value);
export function exportWindowError(from: string, to: string, today = daysAgo(0)): string | null {
  const valid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!valid(from) || !valid(to)) return "Choose both dates.";
  if (from < "2016-11-01" || from > to || to >= today) return "Choose a historical UTC period from 2016-11-01, ending before today.";
  if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 >= 366) return "Choose at most 366 days per export.";
  return null;
}
type ExportQuoteBody = Parameters<typeof ofapiExportActions.create>[0];
type UnconfirmedExportQuote = { body: ExportQuoteBody; pageLabel: string };
interface ExportJobsReadback { pageId: number; dataUpdatedAt: number }

export function exportQuoteReviewSnapshot(
  readback: ExportJobsReadback | null,
  current: ExportJobsReadback & { hasData: boolean; isError: boolean; isFetching: boolean },
  selectedPageId: number,
): string | null {
  if (
    !readback || current.pageId !== readback.pageId || selectedPageId !== readback.pageId
    || !current.hasData || current.isError || current.isFetching
    || current.dataUpdatedAt < readback.dataUpdatedAt
  ) return null;
  return `${current.pageId}:${current.dataUpdatedAt}`;
}

export function UnconfirmedExportQuoteNotice({ quote, onReadJobs, onStartNew, reviewSnapshot, busy = false }: {
  quote: UnconfirmedExportQuote;
  onReadJobs: () => void;
  onStartNew: () => void;
  reviewSnapshot: string | null;
  busy?: boolean;
}) {
  const [acknowledgedSnapshot, setAcknowledgedSnapshot] = useState<string | null>(null);
  useEffect(() => { setAcknowledgedSnapshot(null); }, [quote, reviewSnapshot]);
  const reviewed = reviewSnapshot !== null && acknowledgedSnapshot === reviewSnapshot;
  return <section role="alert" className="space-y-3 rounded-xl border border-warning-dark/60 bg-card p-4 text-sm text-text-secondary">
    <h2 className="font-semibold text-text-primary">Quote creation outcome is unknown</h2>
    <p>{quote.pageLabel} (#{quote.body.pageId}) · {labels[quote.body.profile]} · {quote.body.startDate.slice(0, 10)} — {quote.body.endDate.slice(0, 10)} · ceiling {quote.body.maxCredits ?? 10} credits.</p>
    <p>The server may already have created this quote job. A repeat creates a separate task. Reload and inspect the jobs before preparing another quote.</p>
    <button type="button" className={button} disabled={busy} onClick={() => {
      setAcknowledgedSnapshot(null);
      onReadJobs();
    }}>Read and show jobs for this page</button>
    {reviewSnapshot === null && <p className="text-xs text-text-muted">
      Read the original page's jobs successfully, then review the current list below.
      A previous list or an unfinished refresh cannot confirm this review.
    </p>}
    <label className="flex items-start gap-2">
      <input
        type="checkbox"
        disabled={busy || reviewSnapshot === null}
        checked={reviewed}
        onChange={event => setAcknowledgedSnapshot(event.target.checked ? reviewSnapshot : null)}
      />
      I reviewed the jobs. I understand an earlier quote may exist and want to prepare a separate new quote.
    </label>
    <button type="button" className={button} disabled={busy || !reviewed} onClick={() => {
      if (!busy && reviewed) onStartNew();
    }}>Prepare a separate new quote</button>
    <p className="text-xs text-text-muted">This button returns to the preview form. A quote does not approve export collection.</p>
  </section>;
}
export function OfapiExportsPage() {
  const queryClient = useQueryClient();
  const auth = useAuthMe(); const owner = auth.data?.user.role === "owner";
  const pages = useOfapiExportPages(); const [selectedPage, setSelectedPage] = useState(0);
  const pageId = selectedPage || pages.data?.pages[0]?.id || 0;
  const [profile, setProfile] = useState<OfapiTypedExportProfile>("profile_visitors");
  const [from, setFrom] = useState(daysAgo(7)); const [to, setTo] = useState(daysAgo(1));
  const [maxCredits, setMaxCredits] = useState(10); const [startCredits, setStartCredits] = useState(2);
  const [fanType, setFanType] = useState<"all" | "active" | "expired" | "latest">("all");
  const [source, setSource] = useState<"export" | "rest">("export");
  const [preview, setPreview] = useState<{ receipt: Awaited<ReturnType<typeof ofapiExportActions.create>>; body: Parameters<typeof ofapiExportActions.create>[0]; pageLabel: string } | null>(null);
  const [approvedPreview, setApprovedPreview] = useState<{ jobId: string; rowVersion: number; credits: number; pageId: number; pageLabel: string; profile: OfapiTypedExportProfile } | null>(null);
  const [controlPreview, setControlPreview] = useState<{ sourceJobId: string; action: "cancel" | "retry"; expectedRowVersion: number; expectedPolicyRevision: number; approvedMaxCredits: number; pageId: number; pageLabel: string; profile: OfapiTypedExportProfile } | null>(null);
  const inventory = useOfapiExportInventory(owner);
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(""); const [error, setError] = useState("");
  const [selectedJob, setSelectedJob] = useState("");
  const [unconfirmedQuote, setUnconfirmedQuote] = useState<UnconfirmedExportQuote | null>(null);
  const [quoteReadback, setQuoteReadback] = useState<ExportJobsReadback | null>(null);
  // A disabled observer keeps recovery pinned to the original page without adding
  // another polling timer. Its explicit refetch shares the ordinary jobs cache.
  const recoveryPageId = unconfirmedQuote?.body.pageId ?? 0;
  const recoveryJobs = useQuery({ ...ofapiExportJobsQueryOptions(recoveryPageId), enabled: false });
  const reviewSnapshot = exportQuoteReviewSnapshot(quoteReadback, {
    pageId: recoveryPageId,
    dataUpdatedAt: recoveryJobs.dataUpdatedAt,
    hasData: recoveryJobs.data !== undefined,
    isError: recoveryJobs.isError,
    isFetching: recoveryJobs.isFetching,
  }, pageId);
  const windowError = exportWindowError(from, to);
  const validMaxCredits = Number.isInteger(maxCredits) && maxCredits >= 2 && maxCredits <= 50;
  const validStartCredits = Number.isInteger(startCredits) && startCredits >= 1 && startCredits <= 50;
  const jobs = useOfapiExports(pageId); const visitors = useOfapiVisitors({ pageId: windowError ? 0 : pageId, from, to, source }); const rows = useOfapiExportRows(selectedJob);
  const clearPreview = () => { setPreview(null); setApprovedPreview(null); setControlPreview(null); };
  const inFlight = useRef(false);
  async function readQuoteJobs() {
    if (inFlight.current || !unconfirmedQuote) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setQuoteReadback(null);
    setSelectedPage(unconfirmedQuote.body.pageId);
    setSelectedJob("");
    clearPreview();
    try {
      const readback = await readOfapiExportJobsForRecovery(queryClient, unconfirmedQuote.body.pageId);
      setQuoteReadback(readback);
    } catch {
      setError("The original page's jobs could not be read. The quote outcome remains unknown; try reading again before preparing another quote.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function run(action: () => Promise<void>, refreshedNotice?: string, onActionError?: (error: unknown) => void) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(""); setNotice("");
    let actionCompleted = false;
    try {
      await action();
      actionCompleted = true;
      const results = await Promise.all([jobs.refetch(), pages.refetch(), ...(!windowError ? [visitors.refetch()] : []), ...(owner ? [inventory.refetch()] : [])]);
      if (results.some(result => result.isError)) setError("Saved data could not be refreshed. Any action result above is retained; reload saved data to check it.");
      else if (refreshedNotice) setNotice(refreshedNotice);
    } catch (err) { if (!actionCompleted) onActionError?.(err); setError(err instanceof Error ? err.message : String(err)); } finally { inFlight.current = false; setBusy(false); }
  }
  const pageLabel = pages.data?.pages.find(page => page.id === pageId)?.label ?? String(pageId);
  async function create(dryRun: boolean) {
    if (unconfirmedQuote) return;
    const quote = !dryRun && preview ? { body: preview.body, pageLabel: preview.pageLabel } : null;
    await run(async () => {
      if (dryRun && (windowError || !validMaxCredits || !pages.data || pages.isError)) throw new Error(windowError ?? "Check the credit ceiling and reload page settings.");
      const body = dryRun ? { pageId, profile, startDate: `${from}T00:00:00.000Z`, endDate: `${to}T23:59:59.000Z`, maxRows: 1000, maxCredits, maxBytes: 4 * 1024 * 1024, fanType, expectedPolicyRevision: pages.data!.revision, dryRun } : preview?.body;
      if (!body) throw new Error("Preview this export before creating a quote.");
      const result = await ofapiExportActions.create({ ...body, dryRun });
      if (dryRun) setPreview({ receipt: result, body, pageLabel }); else { setPreview(null); setNotice("Quote queued. Export collection starts only after a separate approval below."); }
    }, undefined, error => {
      if (quote && isUncertainActionFailure(error)) {
        setUnconfirmedQuote(quote);
        setQuoteReadback(null);
        setPreview(null);
      }
    });
  }
  return <div className="space-y-6 max-w-7xl">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-xl font-extrabold text-text-primary">OFAPI exports & visitors</h1><p className="mt-1 text-sm text-text-muted">Saved account data, bounded export jobs, and daily visitor coverage.</p></div><Link className="text-sm text-accent" to="/settings?tab=collection">Collection controls</Link></div>
    <div className="flex flex-wrap gap-3 items-end">
      <label className="grid gap-1 text-sm text-text-muted">Page<select disabled={busy || !pages.data} className={field} value={pageId} onChange={e => { setSelectedPage(Number(e.target.value)); setSelectedJob(""); clearPreview(); }}>{pages.data?.pages.map(page => <option key={page.id} value={page.id}>{page.label}</option>)}</select></label>
      <label className="grid gap-1 text-sm text-text-muted">From<input disabled={busy} className={field} type="date" value={from} onChange={e => { setFrom(e.target.value); clearPreview(); }} /></label>
      <label className="grid gap-1 text-sm text-text-muted">Through<input disabled={busy} className={field} type="date" max={daysAgo(1)} value={to} onChange={e => { setTo(e.target.value); clearPreview(); }} /></label>
      <button className={button} disabled={busy || !pageId} onClick={() => void run(async () => {}, "Reloaded saved data.")}>Reload saved data</button>
    </div>
    {(error || pages.error || jobs.error || visitors.error) && <p role="alert" className="rounded border border-red-500/40 p-3 text-sm text-red-400">{error || String(pages.error || jobs.error || visitors.error)}</p>}
    {pages.isError && !pages.data && <button type="button" className={button} disabled={pages.isFetching} onClick={() => void pages.refetch()}>Retry page list</button>}
    {((jobs.isError && jobs.data) || (visitors.isError && visitors.data)) && <p className="text-sm text-warning-dark">The previous saved snapshot is still shown. Reload saved data to check its current state.</p>}
    {notice && <p role="status" className="rounded bg-hover p-3 text-sm text-text-primary">{notice}</p>}
    {pages.isPending && <p role="status" className="text-sm text-text-muted">Loading pages…</p>}
    {pages.data && !pages.isError && pages.data.pages.length === 0 && <p className="text-sm text-text-muted">No OnlyFans pages are available. Add or bind a page in Collection controls.</p>}
    {windowError && <p role="alert" className="text-sm text-red-400">{windowError}</p>}
    {unconfirmedQuote && <UnconfirmedExportQuoteNotice
      quote={unconfirmedQuote}
      busy={busy}
      onReadJobs={() => void readQuoteJobs()}
      reviewSnapshot={reviewSnapshot}
      onStartNew={() => {
        if (inFlight.current || reviewSnapshot === null) return;
        setSelectedPage(unconfirmedQuote.body.pageId);
        setProfile(unconfirmedQuote.body.profile);
        setFrom(unconfirmedQuote.body.startDate.slice(0, 10));
        setTo(unconfirmedQuote.body.endDate.slice(0, 10));
        setMaxCredits(unconfirmedQuote.body.maxCredits ?? 10);
        setFanType(unconfirmedQuote.body.fanType ?? "all");
        clearPreview();
        setUnconfirmedQuote(null);
        setQuoteReadback(null);
        setError("");
      }}
    />}
    {owner && <section className="rounded-xl border border-border bg-card p-5 space-y-4"><h2 className="font-semibold text-text-primary">New bounded export</h2><p className="text-sm text-text-muted">Preview is local. Creating a quote requests vendor pricing with auto-start disabled. This task allows at most 1,000 rows, 100 requests and 4 MiB. Fans describe the selected audience at export time.</p>
      <div className="flex flex-wrap gap-3 items-end">
        <label className="grid gap-1 text-sm text-text-muted">Export<select disabled={busy} className={field} value={profile} onChange={e => { setProfile(e.target.value as OfapiTypedExportProfile); clearPreview(); }}>{OFAPI_TYPED_EXPORT_PROFILES.map(value => <option value={value} key={value}>{labels[value]}</option>)}</select></label>
        {profile === "fans" && <label className="grid gap-1 text-sm text-text-muted">Audience<select disabled={busy} className={field} value={fanType} onChange={e => { setFanType(e.target.value as typeof fanType); clearPreview(); }}>{["all", "active", "expired", "latest"].map(value => <option key={value}>{value}</option>)}</select></label>}
        <label className="grid gap-1 text-sm text-text-muted">Task credit ceiling<input disabled={busy} className={field} type="number" min={2} max={50} value={maxCredits} onChange={e => { setMaxCredits(Number(e.target.value)); clearPreview(); }} /></label>
        <button className={button} disabled={busy || Boolean(unconfirmedQuote) || !pageId || Boolean(windowError) || !validMaxCredits || !pages.data || pages.isError} onClick={() => void create(true)}>Preview</button>
      </div>
      {!validMaxCredits && <p role="alert" className="text-sm text-red-400">Task credit ceiling must be a whole number from 2 to 50.</p>}
      {preview && <div className="rounded border border-border p-3 text-sm text-text-secondary"><p>Page: {preview.pageLabel} (#{preview.body.pageId}) · Export: {labels[preview.body.profile]} · {preview.body.startDate} through {preview.body.endDate}{preview.body.profile === "fans" ? ` · Audience: ${preview.body.fanType}` : ""}</p><p>At most {preview.receipt.maxRows} rows. Estimated export charge: {preview.receipt.estimatedCredits === null ? "unknown; wait for vendor quote" : `${preview.receipt.estimatedCredits} credits`}. Total task ceiling: {preview.receipt.maximumCredits} credits.</p><button className={`${button} mt-3`} disabled={busy} onClick={() => void create(false)}>Create quote</button></div>}
    </section>}
    <section className="space-y-3"><h2 className="font-semibold text-text-primary">Export jobs</h2>
      {owner && <label className="flex flex-wrap items-center gap-2 text-sm text-text-muted">Maximum credits for one export start<input disabled={busy} className={field} type="number" min={1} max={50} value={startCredits} onChange={e => { setStartCredits(Number(e.target.value)); setApprovedPreview(null); setControlPreview(null); }} /></label>}
      {!validStartCredits && <p role="alert" className="text-sm text-red-400">Start credit ceiling must be a whole number from 1 to 50.</p>}
      {pageId > 0 && jobs.isPending && <p role="status" className="text-sm text-text-muted">Loading export jobs…</p>}
      {jobs.data && !jobs.isError && !jobs.data.jobs.length && <p className="text-sm text-text-muted">No saved export jobs for this page.</p>}
      {jobs.data?.jobs.map(job => <div key={job.jobId} className="rounded-xl border border-border bg-card p-4 space-y-2 text-sm">
        <div className="flex flex-wrap justify-between gap-2"><strong className="text-text-primary">{job.controlAction ? `${job.controlAction === "cancel" ? "Cancellation" : "Retry"} · ` : ""}{labels[job.profile]} · {job.reason === "indeterminate" ? "Outcome unknown · review required" : job.controlAction && job.state === "ready" ? "Queued" : job.imported ? "Imported" : job.vendorStatus ?? job.state}</strong><span className="text-text-muted">{new Date(job.createdAt).toLocaleString()}</span></div>
        <p className="text-text-secondary">Rows: {metric(job.deliveredRows)} / {metric(job.totalRows)} · Vendor charge: {metric(job.creditCost)} · Recorded spend: {job.spentCredits}</p>
        {job.reason && <p className="text-text-muted">{job.reason.replaceAll("_", " ")}</p>}
        {job.sha256 && <p className="break-all text-xs text-text-muted">SHA256 {job.sha256} · {job.artifactBytes} bytes</p>}
        <div className="flex flex-wrap gap-2">
          {owner && job.state === "blocked" && ["background_paused", "job_unavailable", "collection_off", "on_demand_only"].includes(job.reason ?? "") && <button className={button} disabled={busy || !pages.data || pages.data.backgroundPaused} onClick={() => void run(async () => { await ofapiExportActions.resume(job.jobId, { expectedRowVersion: job.rowVersion, expectedPolicyRevision: pages.data!.revision, reason: "Owner resumed original bounded export" }); setNotice("Resumed the saved cursor under its original allowance. A started export is polled without another start."); })}>Resume approved export</button>}
          {owner && job.state === "blocked" && ["owner_approval_required", "export_quote_requires_start"].includes(job.reason ?? "") && <button className={button} disabled={busy || !validStartCredits} onClick={() => void run(async () => { await ofapiExportActions.approve(job.jobId, { expectedRowVersion: job.rowVersion, approvedMaxCredits: startCredits, reason: "Owner reviewed bounded export", dryRun: true }); setApprovedPreview({ jobId: job.jobId, rowVersion: job.rowVersion, credits: startCredits, pageId, pageLabel, profile: job.profile }); })}>Preview start</button>}
          {owner && approvedPreview?.jobId === job.jobId && <div className="rounded border border-border p-3"><p className="mb-2 text-text-secondary">Page: {approvedPreview.pageLabel} (#{approvedPreview.pageId}) · Export: {labels[approvedPreview.profile]} · Job: {approvedPreview.jobId}</p><button className={button} disabled={busy} onClick={() => void run(async () => { await ofapiExportActions.approve(job.jobId, { expectedRowVersion: approvedPreview.rowVersion, approvedMaxCredits: approvedPreview.credits, reason: "Owner approved bounded export", dryRun: false }); setApprovedPreview(null); setNotice("Export start approved within the task ceiling."); })}>Approve start · up to {approvedPreview.credits} credits</button></div>}
          {owner && job.reason === "artifact_capture_required" && !job.imported && <button className={button} disabled={busy} onClick={() => void run(async () => { await ofapiExportActions.artifact(job.jobId, { expectedRowVersion: job.rowVersion, reason: "Owner captured completed export" }); setNotice("Artifact verified and imported. Saved reports now include its rows."); })}>Download, verify & import</button>}
          {owner && job.reason === "artifact_capture_required" && !job.imported && <label className={`${button} cursor-pointer`}>Import reviewed CSV<input type="file" accept=".csv,text/csv" className="sr-only" disabled={busy} onChange={event => {
            const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
            void run(async () => {
              if (file.size > 4 * 1024 * 1024) throw new Error("CSV exceeds this screen's 4 MiB ceiling");
              const bytes = new Uint8Array(await file.arrayBuffer());
              const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
              const expectedSha256 = Array.from(digest, value => value.toString(16).padStart(2, "0")).join("");
              let binary = ""; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
              await ofapiExportActions.artifact(job.jobId, { expectedRowVersion: job.rowVersion, csvBase64: btoa(binary), expectedSha256, reason: "Owner imported reviewed CSV" });
              setNotice("CSV checksum verified and source rows imported.");
            });
          }} /></label>}
          {owner && job.controlAction !== "cancel" && ((job.state === "retry_wait" && ["pending", "in_progress"].includes(job.vendorStatus ?? "")) || (job.state === "blocked" && job.reason === "export_failed")) && <button className={button} disabled={busy || !pages.data || pages.isError || (job.reason === "export_failed" && !validStartCredits)} onClick={() => void run(async () => {
            const action = job.reason === "export_failed" ? "retry" as const : "cancel" as const;
            const snapshot = { sourceJobId: job.jobId, action, expectedRowVersion: job.rowVersion, expectedPolicyRevision: pages.data!.revision, approvedMaxCredits: action === "cancel" ? 1 : startCredits };
            const { sourceJobId: _sourceJobId, ...body } = snapshot;
            await ofapiExportActions.control(job.jobId, { ...body, reason: "Owner reviewed provider export action", dryRun: true });
            setControlPreview({ ...snapshot, pageId, pageLabel, profile: job.profile });
          })}>{job.reason === "export_failed" ? "Preview paid retry" : "Preview vendor cancellation"}</button>}
          {owner && controlPreview?.sourceJobId === job.jobId && <div className="rounded border border-border p-3 text-sm text-text-secondary"><p>Page: {controlPreview.pageLabel} (#{controlPreview.pageId}) · Export: {labels[controlPreview.profile]} · Job: {controlPreview.sourceJobId}</p><p>{controlPreview.action === "retry" ? `Creates a new export and starts it immediately, up to ${controlPreview.approvedMaxCredits} credits. Original charges remain recorded.` : "Cancels this running vendor export. Earlier export charges remain recorded."}</p><button className={`${button} mt-2`} disabled={busy} onClick={() => void run(async () => {
            const { sourceJobId, pageId: _pageId, pageLabel: _pageLabel, profile: _profile, ...snapshot } = controlPreview;
            await ofapiExportActions.control(sourceJobId, { ...snapshot, reason: "Owner approved provider export action", dryRun: false }); setControlPreview(null); setNotice("Provider action queued once. Its captured outcome will appear here.");
          })}>{controlPreview.action === "retry" ? "Approve new paid export" : "Cancel vendor export"}</button></div>}
          {job.imported && <button className={button} disabled={busy} onClick={() => setSelectedJob(job.jobId)}>View saved rows</button>}
        </div>
      </div>)}
      {selectedJob && <div className="overflow-auto rounded border border-border p-3 text-xs text-text-secondary"><p className="mb-2">First 100 saved source rows. Financial values retain the vendor’s units and meaning.</p><button type="button" className={`${button} mb-2`} onClick={() => setSelectedJob("")}>Close saved rows</button>{rows.isPending ? <p role="status">Loading saved rows…</p> : rows.error ? <p role="alert">{String(rows.error)}</p> : <pre>{JSON.stringify(rows.data?.rows ?? [], null, 2)}</pre>}</div>}
    </section>
    {owner && <section className="space-y-3 rounded-xl border border-border bg-card p-4"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold text-text-primary">Provider export inventory</h2><button className={button} disabled={busy} onClick={() => void run(async () => { await ofapiExportActions.refreshInventory({ page: 1, perPage: 25, type: profile }); setNotice("Captured one free vendor inventory page."); })}>Refresh {labels[profile]} inventory</button></div><p className="text-sm text-text-muted">Last captured provider list · {inventory.data?.observedAt ? new Date(inventory.data.observedAt).toLocaleString() : inventory.isPending ? "Loading…" : inventory.isError ? "Unavailable" : "Not collected"}. This list does not start or import exports.</p>
      {inventory.error && <p role="alert" className="text-sm text-red-400">{String(inventory.error)}</p>}
      <div className="overflow-auto"><table className="w-full text-sm text-left text-text-secondary"><thead><tr>{["Export", "Type", "Status", "Delivered / found", "Vendor credits"].map(value => <th className="p-2 font-medium" key={value}>{value}</th>)}</tr></thead><tbody>{inventory.data?.rows.map(row => <tr className="border-t border-border" key={row.id}><td className="p-2">{row.id}</td><td className="p-2">{row.type}</td><td className="p-2">{row.status}</td><td className="p-2">{metric(row.deliveredRows)} / {metric(row.totalRows)}</td><td className="p-2">{metric(row.creditCost)}</td></tr>)}</tbody></table></div>
      {inventory.data && inventory.data.currentPage < inventory.data.lastPage && <button className={button} disabled={busy} onClick={() => void run(async () => { await ofapiExportActions.refreshInventory({ page: inventory.data!.currentPage + 1, perPage: 25, type: profile }); })}>Capture next inventory page</button>}
    </section>}
    <section className="space-y-3"><div className="flex flex-wrap items-center gap-3"><h2 className="font-semibold text-text-primary">Daily profile visitors</h2><select disabled={busy} aria-label="Visitor source" className={field} value={source} onChange={e => setSource(e.target.value as typeof source)}><option value="export">CSV export</option><option value="rest">REST daily chart</option></select></div>
      <p className="text-sm text-text-muted">{visitors.data?.note ?? "Missing days stay unknown. Each source keeps its own coverage."}</p>
      {!windowError && pageId > 0 && visitors.isPending && <p role="status" className="text-sm text-text-muted">Loading visitor coverage…</p>}<div className="overflow-auto rounded-xl border border-border"><table className="w-full text-left text-sm"><thead className="bg-card text-text-muted"><tr>{["Day", "Total", "Guests", "Users", "Subscribers", "Duration (vendor units)", "Coverage"].map(label => <th key={label} className="p-3 font-medium">{label}</th>)}</tr></thead><tbody>{visitors.data?.days.map(day => <tr key={day.date} className="border-t border-border text-text-secondary"><td className="p-3">{day.date}</td><td className="p-3">{metric(day.totalVisitors)}</td><td className="p-3">{metric(day.guestVisitors)}</td><td className="p-3">{metric(day.userVisitors)}</td><td className="p-3">{metric(day.subscriberVisitors)}</td><td className="p-3">{metric(source === "export" ? day.avgViewDuration : day.chartDuration)}</td><td className="p-3" title={day.observationId ? `Observation ${day.observationId} · ${day.observedAt}` : undefined}>{day.availability} · {day.source}</td></tr>)}</tbody></table></div>
    </section>
  </div>;
}
