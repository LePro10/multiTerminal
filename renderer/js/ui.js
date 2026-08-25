import { state, bus, GROUPS, orderedPanes, setSelection, setTarget } from './state.js';
import { scheduleFit } from './layout.js';

const api = window.api;

/* ------------------------------------------------------------------ toasts */

const toastsEl = document.getElementById('toasts');

export function toast(text, kind) {
  const node = document.createElement('div');
  node.className = `toast${kind ? ` ${kind}` : ''}`;
  node.textContent = text;
  toastsEl.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity 200ms, transform 200ms';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 220);
  }, kind === 'error' ? 4200 : 2200);
  // Never let a burst of toasts take over the screen.
  while (toastsEl.children.length > 4) toastsEl.firstChild.remove();
}

/* ------------------------------------------------------------ status chips */

const chips = {
  attention: document.getElementById('chipAttention'),
  running: document.getElementById('chipRunning'),
  idle: document.getElementById('chipIdle'),
  exited: document.getElementById('chipExited'),
};

export function renderStatusChips() {
  const panes = orderedPanes();
  const counts = { attention: 0, running: 0, idle: 0, exited: 0 };
  for (const pane of panes) {
    if (pane.exited) counts.exited += 1;
    else if (pane.attention) counts.attention += 1;
    else if (pane.status === 'running') counts.running += 1;
    else counts.idle += 1;
  }
  for (const [key, el] of Object.entries(chips)) {
    el.hidden = counts[key] === 0;
    el.querySelector('.n').textContent = String(counts[key]);
  }
  document.title = counts.attention > 0
    ? `(${counts.attention}) multiTerminal`
    : 'multiTerminal';
}

function selectByStatus(kind) {
  const ids = orderedPanes().filter((pane) => {
    if (kind === 'exited') return pane.exited;
    if (kind === 'attention') return !pane.exited && pane.attention;
    if (kind === 'running') return !pane.exited && !pane.attention && pane.status === 'running';
    return !pane.exited && !pane.attention && pane.status !== 'running';
  }).map((p) => p.id);
  if (ids.length === 0) return;
  setSelection(ids);
  setTarget('selection');
  toast(`${ids.length} Terminals ausgewählt`);
}

/* ------------------------------------------------------------ context menu */

let openMenu = null;

export function closeContextMenu() {
  openMenu?.remove();
  openMenu = null;
}

function menuItem(label, onClick, { key, danger, swatch } = {}) {
  const item = document.createElement('div');
  item.className = `cm-item${danger ? ' danger' : ''}`;
  if (swatch) {
    const dot = document.createElement('span');
    dot.className = 'cm-swatch';
    dot.style.background = swatch;
    item.appendChild(dot);
  }
  item.appendChild(document.createTextNode(label));
  if (key) {
    const k = document.createElement('span');
    k.className = 'cm-key';
    k.textContent = key;
    item.appendChild(k);
  }
  item.addEventListener('click', () => {
    closeContextMenu();
    onClick();
  });
  return item;
}

function menuTitle(text) {
  const el = document.createElement('div');
  el.className = 'cm-title';
  el.textContent = text;
  return el;
}

function menuSep() {
  const el = document.createElement('div');
  el.className = 'cm-sep';
  return el;
}

function showMenu(x, y, children) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.append(...children);
  document.body.appendChild(menu);

  // Keep the menu inside the window even when opened near an edge.
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;

  openMenu = menu;
  setTimeout(() => {
    window.addEventListener('mousedown', onDocDown, { once: true });
  }, 0);
  return menu;
}

function onDocDown(e) {
  if (openMenu && !openMenu.contains(e.target)) closeContextMenu();
  else if (openMenu) window.addEventListener('mousedown', onDocDown, { once: true });
}

function assignGroup(panes, group) {
  for (const pane of panes) {
    pane.group = group;
    pane._renderMeta();
  }
  bus.emit('target:change');
  bus.emit('session:dirty');
}

