import type { SyncBlocksPage } from "@agency_hub_core/contracts";
import { Link } from "react-router";
import { buildSettingsRoute } from "@/lib/navigation";
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
    return <SyncDiagnosisNotice diagnosis={page.diagnosis} />;
  }

  const blocks = getBlockOrder().map((key) => page.blocks[key]);
  const attentionBlocks = blocks.filter(needsVisualAttention).filter((block) => !isDependencyWait(block));
  if (attentionBlocks.length === 0) return null;

  const authFailed = attentionBlocks.find((b) => b.statusReason?.code === "credentials_invalid");
  if (authFailed) {
    return (
      <div className="notice notice-danger" data-sync-attention="credentials">
        <p>
          <span className="font-semibold">{getReasonSummary(authFailed) ?? "Данные входа, похоже, устарели"}</span>
          <Link to={buildSettingsRoute("credentials")} className="link ml-2 font-semibold">
            Обновить данные входа
          </Link>
        </p>
      </div>
    );
  }

  const failed = attentionBlocks.some((block) => block.state === "failed");

  return (
    <div className={`notice ${failed ? "notice-danger" : "notice-warning"}`} data-sync-attention="blocks">
      <ul className="min-w-0 space-y-0.5">
        {attentionBlocks.map((b) => (
          <li key={b.block} className="break-words">
            <span className="font-semibold">{getBlockLabel(b.block)}:</span>{" "}
            {b.state === "delayed" ? formatBlockSummary(b) : getReasonSummary(b) ?? "Нужна проверка"}
          </li>
        ))}
      </ul>
    </div>
  );
}
