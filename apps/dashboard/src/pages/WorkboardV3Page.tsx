import { useState } from "react";
import { useParams } from "react-router";
import type {
  WorkboardV3BoardResponse,
  WorkboardV3Row,
  WorkboardV3Tab,
} from "@agency_hub_core/contracts";

import { useWorkboardV3Board } from "@/api/queries";

// Workboard v3 — Phase 1: read-only board (plan preview). UI copy per the PRD
// §7; all actions are disabled until Phase 2 (shifts, Готово, refill).

type TabKey = "subs" | "spenders" | "fresh" | "mass" | "service";

const SECTION_META: Record<
  string,
  { title: string; rail: string; header: string }
> = {
  // The theme has no violet token — ◆ maps to accent, ● to the fansly blue.
  purchase: { title: "◆ Покупка", rail: "bg-accent", header: "text-accent" },
  needs_reply: { title: "● Ждёт ответа", rail: "bg-fansly", header: "text-fansly" },
  risk: { title: "⚠ Риск", rail: "bg-warning", header: "text-warning-dark" },
  scheduled: { title: "○ Плановое", rail: "bg-border", header: "text-text-secondary" },
};

const PROACTIVE_TITLES: Record<Exclude<TabKey, "service">, string> = {
  subs: "Ретеншн",
  spenders: "Реактивация",
  fresh: "Прогрев",
  mass: "Ротация",
};

const CHIP_TONES: Record<string, string> = {
  neutral: "bg-hover text-text-secondary border-border",
  accent: "bg-accent/10 text-accent border-accent/40",
  warning: "bg-warning/10 text-warning-dark border-warning/40",
  danger: "bg-danger/10 text-danger border-danger/40",
  success: "bg-green/10 text-green border-green/40",
};

function formatLtv(mills: number): string {
  return `$${Math.round(mills / 1000).toLocaleString("en-US")}`;
}

