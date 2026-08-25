import {
  state, bus, serializeSession, hydrateTree, toggleSelection, selectRange,
  orderedPanes, leafIds, setTarget, buildGridTree,
} from './state.js';
import {
  render, addPane, splitPane, closePane, toggleZoom, setFocus, createPane,
  applyPreset, balance, scheduleFit,
} from './layout.js';
import { initComposer, renderTargets, renderPrompts } from './composer.js';
import { initFolders, openFolderSheet } from './folders.js';
import { initUi, renderStatusChips, toast, showTemplateMenu, showFolderMenu, closeContextMenu } from './ui.js';
import { initShortcuts, initPalette, openPalette, run } from './commands.js';

const api = window.api;

const templateSelect = document.getElementById('templateSelect');
const presetSelect = document.getElementById('presetSelect');

/* --------------------------------------------------------------- templates */

async function loadTemplates(preserveSelection = true) {
  const previous = templateSelect.value;
  state.templates = await api.templates.list();
  templateSelect.innerHTML = '';

  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = 'Standard-Shell';
  templateSelect.appendChild(blank);

  for (const template of state.templates) {
    const option = document.createElement('option');
    option.value = template.id;
    option.textContent = template.name;
    templateSelect.appendChild(option);
  }
  const wanted = preserveSelection ? previous : (state.settings.lastTemplateId || '');
  if ([...templateSelect.options].some((o) => o.value === wanted)) templateSelect.value = wanted;
}

function currentTemplate() {
  return state.templates.find((t) => t.id === templateSelect.value) || null;
}

/* ----------------------------------------------------------------- session */

let sessionTimer = null;

function scheduleSessionSave() {
  if (state.restoring) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    api.session.set(serializeSession()).catch(() => { /* disk full or read-only */ });
  }, 700);
}

async function restoreSession() {
  if (state.settings.restoreSession === false) return false;
  const saved = await api.session.get();
  if (!saved || !saved.tree || !Array.isArray(saved.panes) || saved.panes.length === 0) return false;

  state.restoring = true;
  const idBySlot = new Map();
  saved.panes.forEach((meta, slot) => {
    const template = state.templates.find((t) => t.id === meta.templateId) || null;
    const pane = createPane({
      template,
      cwd: meta.cwd,
      name: meta.name,
      group: meta.group,
      muted: meta.muted,
    });
    pane.renamed = !!meta.renamed;
    idBySlot.set(slot, pane.id);
  });

  state.tree = hydrateTree(saved.tree, idBySlot) || buildGridTree([...idBySlot.values()]);
  state.focusedId = leafIds()[0] || null;
  state.target = saved.target && saved.target !== 'selection' ? saved.target : 'all';
  render();
  state.restoring = false;

  toast(`Sitzung wiederhergestellt — ${saved.panes.length} Terminals`);
  return true;
}

/* ------------------------------------------------------------ pane plumbing */

function wirePaneEvents() {
  bus.on('pane:close', async (id) => {
    const pane = state.panes.get(id);
    if (!pane) return;
    if (state.settings.confirmClose !== false && !pane.exited && pane.status === 'running') {
      const ok = await api.confirm({
        title: 'Pane schließen',
        message: `"${pane.name}" läuft gerade.`,
        detail: 'Der Prozess wird beendet.',
        confirmLabel: 'Schließen',
      });
      if (!ok) return;
    }
    closePane(id);
  });

  bus.on('pane:zoom', (id) => toggleZoom(id));
  bus.on('pane:focus', (id) => {
    if (state.focusedId !== id) setFocus(id);
  });

  bus.on('pane:headerClick', ({ pane, event }) => {
    if (event.shiftKey && state.focusedId) {
      selectRange(state.focusedId, pane.id);
    } else if (event.ctrlKey || event.metaKey) {
      toggleSelection(pane.id, false);
    } else {
      toggleSelection(pane.id, true);
    }
    setFocus(pane.id);
  });

  bus.on('pane:toggleSelect', ({ id }) => {
    toggleSelection(id, false);
    setFocus(id);
  });

  bus.on('selection:change', () => {
    for (const pane of state.panes.values()) {
      pane.el.classList.toggle('selected', state.selection.has(pane.id));
    }
    renderTargets();
  });

  bus.on('focus:change', () => {
    for (const pane of state.panes.values()) {
      pane.el.classList.toggle('focused', pane.id === state.focusedId);
    }
  });

  bus.on('session:dirty', scheduleSessionSave);
  bus.on('status:change', renderStatusChips);

  bus.on('pane:attention', ({ pane, reason }) => {
    renderStatusChips();
    if (state.settings.notifyOnAttention === false) return;
    if (!state.windowFocused) {
      api.notify(`${pane.name} wartet auf dich`, reason || 'Das Terminal erwartet eine Eingabe.');
      api.flashWindow();
    }
  });

  bus.on('templates:reload', async () => {
    await loadTemplates();
    toast(`${state.templates.length} Templates geladen`);
  });

  bus.on('palette:open', openPalette);
}

