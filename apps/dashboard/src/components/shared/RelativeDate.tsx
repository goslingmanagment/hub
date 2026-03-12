import { relativeTime, formatIso } from "@/lib/date";

export function RelativeDate({ iso }: { iso: string | null | undefined }) {
  return (
    <span className="text-zinc-400" title={formatIso(iso)}>
      {relativeTime(iso)}
    </span>
  );
}
