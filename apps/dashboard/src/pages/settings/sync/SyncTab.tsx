import { SyncPageList } from "./SyncPageList.js";
import { SyncPageDetail } from "./SyncPageDetail.js";
import { useSelectedSyncPage } from "./useSelectedSyncPage.js";

/** «Синхронизация»: the pages the legacy page-sync executor serves. */
export function SyncTab() {
  const { selectedPage, selectPage, clearPage } = useSelectedSyncPage();

  if (selectedPage) {
    return <SyncPageDetail pageLabel={selectedPage} onBack={clearPage} />;
  }

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-sm font-bold text-text-primary">Sync</h2>
      </div>
      <SyncPageList onSelectPage={selectPage} />
    </div>
  );
}
