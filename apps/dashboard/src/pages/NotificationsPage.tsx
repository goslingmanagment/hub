import { useSearchParams } from "react-router";
import { NotificationsIncidentsTab } from "./notifications/NotificationsIncidentsTab.js";
import { NotificationsReportsTab } from "./notifications/NotificationsReportsTab.js";
import { NotificationsSettingsTab } from "./notifications/NotificationsSettingsTab.js";

type Tab = "settings" | "incidents" | "reports";

const tabs: { key: Tab; label: string }[] = [
  { key: "settings", label: "Подключение и правила" },
  { key: "incidents", label: "Инциденты" },
  { key: "reports", label: "Отчёты" },
];

export function NotificationsPage() {
  const [search, setSearch] = useSearchParams();
  const activeTab = tabs.find((tab) => tab.key === search.get("tab"))?.key ?? "settings";
  function setActiveTab(tab: Tab) {
    const next = new URLSearchParams(search);
    next.set("tab", tab);
    setSearch(next);
  }

  return (
    <div>
      <h1 className="mb-2 text-xl font-extrabold text-text-primary">Уведомления</h1>
      <p className="mb-5 text-sm text-text-secondary">Доставка в Telegram, операционные инциденты и история отчётов.</p>

      <nav aria-label="Разделы уведомлений" className="mb-5 flex flex-wrap items-center gap-1 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            aria-pressed={activeTab === tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab.key
                ? "border-accent text-accent"
                : "border-transparent text-text-muted hover:text-text-secondary"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === "settings" && <NotificationsSettingsTab />}
      {activeTab === "incidents" && <NotificationsIncidentsTab />}
      {activeTab === "reports" && <NotificationsReportsTab />}
    </div>
  );
}
