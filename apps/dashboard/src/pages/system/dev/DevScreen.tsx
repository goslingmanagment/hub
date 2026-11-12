import { PeriodControl } from "@/components/layout/PeriodControl";
import { ScreenSections } from "@/components/layout/ScreenSections";
import { ConfigurationTab } from "@/pages/settings/ConfigurationTab";
import { ClientHealthPage } from "./ClientHealthPage.js";
import { DbStatsPage } from "./DbStatsPage.js";
import { LogPage } from "./LogPage.js";
import { QueuePage } from "./QueuePage.js";

const SECTIONS = {
  log: () => <LogPage />,
  queue: () => <QueuePage />,
  database: () => <DbStatsPage />,
  // Its period is the screen's own (`?period=`), drawn here: the other sections have none.
  extension: () => (
    <div className="space-y-4">
      <div className="screen-part-controls"><PeriodControl /></div>
      <ClientHealthPage />
    </div>
  ),
  config: () => <ConfigurationTab />,
};

/**
 * «Разработчик»: one screen of sections (it was six screens, none opened in 14
 * days). Each old address opens its section (lib/redirects.ts); a run of the
 * collection stays a deep page of its own, `/system/dev/log/:runId`. Without
 * an anchor every section is closed: five equals, none read until opened.
 */
export function DevScreen() {
  return <ScreenSections screenId="system-dev" sections={SECTIONS} closed />;
}
