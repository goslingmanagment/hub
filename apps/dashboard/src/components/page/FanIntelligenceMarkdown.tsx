import ReactMarkdown from "react-markdown";

type FanIntelligenceMarkdownProps = {
  body: string;
};

export const FanIntelligenceMarkdownRenderer = ReactMarkdown;

export function FanIntelligenceMarkdown({ body }: FanIntelligenceMarkdownProps) {
  return (
    <div className="fan-intelligence-markdown">
      <FanIntelligenceMarkdownRenderer>{body}</FanIntelligenceMarkdownRenderer>
    </div>
  );
}
