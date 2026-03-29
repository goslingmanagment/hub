import { useSearchParams } from "react-router";
import { SyncPageList } from "./SyncPageList.js";
import { SyncPageDetail } from "./SyncPageDetail.js";

export function SyncTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedPage = searchParams.get("page");

  function handleSelectPage(pageLabel: string) {
    const next = new URLSearchParams(searchParams);
    next.set("page", pageLabel);
    setSearchParams(next);
  }

  function handleBack() {
    const next = new URLSearchParams(searchParams);
    next.delete("page");
    setSearchParams(next);
  }

  if (selectedPage) {
    return <SyncPageDetail pageLabel={selectedPage} onBack={handleBack} />;
  }

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-sm font-bold text-text-primary">Sync</h2>
      </div>
      <SyncPageList onSelectPage={handleSelectPage} />
    </div>
  );
}
