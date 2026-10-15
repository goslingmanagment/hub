import { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { ChevronDown } from "lucide-react";
import { parseProfileSections } from "@/lib/parseFanProfile";

type FanIntelligenceMarkdownProps = {
  body: string;
};

export function FanIntelligenceMarkdown({ body }: FanIntelligenceMarkdownProps) {
  const { preamble, sections } = useMemo(() => parseProfileSections(body), [body]);

  // Flat render for 0 or 1 H2 section (backward compat for simple profiles)
  if (sections.length < 2) {
    return (
      <div className="fan-intelligence-markdown">
        <ReactMarkdown>{body}</ReactMarkdown>
      </div>
    );
  }

  // The first section is the dossier's summary: it opens by itself, the rest
  // wait for a click.
  return (
    <div>
      {preamble && (
        <div className="fan-intelligence-markdown mb-3">
          <ReactMarkdown>{preamble}</ReactMarkdown>
        </div>
      )}
      <div className="divide-y divide-border-light border-y border-border-light">
        {sections.map((section, index) => (
          <AccordionSection
            key={`${section.heading}-${index}`}
            heading={section.heading}
            content={section.content}
            defaultOpen={index === 0}
          />
        ))}
      </div>
    </div>
  );
}

function AccordionSection({
  heading,
  content,
  defaultOpen,
}: {
  heading: string;
  content: string;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 py-2.5 text-left text-sm font-semibold text-text-primary transition-colors hover:text-accent"
        aria-expanded={open}
      >
        <span>{heading}</span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={`shrink-0 text-text-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="fan-intelligence-markdown pb-3">
          <ReactMarkdown>{content}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
