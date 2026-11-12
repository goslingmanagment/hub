import { ScreenSections } from "@/components/layout/ScreenSections";
import { useRole } from "../shared.js";
import { OfapiActions } from "./OfapiActions.js";
import { OfapiExportsPage } from "./OfapiExportsPage.js";
import { OfapiMediaPage } from "./OfapiMediaPage.js";
import { OfapiSaidAbove } from "./OfapiOffBar.js";
import { CollectionTab } from "./rules/CollectionTab.js";
import { OfapiStateNotice, StatePage } from "./StatePage.js";
import { ToolsPage } from "./ToolsPage.js";

const SECTIONS = {
  state: () => <StatePage />,
  collection: () => <CollectionTab />,
  tools: () => <ToolsPage />,
  media: () => <OfapiMediaPage />,
  exports: () => <OfapiExportsPage />,
  actions: () => <OfapiActions />,
};

/**
 * «OnlyFans API»: one screen of sections (it was six screens, five never opened
 * in 14 days). Each old address opens its section (lib/redirects.ts). The
 * switch is said once above them; a team lead, who does not know it, gets
 * «Медиа» and «Выгрузки» alone.
 */
export function OnlyfansApiScreen() {
  const owner = useRole() === "owner";
  return (
    <OfapiSaidAbove.Provider value={owner}>
      <ScreenSections screenId="system-onlyfans-api" sections={SECTIONS} top={owner ? <OfapiStateNotice /> : undefined} />
    </OfapiSaidAbove.Provider>
  );
}
