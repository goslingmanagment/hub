# @agency_hub_core/chatgoose-hotkeys

The single hotkey scheme of both ChatGoose clients — the Fansly extension
(`fansly-ext`) and the OnlyFans desktop app (`of-desktop`). This README is the
human-readable spec; `src/scheme.ts` is the table the clients run.

Clients never import this package from the hub: `scripts/vendor-hotkeys.mjs`
compiles it into `fansly-ext/vendor/chatgoose-hotkeys/` and
`of-desktop/packages/chatgoose-hotkeys/` as `@chatgoose/hotkeys`, with a
manifest (`chatgoose-hotkeys.vendor.json`: scheme version, source commit,
sha256 of every file). Both client releases must carry the same sha from the
same hub commit. Re-vendor both in one session; never hand-edit the copies.

## The scheme

Everything that writes into the reply field, plus Cancel, is **Cmd + key** on
macOS and **Ctrl + key** on Windows. Analysis, panels and toggles are
**Cmd+Shift + key** on macOS and **Ctrl+Alt + key** on Windows. Keys are
matched by physical position (`KeyboardEvent.code`), so the Russian layout
works without switching.

| Action | macOS | Windows | ЙЦУКЕН key | Clients |
|---|---|---|---|---|
| Reply | ⌘E | Ctrl+E | У | both |
| Fix (desktop: Improve) | ⌘I | Ctrl+I | Ш | both |
| Hi | ⌘G | Ctrl+G | П | both |
| Ping | ⌘P | Ctrl+P | З | both |
| Cancel AI | ⌘. | Ctrl+. | Ю | both |
| Help (desktop: Help Me) | ⌘⇧H | Ctrl+Alt+H | Р | both |
| Recap (desktop: Scan) | ⌘⇧S | Ctrl+Alt+S | Ы | both |
| Tone | ⌘⇧O | Ctrl+Alt+O | Щ | both |
| Review | ⌘⇧B | Ctrl+Alt+B | И | both |
| Split | ⌘⇧L | Ctrl+Alt+L | Д | both |
| Spenders | ⌘⇧M | Ctrl+Alt+M | Ь | both |
| Coach | ⌘⇧C | Ctrl+Alt+C | С | extension (reserved in desktop) |

The cheatsheet key (`?` outside inputs), send, chat navigation and board keys
stay client-owned and are not part of this table.

**macOS legacy habits** (the extension's Cmd+Shift scheme before v1):
⌘⇧E, ⌘⇧I, ⌘⇧G mean the same as ⌘E, ⌘I, ⌘G; ⌘⇧X stays Cancel; ⌘⇧D and ⌘⇧F are
swallowed in the ChatGoose context (no action, no Firefox side effect).
Windows is strict: no aliases.

## Why these keys

- **Firefox.** Among bare accel+letter only N, T, W (and quit) are
  `reserved="true"` (`browser/base/content/browser-sets.inc.xhtml`); E, I, G,
  P and `.` can be taken by the page, and a missed press only opens find,
  page info, print or stop — no work is lost. R is out (a missed press reloads
  Fansly), F stays find-in-page (the chatters use it in chats). Under
  accel+shift: P and W are reserved, R hard-reloads, T reopens a closed tab,
  F is reserved as exit-fullscreen while in full screen, V is paste-as-plain
  -text — none of them is used.
- **macOS.** Cmd+H hides and Cmd+M minimises the app; Services on selected
  text sit on ⌘⇧L (Safari search), ⌘⇧M (Terminal man page), ⌘⇧Y (Stickies),
  ⌘⇧A (Terminal man index) — L and M are the extension's long-standing Split
  and Spenders and stay under live test.
- **Windows.** The team switches input language with Alt+Shift, Ctrl+Shift
  and Win+Space, so neither Shift chord can carry hotkeys; Ctrl+Alt meets none
  of them. Firefox binds only X, U, Z under Ctrl+Alt, none reserved. AltGr
  layouts other than EN/RU are not supported.

## Engine rules (`src/engine.ts`)

- Strict modifiers. macOS text level: Cmd only; panel level: Cmd+Shift only.
  Windows text level: Ctrl only; panel level: Ctrl+Alt only.
- **Fresh-press roll-over guard** on Reply, Fix, Hi, Ping: the command fires
  only if, since Cmd/Ctrl went down, no other non-modifier key was pressed and
  Shift or Space was not pressed-and-released. A held Shift is fine. A second
  command under the same held modifier needs the modifier pressed again; a
  modifier already held when the page gained focus does not fire. Cancel is
  exempt.
- Auto-repeat returns the action with `repeat: true`: swallow, don't re-run.
- `isComposing` events are ignored.
- The engine only decides; each client decides its context (the extension's
  chat route, the desktop workspace) and calls `preventDefault`.

## Changing the scheme

Edit `src/scheme.ts`, bump `HOTKEY_SCHEME_VERSION`, run `pnpm vitest run
tests/chatgoose-hotkeys.test.ts`, commit, then from the clean hub tree:

    node scripts/vendor-hotkeys.mjs ../fansly-chat/vendor/chatgoose-hotkeys
    node scripts/vendor-hotkeys.mjs ../onlyfans-chat/packages/chatgoose-hotkeys

and commit both clients with their labels, cheatsheets and docs.
