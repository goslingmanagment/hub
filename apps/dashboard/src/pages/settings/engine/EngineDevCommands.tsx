import { toast } from "sonner";

import type { EngineDevCommand } from "./enginePageSummary.js";

// «Для разработчика»: the server console's commands for what the screen
// shows, once per screen and collapsed — never in the owner's own lines.

async function copy(command: string) {
  try {
    await navigator.clipboard.writeText(command);
    toast.success("Команда скопирована");
  } catch {
    toast.error("Буфер обмена недоступен: выделите команду и скопируйте её вручную.");
  }
}

export interface EngineDevCommandGroup {
  title: string | null;
  commands: readonly EngineDevCommand[];
}

export function EngineDevCommands({ groups }: { groups: readonly EngineDevCommandGroup[] }) {
  const shown = groups.filter((group) => group.commands.length > 0);
  if (shown.length === 0) return null;
  return (
    <details className="help" data-dev-commands="true">
      <summary>Для разработчика</summary>
      <div className="help-body max-w-none">
        <p>Команды консоли сервера для того, что показано на этом экране.</p>
        {shown.map((group) => (
          <div key={group.title ?? ""} className="space-y-1.5">
            {group.title && <p className="font-semibold text-text-primary">{group.title}</p>}
            <ul className="space-y-1.5">
              {group.commands.map((item) => (
                <li key={item.command} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-text-secondary">{item.label}</span>
                  <code className="min-w-0 break-all rounded-md bg-hover px-2 py-1 font-mono text-xs text-text-primary">
                    {item.command}
                  </code>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy(item.command)}>
                    Скопировать
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </details>
  );
}
