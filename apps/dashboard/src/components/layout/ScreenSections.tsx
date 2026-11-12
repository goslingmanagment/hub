import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { useAuthMe } from "@/api/queries";
import { ScreenFrameContext, type ScreenFrame } from "@/components/ui/screenFrame";
import { useScrollToAnchor } from "@/lib/useScrollToAnchor";
import { partOfAnchor, screenById, screenParts, type ScreenPart } from "@agency_hub_core/ui/screens";

/**
 * A screen that holds several things on one page (packages/ui/src/screens.ts
 * `parts`): OnlyFans API, Разработчик. Each section is a header with its name
 * and its sentence; it opens in place, and what it holds is built the first
 * time it opens (nothing is asked of Hub for a closed one) and kept while it
 * is closed again (a draft survives). The address's anchor opens its section
 * and brings it into view (`#queue`; `#config-<key>` opens `config`); with no
 * anchor the first is open, or none (`closed`: a screen whose sections are
 * equals). Opening one writes its anchor, so the address
 * names what is on the screen. A section's «Обновлено в …» stands in its own
 * header: inside it a screen's PageHeader is `inline`.
 */
export function ScreenSections({ screenId, sections, top, closed = false }: {
  screenId: string;
  /** What each section draws, by its id. A section without one is not shown. */
  sections: Readonly<Record<string, () => ReactNode>>;
  /** Said once above every section (a notice that holds for all of them). */
  top?: ReactNode;
  /** With no anchor every section starts closed: the screen is a list of them. */
  closed?: boolean;
}) {
  const { data: auth } = useAuthMe();
  const role = auth?.user.role ?? "team_lead";
  const parts = useMemo(() => screenParts(screenById(screenId), role).filter((part) => sections[part.id] !== undefined), [role, screenId, sections]);
  const location = useLocation();
  const navigate = useNavigate();
  const anchored = partOfAnchor(parts, location.hash);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(anchored ? [anchored.id] : closed ? [] : parts.slice(0, 1).map((part) => part.id)));
  const [built, setBuilt] = useState<ReadonlySet<string>>(open);
  // Brought into view: the section an anchor names; a deeper anchor (`#config-<key>`) is the section's own to find.
  const [arrival, setArrival] = useState<string | null>(anchored && location.hash === `#${anchored.id}` ? anchored.id : null);

  // A link to another section of this screen (a new anchor) opens it and brings it into view.
  const lastHash = useRef(location.hash);
  useEffect(() => {
    if (location.hash === lastHash.current) return;
    lastHash.current = location.hash;
    const part = partOfAnchor(parts, location.hash);
    if (!part) return;
    setOpen((current) => new Set([...current, part.id]));
    setBuilt((current) => new Set([...current, part.id]));
    setArrival(location.hash === `#${part.id}` ? part.id : null);
  }, [location.hash, parts]);

  // Kept in view while what it holds loads; the person's first touch of the page takes over.
  useScrollToAnchor(arrival ?? "", arrival !== null);

  const toggle = (part: ScreenPart) => {
    const opening = !open.has(part.id);
    setOpen((current) => {
      const next = new Set(current);
      if (opening) next.add(part.id);
      else next.delete(part.id);
      return next;
    });
    if (opening) {
      setBuilt((current) => new Set([...current, part.id]));
      lastHash.current = `#${part.id}`;
      navigate({ pathname: location.pathname, search: location.search, hash: part.id }, { replace: true, state: location.state });
    }
  };

  return (
    <>
      {top && <div className="screen-parts-top empty:hidden">{top}</div>}
      <div className="screen-parts">
        {parts.map((part) => (
          <Section key={part.id} part={part} open={open.has(part.id)} built={built.has(part.id)} onToggle={() => toggle(part)}>
            {sections[part.id]!()}
          </Section>
        ))}
      </div>
    </>
  );
}

function Section({ part, open, built, onToggle, children }: { part: ScreenPart; open: boolean; built: boolean; onToggle: () => void; children: ReactNode }) {
  const [windowSlot, setWindowSlot] = useState<HTMLElement | null>(null);
  const frame = useMemo<ScreenFrame>(() => ({ mode: "inline", slots: { title: null, subtitle: null, actions: null, window: windowSlot } }), [windowSlot]);
  const bodyId = `${part.id}-body`;
  return (
    <section id={part.id} className="screen-part" aria-labelledby={`${part.id}-title`}>
      <div className="screen-part-head">
        <button type="button" className="screen-part-toggle" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
          <ChevronRight size={18} aria-hidden="true" className="screen-part-chevron" />
          <span className="min-w-0">
            <h2 id={`${part.id}-title`} className="screen-part-title">{part.label}</h2>
            <span className="screen-part-why">{part.why}</span>
          </span>
        </button>
        <span ref={setWindowSlot} className="screen-part-window" hidden={!open} />
      </div>
      <div id={bodyId} className="screen-part-body" hidden={!open}>
        {built && <ScreenFrameContext.Provider value={frame}>{children}</ScreenFrameContext.Provider>}
      </div>
    </section>
  );
}
