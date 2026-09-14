import { useSearchParams } from "react-router";
import { NotificationsIncidentsTab } from "./notifications/NotificationsIncidentsTab.js";
import { NotificationsReportsTab } from "./notifications/NotificationsReportsTab.js";
import { NotificationsSettingsTab } from "./notifications/NotificationsSettingsTab.js";

type Tab = "settings" | "incidents" | "reports";

const tabs: { key: Tab; label: string }[] = [
  { key: "settings", label: "Settings" },
  { key: "incidents", label: "Incidents" },
  { key: "reports", label: "Reports" },
];

export function NotificationsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const activeTab = tabs.find((tab) => tab.key === requestedTab)?.key ?? "settings";

  return (
    <div>
      <h1 className="mb-5 text-xl font-extrabold text-text-primary">Notifications</h1>

      <div className="mb-5 flex items-center gap-1 border-b border-border">
        {tabs.map((tab) => (
          <button
            type="button"
            key={tab.key}
            aria-current={activeTab === tab.key ? "page" : undefined}
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.set("tab", tab.key);
              setSearchParams(next);
            }}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab.key
                ? "border-accent text-accent"
                : "border-transparent text-text-muted hover:text-text-secondary"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "settings" && <NotificationsSettingsTab />}
      {activeTab === "incidents" && <NotificationsIncidentsTab />}
      {activeTab === "reports" && <NotificationsReportsTab />}
    </div>
  );
}
