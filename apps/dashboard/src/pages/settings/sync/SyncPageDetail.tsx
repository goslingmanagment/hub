import { usePageSyncBlocks } from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { syncSettingsTab } from "@/lib/navigation";
import { SyncBlockDetailCard } from "./SyncBlockDetailCard.js";
import { SyncDiagnosisNotice } from "./SyncDiagnosisNotice.js";
import { SyncBackButton, SyncPageOnOtherTab, SyncPageTitle } from "./SyncPageParts.js";
import { getBlockOrder } from "./syncBlockDisplay.js";

const BACK = "Back to overview";

/** A page of the legacy page-sync executor in detail: its five blocks. */
export function SyncPageDetail({
  pageLabel,
  onBack,
}: {
  pageLabel: string;
  onBack: () => void;
}) {
  const { data, isLoading, isError, error } = usePageSyncBlocks(pageLabel);

  if (isLoading && !data) {
    return (
      <div>
        <SyncBackButton onBack={onBack} label={BACK} />
        <p className="text-sm text-text-muted">Loading page details...</p>
      </div>
    );
  }

  if (isError && !data) {
    return (
      <div>
        <SyncBackButton onBack={onBack} label={BACK} />
        <StatusPanel
          title="Sync page failed to load"
          description={error instanceof Error ? error.message : "The page sync details could not be fetched."}
          tone="error"
        />
      </div>
    );
  }

  if (!data) {
    return (
      <div>
        <SyncBackButton onBack={onBack} label={BACK} />
        <p className="text-sm text-text-muted">Page not found.</p>
      </div>
    );
  }

  const page = data.page;
  const ownTab = syncSettingsTab(page.platform);
  if (ownTab !== "sync") {
    return (
      <div>
        <SyncBackButton onBack={onBack} label={BACK} />
        <SyncPageOnOtherTab pageLabel={pageLabel} tab={ownTab} />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-5">
        <SyncBackButton onBack={onBack} label={BACK} />
        <SyncPageTitle page={page} />
      </div>
      <div className="space-y-3">
        {isError && data && (
          <StaleDataNotice error={error} />
        )}
        {page.diagnosis && (
          <SyncDiagnosisNotice diagnosis={page.diagnosis} />
        )}
        {getBlockOrder().map((key) => (
          <SyncBlockDetailCard
            key={key}
            block={page.blocks[key]}
            pageLabel={pageLabel}
          />
        ))}
      </div>
    </div>
  );
}
