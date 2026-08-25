import { state, bus, GROUPS, targetPanes, setTarget, orderedPanes, selectionIds } from './state.js';

const api = window.api;

const input = document.getElementById('composerInput');
const sendBtn = document.getElementById('sendBtn');
const sendEnter = document.getElementById('sendEnter');
const useVars = document.getElementById('useVars');
const targetChips = document.getElementById('targetChips');
const targetSummary = document.getElementById('targetSummary');
const promptChips = document.getElementById('promptChips');
const promptSaveBtn = document.getElementById('promptSaveBtn');
const quickKeys = document.getElementById('quickKeys');

const HISTORY_KEY = 'multiterminal.composer.history';
let history = [];
let historyIndex = -1;
let draft = '';

const QUICK_KEYS = [
  { label: '⏎', data: '\r', title: 'Enter senden' },
  { label: 'y', data: 'y\r', title: 'y + Enter — Nachfrage bestätigen' },
  { label: 'n', data: 'n\r', title: 'n + Enter — Nachfrage ablehnen' },
  { label: '1', data: '1\r', title: '1 + Enter — erste Option wählen' },
  { label: 'esc', data: '\x1b', title: 'Escape — laufende Antwort stoppen' },
  { label: '^C', data: '\x03', title: 'Ctrl+C — Prozess abbrechen' },
  { label: '↑⏎', data: '\x1b[A\r', title: 'Letzten Befehl wiederholen' },
  { label: 'clear', data: 'clear\r', title: 'Bildschirm leeren' },
];

function loadHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    history = Array.isArray(raw) ? raw.filter((s) => typeof s === 'string') : [];
  } catch (_) {
    history = [];
  }
}

function pushHistory(text) {
  if (!text.trim()) return;
  history = [text, ...history.filter((h) => h !== text)].slice(0, 100);
  historyIndex = -1;
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (_) { /* quota */ }
}

/* ------------------------------------------------------------------ targets */

export function renderTargets() {
  const panes = orderedPanes();
  const selected = selectionIds().length;

  const chips = [
    { id: 'all', label: 'Alle', count: panes.filter((p) => !p.muted).length, color: null },
    { id: 'selection', label: 'Auswahl', count: selected, color: null },
  ];
  for (const group of GROUPS) {
    const count = panes.filter((p) => p.group === group.id).length;
    if (count > 0) chips.push({ id: group.id, label: group.label, count, color: group.color, group: true });
  }

  targetChips.innerHTML = '';
  for (const chip of chips) {
    const btn = document.createElement('button');
    btn.className = `target-chip${chip.group ? ' group' : ''}${state.target === chip.id ? ' active' : ''}`;
    if (chip.color) btn.style.setProperty('--chip-color', chip.color);
    btn.innerHTML = `${chip.label} <span class="count">${chip.count}</span>`;
    btn.title = chip.group
      ? `Nur an Gruppe ${chip.label} senden`
      : chip.id === 'all' ? 'An alle nicht stummgeschalteten Terminals senden'
        : 'Nur an die ausgewählten Terminals senden';
    btn.addEventListener('click', () => setTarget(chip.id));
    targetChips.appendChild(btn);
  }

  const targets = targetPanes();
  targetSummary.classList.toggle('empty', targets.length === 0);
  if (panes.length === 0) {
    targetSummary.textContent = 'Kein Terminal offen';
  } else if (targets.length === 0) {
    targetSummary.innerHTML = '<strong>0</strong> Ziele — nichts ausgewählt';
  } else {
    targetSummary.innerHTML = `an <strong>${targets.length}</strong> von ${panes.length}`;
  }
  sendBtn.disabled = targets.length === 0;
}

/* ------------------------------------------------------------------ prompts */

export function renderPrompts() {
  promptChips.innerHTML = '';
  for (const prompt of state.prompts) {
    const chip = document.createElement('button');
    chip.className = 'prompt-chip';
    chip.textContent = prompt.label || prompt.text.slice(0, 24);
    chip.title = `${prompt.text}\n\nKlick: einfügen · Shift+Klick: sofort senden · Rechtsklick: löschen`;
    chip.addEventListener('click', (e) => {
      if (e.shiftKey) {
        send(prompt.text);
      } else {
        input.value = prompt.text;
        autoGrow();
        input.focus();
      }
    });
    chip.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      state.prompts = state.prompts.filter((p) => p.id !== prompt.id);
      await api.prompts.set(state.prompts);
      renderPrompts();
      bus.emit('toast', { text: `Prompt "${chip.textContent}" gelöscht` });
    });
    promptChips.appendChild(chip);
  }
}