/* ----------------------------------------------------------------- toolbar */

function wireToolbar() {
  templateSelect.addEventListener('change', async () => {
    state.settings = await api.settings.set({ lastTemplateId: templateSelect.value });
  });

  document.getElementById('newTermBtn')
    .addEventListener('click', () => addPane({ template: currentTemplate() }));

  document.getElementById('newTermMenuBtn').addEventListener('click', (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    showTemplateMenu(rect.left, rect.bottom + 4, (template) => {
      templateSelect.value = template ? template.id : '';
      addPane({ template });
    });
  });

  document.getElementById('splitRightBtn')
    .addEventListener('click', () => splitPane('row', { template: currentTemplate() }));
  document.getElementById('splitDownBtn')
    .addEventListener('click', () => splitPane('col', { template: currentTemplate() }));

  document.getElementById('openFoldersBtn').addEventListener('click', () => openFolderSheet());
  document.getElementById('openFoldersMenuBtn').addEventListener('click', (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    showFolderMenu(rect.left - 60, rect.bottom + 4);
  });

  document.getElementById('zoomBtn').addEventListener('click', () => toggleZoom());
  document.getElementById('closePaneBtn')
    .addEventListener('click', () => state.focusedId && bus.emit('pane:close', state.focusedId));
  document.getElementById('searchBtn')
    .addEventListener('click', () => state.panes.get(state.focusedId)?.toggleSearch(true));

  presetSelect.addEventListener('change', (e) => {
    const value = e.target.value;
    e.target.value = '';
    if (!value) return;
    if (value === 'auto') {
      balance();
      return;
    }
    const [rows, cols] = value.split('x').map(Number);
    applyPreset(rows, cols, { template: currentTemplate() });
  });
}

/* -------------------------------------------------------------------- boot */

async function boot() {
  state.info = await api.info();
  state.settings = await api.settings.get();
  state.prompts = await api.prompts.get();
  await loadTemplates(false);

  initUi();
  wirePaneEvents();
  wireToolbar();
  initComposer();
  initFolders();
  initPalette();
  initShortcuts();
  renderPrompts();

  api.onWindowFocus((focused) => {
    state.windowFocused = focused;
    if (focused) closeContextMenu();
  });

  const restored = await restoreSession();
  if (!restored) render();

  renderTargets();
  renderStatusChips();

  // Terminals are laid out with flexbox, so a window resize needs one more fit
  // pass after the browser settles.
  window.addEventListener('resize', scheduleFit);
  new ResizeObserver(() => scheduleFit()).observe(document.getElementById('gridRoot'));

  window.addEventListener('beforeunload', () => {
    if (!state.restoring) api.session.set(serializeSession());
  });

  // Clicking empty grid space clears a selection, the same way a file manager
  // behaves — it is the fastest way back to "send to all".
  document.getElementById('gridRoot').addEventListener('mousedown', (e) => {
    if (e.target.id === 'gridRoot' || e.target.classList.contains('split-container')) {
      state.selection.clear();
      setTarget('all');
      bus.emit('selection:change');
    }
  });
}

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<div class="empty-state"><h2>Start fehlgeschlagen</h2><p>${err.message}</p></div>`;
});

// Exposed for quick debugging from the devtools console.
window.__mt = { state, bus, run, orderedPanes };
