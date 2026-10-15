import { Link } from "react-router";
import { FilePenLine, MonitorSmartphone, Plus } from "lucide-react";

import { useDeletePageBrowserDraft, usePageBrowserDrafts, usePageBrowserProfiles } from "@/api/queries";
import { ToneChip } from "../page-browser/loginParts.js";
import { browserStatusOf, onboardingChipOf } from "../page-browser/pageBrowserOnboardingView.js";
import { draftChipOf, envLine, maskedLine } from "../page-browser/proxyEntryView.js";

// New pages connected through their own server browser (Project Browser PR
// 16; owner decision 2026-10-15): a browser starts here — its proxy pasted
// and checked, its environment confirmed (a draft); then `scripts/
// deploy-page-browser.sh add-profile` makes it from the draft, and the
// profiles it made that no page has yet are listed with where their
// onboarding stands.

/** A small button of a list row, as the row's link. */
const SMALL = "rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-text-secondary hover:bg-hover disabled:opacity-50";

export function browserProfileRoute(profileId: string): string {
  return `/browser-profiles/${encodeURIComponent(profileId)}`;
}

export function browserDraftRoute(name?: string): string {
  return name === undefined ? "/browser-profiles/new" : `/browser-profiles/new?name=${encodeURIComponent(name)}`;
}

export function BrowserProfilesSection() {
  const profiles = usePageBrowserProfiles();
  const drafts = usePageBrowserDrafts();
  const remove = useDeletePageBrowserDraft();
  const items = profiles.data?.profiles ?? [];
  const draftItems = drafts.data?.drafts ?? [];
  const empty = !profiles.isError && !drafts.isError && items.length === 0 && draftItems.length === 0 && !profiles.isPending && !drafts.isPending;
  return (
    <section className="mt-6" aria-label="Новые страницы через браузер">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-text-primary">Новые страницы через серверный браузер</h2>
        <Link to={browserDraftRoute()} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90" data-new-browser>
          <Plus size={14} aria-hidden /> Новый браузер страницы
        </Link>
      </div>
      {(profiles.isError || drafts.isError) && <p className="text-sm text-danger">Список браузеров не загрузился.</p>}
      {empty && (
        <div className="rounded-xl border border-dashed border-border bg-card px-4 py-3 text-sm text-text-muted">
          <p>Браузеров без страницы нет. Чтобы подключить страницу через её серверный браузер, нажмите «Новый браузер страницы»: вставьте прокси, проверьте её и подтвердите окружение.</p>
          <p className="mt-2">Потом на рабочей машине <span className="font-mono text-xs text-text-secondary">scripts/deploy-page-browser.sh add-profile &lt;host&gt; --page &lt;название&gt; --image &lt;образ&gt;</span> создаст браузер по этому черновику — прокси и окружение вводить не нужно.</p>
        </div>
      )}
      {draftItems.length > 0 && (
        <ul className="mb-2 flex flex-col gap-2" aria-label="Черновики браузеров">
          {draftItems.map((draft) => {
            const chip = draftChipOf(draft);
            return (
              <li key={draft.name} className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border bg-card px-4 py-3" data-browser-draft={draft.name}>
                <FilePenLine size={18} className="shrink-0 text-text-muted" aria-hidden />
                <div className="min-w-[12rem] flex-1">
                  <p className="text-sm font-semibold text-text-primary">{draft.name}{draft.page !== null && <span className="ml-2 text-xs font-normal text-text-muted">существующая страница</span>}</p>
                  <p className="truncate text-xs text-text-muted">{draft.proxy === null ? "прокси нет" : maskedLine(draft.proxy)}</p>
                  {draft.env !== null && <p className="truncate text-xs text-text-muted">{envLine(draft.env)}</p>}
                  <p className="mt-1 break-all font-mono text-[11px] text-text-secondary" data-draft-command>{draft.command}</p>
                </div>
                <ToneChip label={chip.label} tone={chip.tone} />
                <div className="flex gap-2">
                  <Link to={browserDraftRoute(draft.name)} className={SMALL}>Изменить</Link>
                  <button type="button" className={SMALL} disabled={remove.isPending} onClick={() => remove.mutate(draft.name)}>Удалить</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {items.map((profile) => {
            const chip = onboardingChipOf(profile);
            const browser = browserStatusOf(profile);
            return (
              <li key={profile.profileId} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3" data-browser-profile={profile.name}>
                <MonitorSmartphone size={18} className="shrink-0 text-text-muted" aria-hidden />
                {/* On a phone the chip and the link go under it: the details stay readable. */}
                <div className="min-w-[12rem] flex-1">
                  <p className="text-sm font-semibold text-text-primary">{profile.name}</p>
                  <p className="truncate text-xs text-text-muted">
                    {browser.label} · создан {new Date(profile.createdAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · <span className="font-mono">{profile.profileId.slice(0, 8)}</span>
                  </p>
                </div>
                <ToneChip label={chip.label} tone={chip.tone} />
                <Link to={browserProfileRoute(profile.profileId)} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
                  Подключить
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