async function savePrompt() {
  const text = input.value.trim();
  if (!text) {
    bus.emit('toast', { text: 'Erst einen Prompt tippen', kind: 'warn' });
    return;
  }
  const label = text.split('\n')[0].slice(0, 22);
  state.prompts = [...state.prompts, { id: `p${Date.now()}`, label, text }];
  await api.prompts.set(state.prompts);
  renderPrompts();
  bus.emit('toast', { text: `Prompt "${label}" gespeichert` });
}

/* --------------------------------------------------------------------- send */

function basename(p) {
  if (!p) return '';
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

function substitute(text, pane, index, total) {
  return text.replace(/\{\{\s*(folder|path|name|index|count|group)\s*\}\}/g, (_m, key) => {
    switch (key) {
      case 'folder': return basename(pane.cwd);
      case 'path': return pane.cwd || '';
      case 'name': return pane.name || '';
      case 'index': return String(index + 1);
      case 'count': return String(total);
      case 'group': return pane.group || '';
      default: return '';
    }
  });
}

export async function send(overrideText) {
  const raw = overrideText !== undefined ? overrideText : input.value;
  if (!raw) return;

  const targets = targetPanes();
  if (targets.length === 0) {
    bus.emit('toast', { text: 'Keine Ziel-Terminals — wähle Panes aus oder schalte auf "Alle"', kind: 'warn' });
    return;
  }

  const withEnter = sendEnter.checked;
  const vars = useVars.checked;
  const stagger = Math.max(0, Number(state.settings.staggerMs) || 0);

  targets.forEach((pane, i) => {
    const text = vars ? substitute(raw, pane, i, targets.length) : raw;
    // Multi-line prompts are sent as-is; only the final newline is what makes
    // the CLI act on them, so a trailing \r is added once at the end.
    const payload = text.replace(/\n/g, '\r') + (withEnter ? '\r' : '');
    const deliver = () => {
      pane.write(payload);
      pane.clearAttention();
    };
    if (stagger > 0 && i > 0) setTimeout(deliver, stagger * i);
    else deliver();
  });

  if (overrideText === undefined) {
    pushHistory(raw);
    input.value = '';
    autoGrow();
  }
  bus.emit('toast', { text: `Gesendet an ${targets.length} Terminal${targets.length === 1 ? '' : 's'}` });
  input.focus();
}

export function sendRaw(data) {
  const targets = targetPanes();
  if (targets.length === 0) {
    bus.emit('toast', { text: 'Keine Ziel-Terminals', kind: 'warn' });
    return;
  }
  for (const pane of targets) {
    pane.write(data);
    pane.clearAttention();
  }
}

/* ---------------------------------------------------------------- textarea */

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

export function focusComposer() {
  input.focus();
  input.select();
}

export function insertIntoComposer(text) {
  input.value = text;
  autoGrow();
  input.focus();
}

/* ------------------------------------------------------------------- setup */

export function initComposer() {
  loadHistory();
  sendEnter.checked = state.settings.sendEnter !== false;
  useVars.checked = state.settings.useVars !== false;
  renderTargets();
  renderPrompts();

  quickKeys.innerHTML = '';
  for (const key of QUICK_KEYS) {
    const btn = document.createElement('button');
    btn.textContent = key.label;
    btn.title = `${key.title} — an die aktuellen Ziele`;
    btn.addEventListener('click', () => sendRaw(key.data));
    quickKeys.appendChild(btn);
  }

  input.addEventListener('input', () => {
    autoGrow();
    historyIndex = -1;
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      input.blur();
      const focused = state.panes.get(state.focusedId);
      focused?.focus();
      return;
    }
    // History only takes over the arrow keys when the caret is at the very
    // edge, so editing a multi-line prompt still works normally.
    if (e.key === 'ArrowUp' && input.selectionStart === 0 && history.length) {
      e.preventDefault();
      if (historyIndex === -1) draft = input.value;
      historyIndex = Math.min(historyIndex + 1, history.length - 1);
      input.value = history[historyIndex];
      autoGrow();
      return;
    }
    if (e.key === 'ArrowDown' && input.selectionStart === input.value.length && historyIndex >= 0) {
      e.preventDefault();
      historyIndex -= 1;
      input.value = historyIndex === -1 ? draft : history[historyIndex];
      autoGrow();
    }
  });

  sendBtn.addEventListener('click', () => send());
  promptSaveBtn.addEventListener('click', savePrompt);
  sendEnter.addEventListener('change', async () => {
    state.settings = await api.settings.set({ sendEnter: sendEnter.checked });
  });
  useVars.addEventListener('change', async () => {
    state.settings = await api.settings.set({ useVars: useVars.checked });
  });

  bus.on('target:change', renderTargets);
  bus.on('selection:change', renderTargets);
  bus.on('status:change', renderTargets);
}
