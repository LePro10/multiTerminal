import {
  state, bus, GROUPS, orderedPanes, setTarget, setSelection, selectionIds, leafIds,
} from './state.js';
import {
  addPane, splitPane, closePane, toggleZoom, balance, equalize, applyPreset,
  navigate, setFocus,
} from './layout.js';
import { openFolderSheet, pickFoldersNative, openRecent } from './folders.js';
import { focusComposer, send, sendRaw } from './composer.js';
import { openSettings, startRename, showPaneMenu } from './ui.js';

const api = window.api;

function currentTemplate() {
  const select = document.getElementById('templateSelect');
  return state.templates.find((t) => t.id === select.value) || null;
}

function focused() {
  return state.panes.get(state.focusedId) || orderedPanes()[0] || null;
}

/* ------------------------------------------------------------- the registry */

export const commands = [
  { id: 'pane.new', title: 'Neues Terminal', group: 'Terminal', keys: 'Ctrl+KeyT',
    run: () => addPane({ template: currentTemplate() }) },
  // Alt+Shift+Arrow is the primary binding because it is the same physical key
  // on every keyboard layout; Ctrl+\ is kept as an alias for US layouts, where
  // it is the habit from other terminals. On a German layout `\` needs AltGr,
  // so it cannot be the only way to split.
  { id: 'pane.splitRight', title: 'Rechts teilen', group: 'Terminal',
    keys: ['Alt+Shift+ArrowRight', 'Ctrl+Backslash'],
    run: () => splitPane('row', { template: currentTemplate() }) },
  { id: 'pane.splitDown', title: 'Unten teilen', group: 'Terminal',
    keys: ['Alt+Shift+ArrowDown', 'Ctrl+Shift+Backslash'],
    run: () => splitPane('col', { template: currentTemplate() }) },
  { id: 'pane.close', title: 'Pane schließen', group: 'Terminal', keys: 'Ctrl+KeyW',
    run: () => { const p = focused(); if (p) closePane(p.id); } },
  { id: 'pane.zoom', title: 'Pane zoomen / zurück', group: 'Terminal', keys: 'Ctrl+Shift+KeyZ',
    run: () => toggleZoom() },
  { id: 'pane.rename', title: 'Pane umbenennen', group: 'Terminal', keys: 'F2',
    run: () => { const p = focused(); if (p) startRename(p); } },
  { id: 'pane.restart', title: 'Prozess im Pane neu starten', group: 'Terminal',
    run: () => focused()?.restart() },
  { id: 'pane.search', title: 'Im Pane suchen', group: 'Terminal', keys: 'Ctrl+Shift+KeyF',
    run: () => focused()?.toggleSearch(true) },
  { id: 'pane.mute', title: 'Pane stummschalten (von "Alle" ausnehmen)', group: 'Terminal',
    run: () => { const p = focused(); if (p) p.setMuted(!p.muted); } },
  { id: 'pane.menu', title: 'Pane-Menü öffnen', group: 'Terminal',
    run: () => { const p = focused(); if (!p) return;
      const r = p.el.getBoundingClientRect();
      showPaneMenu(p, r.left + 20, r.top + 32); } },

  { id: 'nav.left', title: 'Zum Pane links', group: 'Navigation', keys: 'Alt+ArrowLeft', run: () => navigate('left') },
  { id: 'nav.right', title: 'Zum Pane rechts', group: 'Navigation', keys: 'Alt+ArrowRight', run: () => navigate('right') },
  { id: 'nav.up', title: 'Zum Pane oben', group: 'Navigation', keys: 'Alt+ArrowUp', run: () => navigate('up') },
  { id: 'nav.down', title: 'Zum Pane unten', group: 'Navigation', keys: 'Alt+ArrowDown', run: () => navigate('down') },

  { id: 'layout.balance', title: 'Raster ausbalancieren', group: 'Layout', run: () => balance() },
  { id: 'layout.equalize', title: 'Größen angleichen', group: 'Layout', run: () => equalize() },
  { id: 'layout.2x2', title: 'Layout 2 × 2', group: 'Layout', run: () => applyPreset(2, 2, { template: currentTemplate() }) },
  { id: 'layout.2x3', title: 'Layout 2 × 3', group: 'Layout', run: () => applyPreset(2, 3, { template: currentTemplate() }) },
  { id: 'layout.3x3', title: 'Layout 3 × 3', group: 'Layout', run: () => applyPreset(3, 3, { template: currentTemplate() }) },

  { id: 'folders.open', title: 'Ordner öffnen…', group: 'Ordner', keys: 'Ctrl+KeyO',
    run: () => openFolderSheet() },
  { id: 'folders.native', title: 'Ordner über Systemdialog öffnen…', group: 'Ordner', keys: 'Ctrl+Shift+KeyO',
    run: () => pickFoldersNative() },
  { id: 'folders.recent', title: 'Zuletzt verwendete Ordner', group: 'Ordner', run: () => openRecent() },
  { id: 'folders.reveal', title: 'Ordner des Panes im Dateimanager öffnen', group: 'Ordner', keys: 'Ctrl+Shift+KeyE',
    run: () => { const p = focused(); if (p?.cwd) api.fs.reveal(p.cwd); } },

  { id: 'select.all', title: 'Alle Terminals auswählen', group: 'Auswahl', keys: 'Ctrl+Shift+KeyA',
    run: () => { setSelection(leafIds()); setTarget('selection'); } },
  { id: 'select.none', title: 'Auswahl aufheben', group: 'Auswahl',
    run: () => { setSelection([]); setTarget('all'); } },
  { id: 'select.invert', title: 'Auswahl umkehren', group: 'Auswahl',
    run: () => { const sel = new Set(selectionIds());
      setSelection(leafIds().filter((id) => !sel.has(id))); } },
  { id: 'select.attention', title: 'Alle auswählen, die auf dich warten', group: 'Auswahl',
    run: () => { setSelection(orderedPanes().filter((p) => p.attention).map((p) => p.id));
      setTarget('selection'); } },
  { id: 'select.idle', title: 'Alle bereiten Terminals auswählen', group: 'Auswahl',
    run: () => { setSelection(orderedPanes().filter((p) => p.status === 'idle').map((p) => p.id));
      setTarget('selection'); } },

  { id: 'target.all', title: 'Ziel: Alle', group: 'Senden', run: () => setTarget('all') },
  { id: 'target.selection', title: 'Ziel: Auswahl', group: 'Senden', run: () => setTarget('selection') },
  { id: 'composer.focus', title: 'Zum Prompt-Feld springen', group: 'Senden', keys: 'Ctrl+KeyL',
    run: () => focusComposer() },
  { id: 'send.enter', title: 'Enter an Ziele senden', group: 'Senden', run: () => sendRaw('\r') },
  { id: 'send.yes', title: 'y + Enter an Ziele senden', group: 'Senden', run: () => sendRaw('y\r') },
  { id: 'send.esc', title: 'Escape an Ziele senden', group: 'Senden', run: () => sendRaw('\x1b') },
  { id: 'send.interrupt', title: 'Ctrl+C an Ziele senden', group: 'Senden', run: () => sendRaw('\x03') },
  { id: 'send.repeat', title: 'Letzten Prompt erneut senden', group: 'Senden',
    run: () => {
      try {
        const history = JSON.parse(localStorage.getItem('multiterminal.composer.history') || '[]');
        if (history[0]) send(history[0]);
      } catch (_) { /* nothing stored */ }
    } },

  { id: 'app.settings', title: 'Einstellungen', group: 'App', keys: 'Ctrl+Comma', run: () => openSettings() },
  { id: 'app.templates', title: 'Templates-Ordner öffnen', group: 'App', run: () => api.templates.openDir() },
  { id: 'app.reloadTemplates', title: 'Templates neu laden', group: 'App',
    run: () => bus.emit('templates:reload') },
  { id: 'app.config', title: 'Konfigurationsordner öffnen', group: 'App',
    run: () => api.fs.reveal(state.info.configDir) },
  // Without a menu bar there is no menu accelerator for these, so they are
  // bound here instead.
  { id: 'app.devtools', title: 'Entwicklertools', group: 'App', keys: 'F12',
    run: () => api.toggleDevTools() },
];

