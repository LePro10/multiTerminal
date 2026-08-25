# multiTerminal

A control room for running many terminals — and many AI coding CLIs — side by
side. Open one terminal per project folder, watch at a glance which of them is
working and which is waiting for you, and drive a prompt into all of them (or
just the ones you picked) from a single input.

Built with Electron, [`node-pty`](https://github.com/microsoft/node-pty) (real
PTYs, so `cd`, vim and interactive programs work normally) and
[`xterm.js`](https://github.com/xtermjs/xterm.js).

![icon](build/icon.png)

## Why

Running eight AI coding agents in eight terminal tabs falls apart quickly: you
can't see which one finished, you re-type the same prompt eight times, and
alt-tabbing to find the one asking for approval costs more time than the agent
saved. multiTerminal puts all of them in one grid, tells you which ones need
you, and gives you one prompt box pointed at exactly the ones you choose.

## Features

### Grid

- **Resizable split grid** — split panes horizontally or vertically, drag the
  dividers, and the sizes stick. Closing a pane hands its space to its
  siblings instead of resetting the whole layout.
- **Layout presets** (1×1 up to 4×4) that **reuse the terminals you already
  have** instead of killing them. Extra panes are only closed after you
  confirm.
- **Zoom** a single pane to full window and back (`Ctrl+Shift+Z`, or
  double-click its header) — the other panes keep running.
- **Session restore** — layout, folders, names, groups and mute flags come back
  the way you left them.
- New panes inherit the folder of the pane you were in.

### Status, at a glance

Every pane reports what it is doing, and the title bar sums it up:

| Dot | Meaning |
|---|---|
| ⚪ grey | Ready — the prompt is back, nothing running |
| 🟢 green | Output is flowing, the tool is working |
| 🟠 orange | **Waiting for you** |
| 🔴 red | The process exited |

"Waiting for you" is detected from the terminal bell, from `OSC 9` / `OSC 777`
desktop-notification escapes (what most AI CLIs emit when they need input), and
from the shape of the last lines on screen (`(y/n)`, `Do you want …?`,
`Press Enter`, password prompts, pagers). When it triggers while the window is
in the background you get a system notification and the taskbar entry flashes.

Clicking a status chip in the title bar selects every pane in that state — so
"select everything waiting for me, send `y`" is two clicks.

### Selecting terminals and sending to them

- Click a pane header to select it, `Ctrl+Click` to add, `Shift+Click` for a
  range, `Alt+1…9` to toggle a pane by its number.
- Assign panes to **groups A–F** (right-click a header). Groups survive
  restarts and show up as chips next to the prompt box.
- The **target chips** decide where a prompt goes: `Alle`, `Auswahl`, or one
  group. The composer always tells you how many terminals will receive it.
- Individual panes can be **muted** so `Alle` skips them.

### The prompt composer

- Multi-line: `Enter` sends, `Shift+Enter` adds a line, `↑`/`↓` walks the
  history.
- **Placeholders** are expanded per terminal, so one prompt says something
  different in each pane:
  `{{folder}}`, `{{path}}`, `{{name}}`, `{{index}}`, `{{count}}`, `{{group}}`.
  For example `Read the README in {{folder}} and summarise it` sends the right
  folder name to each agent.
- **Prompt library** — save the prompt you're typing (☆), then it's one click
  (or `Shift+Click` to send immediately). Right-click a chip to delete it.
- **Quick keys** for the things AI CLIs constantly ask for: `⏎`, `y`, `n`, `1`,
  `esc`, `^C`, repeat-last-command, `clear` — all sent to the current targets.
  Panes that are waiting for you also grow their own small `y n ⏎ esc ^C` bar.
- **Stagger** (Settings → Senden) puts a delay between targets so you don't
  fire ten API calls in the same millisecond.

### Opening folders

Three ways, all of which create one terminal per folder, already `cd`'d in:

1. **Built-in browser** (`Ctrl+O`) — type to filter, `↑`/`↓` to move, `Enter`
   to descend, `Space` to pick, `Backspace` to go up, `Ctrl+A` for everything
   visible. Folders containing `.git`, `package.json`, `Cargo.toml`, `go.mod`,
   `CLAUDE.md` and friends are tagged, and **Projekte finden** sweeps up to
   three levels down and lists every project it finds — that is the fast way to
   turn a workspace directory into a full grid.
2. **System dialog** — the normal OS folder picker, with multi-select.
3. **Drag and drop** — drag folders straight out of Nautilus / Finder /
   Explorer into the window. Dropping a *file* opens its containing folder.

Any pane's folder can be opened in the OS file manager with `Ctrl+Shift+E`.

### Everything else

- **Command palette** (`Ctrl+K`) — every action, searchable, with its shortcut.
- **Search inside a pane** (`Ctrl+Shift+F`) with match highlighting.
- Copy with `Ctrl+Shift+C` or right-click on a selection; paste with
  `Ctrl+Shift+V` or right-click with nothing selected.
- Clickable URLs, GPU-accelerated rendering with a DOM fallback.
- A pane whose process exits offers a **Restart** button rather than going dead.

## Keyboard shortcuts

| | |
|---|---|
| `Ctrl+K` | Command palette |
| `Ctrl+T` | New terminal |
| `Ctrl+\` / `Ctrl+Shift+\` | Split right / split down |
| `Ctrl+W` | Close pane |
| `Ctrl+Shift+Z` | Zoom pane |
| `Ctrl+O` / `Ctrl+Shift+O` | Folder browser / system dialog |
| `Ctrl+Shift+E` | Reveal pane's folder in the file manager |
| `Ctrl+L` | Jump to the prompt box |
| `Alt+1…9` | Toggle selection of pane N (`Shift` to focus it instead) |
| `Ctrl+Shift+A` | Select all panes |
| `Esc` | Clear the selection |
| `Alt+←↑↓→` | Move focus between panes |
| `F2` | Rename pane |
| `Ctrl+Shift+F` | Search in pane |
| `Ctrl+,` | Settings |

## Requirements

- Node.js and npm
- Build tools for the `node-pty` native addon: `python3`, `make`, `g++`

## Getting started

Quick install (Linux/GNOME) — installs dependencies and adds an app-grid/dock
launcher with icon:

```bash
./install.sh
```

Or just run it:

```bash
npm install
npm start
```

On Linux `npm start` passes `--no-sandbox`, which is needed unless
`node_modules/electron/dist/chrome-sandbox` is owned by root with the setuid
bit set.

## Templates

A template is a reusable pane preset. Bundled ones live in `templates/`; your
own go in `~/.config/multiterminal/templates/` (Settings → *Templates-Ordner
öffnen*), and a user template with the same filename shadows a bundled one.

```json
{
  "name": "Claude Code",
  "command": "",
  "args": [],
  "cwd": "",
  "color": "#d97757",
  "initialInput": "claude",
  "env": {}
}
```

- `command` / `args` — what to launch. Empty means your `$SHELL`.
- `cwd` — starting directory (`~` expands; empty means "inherit").
- `color` — accent colour for the pane.
- `initialInput` — typed into the pane once it has started. Launching a CLI
  this way (rather than as `command`) means you still have a working shell if
  the tool isn't installed.
- `env` — extra environment variables.

The shipped **Claude Code** template plus **Open folders → Projekte finden** is
the intended workflow: point it at your projects directory, select the repos
you want, and you get one agent per repo in one grid.

## Where your data lives

Everything is in Electron's user-data directory — `~/.config/multiterminal` on
Linux — so the repo stays clean and `git pull` never touches your setup:

| File | Contents |
|---|---|
| `settings.json` | Preferences |
| `session.json` | Last layout, folders, names, groups |
| `prompts.json` | Prompt library |
| `recent-folders.json` | Recently opened folders |
| `templates/` | Your own templates |

## Desktop integration (Linux/GNOME)

`./install.sh` runs `npm install` and writes
`~/.local/share/applications/multiterminal.desktop` pointing at this repo's
Electron binary, using `build/icon.png` as the icon. After running it,
multiTerminal appears in your application grid — right-click it there and
choose "Add to Favorites" / "Pin to Dash". The script is idempotent, so
re-running it after `git pull` is safe.