function formatClock(iso: string | null): string {
  if (!iso) {
    return "—";
  }
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function RowChips({ row }: { row: WorkboardV3Row }) {
  if (row.chips.length === 0) {
    return null;
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      {row.chips.map((chip) => (
        <span
          key={chip.key}
          className={`rounded-full border px-1.5 py-0.5 text-[11px] leading-none ${CHIP_TONES[chip.tone] ?? CHIP_TONES.neutral} ${chip.dashed ? "border-dashed" : ""}`}
          title={chip.dashed ? "История переписки неполная — сигнал приблизительный" : undefined}
        >
          {chip.label}
        </span>
      ))}
    </span>
  );
}

function BoardRow({ row }: { row: WorkboardV3Row }) {
  const isRenewOff = row.reason.id === "renew_off" || row.reason.id === "renew_off_expiring";
  const rail = isRenewOff ? "bg-danger" : SECTION_META[row.reason.section]!.rail;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border-light bg-card px-3 py-2">
      <span className={`h-8 w-[3px] shrink-0 rounded ${rail}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-text-primary">{row.name}</span>
          {row.alias ? <span className="truncate text-xs text-text-muted">({row.alias})</span> : null}
          <RowChips row={row} />
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs">
          <span className={isRenewOff ? "text-danger" : "text-text-secondary"}>{row.reason.phrase}</span>
          {row.gist ? (
            <span className="truncate text-text-muted" title={row.gistSource ?? undefined}>
              {row.gist}
            </span>
          ) : null}
        </div>
      </div>
      <span className="w-16 shrink-0 text-right text-sm font-medium text-text-primary">
        {row.ltvMills > 0 ? formatLtv(row.ltvMills) : "—"}
      </span>
      <div className="flex shrink-0 gap-1">
        <button
          type="button"
          disabled
          title="Доступно в Phase 2"
          className="cursor-not-allowed rounded-md border border-border px-2 py-1 text-xs text-text-muted"
        >
          Открыть чат
        </button>
        <button
          type="button"
          disabled
          title="Доступно в Phase 2"
          className="cursor-not-allowed rounded-md border border-border px-2 py-1 text-xs text-text-muted"
        >
          Готово
        </button>
      </div>
    </div>
  );
}

function SectionBlock({ section, rows }: { section: string; rows: WorkboardV3Row[] }) {
  const meta = SECTION_META[section]!;
  if (rows.length === 0) {
    return (
      <div className="flex items-center gap-2 px-1 py-1 text-xs text-text-muted">
        <span className={meta.header}>{meta.title}</span>
        <span>✓ пусто</span>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className={`px-1 text-xs font-semibold uppercase tracking-wide ${meta.header}`}>
        {meta.title} · {rows.length}
      </div>
      {rows.map((row) => (
        <BoardRow key={`${section}-${row.fanId}`} row={row} />
      ))}
    </div>
  );
}

function TabContent({ tab }: { tab: WorkboardV3Tab }) {
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-text-primary">
          Живой диалог <span className="text-text-muted">· {tab.live}</span>
        </h3>
        {tab.blocks.live.map((block) => (
          <SectionBlock key={block.section} section={block.section} rows={block.rows} />
        ))}
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-text-primary">
          {PROACTIVE_TITLES[tab.key]} <span className="text-text-muted">· {tab.proactive}</span>
          {tab.debt > 0 ? (
            <span className="ml-2 rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning-dark">
              долг: {tab.debt}
            </span>
          ) : null}
        </h3>
        {tab.blocks.proactive.map((block) => (
          <SectionBlock key={block.section} section={block.section} rows={block.rows} />
        ))}
      </div>
    </div>
  );
}

function ServiceTab({ board }: { board: WorkboardV3BoardResponse }) {
  const { counts, rows } = board.service;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Снузы", value: counts.snoozed },
          { label: "Не трогать", value: counts.doNotTouch },
          { label: "Мёртвые", value: counts.dead },
          { label: "Архив", value: counts.archived },
        ].map((item) => (
          <div key={item.label} className="rounded-lg border border-border-light bg-card px-3 py-2">
            <div className="text-xs text-text-muted">{item.label}</div>
            <div className="text-lg font-semibold text-text-primary">{item.value}</div>
          </div>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-text-muted">Нет снузов и ограничений.</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => (
            <div
              key={`${row.kind}-${row.fanId}`}
              className="flex items-center gap-3 rounded-lg border border-border-light bg-card px-3 py-2 text-sm"
            >
              <span className="font-medium text-text-primary">{row.name}</span>
              {row.alias ? <span className="text-xs text-text-muted">({row.alias})</span> : null}
              <span className="text-xs text-text-secondary">
                {row.kind === "snoozed"
                  ? `снуз до ${row.until ? new Date(row.until).toLocaleDateString("ru-RU") : "—"}`
                  : "не трогать"}
              </span>
              {row.reason ? <span className="text-xs text-text-muted">— {row.reason}</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkboardV3Page() {
  const { pageLabel } = useParams<{ pageLabel: string }>();
  const label = pageLabel ?? "";
  const [activeTab, setActiveTab] = useState<TabKey>("subs");

  const { data, isLoading, isError } = useWorkboardV3Board(label, { enabled: Boolean(pageLabel) });

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">{label} · Workboard v3</h1>
          <p className="text-xs text-text-secondary">
            данные на {formatClock(data?.dataAsOf ?? null)}
            {data ? <> · ● ждут ответа: {data.needsReplyTotal}</> : null}
            {" · режим просмотра (Phase 1)"}
          </p>
        </div>
        <button
          type="button"
          disabled
          title="Смены появятся в Phase 2"
          className="cursor-not-allowed rounded-lg border border-border bg-hover px-4 py-2 text-sm font-medium text-text-muted"
        >
          Начать смену
        </button>
      </header>

      {isLoading ? <p className="py-10 text-center text-text-muted">Загрузка…</p> : null}
      {isError ? (
        <p className="py-10 text-center text-danger">
          Не удалось загрузить план. Проверьте, что WB3_ENABLED включён.
        </p>
      ) : null}

      {data ? (
        <>
          <nav className="flex flex-wrap gap-1 border-b border-border pb-2">
            {data.tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`rounded-lg px-3 py-1.5 text-sm ${
                  activeTab === tab.key
                    ? "bg-active-bg font-medium text-text-primary"
                    : "text-text-secondary hover:bg-hover"
                }`}
              >
                {tab.title} {tab.planned}
                {tab.debt > 0 ? <span className="ml-1 text-warning-dark">долг {tab.debt}</span> : null}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setActiveTab("service")}
              className={`rounded-lg px-3 py-1.5 text-sm ${
                activeTab === "service"
                  ? "bg-active-bg font-medium text-text-primary"
                  : "text-text-secondary hover:bg-hover"
              }`}
            >
              Сервис
            </button>
          </nav>

          {activeTab === "service" ? (
            <ServiceTab board={data} />
          ) : (
            (() => {
              const tab = data.tabs.find((t) => t.key === activeTab);
              if (!tab) {
                return null;
              }
              if (tab.planned === 0) {
                return (
                  <p className="py-10 text-center text-text-muted">
                    План пуст — ни одной причины в этой вкладке сегодня.
                  </p>
                );
              }
              return <TabContent tab={tab} />;
            })()
          )}
        </>
      ) : null}
    </div>
  );
}
