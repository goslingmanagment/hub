import { useSelectedSyncPage } from "../sync/useSelectedSyncPage.js";
import { EnginePageDetail } from "./EnginePageDetail.js";
import { EnginePageList } from "./EnginePageList.js";

/** «Синк»: the Fansly pages as the Fansly Sync Engine reads them (plan §10) —
 *  the pause, requests per hour by class, the queue, holds and history
 *  requests with their progress. */
export function EngineTab() {
  const { selectedPage, selectPage, clearPage } = useSelectedSyncPage();
  if (selectedPage) {
    return <EnginePageDetail pageLabel={selectedPage} onBack={clearPage} />;
  }
  return <EnginePageList onSelectPage={selectPage} />;
}
