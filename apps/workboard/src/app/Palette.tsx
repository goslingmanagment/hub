import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { CommandPalette } from "@agency_hub_core/ui/components/Palette";
import { groupCommands, screenCommands, searchCommands, themeCommands, type Command } from "@agency_hub_core/ui/palette";
import { addressApp } from "@agency_hub_core/ui/screens";
import { useThemeStore } from "@agency_hub_core/ui/theme";
import { BASENAME } from "./routes.js";

/**
 * Workboard's search (Ctrl/⌘K, the frame's field): the same window as Hub's —
 * every Workboard screen the role opens, by its name and its old words, and the
 * theme. Hub's screens are Hub's search (the switcher crosses there).
 */
export function WorkboardPalette({ role, onClose }: { role: string; onClose: () => void }) {
  const navigate = useNavigate();
  const setTheme = useThemeStore((state) => state.setTheme);
  const [query, setQuery] = useState("");
  const commands = useMemo<Command[]>(() => [...screenCommands(role, "workboard"), ...themeCommands()], [role]);
  const groups = useMemo(() => groupCommands(searchCommands(commands, query)), [commands, query]);
  const found = groups.some((group) => group.items.length > 0);

  function open(command: Command) {
    onClose();
    if (command.theme) setTheme(command.theme);
    else if (addressApp(command.to) === "workboard" && BASENAME !== "/") navigate(command.to.slice(BASENAME.length));
    else window.location.assign(command.to);
  }

  return (
    <CommandPalette
      groups={groups}
      query={query}
      onQueryChange={setQuery}
      onPick={open}
      onClose={onClose}
      placeholder="Найти: раздел"
      note={found ? null : "Ничего не нашлось. Ищите по названию раздела."}
    />
  );
}
