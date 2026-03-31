import { resolveTouchpointBadgeClass } from "@/pages/workboard/theme";

interface TouchpointBadgeProps {
  touchpointCode: string;
  touchpointLabel: string;
}

export function TouchpointBadge({ touchpointCode, touchpointLabel }: TouchpointBadgeProps) {
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-bold ${resolveTouchpointBadgeClass(touchpointCode)}`}>
      {touchpointLabel}
    </span>
  );
}

