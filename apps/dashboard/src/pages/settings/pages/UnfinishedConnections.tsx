import { useState } from "react";
import { Link } from "react-router";
import { usePageBrowserDrafts, usePageBrowserProfiles } from "@/api/queries";
import { ServerAdminCommand } from "@/components/shared/ServerAdminCommand";
import { Notice } from "@/components/ui/Notice";
import { RowMenu } from "@/components/ui/RowMenu";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatDateTime } from "@/lib/format";
import { browserDraftRoute, browserProfileRoute } from "@/lib/navigation";
import type { StatusTone } from "@/lib/statusWords";
import { browserStatusOf, onboardingChipOf } from "../../page-browser/pageBrowserOnboardingView.js";
import { draftChipOf } from "../../page-browser/proxyEntryView.js";
import { DeleteDraftConfirm } from "./PageConfirms.js";

/** The connecting screens' chip tones in the dictionary's six (design-language.md §2.5). */
const TONE: Readonly<Record<string, StatusTone>> = {
  good: "good",
  progress: "moving",
  neutral: "moving",
  warning: "attention",
  danger: "broken",
};

/**
 * Fansly pages begun and not finished: drafts the server administrator has yet to
 * turn into a browser, and browsers no page has yet. Shown only when there is
 * something, or when the list did not come.
 */
export function UnfinishedConnections() {
  const profiles = usePageBrowserProfiles();
  const drafts = usePageBrowserDrafts();
  const [deleting, setDeleting] = useState<string | null>(null);
  const profileItems = profiles.data?.profiles ?? [];
  const draftItems = drafts.data?.drafts ?? [];
  const failed = (profiles.isError && !profiles.data) || (drafts.isError && !drafts.data);
  if (!failed && profileItems.length === 0 && draftItems.length === 0) return null;

  return (
    <section className="card" aria-labelledby="unfinished-connections-title">
      <div className="card-header">
        <div className="min-w-0">
          <h2 id="unfinished-connections-title" className="card-title">Незавершённые подключения</h2>
          <p className="card-description">Страницы Fansly, которые начали подключать и не закончили.</p>
        </div>
      </div>
      {failed && (
        <div className="card-body">
          <Notice
            tone="warning"
            role="alert"
            action={<button type="button" className="btn btn-sm" onClick={() => { void profiles.refetch(); void drafts.refetch(); }}>Повторить</button>}
          >
            Список незавершённых подключений не загрузился.
          </Notice>
        </div>
      )}
      {(draftItems.length > 0 || profileItems.length > 0) && (
        <ul className="settings-list" aria-label="Незавершённые подключения">
          {draftItems.map((draft) => {
            const chip = draftChipOf(draft);
            return (
              <li key={draft.name} className="settings-list-row" data-browser-draft={draft.name}>
                <div className="settings-list-main">
                  <p className="font-medium">{draft.name}</p>
                  <p className="settings-second">{draft.page !== null ? "Черновик, существующая страница" : "Черновик"}</p>
                </div>
                <StatusBadge tone={TONE[chip.tone] ?? "moving"}>{chip.label}</StatusBadge>
                <div className="settings-actions">
                  <Link to={browserDraftRoute(draft.name)} className="btn btn-sm">Изменить</Link>
                  <RowMenu
                    label={`Действия с черновиком ${draft.name}`}
                    items={[{ label: "Удалить черновик", danger: true, onSelect: () => setDeleting(draft.name) }]}
                  />
                </div>
              </li>
            );
          })}
          {profileItems.map((profile) => {
            const chip = onboardingChipOf(profile);
            const browser = browserStatusOf(profile);
            return (
              <li key={profile.profileId} className="settings-list-row" data-browser-profile={profile.name}>
                <div className="settings-list-main">
                  <p className="font-medium">{profile.name}</p>
                  <p className="settings-second">{browser.label}, создан {formatDateTime(profile.createdAt)}</p>
                </div>
                <StatusBadge tone={TONE[chip.tone] ?? "moving"}>{chip.label}</StatusBadge>
                <div className="settings-actions">
                  <Link to={browserProfileRoute(profile.profileId)} className="btn btn-sm">Подключить</Link>
                  <span className="settings-menu-gap" aria-hidden="true" />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {draftItems.length > 0 && (
        <div className="card-footer">
          <ServerAdminCommand
            text="Браузер по черновику создаёт администратор на рабочей машине: прокси и окружение вводить не нужно."
            command={draftItems.map((draft) => draft.command)}
          />
        </div>
      )}
      {deleting !== null && <DeleteDraftConfirm name={deleting} onClose={() => setDeleting(null)} />}
    </section>
  );
}
