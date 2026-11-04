import { useState, type ReactNode } from "react";
import { Disclosure } from "@/components/ui/Disclosure";

/** Commands for whoever runs the server, kept out of the owner's way: folded under
 *  «Подробнее», each command with its own copy button. */
export function ServerAdminCommand({ text, command }: { text: ReactNode; command: string | readonly string[] }) {
  const commands = typeof command === "string" ? [command] : command;
  return (
    <Disclosure label="Подробнее">
      <p>{text}</p>
      {commands.map((line) => <CommandLine key={line} command={line} />)}
    </Disclosure>
  );
}

function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    }, () => undefined);
  };
  return (
    <div className="flex flex-wrap items-start gap-2">
      <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-border bg-hover-alt px-3 py-2 font-mono text-xs text-text-primary" data-draft-command>{command}</pre>
      <button type="button" className="btn btn-sm" onClick={copy}>{copied ? "Скопировано" : "Скопировать"}</button>
    </div>
  );
}
