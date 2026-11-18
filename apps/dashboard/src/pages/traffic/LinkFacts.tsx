import { Fragment, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { useOfLinkSource, useSetOfLinkSource } from "@/api/ofLinkFans";
import { KernelApiError } from "@/api/sdk";
import { sourcePath, type LinkHead } from "./linkView.js";

type LinkKey = { pageId: number; linkKind: "tracking" | "trial"; linkRef: string };

/** Why the first source was not given, in the console's words. */
function refusal(error: unknown): string {
  const status = error instanceof KernelApiError ? error.status : null;
  if (status === 409) return "У ссылки уже есть источник: менять его — через CLI";
  if (status === 400 || status === 404) return "Такого источника нет: обновите страницу";
  if (status === null || status >= 500) return "Hub не ответил: неизвестно, сохранилось ли.";
  return "Не получилось. Hub вернул ошибку.";
}

/**
 * The link's line of facts: its kind and page, its source, when it was made and
 * its state. The source opens its page; a link without one gets a quiet
 * «Назначить источник» — the sources by title, the proposed one chosen.
 */
export function LinkFacts({ head, link }: { head: LinkHead; link: LinkKey }) {
  const unbound = head.source.kind === "none";
  const source = useOfLinkSource(link, { enabled: unbound });
  const write = useSetOfLinkSource();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);

  const choices = source.data?.channels ?? [];
  const value = chosen ?? source.data?.proposedChannel?.channelKey ?? "";
  const canAssign = unbound && source.data !== undefined && !source.data.bound && choices.length > 0;

  const parts: Array<{ key: string; node: ReactNode }> = [
    ...head.before.map((fact) => ({ key: `b:${fact}`, node: fact })),
    {
      key: "source",
      node: head.source.kind === "bound"
        ? <>источник <Link className="tl-source-link" to={sourcePath(head.source.channelKey)}>{head.source.title}</Link>{head.source.contractor ? `, ${head.source.contractor}` : ""}</>
        : <span className="tl-unbound">без источника</span>,
    },
    ...head.after.map((fact) => ({ key: `a:${fact}`, node: fact })),
  ];

  return (
    <span className="tl-facts">
      {parts.map((part, index) => (
        <Fragment key={part.key}>{index > 0 && ", "}{part.node}</Fragment>
      ))}
      {canAssign && !open && (
        <span className="tl-assign-line">
          <button type="button" className="tl-assign" onClick={() => setOpen(true)}>Назначить источник</button>
        </span>
      )}
      {canAssign && open && (
        <span className="tl-assign-line tl-assign-form">
          <select
            className="select tl-assign-select"
            aria-label="Источник"
            value={value}
            onChange={(event) => setChosen(event.target.value)}
            disabled={write.isPending}
          >
            {value === "" && <option value="" disabled>Выберите источник</option>}
            {choices.map((choice) => (
              <option key={choice.channelKey} value={choice.channelKey}>{choice.channelTitle}</option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={value === "" || write.isPending}
            onClick={() => write.mutate({ ...link, channelKey: value }, {
              onSuccess: () => setOpen(false),
              onError: (error) => toast.error(refusal(error)),
            })}
          >
            {write.isPending ? "Назначаем…" : "Назначить"}
          </button>
          <button type="button" className="btn btn-sm btn-ghost" disabled={write.isPending} onClick={() => setOpen(false)}>Отмена</button>
        </span>
      )}
    </span>
  );
}
