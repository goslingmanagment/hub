import { useState } from "react";
import { CredentialsTab } from "./settings/CredentialsTab";
import { SyncTab } from "./settings/SyncTab";
import { ModelsTab } from "./settings/ModelsTab";
import { PagesTab } from "./settings/PagesTab";
import { UsersTab } from "./settings/UsersTab";

type Tab = "credentials" | "sync" | "models" | "pages" | "users";

const tabs: { key: Tab; label: string }[] = [
  { key: "credentials", label: "Credentials" },
  { key: "sync", label: "Sync" },
  { key: "models", label: "Models" },
  { key: "pages", label: "Pages" },
  { key: "users", label: "Users" },
];

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>("credentials");

  return (
    <div>
      <h1 className="text-xl font-extrabold text-text-primary mb-5">Settings</h1>

      <div className="mb-5 flex items-center gap-1 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.key}
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
      </div>

      {activeTab === "credentials" && <CredentialsTab />}
      {activeTab === "sync" && <SyncTab />}
      {activeTab === "models" && <ModelsTab />}
      {activeTab === "pages" && <PagesTab />}
      {activeTab === "users" && <UsersTab />}
    </div>
  );
}