for (const group of GROUPS) {
  commands.push({
    id: `group.assign.${group.id}`,
    title: `Auswahl der Gruppe ${group.label} zuweisen`,
    group: 'Gruppen',
    run: () => {
      const ids = selectionIds();
      if (ids.length === 0) {
        bus.emit('toast', { text: 'Erst Terminals auswählen', kind: 'warn' });
        return;
      }
      for (const id of ids) {
        const pane = state.panes.get(id);
        if (pane) { pane.group = group.id; pane._renderMeta(); }
      }
      bus.emit('target:change');
      bus.emit('session:dirty');
      bus.emit('toast', { text: `${ids.length} Terminals → Gruppe ${group.label}` });
    },
  });
  commands.push({
    id: `group.select.${group.id}`,
    title: `Gruppe ${group.label} auswählen`,
    group: 'Gruppen',
    run: () => {
      const ids = orderedPanes().filter((p) => p.group === group.id).map((p) => p.id);
      setSelection(ids);
      setTarget(group.id);
    },
  });
}

const byId = new Map(commands.map((c) => [c.id, c]));

export function run(id) {
  const command = byId.get(id);
  if (!command) return;
  Promise.resolve(command.run()).catch((err) => {
    console.error(err);
    bus.emit('toast', { text: `Fehler: ${err.message}`, kind: 'error' });
  });
}

