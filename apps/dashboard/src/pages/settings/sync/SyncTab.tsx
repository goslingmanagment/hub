import { SyncPageList } from "./SyncPageList.js";
import { SyncPageDetail } from "./SyncPageDetail.js";
import { useSelectedSyncPage } from "./useSelectedSyncPage.js";

/** System → «OnlyFans»: the pages the legacy page-sync executor serves. The
 *  screen's heading is the System section's own (SettingsPage). */
export function SyncTab() {
  const { selectedPage, selectPage, clearPage } = useSelectedSyncPage();

  if (selectedPage) {
    return <SyncPageDetail pageLabel={selectedPage} onBack={clearPage} />;
  }

  return <SyncPageList onSelectPage={selectPage} />;
}
