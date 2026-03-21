import { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { ChevronDown } from "lucide-react";
import { parseProfileSections } from "@/lib/parseFanProfile";

type FanIntelligenceMarkdownProps = {
  body: string;
};

export const FanIntelligenceMarkdownRenderer = ReactMarkdown;

export function FanIntelligenceMarkdown({ body }: FanIntelligenceMarkdownProps) {
  const { preamble, sections } = useMemo(() => parseProfileSections(body), [body]);

  // Flat render for 0 or 1 H2 section (backward compat for simple profiles)
  if (sections.length < 2) {
    return (
      <div className="fan-intelligence-markdown">
        <FanIntelligenceMarkdownRenderer>{body}</FanIntelligenceMarkdownRenderer>
      </div>
    );
  }

  return (
    <div>
      {preamble && (
        <div className="fan-intelligence-markdown mb-3">
          <FanIntelligenceMarkdownRenderer>{preamble}</FanIntelligenceMarkdownRenderer>
        </div>
      )}
      {sections.map((section) => (
        <AccordionSection
          key={section.heading}
          heading={section.heading}
          content={section.content}
          defaultOpen={false}
        />
      ))}
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
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-lg border border-border bg-hover-alt/30 px-4 py-2.5 text-left transition-colors hover:bg-hover-alt"
        aria-expanded={open}
      >
        <span className="text-[13px] font-bold text-text-primary">{heading}</span>
        <ChevronDown
          size={16}
          className={`text-text-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="fan-intelligence-markdown mt-2 px-1">
          <FanIntelligenceMarkdownRenderer>{content}</FanIntelligenceMarkdownRenderer>
        </div>
      )}
    </div>
  );
}