/* ---------------------------------------------------------------- shortcuts */

function eventKey(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  parts.push(e.code);
  return parts.join('+');
}

export function prettyKey(keys) {
  if (!keys) return '';
  // A command may declare several bindings; the first one is what the UI shows.
  return (Array.isArray(keys) ? keys[0] : keys)
    .replace(/\bKey([A-Z])\b/g, '$1')
    .replace(/\bDigit(\d)\b/g, '$1')
    .replace(/\bBackslash\b/, '\\')
    .replace(/\bComma\b/, ',')
    .replace(/\bArrowLeft\b/, '←')
    .replace(/\bArrowRight\b/, '→')
    .replace(/\bArrowUp\b/, '↑')
    .replace(/\bArrowDown\b/, '↓')
    .replace(/\+/g, ' + ');
}

// Declared bindings are normalised into the same modifier order eventKey()
// produces, so a binding written as "Alt+Shift+ArrowDown" still matches an
// event that stringifies to "Shift+Alt+ArrowDown".
function normalizeCombo(combo) {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
  const code = parts.pop();
  const mods = new Set(parts.map((m) => (m === 'Cmd' || m === 'Meta' ? 'Ctrl' : m)));
  const ordered = ['Ctrl', 'Shift', 'Alt'].filter((m) => mods.has(m));
  return [...ordered, code].join('+');
}

const keyMap = new Map();
for (const command of commands) {
  if (!command.keys) continue;
  for (const combo of Array.isArray(command.keys) ? command.keys : [command.keys]) {
    keyMap.set(normalizeCombo(combo), command.id);
  }
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

export function initShortcuts() {
  window.addEventListener('keydown', (e) => {
    const key = eventKey(e);

    // Ctrl+K is global so the palette is always one keystroke away.
    if (key === 'Ctrl+KeyK') {
      e.preventDefault();
      togglePalette();
      return;
    }
    if (e.key === 'Escape' && !document.getElementById('paletteSheet').hidden) {
      e.preventDefault();
      closePalette();
      return;
    }

    // Alt+1…9 targets a pane by its header number, from anywhere. Shift+Alt+N
    // focuses that pane instead of toggling its selection.
    const digit = /^(?:Shift\+)?Alt\+Digit([1-9])$/.exec(key);
    if (digit) {
      e.preventDefault();
      const pane = orderedPanes()[Number(digit[1]) - 1];
      if (!pane) return;
      if (e.shiftKey) {
        setFocus(pane.id);
      } else {
        bus.emit('pane:toggleSelect', { id: pane.id, additive: true });
      }
      return;
    }

    // A pane that has focus makes xterm's hidden textarea the active element,
    // so "is the user typing" is true almost all the time. Only bare keys must
    // be handed through to whatever has focus — anything carrying Ctrl or Alt,
    // and the function keys, is a shortcut and belongs to the app.
    const typing = isTypingTarget(document.activeElement);
    const isChord = e.ctrlKey || e.metaKey || e.altKey || /^F\d{1,2}$/.test(e.code);
    if (typing && !isChord) return;

    if (e.key === 'Escape' && !typing) {
      if (state.selection.size > 0) {
        e.preventDefault();
        setSelection([]);
        setTarget('all');
        return;
      }
    }

    const commandId = keyMap.get(key);
    if (commandId) {
      e.preventDefault();
      run(commandId);
    }
  });
}

/* ----------------------------------------------------------- command palette */

const paletteSheet = document.getElementById('paletteSheet');
const paletteInput = document.getElementById('paletteInput');
const paletteList = document.getElementById('paletteList');
let paletteCursor = 0;
let paletteMatches = [];

function score(command, needle) {
  if (!needle) return 1;
  const haystack = `${command.title} ${command.group} ${command.id}`.toLowerCase();
  if (haystack.includes(needle)) return 100 - haystack.indexOf(needle);
  // Fall back to subsequence matching so "opfo" finds "Ordner öffnen".
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i += 1;
    if (i === needle.length) return 10;
  }
  return 0;
}

