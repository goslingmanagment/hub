import { toast } from "sonner";
import { kernel } from "@/api/sdk";
import { ruPlural } from "@/lib/plural";

const PAGE = 200;

/** «$0–25», «$600+»: whole dollars of a bucket; its first edge of one cent is «$0». */
export function bucketAmount(bucket: { minAmountMills: number; maxAmountMillsExclusive: number | null }): string {
  const dollars = (mills: number) => Math.floor(mills / 1000).toLocaleString("en-US");
  const from = dollars(bucket.minAmountMills);
  return bucket.maxAmountMillsExclusive === null ? `$${from}+` : `$${from}–${dollars(bucket.maxAmountMillsExclusive)}`;
}

function namesWord(count: number): string {
  return `${count} ${ruPlural(count, "имя", "имени", "имён")}`;
}

/**
 * «Скопировать имена»: every nick of one bucket, one a line, into the clipboard. A
 * read only: one request at a time until the total; a failed one copies nothing.
 */
export async function copyFanNames(input: {
  pageLabel: string;
  bucketKey: string;
  bucketLabel: string;
  period: string;
  query?: string | undefined;
  followersOnly?: boolean | undefined;
}): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    toast.error("Буфер обмена недоступен");
    return;
  }
  const names: string[] = [];
  let withoutNick = 0;
  try {
    let offset = 0;
    for (;;) {
      const answer = await kernel.pageSpenderAutoListDetail({
        params: { pageLabel: input.pageLabel, bucketKey: input.bucketKey } as Parameters<typeof kernel.pageSpenderAutoListDetail>[0]["params"],
        query: {
          limit: PAGE,
          offset,
          period: input.period,
          ...(input.query ? { query: input.query } : {}),
          ...(input.followersOnly ? { excludeNonFollowers: true } : {}),
        } as Parameters<typeof kernel.pageSpenderAutoListDetail>[0]["query"],
      });
      for (const item of answer.items) {
        if (item.fan.username) names.push(item.fan.username);
        else withoutNick += 1;
      }
      offset += answer.items.length;
      if (offset >= answer.total || answer.items.length === 0) break;
    }
  } catch {
    toast.error("Не удалось скопировать: Hub не ответил.");
    return;
  }
  try {
    await navigator.clipboard.writeText(names.join("\n"));
  } catch {
    toast.error("Не удалось скопировать");
    return;
  }
  const where = [input.bucketLabel, input.pageLabel, input.followersOnly ? "только фолловеры" : null, input.query ? `по запросу «${input.query}»` : null]
    .filter(Boolean)
    .join(", ");
  toast.success(`Скопировано ${namesWord(names.length)}: ${where}.${withoutNick > 0 ? ` Без ника ${withoutNick}: они не вошли.` : ""}`);
}
