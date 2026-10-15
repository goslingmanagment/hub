import type { ReactNode } from "react";
import { Link, Outlet, useLocation, useNavigate, useSearchParams } from "react-router";
import { useAuthMe } from "@/api/queries";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { buildSettingsSectionRoute, resolveSettingsTab } from "@/lib/navigation";
import {
  SYSTEM_GROUPS,
  TABBED_SECTIONS,
  currentSideLink,
  visibleTabs,
  type SectionLink,
  type SideNavGroup,
  type TabbedSection,
} from "@/lib/sections";

/** A section of sibling screens under one title and a row of tabs. */
export function TabbedSectionLayout({ id }: { id: TabbedSection["id"] }) {
  const { data } = useAuthMe();
  const section = TABBED_SECTIONS[id];
  const tabs = visibleTabs(section, data?.user.role ?? "team_lead");
  return (
    <div className="min-w-0">
      <PageHeader title={section.title} />
      <SectionTabs label={section.title} items={tabs} />
      <Outlet />
    </div>
  );
}

const SETTINGS_LINK = /^\/settings\?tab=([A-Za-z]+)$/;

/**
 * Settings and System: a title, a grouped side navigation (a select on narrow
 * screens) and the chosen screen. A link to another Settings tab keeps the
 * query the current tab carries — a page selected on one sync tab is still
 * selected on the other.
 */
export function SideNavLayout({
  title,
  groups,
  current,
  navLabel,
  children,
}: {
  title: string;
  groups: readonly SideNavGroup[];
  current: SectionLink | null;
  navLabel: string;
  children?: ReactNode;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  function href(link: SectionLink) {
    const tab = SETTINGS_LINK.exec(link.to)?.[1];
    return tab && location.pathname === "/settings"
      ? buildSettingsSectionRoute(searchParams, resolveSettingsTab(tab))
      : link.to;
  }

  return (
    <div className="min-w-0">
      <PageHeader title={title} />
      <div className="side-nav-layout">
        <nav aria-label={navLabel} className="side-nav">
          {groups.map((group) => (
            <div key={group.id} className="side-nav-group">
              <h2 id={`side-nav-${group.id}`} className="side-nav-label">{group.label}</h2>
              <ul aria-labelledby={`side-nav-${group.id}`} className="space-y-0.5">
                {group.links.map((link) => (
                  <li key={link.to}>
                    <Link to={href(link)} className="side-nav-link" aria-current={link === current ? "page" : undefined}>
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="min-w-0">
          <label className="side-nav-select mb-5">
            <span className="field-label">{navLabel}</span>
            <select
              className="select"
              value={current?.to ?? ""}
              onChange={(event) => {
                const link = groups.flatMap((group) => group.links).find((item) => item.to === event.target.value);
                if (link) navigate(href(link));
              }}
            >
              {groups.map((group) => (
                <optgroup key={group.id} label={group.label}>
                  {group.links.map((link) => <option key={link.to} value={link.to}>{link.label}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          {children ?? <Outlet />}
        </div>
      </div>
    </div>
  );
}

/** The developer screens under /dev, inside System's navigation. */
export function SystemRoutesLayout() {
  const location = useLocation();
  return (
    <SideNavLayout
      title="Система"
      navLabel="Разделы системы"
      groups={SYSTEM_GROUPS}
      current={currentSideLink(SYSTEM_GROUPS, location.pathname, location.search)}
    />
  );
}