function renderPalette() {
  const needle = paletteInput.value.trim().toLowerCase();
  paletteMatches = commands
    .map((c) => ({ c, s: score(c, needle) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 60)
    .map((x) => x.c);

  paletteCursor = Math.max(0, Math.min(paletteCursor, paletteMatches.length - 1));
  paletteList.innerHTML = '';

  if (paletteMatches.length === 0) {
    paletteList.innerHTML = '<div class="list-empty">Kein Befehl gefunden.</div>';
    return;
  }

  let lastGroup = null;
  paletteMatches.forEach((command, i) => {
    if (!needle && command.group !== lastGroup) {
      lastGroup = command.group;
      const header = document.createElement('div');
      header.className = 'palette-group';
      header.textContent = command.group;
      paletteList.appendChild(header);
    }
    const item = document.createElement('div');
    item.className = `palette-item${i === paletteCursor ? ' cursor' : ''}`;
    const label = document.createElement('span');
    label.className = 'pi-label';
    label.textContent = command.title;
    item.appendChild(label);
    if (needle) {
      const hint = document.createElement('span');
      hint.className = 'pi-hint';
      hint.textContent = command.group;
      item.appendChild(hint);
    }
    if (command.keys) {
      const key = document.createElement('span');
      key.className = 'pi-key';
      key.textContent = prettyKey(command.keys);
      item.appendChild(key);
    }
    item.addEventListener('click', () => {
      closePalette();
      run(command.id);
    });
    item.addEventListener('mousemove', () => {
      if (paletteCursor !== i) { paletteCursor = i; renderPalette(); }
    });
    paletteList.appendChild(item);
  });
  paletteList.querySelector('.palette-item.cursor')?.scrollIntoView({ block: 'nearest' });
}

export function openPalette() {
  paletteSheet.hidden = false;
  paletteInput.value = '';
  paletteCursor = 0;
  renderPalette();
  paletteInput.focus();
}

export function closePalette() {
  paletteSheet.hidden = true;
  state.panes.get(state.focusedId)?.focus();
}

function togglePalette() {
  if (paletteSheet.hidden) openPalette();
  else closePalette();
}

export function initPalette() {
  paletteInput.addEventListener('input', () => {
    paletteCursor = 0;
    renderPalette();
  });
  paletteInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      paletteCursor = Math.min(paletteCursor + 1, paletteMatches.length - 1);
      renderPalette();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      paletteCursor = Math.max(paletteCursor - 1, 0);
      renderPalette();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const command = paletteMatches[paletteCursor];
      if (command) { closePalette(); run(command.id); }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
    }
  });
  paletteSheet.addEventListener('mousedown', (e) => {
    if (e.target === paletteSheet) closePalette();
  });
  document.getElementById('paletteBtn').addEventListener('click', togglePalette);
  bus.on('command', (id) => run(id));
}
