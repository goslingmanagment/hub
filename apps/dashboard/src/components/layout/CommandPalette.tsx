import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { CommandPalette as Palette } from "@agency_hub_core/ui/components/Palette";
import { addressApp } from "@agency_hub_core/ui/screens";
import { useFansSearch } from "@/api/fansSearch";
import { kernel } from "@/api/sdk";
import { buildCommands, fanCommands, groupCommands, searchCommands, type Command, type CommandSetting } from "@/lib/commands";
import { useThemeStore } from "@/lib/theme";
import { CONFIG_COPY_RU } from "@/pages/settings/configCopyRu";
import { useDashboardShell } from "./DashboardShellContext.js";

/** One field to reach anything: a screen of the console or Workboard, a page
 *  or one of its views, a fan, a setting. Opens with Ctrl/⌘K or the search
 *  field of the frame; ↑↓ pick, Enter opens. It only navigates and changes the
 *  theme. The window is packages/ui's, the same as Workboard's. */
export function CommandPalette({ role, onClose }: { role: string; onClose: () => void }) {
  const { pages } = useDashboardShell();
  const navigate = useNavigate();
  const location = useLocation();
  const setTheme = useThemeStore((state) => state.setTheme);
  const [query, setQuery] = useState("");
  const typing = query.trim().length > 0;
  const config = useQuery({
    queryKey: ["admin", "config"],
    queryFn: () => kernel.adminConfig(),
    enabled: role === "owner" && typing,
    meta: { suppressGlobalError: true },
  });
  const settings = useMemo<CommandSetting[]>(() => (config.data?.subsystems ?? [])
    .flatMap((subsystem) => subsystem.items)
    .filter((item) => !item.secret && CONFIG_COPY_RU[item.key])
    .map((item) => ({ key: item.key, title: CONFIG_COPY_RU[item.key]!.title, subsystem: item.subsystem })), [config.data]);
  const commands = useMemo(() => buildCommands({ role, pages, settings }), [role, pages, settings]);
  const fans = useFansSearch(query);
  const backTo = `${location.pathname}${location.search}`;
  const fanResults = useMemo(() => fanCommands(fans.items, backTo), [backTo, fans.items]);
  const groups = useMemo(() => groupCommands([...searchCommands(commands, query), ...fanResults]), [commands, fanResults, query]);
  const found = groups.some((group) => group.items.length > 0);

  function open(command: Command) {
    onClose();
    if (command.theme) setTheme(command.theme);
    // Workboard is another app on this host: the browser goes there, the console's router cannot.
    else if (addressApp(command.to) === "workboard") window.location.assign(command.to);
    else navigate(command.to, command.state ? { state: command.state } : undefined);
  }

  return (
    <Palette
      groups={groups}
      query={query}
      onQueryChange={setQuery}
      onPick={open}
      onClose={onClose}
      placeholder="Найти: раздел, страницу, фана"
      note={fans.failed
        ? "Поиск фанов не ответил."
        : !found && !fans.pending
          ? "Ничего не нашлось. Ищите по названию раздела, страницы, модели, по имени фана."
          : null}
    />
  );
}
