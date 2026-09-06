import { useState } from "react";
import { Link } from "react-router";
import { OFAPI_TYPED_EXPORT_PROFILES, type OfapiTypedExportProfile } from "@agency_hub_core/shared";
import { useAuthMe } from "@/api/queries";
import { ofapiExportActions, useOfapiExportPages, useOfapiExportInventory, useOfapiExportRows, useOfapiExports, useOfapiVisitors } from "@/api/ofapiExports";
const labels: Record<OfapiTypedExportProfile, string> = { profile_visitors: "Profile visitors", fans: "Fans", tracking_links: "Tracking links", trial_links: "Trial links", smart_links: "Smart links" };
const field = "rounded border border-border bg-card px-3 py-2 text-sm text-text-primary";
const button = "rounded border border-border px-3 py-2 text-sm text-text-primary hover:bg-hover disabled:opacity-40";
const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
const metric = (value: number | string | null) => value === null ? "No data" : String(value);
export function OfapiExportsPage() {
  const auth = useAuthMe(); const owner = auth.data?.user.role === "owner";
  const pages = useOfapiExportPages(); const [selectedPage, setSelectedPage] = useState(0);
  const pageId = selectedPage || pages.data?.pages[0]?.id || 0;
  const [profile, setProfile] = useState<OfapiTypedExportProfile>("profile_visitors");
  const [from, setFrom] = useState(daysAgo(7)); const [to, setTo] = useState(daysAgo(1));
  const [maxCredits, setMaxCredits] = useState(10); const [startCredits, setStartCredits] = useState(2);
  const [fanType, setFanType] = useState<"all" | "active" | "expired" | "latest">("all");
  const [source, setSource] = useState<"export" | "rest">("export");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof ofapiExportActions.create>> | null>(null);
  const [approvedPreview, setApprovedPreview] = useState<{ jobId: string; rowVersion: number; credits: number } | null>(null);
  const [controlPreview, setControlPreview] = useState<{ sourceJobId: string; action: "cancel" | "retry"; expectedRowVersion: number; expectedPolicyRevision: number; approvedMaxCredits: number } | null>(null);
  const inventory = useOfapiExportInventory(owner);
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(""); const [error, setError] = useState("");
  const [selectedJob, setSelectedJob] = useState("");
  const jobs = useOfapiExports(pageId); const visitors = useOfapiVisitors({ pageId, from, to, source }); const rows = useOfapiExportRows(selectedJob);
  const clearPreview = () => { setPreview(null); setApprovedPreview(null); setControlPreview(null); };
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); await jobs.refetch(); await pages.refetch(); await visitors.refetch(); if (owner) await inventory.refetch(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  }
  async function create(dryRun: boolean) {
    await run(async () => {
      const result = await ofapiExportActions.create({ pageId, profile, startDate: `${from}T00:00:00.000Z`, endDate: `${to}T23:59:59.000Z`, maxRows: 1000, maxCredits, maxBytes: 4 * 1024 * 1024, fanType, expectedPolicyRevision: pages.data!.revision, dryRun });
      if (dryRun) setPreview(result); else { setPreview(null); setNotice("Quote queued. Export collection starts only after a separate approval below."); }
    });
  }
  return <div className="space-y-6 max-w-7xl">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-xl font-extrabold text-text-primary">OFAPI exports & visitors</h1><p className="mt-1 text-sm text-text-muted">Saved account data, bounded export jobs, and daily visitor coverage.</p></div><Link className="text-sm text-accent" to="/settings?tab=collection">Collection controls</Link></div>
    <div className="flex flex-wrap gap-3 items-end">
      <label className="grid gap-1 text-sm text-text-muted">Page<select className={field} value={pageId} onChange={e => { setSelectedPage(Number(e.target.value)); setSelectedJob(""); clearPreview(); }}>{pages.data?.pages.map(page => <option key={page.id} value={page.id}>{page.label}</option>)}</select></label>
      <label className="grid gap-1 text-sm text-text-muted">From<input className={field} type="date" value={from} onChange={e => { setFrom(e.target.value); clearPreview(); }} /></label>
      <label className="grid gap-1 text-sm text-text-muted">Through<input className={field} type="date" max={daysAgo(1)} value={to} onChange={e => { setTo(e.target.value); clearPreview(); }} /></label>
      <button className={button} disabled={busy || !pageId} onClick={() => void run(async () => { setNotice("Reloaded saved data."); })}>Reload saved data</button>
    </div>
    {(error || pages.error || jobs.error || visitors.error) && <p role="alert" className="rounded border border-red-500/40 p-3 text-sm text-red-400">{error || String(pages.error || jobs.error || visitors.error)}</p>}
    {notice && <p role="status" className="rounded bg-hover p-3 text-sm text-text-primary">{notice}</p>}
    {owner && <section className="rounded-xl border border-border bg-card p-5 space-y-4"><h2 className="font-semibold text-text-primary">New bounded export</h2><p className="text-sm text-text-muted">Preview is local. Creating a quote requests vendor pricing with auto-start disabled. This task allows at most 1,000 rows, 100 requests and 4 MiB. Fans describe the selected audience at export time.</p>
      <div className="flex flex-wrap gap-3 items-end">
        <label className="grid gap-1 text-sm text-text-muted">Export<select className={field} value={profile} onChange={e => { setProfile(e.target.value as OfapiTypedExportProfile); clearPreview(); }}>{OFAPI_TYPED_EXPORT_PROFILES.map(value => <option value={value} key={value}>{labels[value]}</option>)}</select></label>
        {profile === "fans" && <label className="grid gap-1 text-sm text-text-muted">Audience<select className={field} value={fanType} onChange={e => { setFanType(e.target.value as typeof fanType); clearPreview(); }}>{["all", "active", "expired", "latest"].map(value => <option key={value}>{value}</option>)}</select></label>}
        <label className="grid gap-1 text-sm text-text-muted">Task credit ceiling<input className={field} type="number" min={2} max={50} value={maxCredits} onChange={e => { setMaxCredits(Number(e.target.value)); clearPreview(); }} /></label>
        <button className={button} disabled={busy || !pageId || !from || !to} onClick={() => void create(true)}>Preview</button>
      </div>
      {preview && <div className="rounded border border-border p-3 text-sm text-text-secondary"><p>At most {preview.maxRows} rows. Estimated export charge: {preview.estimatedCredits === null ? "unknown; wait for vendor quote" : `${preview.estimatedCredits} credits`}. Total task ceiling: {preview.maximumCredits} credits.</p><button className={`${button} mt-3`} disabled={busy} onClick={() => void create(false)}>Create quote</button></div>}
    </section>}
    <section className="space-y-3"><h2 className="font-semibold text-text-primary">Export jobs</h2>
      {owner && <label className="flex flex-wrap items-center gap-2 text-sm text-text-muted">Maximum credits for one export start<input className={field} type="number" min={1} max={50} value={startCredits} onChange={e => { setStartCredits(Number(e.target.value)); setApprovedPreview(null); setControlPreview(null); }} /></label>}
      {!jobs.data?.jobs.length && <p className="text-sm text-text-muted">No saved export jobs for this page.</p>}
      {jobs.data?.jobs.map(job => <div key={job.jobId} className="rounded-xl border border-border bg-card p-4 space-y-2 text-sm">
        <div className="flex flex-wrap justify-between gap-2"><strong className="text-text-primary">{job.controlAction ? `${job.controlAction === "cancel" ? "Cancellation" : "Retry"} · ` : ""}{labels[job.profile]} · {job.reason === "indeterminate" ? "Outcome unknown · review required" : job.controlAction && job.state === "ready" ? "Queued" : job.imported ? "Imported" : job.vendorStatus ?? job.state}</strong><span className="text-text-muted">{new Date(job.createdAt).toLocaleString()}</span></div>
        <p className="text-text-secondary">Rows: {metric(job.deliveredRows)} / {metric(job.totalRows)} · Vendor charge: {metric(job.creditCost)} · Recorded spend: {job.spentCredits}</p>
        {job.reason && <p className="text-text-muted">{job.reason.replaceAll("_", " ")}</p>}
        {job.sha256 && <p className="break-all text-xs text-text-muted">SHA256 {job.sha256} · {job.artifactBytes} bytes</p>}
        <div className="flex flex-wrap gap-2">
          {owner && job.state === "blocked" && ["owner_approval_required", "export_quote_requires_start"].includes(job.reason ?? "") && <button className={button} disabled={busy} onClick={() => void run(async () => { await ofapiExportActions.approve(job.jobId, { expectedRowVersion: job.rowVersion, approvedMaxCredits: startCredits, reason: "Owner reviewed bounded export", dryRun: true }); setApprovedPreview({ jobId: job.jobId, rowVersion: job.rowVersion, credits: startCredits }); })}>Preview start</button>}
          {owner && approvedPreview?.jobId === job.jobId && <button className={button} disabled={busy} onClick={() => void run(async () => { await ofapiExportActions.approve(job.jobId, { expectedRowVersion: approvedPreview.rowVersion, approvedMaxCredits: approvedPreview.credits, reason: "Owner approved bounded export", dryRun: false }); setApprovedPreview(null); setNotice("Export start approved within the task ceiling."); })}>Approve start · up to {approvedPreview.credits} credits</button>}
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
          {owner && job.controlAction !== "cancel" && ((job.state === "retry_wait" && ["pending", "in_progress"].includes(job.vendorStatus ?? "")) || (job.state === "blocked" && job.reason === "export_failed")) && <button className={button} disabled={busy} onClick={() => void run(async () => {
            const action = job.reason === "export_failed" ? "retry" as const : "cancel" as const;
            const snapshot = { sourceJobId: job.jobId, action, expectedRowVersion: job.rowVersion, expectedPolicyRevision: pages.data!.revision, approvedMaxCredits: action === "cancel" ? 1 : startCredits };
            const { sourceJobId: _sourceJobId, ...body } = snapshot;
            await ofapiExportActions.control(job.jobId, { ...body, reason: "Owner reviewed provider export action", dryRun: true });
            setControlPreview(snapshot);
          })}>{job.reason === "export_failed" ? "Preview paid retry" : "Preview vendor cancellation"}</button>}
          {owner && controlPreview?.sourceJobId === job.jobId && <div className="rounded border border-border p-3 text-sm text-text-secondary"><p>{controlPreview.action === "retry" ? `Creates a new export and starts it immediately, up to ${controlPreview.approvedMaxCredits} credits. Original charges remain recorded.` : "Cancels this running vendor export. Earlier export charges remain recorded."}</p><button className={`${button} mt-2`} disabled={busy} onClick={() => void run(async () => {
            const { sourceJobId, ...snapshot } = controlPreview;
            await ofapiExportActions.control(sourceJobId, { ...snapshot, reason: "Owner approved provider export action", dryRun: false }); setControlPreview(null); setNotice("Provider action queued once. Its captured outcome will appear here.");
          })}>{controlPreview.action === "retry" ? "Approve new paid export" : "Cancel vendor export"}</button></div>}
          {job.imported && <button className={button} onClick={() => setSelectedJob(job.jobId)}>View saved rows</button>}
        </div>
      </div>)}
      {selectedJob && <div className="overflow-auto rounded border border-border p-3 text-xs text-text-secondary"><p className="mb-2">First 100 saved source rows. Financial values retain the vendor’s units and meaning.</p>{rows.error ? <p role="alert">{String(rows.error)}</p> : <pre>{JSON.stringify(rows.data?.rows ?? [], null, 2)}</pre>}</div>}
    </section>
    {owner && <section className="space-y-3 rounded-xl border border-border bg-card p-4"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold text-text-primary">Provider export inventory</h2><button className={button} disabled={busy} onClick={() => void run(async () => { await ofapiExportActions.refreshInventory({ page: 1, perPage: 25, type: profile }); setNotice("Captured one free vendor inventory page."); })}>Refresh {labels[profile]} inventory</button></div><p className="text-sm text-text-muted">Last captured provider list · {inventory.data?.observedAt ? new Date(inventory.data.observedAt).toLocaleString() : "Not collected"}. This list does not start or import exports.</p>
      {inventory.error && <p role="alert" className="text-sm text-red-400">{String(inventory.error)}</p>}
      <div className="overflow-auto"><table className="w-full text-sm text-left text-text-secondary"><thead><tr>{["Export", "Type", "Status", "Delivered / found", "Vendor credits"].map(value => <th className="p-2 font-medium" key={value}>{value}</th>)}</tr></thead><tbody>{inventory.data?.rows.map(row => <tr className="border-t border-border" key={row.id}><td className="p-2">{row.id}</td><td className="p-2">{row.type}</td><td className="p-2">{row.status}</td><td className="p-2">{metric(row.deliveredRows)} / {metric(row.totalRows)}</td><td className="p-2">{metric(row.creditCost)}</td></tr>)}</tbody></table></div>
      {inventory.data && inventory.data.currentPage < inventory.data.lastPage && <button className={button} disabled={busy} onClick={() => void run(async () => { await ofapiExportActions.refreshInventory({ page: inventory.data!.currentPage + 1, perPage: 25, type: profile }); })}>Capture next inventory page</button>}
    </section>}
    <section className="space-y-3"><div className="flex flex-wrap items-center gap-3"><h2 className="font-semibold text-text-primary">Daily profile visitors</h2><select aria-label="Visitor source" className={field} value={source} onChange={e => setSource(e.target.value as typeof source)}><option value="export">CSV export</option><option value="rest">REST daily chart</option></select></div>
      <p className="text-sm text-text-muted">{visitors.data?.note ?? "Missing days stay unknown. Each source keeps its own coverage."}</p>
      <div className="overflow-auto rounded-xl border border-border"><table className="w-full text-left text-sm"><thead className="bg-card text-text-muted"><tr>{["Day", "Total", "Guests", "Users", "Subscribers", "Duration (vendor units)", "Coverage"].map(label => <th key={label} className="p-3 font-medium">{label}</th>)}</tr></thead><tbody>{visitors.data?.days.map(day => <tr key={day.date} className="border-t border-border text-text-secondary"><td className="p-3">{day.date}</td><td className="p-3">{metric(day.totalVisitors)}</td><td className="p-3">{metric(day.guestVisitors)}</td><td className="p-3">{metric(day.userVisitors)}</td><td className="p-3">{metric(day.subscriberVisitors)}</td><td className="p-3">{metric(source === "export" ? day.avgViewDuration : day.chartDuration)}</td><td className="p-3" title={day.observationId ? `Observation ${day.observationId} · ${day.observedAt}` : undefined}>{day.availability} · {day.source}</td></tr>)}</tbody></table></div>
    </section>
  </div>;
}
