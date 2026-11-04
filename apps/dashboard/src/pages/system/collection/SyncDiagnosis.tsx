import type { SyncDiagnosis } from "@agency_hub_core/contracts";
import { Link } from "react-router";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice } from "@/components/ui/Notice";
import { getDiagnosisHeadline } from "@/pages/settings/sync/syncBlockDisplay";

const HEADLINES: Readonly<Record<string, string>> = {
  auth_blocked: "Доступ через OnlyFans API больше не действует",
};

/** What the server diagnosed of an OnlyFans page, in Russian; its own English under «Подробнее». */
export function SyncDiagnosisHeadline({ diagnosis }: { diagnosis: SyncDiagnosis }) {
  return (
    <Notice
      tone={diagnosis.severity === "warning" ? "warning" : "danger"}
      action={<Link to="/system/onlyfans-api" className="btn btn-sm">Что делать</Link>}
    >
      {HEADLINES[diagnosis.code] ?? getDiagnosisHeadline(diagnosis)}.
      <Disclosure label="Подробнее"><p lang="en">{diagnosis.detail}</p></Disclosure>
    </Notice>
  );
}
