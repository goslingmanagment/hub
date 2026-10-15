import { Link } from "react-router";
import { FilePenLine, MonitorSmartphone, Plus } from "lucide-react";

import { useDeletePageBrowserDraft, usePageBrowserDrafts, usePageBrowserProfiles } from "@/api/queries";
import { RowMenu } from "@/components/ui/RowMenu";
import { formatDateTime } from "@/lib/format";
import { ServerAdminCommand, ToneChip } from "../page-browser/loginParts.js";
import { browserStatusOf, onboardingChipOf } from "../page-browser/pageBrowserOnboardingView.js";
import { draftChipOf } from "../page-browser/proxyEntryView.js";

// New pages connected through their own server browser (Project Browser PR
// 16; owner decision 2026-10-15): a browser starts here — its proxy pasted
// and checked, its environment confirmed (a draft); then the server's
// administrator makes it from the draft (`scripts/deploy-page-browser.sh
// add-profile`, the command kept in a collapsed disclosure), and the profiles
// it made that no page has yet are listed with where their onboarding stands.

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
    <section className="card" aria-labelledby="browser-profiles-title">
      <div className="card-header">
        <div className="min-w-0">
          <h3 id="browser-profiles-title" className="card-title">Браузеры страниц</h3>
          <p className="card-description">Страницы Fansly, которые входят через собственный серверный браузер.</p>
        </div>
        <Link to={browserDraftRoute()} className="btn" data-new-browser>
          <Plus size={16} aria-hidden /> Новый браузер страницы
        </Link>
      </div>
      {(profiles.isError || drafts.isError) && (
        <div className="card-body">
          <p role="alert" className="notice notice-danger">Список браузеров не загрузился.</p>
        </div>
      )}
      {empty && (
        <p className="card-body text-sm text-text-secondary">
          Пока ни одного. Нажмите «Новый браузер страницы»: вставьте прокси, проверьте её и подтвердите
          окружение — по этому черновику сервер создаст браузер.
        </p>
      )}
      {draftItems.length > 0 && (
        <ul className="divide-y divide-border-light" aria-label="Черновики браузеров">
          {draftItems.map((draft) => {
            const chip = draftChipOf(draft);
            return (
              <li key={draft.name} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3" data-browser-draft={draft.name}>
                <FilePenLine size={18} className="shrink-0 text-text-secondary" aria-hidden />
                <div className="min-w-[9rem] flex-1">
                  <p className="text-sm font-medium text-text-primary">{draft.name}</p>
                  <p className="text-xs text-text-secondary">Черновик{draft.page !== null ? " · существующая страница" : ""}</p>
                </div>
                <ToneChip label={chip.label} tone={chip.tone} />
                <div className="flex items-center gap-1">
                  <Link to={browserDraftRoute(draft.name)} className="btn btn-sm">Изменить</Link>
                  <RowMenu
                    label={`Действия с черновиком ${draft.name}`}
                    items={[{ label: "Удалить черновик", danger: true, disabled: remove.isPending, onSelect: () => remove.mutate(draft.name) }]}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {items.length > 0 && (
        <ul className={`divide-y divide-border-light ${draftItems.length > 0 ? "border-t border-border-light" : ""}`} aria-label="Браузеры без страницы">
          {items.map((profile) => {
            const chip = onboardingChipOf(profile);
            const browser = browserStatusOf(profile);
            return (
              <li key={profile.profileId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3" data-browser-profile={profile.name}>
                <MonitorSmartphone size={18} className="shrink-0 text-text-secondary" aria-hidden />
                <div className="min-w-[9rem] flex-1">
                  <p className="text-sm font-medium text-text-primary">{profile.name}</p>
                  <p className="text-xs text-text-secondary">{browser.label} · создан {formatDateTime(profile.createdAt)}</p>
                </div>
                <ToneChip label={chip.label} tone={chip.tone} />
                <Link to={browserProfileRoute(profile.profileId)} className="btn btn-sm">
                  Подключить
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {draftItems.length > 0 && (
        <div className="border-t border-border-light px-5 py-3">
          <ServerAdminCommand
            text="Браузер по черновику создаёт администратор на рабочей машине — прокси и окружение вводить не нужно:"
            command={draftItems.map((draft) => draft.command)}
          />
        </div>
      )}
    </section>
  );
}
