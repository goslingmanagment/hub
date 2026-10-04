import { Link, useNavigate, useSearchParams } from "react-router";
import { buildSettingsSectionRoute, resolveSettingsTab, type SettingsTab } from "@/lib/navigation";
import { CredentialsTab } from "./settings/CredentialsTab.js";
import { SyncTab } from "./settings/SyncTab.js";
import { EngineTab } from "./settings/engine/EngineTab.js";
import { CollectionTab } from "./settings/CollectionTab.js";
import { ModelsTab } from "./settings/ModelsTab.js";
import { PagesTab } from "./settings/PagesTab.js";
import { TeamTab } from "./settings/team/TeamTab.js";
import { ConfigurationTab } from "./settings/ConfigurationTab.js";
import { AiPersonasTab } from "./settings/AiPersonasTab.js";
import { TechnicalTab } from "./settings/team/TechnicalTab.js";
import { FeaturesTab } from "./settings/FeaturesTab.js";

const sections: Record<SettingsTab, { label: string; description: string }> = {
  features: {
    label: "Возможности",
    description: "",
  },
  configuration: {
    label: "Работа Hub",
    description: "Настройте обновление данных, работу AI и другие возможности Hub.",
  },
  engine: {
    label: "Синк",
    description: "Посмотрите, как Fansly Sync Engine читает каждую страницу Fansly: темп, очередь, удержания и заявки на историю.",
  },
  sync: {
    label: "Синхронизация",
    description: "Посмотрите, какие данные OnlyFans обновляются и нужна ли помощь какой-то странице.",
  },
  collection: {
    label: "Сбор OnlyFans",
    description: "Выберите, что и как часто загружать с OnlyFans.",
  },
  models: {
    label: "Модели",
    description: "Добавляйте моделей и объединяйте их страницы в одном месте.",
  },
  pages: {
    label: "Страницы",
    description: "Подключайте страницы Fansly и OnlyFans и проверяйте их связь с Hub.",
  },
  personas: {
    label: "AI-персоны",
    description: "Посмотрите, какие образы и стили общения доступны для AI.",
  },
  credentials: {
    label: "Подключения",
    description: "Проверяйте подключения к площадкам и обновляйте данные доступа.",
  },
  users: {
    label: "Команда",
    description: "Приглашайте людей ссылкой, смотрите их устройства и выбирайте, с какими страницами они работают.",
  },
  agentKeys: {
    label: "Техническое",
    description: "Ключи агентов и привязка сбора данных к устройству — всё, что нужно только машинам.",
  },
};

const navigationGroups: { id: string; label: string; tabs: SettingsTab[] }[] = [
  { id: "system", label: "Система", tabs: ["features", "configuration", "engine", "sync", "collection"] },
  { id: "accounts", label: "Аккаунты и AI", tabs: ["models", "pages", "personas"] },
  { id: "access", label: "Доступ", tabs: ["credentials", "users", "agentKeys"] },
];

export function SettingsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const activeTab = resolveSettingsTab(searchParams.get("tab"));
  const activeSection = sections[activeTab];

  function sectionHref(tab: SettingsTab) {
    return buildSettingsSectionRoute(searchParams, tab);
  }

  return (
    <div className="settings-screen min-w-0 p-4 md:p-0">
      <h1 className="mb-5 text-2xl lg:mb-7 font-semibold tracking-tight text-text-primary">Настройки</h1>

      <div className="grid min-w-0 gap-5 lg:grid-cols-[168px_minmax(0,1fr)] lg:gap-8">
        <nav
          aria-label="Разделы настроек"
          className="hidden space-y-5 self-start lg:sticky lg:top-20 lg:block"
        >
          {navigationGroups.map((group) => (
            <div key={group.id}>
              <h2 id={`settings-group-${group.id}`} className="mb-1.5 px-3 text-xs font-semibold text-text-secondary">
                {group.label}
              </h2>
              <ul aria-labelledby={`settings-group-${group.id}`} className="space-y-0.5">
                {group.tabs.map((tab) => (
                  <li key={tab}>
                    <Link
                      to={sectionHref(tab)}
                      aria-current={activeTab === tab ? "page" : undefined}
                      className={`flex min-h-9 items-center rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                        activeTab === tab
                          ? "bg-accent/10 text-accent"
                          : "text-text-secondary hover:bg-hover hover:text-text-primary"
                      }`}
                    >
                      {sections[tab].label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="settings-content min-w-0">
          <label className="mb-4 block lg:hidden">
            <span className="mb-1.5 block text-sm font-medium text-text-secondary">Раздел настроек</span>
            <select
              value={activeTab}
              onChange={(event) => navigate(sectionHref(resolveSettingsTab(event.target.value)))}
              className="min-h-11 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {navigationGroups.map((group) => (
                <optgroup key={group.id} label={group.label}>
                  {group.tabs.map((tab) => <option key={tab} value={tab}>{sections[tab].label}</option>)}
                </optgroup>
              ))}
            </select>
          </label>

          <section aria-labelledby="settings-section-title" className="min-w-0">
            <div className={activeTab === "features" ? "sr-only" : "mb-5"}>
              <h2 id="settings-section-title" className="hidden text-xl font-semibold tracking-tight text-text-primary lg:block">
                {activeSection.label}
              </h2>
              <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-text-secondary">
                {activeSection.description}
              </p>
            </div>
            {activeTab === "credentials" && <CredentialsTab />}
            {activeTab === "engine" && <EngineTab />}
            {activeTab === "sync" && <SyncTab />}
            {activeTab === "collection" && <CollectionTab />}
            {activeTab === "models" && <ModelsTab />}
            {activeTab === "personas" && <AiPersonasTab />}
            {activeTab === "pages" && <PagesTab />}
            {activeTab === "users" && <TeamTab />}
            {activeTab === "agentKeys" && <TechnicalTab />}
            {activeTab === "configuration" && <ConfigurationTab />}
            {activeTab === "features" && <FeaturesTab />}
          </section>
        </div>
      </div>
    </div>
  );
}
