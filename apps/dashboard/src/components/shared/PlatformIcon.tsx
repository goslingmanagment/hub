import { PLATFORM_LABELS } from "@/lib/constants";

export function PlatformIcon({ platform }: { platform: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-zinc-400">
      <span
        className={
          platform === "fansly"
            ? "h-2 w-2 rounded-full bg-cyan-400"
            : "h-2 w-2 rounded-full bg-blue-400"
        }
      />
      {PLATFORM_LABELS[platform] ?? platform}
    </span>
  );
}
