import { Link } from "react-router";
import { MonitorSmartphone } from "lucide-react";

import { usePageBrowserProfiles } from "@/api/queries";
import { ToneChip } from "../page-browser/loginParts.js";
import { browserStatusOf, onboardingChipOf } from "../page-browser/pageBrowserOnboardingView.js";

// New pages connected through their own server browser (Project Browser PR
// 16): the profiles `scripts/deploy-page-browser.sh add-profile` made that no
// page has yet, each with where its onboarding stands and a link to it.

export function browserProfileRoute(profileId: string): string {
  return `/browser-profiles/${encodeURIComponent(profileId)}`;
}

export function BrowserProfilesSection() {
  const profiles = usePageBrowserProfiles();
  const items = profiles.data?.profiles ?? [];
  return (
    <section className="mt-6" aria-label="Новые страницы через браузер">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-text-primary">Новые страницы через серверный браузер</h2>
      </div>
      {profiles.isError && <p className="text-sm text-danger">Список браузеров не загрузился.</p>}
      {!profiles.isError && items.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card px-4 py-3 text-sm text-text-muted">
          <p>Браузеров без страницы нет. Чтобы подключить новую страницу через её серверный браузер, создайте профиль на сервере:</p>
          <p className="mt-2 font-mono text-xs text-text-secondary">scripts/deploy-page-browser.sh add-profile &lt;host&gt; --page &lt;название&gt; --image &lt;образ&gt; --socks &lt;host:port&gt; --env &lt;json&gt;</p>
          <p className="mt-2">Он появится здесь — дальше прокси, вход и создание страницы делаются в дашборде.</p>
        </div>
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