export function showPaneMenu(pane, x, y) {
  const selected = state.selection.has(pane.id) && state.selection.size > 1;
  const affected = selected ? [...state.selection].map((id) => state.panes.get(id)).filter(Boolean) : [pane];
  const suffix = affected.length > 1 ? ` (${affected.length})` : '';

  const items = [
    menuTitle(affected.length > 1 ? `${affected.length} Terminals` : pane.name),
    menuItem('Umbenennen', () => startRename(pane), { key: 'F2' }),
    menuItem('Zoomen', () => bus.emit('pane:zoom', pane.id), { key: 'Ctrl+⇧+Z' }),
    menuItem('Im Dateimanager öffnen', () => pane.cwd && api.fs.reveal(pane.cwd), { key: 'Ctrl+⇧+E' }),
    menuItem('Pfad kopieren', () => { api.clipboard.write(pane.cwd || ''); toast('Pfad kopiert'); }),
    menuSep(),
    menuTitle('Gruppe'),
  ];

  for (const group of GROUPS) {
    // Clicking a group everyone is already in removes them from it, so the
    // same row both assigns and clears — no separate "unassign" step.
    const active = affected.every((p) => p.group === group.id);
    items.push(menuItem(
      `Gruppe ${group.label}${active ? '  ✓' : ''}${suffix}`,
      () => assignGroup(affected, active ? null : group.id),
      { swatch: group.color },
    ));
  }

  items.push(
    menuItem('Keine Gruppe', () => assignGroup(affected, null)),
    menuSep(),
    menuItem(
      affected.every((p) => p.muted) ? `Stummschaltung aufheben${suffix}` : `Stummschalten${suffix}`,
      () => {
        const mute = !affected.every((p) => p.muted);
        for (const p of affected) p.setMuted(mute);
      },
    ),
    menuItem(`Prozess neu starten${suffix}`, () => affected.forEach((p) => p.restart())),
    menuSep(),
    menuItem(`Schließen${suffix}`, () => {
      for (const p of affected) bus.emit('pane:close', p.id);
    }, { key: 'Ctrl+W', danger: true }),
  );

  showMenu(x, y, items);
}

export function showTemplateMenu(x, y, onPick) {
  const items = [menuTitle('Neues Terminal mit…')];
  items.push(menuItem('Standard-Shell', () => onPick(null)));
  for (const template of state.templates) {
    items.push(menuItem(template.name, () => onPick(template), { swatch: template.color }));
  }
  items.push(menuSep(), menuItem('Templates-Ordner öffnen…', () => api.templates.openDir()));
  showMenu(x, y, items);
}

export function showFolderMenu(x, y) {
  showMenu(x, y, [
    menuItem('Ordner-Browser…', () => bus.emit('command', 'folders.open'), { key: 'Ctrl+O' }),
    menuItem('Systemdialog…', () => bus.emit('command', 'folders.native'), { key: 'Ctrl+⇧+O' }),
    menuItem('Zuletzt verwendet…', () => bus.emit('command', 'folders.recent')),
    menuSep(),
    menuItem('Ordner des Panes im Dateimanager', () => bus.emit('command', 'folders.reveal'), { key: 'Ctrl+⇧+E' }),
  ]);
}

/* ------------------------------------------------------------- inline rename */

