import type { SyncBlocksPage } from "@agency_hub_core/contracts";
import { Link } from "react-router";
import { SyncDiagnosisNotice } from "./SyncDiagnosisNotice.js";
import {
  formatBlockSummary,
  getBlockLabel,
  getBlockOrder,
  getReasonSummary,
  isDependencyWait,
  needsVisualAttention,
} from "./syncBlockDisplay.js";

/** What on a page needs the owner: its diagnosis, else the blocks that ask
 *  for attention. Nothing when the page is fine. */
export function SyncPageAttention({ page }: { page: SyncBlocksPage }) {
  if (page.diagnosis) {
    return <SyncDiagnosisNotice diagnosis={page.diagnosis} className="mt-3" />;
  }

  const blocks = getBlockOrder().map((key) => page.blocks[key]);
  const attentionBlocks = blocks.filter(needsVisualAttention).filter((block) => !isDependencyWait(block));
  if (attentionBlocks.length === 0) return null;

  const authFailed = attentionBlocks.find((b) => b.statusReason?.code === "credentials_invalid");
  if (authFailed) {
    return (
      <div className="mt-3 rounded-lg border border-danger/20 bg-danger/[0.04] px-3 py-2.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
          <span className="text-danger font-medium">
            {getReasonSummary(authFailed) ?? "Credentials may have expired"}
          </span>
          <Link
            to="/settings?tab=credentials"
            className="font-semibold text-accent hover:underline"
          >
            Update credentials
          </Link>
        </div>
      </div>
    );
  }

  const failedBlock = attentionBlocks.find((block) => block.state === "failed");
  const tone = failedBlock
    ? {
      container: "mt-3 rounded-lg border border-danger/20 bg-danger/[0.04] px-3 py-2.5",
      text: "text-danger",
    }
    : {
      container: "mt-3 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2.5",
      text: "text-warning-dark",
    };

  return (
    <div className={tone.container}>
      {attentionBlocks.map((b) => (
        <div
          key={b.block}
          className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
        >
          <span className={`${tone.text} font-medium`}>
            {getReasonSummary(b) ??
              (b.state === "delayed"
                ? formatBlockSummary(b)
                : `${getBlockLabel(b.block)} needs attention`)}
          </span>
        </div>
      ))}
    </div>
  );
}
