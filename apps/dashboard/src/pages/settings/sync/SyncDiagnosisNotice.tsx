import type { SyncDiagnosis } from "@agency_hub_core/contracts";
import { Link } from "react-router";

function noticeTone(severity: SyncDiagnosis["severity"]) {
  if (severity === "warning") {
    return {
      container: "border-warning/25 bg-warning/10",
      title: "text-warning-dark",
    };
  }

  return {
    container: "border-danger/20 bg-danger/[0.04]",
    title: "text-danger",
  };
}

export function SyncDiagnosisNotice({
  diagnosis,
  className = "",
}: {
  diagnosis: SyncDiagnosis;
  className?: string;
}) {
  const tone = noticeTone(diagnosis.severity);
  const classes = [
    "rounded-lg border px-3 py-2.5",
    tone.container,
    className,
  ].filter(Boolean).join(" ");

  return (
    <div className={classes}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
        <span className={`font-medium ${tone.title}`}>
          {diagnosis.headline}
        </span>
        <span className="text-text-secondary">{diagnosis.detail}</span>
        {diagnosis.actionKind === "credentials" && (
          <Link
            to="/settings?tab=credentials"
            className="font-semibold text-accent hover:underline"
          >
            Update credentials
          </Link>
        )}
      </div>
    </div>
  );
}