export function startRename(pane) {
  const nameEl = pane.nameEl;
  if (nameEl.dataset.editing) return;
  nameEl.dataset.editing = '1';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'pane-name-input';
  input.value = pane.name;
  input.spellcheck = false;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  const finish = (commit) => {
    if (!input.isConnected) return;
    if (commit) pane.rename(input.value.trim() || pane.name);
    input.replaceWith(nameEl);
    delete nameEl.dataset.editing;
    pane.focus();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

/* ---------------------------------------------------------------- settings */

const settingsSheet = document.getElementById('settingsSheet');
const settingsBody = document.getElementById('settingsBody');

const SETTINGS_SCHEMA = [
  { section: 'Sitzung' },
  { key: 'restoreSession', type: 'boolean', label: 'Sitzung wiederherstellen',
    desc: 'Layout, Ordner und Gruppen beim Start wieder öffnen.' },
  { key: 'confirmClose', type: 'boolean', label: 'Schließen bestätigen',
    desc: 'Vor dem Beenden laufender Prozesse nachfragen.' },

  { section: 'Terminal' },
  { key: 'fontSize', type: 'number', label: 'Schriftgröße', min: 8, max: 28, desc: 'Punkte.' },
  { key: 'fontFamily', type: 'text', label: 'Schriftart',
    desc: 'Leer lassen für die eingebaute Monospace-Reihenfolge.' },
  { key: 'scrollback', type: 'number', label: 'Scrollback', min: 500, max: 200000, step: 500,
    desc: 'Wie viele Zeilen pro Pane aufbewahrt werden.' },
  { key: 'cursorBlink', type: 'boolean', label: 'Cursor blinkt' },
  { key: 'copyOnSelect', type: 'boolean', label: 'Auswahl automatisch kopieren',
    desc: 'Wirkt auf neu geöffnete Panes.' },

  { section: 'Senden' },
  { key: 'staggerMs', type: 'number', label: 'Versatz beim Senden', min: 0, max: 5000, step: 50,
    desc: 'Millisekunden zwischen den Zielen — entlastet API-Ratelimits.' },

  { section: 'Aufmerksamkeit' },
  { key: 'idleAfterMs', type: 'number', label: 'Als "bereit" nach', min: 200, max: 10000, step: 100,
    desc: 'Millisekunden Ruhe, bevor ein Pane als fertig gilt.' },
  { key: 'notifyOnAttention', type: 'boolean', label: 'Systembenachrichtigung',
    desc: 'Melden, wenn ein Terminal auf dich wartet und das Fenster im Hintergrund ist.' },
];

async function updateSetting(key, value) {
  state.settings = await api.settings.set({ [key]: value });
  applyLiveSettings();
}

function applyLiveSettings() {
  for (const pane of state.panes.values()) {
    try {
      pane.term.options.fontSize = state.settings.fontSize || 13;
      if (state.settings.fontFamily) pane.term.options.fontFamily = state.settings.fontFamily;
      pane.term.options.scrollback = state.settings.scrollback || 10000;
      pane.term.options.cursorBlink = state.settings.cursorBlink !== false;
    } catch (_) { /* pane disposed */ }
  }
  scheduleFit();
}

function renderSettings() {
  settingsBody.innerHTML = '';
  for (const field of SETTINGS_SCHEMA) {
    if (field.section) {
      const title = document.createElement('div');
      title.className = 'section-title';
      title.textContent = field.section;
      settingsBody.appendChild(title);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'setting';

    const text = document.createElement('div');
    text.className = 's-text';
    const label = document.createElement('div');
    label.className = 's-label';
    label.textContent = field.label;
    text.appendChild(label);
    if (field.desc) {
      const desc = document.createElement('div');
      desc.className = 's-desc';
      desc.textContent = field.desc;
      text.appendChild(desc);
    }
    row.appendChild(text);

    const control = document.createElement('input');
    if (field.type === 'boolean') {
      control.type = 'checkbox';
      control.checked = state.settings[field.key] !== false;
      control.addEventListener('change', () => updateSetting(field.key, control.checked));
    } else if (field.type === 'number') {
      control.type = 'number';
      control.value = state.settings[field.key] ?? 0;
      if (field.min !== undefined) control.min = field.min;
      if (field.max !== undefined) control.max = field.max;
      if (field.step) control.step = field.step;
      control.addEventListener('change', () => updateSetting(field.key, Number(control.value)));
    } else {
      control.type = 'text';
      control.value = state.settings[field.key] ?? '';
      control.placeholder = 'JetBrains Mono, …';
      control.addEventListener('change', () => updateSetting(field.key, control.value));
    }
    row.appendChild(control);
    settingsBody.appendChild(row);
  }

  const shortcutsTitle = document.createElement('div');
  shortcutsTitle.className = 'section-title';
  shortcutsTitle.textContent = 'Tastenkürzel';
  settingsBody.appendChild(shortcutsTitle);

  const hint = document.createElement('div');
  hint.className = 'setting';
  hint.innerHTML = `<div class="s-text">
      <div class="s-label">Alle Befehle mit Kürzeln</div>
      <div class="s-desc">Die Befehlspalette zeigt jedes Kürzel — <b>Ctrl + K</b>.</div>
    </div>`;
  const openPaletteBtn = document.createElement('button');
  openPaletteBtn.className = 'solid';
  openPaletteBtn.textContent = 'Palette öffnen';
  openPaletteBtn.addEventListener('click', () => {
    closeSettings();
    bus.emit('palette:open');
  });
  hint.appendChild(openPaletteBtn);
  settingsBody.appendChild(hint);
}

export function openSettings() {
  renderSettings();
  settingsSheet.hidden = false;
}

export function closeSettings() {
  settingsSheet.hidden = true;
}

/* ------------------------------------------------------------------ wiring */

export function initUi() {
  bus.on('toast', ({ text, kind }) => toast(text, kind));
  bus.on('status:change', renderStatusChips);

  for (const [kind, el] of Object.entries(chips)) {
    el.addEventListener('click', () => selectByStatus(kind));
  }

  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('settingsCloseBtn').addEventListener('click', closeSettings);
  document.getElementById('openConfigBtn')
    .addEventListener('click', () => api.fs.reveal(state.info.configDir));
  document.getElementById('openTemplatesBtn')
    .addEventListener('click', () => api.templates.openDir());
  settingsSheet.addEventListener('mousedown', (e) => {
    if (e.target === settingsSheet) closeSettings();
  });
  settingsSheet.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSettings();
  });

  bus.on('pane:menu', ({ pane, x, y }) => showPaneMenu(pane, x, y));
  window.addEventListener('blur', closeContextMenu);
}
