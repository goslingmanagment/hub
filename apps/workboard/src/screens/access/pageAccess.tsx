import { useState, type ReactNode } from "react";
import { Confirm, toast } from "@agency_hub_core/ui";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { useAssignPage, useUnassignPage, type AdminPage } from "./data";

/**
 * Opening and removing a person's pages, the same in the matrix and in a
 * person's panel. Each page is the console's own request (`adminAssignPage`,
 * `adminUnassignPage`, PersonPage.tsx:319-340) with its toasts. Opening one page
 * goes at once, as the console's «Назначить» did. Removing always asks first
 * (spec §6: «Снять» had no question), and so does a whole model: several
 * pages, one request each, in order, stopping at the first refusal — never
 * repeated by itself.
 */

interface Person {
  id: number;
  username: string;
}

interface Change {
  person: Person;
  add: AdminPage[];
  remove: AdminPage[];
  /** «Mia Hart»: the change is a whole model. */
  model?: string;
}

const PLATFORM: Readonly<Record<string, string>> = { fansly: "Fansly", onlyfans: "OnlyFans", telegram: "Telegram" };

function labels(pages: readonly AdminPage[]): string {
  return pages.map((page) => page.label).join(", ");
}

function pagesWord(count: number): string {
  return `${count} ${ruPlural(count, "страницу", "страницы", "страниц")}`;
}

export interface PageAccess {
  /** One page of one person: open at once, or ask before removing. */
  toggle: (person: Person, page: AdminPage, has: boolean) => void;
  /** A whole model: open the missing pages, or remove them all when every one is open. Always asks. */
  toggleModel: (person: Person, model: { modelName: string; pages: readonly AdminPage[] }, assigned: ReadonlySet<string>) => void;
  /** A request of this person and page is on its way. */
  busy: (personId: number, pageLabel: string) => boolean;
  /** The question, when one is open: render it once. */
  dialog: ReactNode;
}

export function usePageAccess(onChanged?: () => void): PageAccess {
  const assign = useAssignPage();
  const unassign = useUnassignPage();
  const [asking, setAsking] = useState<Change | null>(null);
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const key = (personId: number, pageLabel: string) => `${personId}\u0000${pageLabel}`;

  /** The change, one request after another; the first refusal stops the rest. Returns what was not done. */
  async function run(change: Change): Promise<string | null> {
    const steps = [
      ...change.add.map((page) => ({ page, add: true })),
      ...change.remove.map((page) => ({ page, add: false })),
    ];
    setRunning(new Set(steps.map((step) => key(change.person.id, step.page.label))));
    let done = 0;
    try {
      for (const step of steps) {
        try {
          if (step.add) await assign.mutateAsync({ userId: change.person.id, pageLabel: step.page.label });
          else await unassign.mutateAsync({ userId: change.person.id, pageLabel: step.page.label });
          done += 1;
        } catch {
          const failed = step.add ? "Не удалось назначить страницу: Hub вернул ошибку." : "Не удалось снять страницу: Hub вернул ошибку.";
          return steps.length === 1 ? failed : `${step.add ? "Открыто" : "Снято"} ${done} из ${steps.length}. ${step.page.label}: ${failed.charAt(0).toLowerCase()}${failed.slice(1)} Остальные не трогали.`;
        }
      }
      return null;
    } finally {
      setRunning(new Set());
      if (done > 0) onChanged?.();
    }
  }

  function said(change: Change) {
    const one = change.add[0] ?? change.remove[0];
    if (change.add.length + change.remove.length === 1 && one) {
      toast.success(change.add.length === 1 ? `Страница ${one.label} назначена ${change.person.username}` : `Страница ${one.label} снята с ${change.person.username}`);
    } else {
      toast.success(change.add.length > 0
        ? `${change.person.username}: открыто ${pagesWord(change.add.length)} ${change.model ?? ""}`.trim()
        : `${change.person.username}: снято ${pagesWord(change.remove.length)} ${change.model ?? ""}`.trim());
    }
  }

  const toggle: PageAccess["toggle"] = (person, page, has) => {
    if (running.size > 0 || pending) return;
    if (has) {
      setProblem(null);
      setAsking({ person, add: [], remove: [page] });
      return;
    }
    const change = { person, add: [page], remove: [] };
    void run(change).then((failed) => {
      if (failed === null) said(change);
      else toast.error(failed);
    });
  };

  const toggleModel: PageAccess["toggleModel"] = (person, model, assigned) => {
    if (running.size > 0 || pending) return;
    const all = model.pages.every((page) => assigned.has(page.label));
    setProblem(null);
    setAsking(all
      ? { person, add: [], remove: [...model.pages], model: model.modelName }
      : { person, add: model.pages.filter((page) => !assigned.has(page.label)), remove: [], model: model.modelName });
  };

  const close = () => {
    if (pending) return;
    setAsking(null);
    setProblem(null);
  };

  let dialog: ReactNode = null;
  if (asking) {
    const removing = asking.remove.length > 0;
    const pages = removing ? asking.remove : asking.add;
    const single = pages.length === 1 && !asking.model ? pages[0]! : null;
    const name = asking.person.username;
    dialog = (
      <Confirm
        title={single
          ? `Снять страницу ${single.label} с ${name}?`
          : removing ? `Снять с ${name} всю модель ${asking.model}?` : `Открыть ${name} всю модель ${asking.model}?`}
        message={removing
          ? `${name} перестанет работать ${single ? "с этой страницей" : "с этими страницами"}: ${single ? "она пропадёт" : "они пропадут"} из расширения. История работы сохранится; открыть снова можно здесь же.`
          : `${name} получит доступ к чатам и фанам ${pages.length === 1 ? "этой страницы" : "этих страниц"} в расширении.`}
        facts={[
          { label: "Кому", value: name },
          single
            ? { label: "Страница", value: `${single.label} · ${PLATFORM[single.platform] ?? single.platform} · ${single.modelName}` }
            : { label: removing ? "Снимаем" : "Открываем", value: `${labels(pages)} (${pagesWord(pages.length)})` },
          ...(single ? [] : [{ label: "Как", value: "Каждая страница — отдельным запросом, по очереди; на первой ошибке остановимся." }]),
        ]}
        confirmLabel={single ? "Снять страницу" : removing ? `Снять ${pagesWord(pages.length)}` : `Открыть ${pagesWord(pages.length)}`}
        pendingLabel={removing ? "Снимаем…" : "Открываем…"}
        tone={removing ? "danger" : "primary"}
        error={problem ?? undefined}
        isPending={pending}
        onConfirm={() => {
          if (pending) return;
          setPending(true);
          const change = asking;
          void run(change).then((failed) => {
            setPending(false);
            if (failed === null) {
              said(change);
              setAsking(null);
            } else {
              setProblem(failed);
            }
          });
        }}
        onClose={close}
      />
    );
  }

  return {
    toggle,
    toggleModel,
    busy: (personId, pageLabel) => running.has(key(personId, pageLabel)),
    dialog,
  };
}
