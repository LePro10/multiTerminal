# multiTerminal

A desktop app for opening a grid of real terminals in one window — split them like tmux, launch panes from reusable templates, and broadcast the same input to all of them at once.

Built with Electron, [`node-pty`](https://github.com/microsoft/node-pty) (real PTYs, so `cd`, vim, and interactive programs all work normally), and [`xterm.js`](https://github.com/xtermjs/xterm.js).

![icon](build/icon.png)

## Features

- **Resizable split-pane grid** — add terminals and split them side-by-side (⬌) or stacked (⬍); drag dividers to resize. Panes host fully functional shells via `node-pty`.
- **Templates** — JSON files in `templates/` define reusable pane presets (`name`, `command`, `args`, `cwd`, `env`, `color`). Pick one from the toolbar dropdown before adding/splitting a pane. Ships with a `Blank Shell` default and an example `omp` template you can point at your own tool.
- **Layout presets** — instantly arrange the grid into fixed sizes from 1x1 up to 4x6.
- **Open Folder…** — pick a parent folder and it opens one terminal per immediate subfolder, each already `cd`'d into its own directory. Panes are auto-arranged in a near-square grid (e.g. 3 subfolders → one row of 3 at 33% each; 5 subfolders → a balanced 3-then-2 layout).
- **Broadcast input** — type into the top bar and hit "Send to all" (or Enter) to write the same keystrokes into every terminal's PTY at once, with an optional trailing Enter so it executes everywhere simultaneously. Each pane has a "bcast" checkbox to opt out individually.
- **Per-pane controls** — close, rename via template, and toggle broadcast inclusion per terminal.

## Requirements

- Node.js and npm
- Build tools for the `node-pty` native addon: `python3`, `make`, `g++` (already required by most dev machines)

## Getting started

```bash
npm install
npm start
```

On Linux, `npm start` runs Electron with `--no-sandbox`. This is needed unless your system's `node_modules/electron/dist/chrome-sandbox` binary is owned by `root` with the setuid bit (`chmod 4755`) — most dev machines aren't set up that way, so the flag is the simpler path for local use.

## Templates

Add a `.json` file to `templates/` to make it selectable from the toolbar dropdown:

```json
{
  "name": "omp",
  "command": "omp",
  "args": [],
  "cwd": "~",
  "color": "#C586C0",
  "env": {}
}
```

- `command`/`args` — what to launch in the pane (defaults to your `$SHELL`)
- `cwd` — starting directory (`~` expands to your home directory)
- `color` — accent color shown in the pane header
- `env` — extra environment variables merged into the pane's process

A common workflow: create a template for a CLI tool (e.g. an AI assistant you can pick a different model in per-terminal), open several panes from it, configure each manually, then use **Broadcast** to send the same prompt into all of them at once.

## Desktop integration (Linux/GNOME)

The app ships an icon at `build/icon.png` and can be pinned to the dock like any other app:

1. Create a `.desktop` file (see below) pointing `Exec` at `node_modules/electron/dist/electron <path-to-this-repo> --no-sandbox` and `Icon` at `build/icon.png`.
2. Place it in `~/.local/share/applications/` and run `update-desktop-database ~/.local/share/applications`.
3. Add it to your dock via `gsettings` (`org.gnome.shell favorite-apps`) or by right-clicking it in the app grid.

```ini
[Desktop Entry]
Name=multiTerminal
Comment=Grid of real terminals with templates and broadcast input
Exec=/path/to/multiterminal/node_modules/electron/dist/electron /path/to/multiterminal --no-sandbox
Icon=/path/to/multiterminal/build/icon.png
Terminal=false
Type=Application
StartupWMClass=multiterminal
Categories=Development;TerminalEmulator;
```
