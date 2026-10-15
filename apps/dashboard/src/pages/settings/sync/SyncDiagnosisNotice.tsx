import type { SyncDiagnosis } from "@agency_hub_core/contracts";
import { Link } from "react-router";
import { buildSettingsRoute } from "@/lib/navigation";
import { getDiagnosisHeadline } from "./syncBlockDisplay.js";

/** What the server diagnosed of a page: the headline in the screen's words,
 *  the server's own detail as a secondary line, and the credentials form when
 *  that is the way out. */
export function SyncDiagnosisNotice({
  diagnosis,
  className = "",
}: {
  diagnosis: SyncDiagnosis;
  className?: string;
}) {
  const tone = diagnosis.severity === "warning" ? "notice-warning" : "notice-danger";

  return (
    <div className={`notice ${tone} ${className}`} data-sync-diagnosis={diagnosis.code}>
      <div className="min-w-0">
        <p className="font-semibold">
          {getDiagnosisHeadline(diagnosis)}
          {diagnosis.actionKind === "credentials" && (
            <Link to={buildSettingsRoute("credentials")} className="link ml-2 font-semibold">
              Обновить данные входа
            </Link>
          )}
        </p>
        <p className="mt-0.5 break-words text-xs opacity-80">{diagnosis.detail}</p>
      </div>
    </div>
  );
}
