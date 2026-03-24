import { NavLink, useLocation, Link } from "react-router";
import { BarChart3, Bell, Settings, Users, Heart, Trophy, MessageSquare, Terminal, ListTodo, Database, AlertTriangle, Code2, ChevronDown } from "lucide-react";
import { useState } from "react";
import { useOverview, useAdminConnections } from "@/api/queries";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { isAlertState } from "@/components/shared/syncUxDisplay";

interface SidebarProps {
  user: { username: string; role: string };
}

const devLinks = [
  { to: "/dev/log", label: "Log", icon: Terminal },
  { to: "/dev/queue", label: "Queue", icon: ListTodo },
  { to: "/dev/db-stats", label: "DB Stats", icon: Database },
  { to: "/dev/incidents", label: "Incidents", icon: AlertTriangle },
] as const;

export function Sidebar({ user }: SidebarProps) {
  const { data } = useOverview();
  const location = useLocation();
  const [devOpen, setDevOpen] = useState(() => location.pathname.startsWith("/dev"));
  const { data: connections } = useAdminConnections({ enabled: user.role === "owner" });
  const hasSyncWarning = user.role === "owner" && (connections?.some((c) => isAlertState(c.syncUx)) ?? false);

  type PageItem = NonNullable<typeof data>["pages"][number];
  const modelPages = new Map<string, { modelName: string; pages: PageItem[] }>();
  if (data) {
    for (const page of data.pages) {
      const existing = modelPages.get(page.modelSlug);
      if (existing) {
        existing.pages.push(page);
      } else {
        modelPages.set(page.modelSlug, { modelName: page.modelName, pages: [page] });
      }
    }
  }

  function isPageActive(pageLabel: string) {
    return location.pathname.startsWith(`/pages/${pageLabel}`);
  }

  return (
    <nav className="w-[248px] bg-card border-r border-border flex flex-col fixed top-0 bottom-0 z-20">
      <Link to="/" className="block px-[22px] py-[22px] text-[17px] font-bold text-text-primary border-b border-border tracking-[-0.03em]">
        <span className="text-accent">Agency</span>Hub
      </Link>

      <div className="flex-1 p-3 overflow-y-auto">
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            `flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              isActive ? "bg-hover text-text-primary font-semibold" : "text-text-secondary hover:bg-hover hover:text-text-primary"
            }`
          }
        >
          <BarChart3 size={16} />
          Overview
        </NavLink>

        {modelPages.size > 0 && (
          <div className="mt-4 px-3.5 pb-2 text-[11px] font-semibold text-text-muted uppercase tracking-[0.1em]">
            Models
          </div>
        )}

        {[...modelPages.entries()].map(([slug, { modelName, pages }]) => (
          <div key={slug}>
            <div className="px-3.5 py-2 text-[13px] text-text-secondary flex items-center gap-2 mt-1 font-semibold">
              <span className="text-accent">{modelName}</span>
              <span className="text-[12px] text-text-muted font-normal">{pages.length} {pages.length === 1 ? "page" : "pages"}</span>
            </div>
            {pages.map((page) => {
              const active = isPageActive(page.label);
              return (
                <div key={page.id}>
                  <NavLink
                    to={`/pages/${page.label}`}
                    className={`px-3.5 py-2 pl-9 text-[13px] rounded-md transition-colors flex items-center gap-2 font-[450] ${
                      active ? "bg-active-bg text-text-primary font-semibold" : "text-text-secondary hover:bg-hover hover:text-text-primary"
                    }`}
                  >
                    {page.label}
                    <PlatformBadge platform={page.platform} />
                  </NavLink>
                  {active && (
                    <div className="ml-9 mt-0.5">
                      <NavLink
                        to={`/pages/${page.label}/subscribers`}
                        className={({ isActive }) =>
                          `flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-md transition-colors ${
                            isActive ? "text-text-primary font-semibold" : "text-text-muted hover:text-text-secondary"
                          }`
                        }
                      >
                        <Users size={12} /> Subscribers
                      </NavLink>
                      {page.platform === "fansly" && (
                        <NavLink
                          to={`/pages/${page.label}/followers`}
                          className={({ isActive }) =>
                            `flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-md transition-colors ${
                              isActive ? "text-text-primary font-semibold" : "text-text-muted hover:text-text-secondary"
                            }`
                          }
                        >
                          <Heart size={12} /> Followers
                        </NavLink>
                      )}
                      <NavLink
                        to={`/pages/${page.label}/top-supporters`}
                        className={({ isActive }) =>
                          `flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-md transition-colors ${
                            isActive ? "text-text-primary font-semibold" : "text-text-muted hover:text-text-secondary"
                          }`
                        }
                      >
                        <Trophy size={12} /> Top Supporters
                      </NavLink>
                      {page.platform === "fansly" && (
                        <NavLink
                          to={`/pages/${page.label}/crm`}
                          className={({ isActive }) =>
                            `flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-md transition-colors ${
                              isActive ? "text-text-primary font-semibold" : "text-text-muted hover:text-text-secondary"
                            }`
                          }
                        >
                          <MessageSquare size={12} /> CRM
                        </NavLink>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {user.role === "owner" && (
        <div className="p-3 border-t border-border space-y-0.5">
          <button
            type="button"
            onClick={() => setDevOpen((o) => !o)}
            className={`flex w-full items-center gap-2.5 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              location.pathname.startsWith("/dev")
                ? "bg-hover text-text-primary font-semibold"
                : "text-text-secondary hover:bg-hover hover:text-text-primary"
            }`}
          >
            <Code2 size={16} />
            Dev
            <ChevronDown
              size={14}
              className={`ml-auto text-text-muted transition-transform ${devOpen ? "rotate-180" : ""}`}
            />
          </button>
          {devOpen && (
            <div className="ml-4 space-y-0.5">
              {devLinks.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    `flex items-center gap-2 px-3 py-1.5 text-[13px] rounded-md transition-colors ${
                      isActive ? "text-text-primary font-semibold" : "text-text-muted hover:text-text-secondary"
                    }`
                  }
                >
                  <Icon size={13} />
                  {label}
                </NavLink>
              ))}
            </div>
          )}
          <NavLink
            to="/notifications"
            className={({ isActive }) =>
              `flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive ? "bg-hover text-text-primary font-semibold" : "text-text-secondary hover:bg-hover hover:text-text-primary"
              }`
            }
          >
            <Bell size={16} />
            Notifications
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive ? "bg-hover text-text-primary font-semibold" : "text-text-secondary hover:bg-hover hover:text-text-primary"
              }`
            }
          >
            <div className="relative">
              <Settings size={16} />
              {hasSyncWarning && (
                <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-warning-dark" />
              )}
            </div>
            Settings
          </NavLink>
        </div>
      )}
    </nav>
  );
}
