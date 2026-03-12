import { Link, useLocation } from "react-router";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";
import { usePreferencesStore } from "@/stores/preferences";
import {
  LayoutDashboard,
  FileText,
  Users as UsersIcon,
  DollarSign,
  Heart,
  TrendingUp,
  KeyRound,
  RefreshCw,
  Shield,
  Terminal,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";

const NAV_GROUPS = [
  {
    label: "Data",
    items: [
      { to: "/overview", label: "Overview", icon: LayoutDashboard },
      { to: "/pages", label: "Pages", icon: FileText },
      { to: "/models", label: "Models", icon: UsersIcon },
      { to: "/transactions", label: "Transactions", icon: DollarSign },
    ],
  },
  {
    label: "People",
    items: [
      { to: "/fans", label: "Fans", icon: Heart },
      { to: "/spenders", label: "Spenders", icon: TrendingUp },
    ],
  },
  {
    label: "Admin",
    ownerOnly: true,
    items: [
      { to: "/users", label: "Users", icon: Shield },
      { to: "/settings/credentials", label: "Credentials", icon: KeyRound },
      { to: "/settings/sync", label: "Sync", icon: RefreshCw },
    ],
  },
  {
    label: "Tools",
    items: [{ to: "/api-runner", label: "API Runner", icon: Terminal }],
  },
];

export function Sidebar() {
  const location = useLocation();
  const isOwner = useAuthStore((s) => s.isOwner);
  const collapsed = usePreferencesStore((s) => s.sidebarCollapsed);
  const setCollapsed = usePreferencesStore((s) => s.setSidebarCollapsed);

  return (
    <aside
      className={cn(
        "flex h-screen flex-col border-r border-zinc-800 bg-zinc-950 transition-all",
        collapsed ? "w-14" : "w-52",
      )}
    >
      <div className="flex h-12 items-center justify-between border-b border-zinc-800 px-3">
        {!collapsed && (
          <span className="text-sm font-semibold text-zinc-100">Agency Hub</span>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto py-2">
        {NAV_GROUPS.map((group) => {
          if (group.ownerOnly && !isOwner) return null;
          return (
            <div key={group.label} className="mb-3">
              {!collapsed && (
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
                  {group.label}
                </div>
              )}
              {group.items.map((item) => {
                const active = location.pathname === item.to ||
                  location.pathname.startsWith(item.to + "/");
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={cn(
                      "flex items-center gap-2 px-3 py-1.5 text-sm transition-colors",
                      active
                        ? "bg-zinc-800 text-zinc-100"
                        : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200",
                      collapsed && "justify-center",
                    )}
                    title={collapsed ? item.label : undefined}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    {!collapsed && item.label}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
