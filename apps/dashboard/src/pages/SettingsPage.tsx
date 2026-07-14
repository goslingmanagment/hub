import { useSearchParams } from "react-router";
import { resolveSettingsTab, type SettingsTab } from "@/lib/navigation";
import { CredentialsTab } from "./settings/CredentialsTab.js";
import { SyncTab } from "./settings/SyncTab.js";
import { ModelsTab } from "./settings/ModelsTab.js";
import { PagesTab } from "./settings/PagesTab.js";
import { UsersTab } from "./settings/UsersTab.js";
import { ConfigurationTab } from "./settings/ConfigurationTab.js";
import { AiPersonasTab } from "./settings/AiPersonasTab.js";

const tabs: { key: SettingsTab; label: string }[] = [
  { key: "credentials", label: "Credentials" },
  { key: "sync", label: "Sync" },
  { key: "models", label: "Models" },
  { key: "personas", label: "AI Personas" },
  { key: "pages", label: "Pages" },
  { key: "users", label: "Users" },
  { key: "configuration", label: "Configuration" },
];

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveSettingsTab(searchParams.get("tab"));

  function handleTabChange(tab: SettingsTab) {
    const next = new URLSearchParams(searchParams);
    next.set("tab", tab);
    setSearchParams(next);
  }

  return (
    <div>
      <h1 className="text-xl font-extrabold text-text-primary mb-5">Settings</h1>

      <div className="mb-5 flex items-center gap-1 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => handleTabChange(tab.key)}
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

      {activeTab === "credentials" && <CredentialsTab />}
      {activeTab === "sync" && <SyncTab />}
      {activeTab === "models" && <ModelsTab />}
      {activeTab === "personas" && <AiPersonasTab />}
      {activeTab === "pages" && <PagesTab />}
      {activeTab === "users" && <UsersTab />}
      {activeTab === "configuration" && <ConfigurationTab />}
    </div>
  );
}
