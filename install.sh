#!/usr/bin/env bash
# Installs multiTerminal: installs npm dependencies and creates a desktop
# launcher (with icon) so the app shows up in your application grid and
# can be pinned to the dock. Linux/GNOME only.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$HOME/.local/share/applications"
DESKTOP_FILE="$DESKTOP_DIR/multiterminal.desktop"
ELECTRON_BIN="$APP_DIR/node_modules/electron/dist/electron"
ICON_PATH="$APP_DIR/build/icon.png"

echo "==> Installing npm dependencies"
cd "$APP_DIR"
npm install

if [ ! -x "$ELECTRON_BIN" ]; then
  echo "error: electron binary not found at $ELECTRON_BIN after npm install" >&2
  exit 1
fi

echo "==> Creating desktop launcher"
mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Name=multiTerminal
Comment=Grid of real terminals with templates and broadcast input
Exec=$ELECTRON_BIN $APP_DIR --no-sandbox
Icon=$ICON_PATH
Terminal=false
Type=Application
StartupWMClass=multiterminal
StartupNotify=true
Categories=Development;TerminalEmulator;
Keywords=terminal;shell;pty;tmux;grid;
EOF
chmod +x "$DESKTOP_FILE"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
fi

echo "==> Done"
echo "multiTerminal is installed. Find it in your application grid,"
echo "or pin it to the dock by right-clicking it there and choosing"
echo "'Add to Favorites' (GNOME) / 'Pin to Dash'."
echo
echo "Run it directly any time with: npm start (from $APP_DIR)"
