import {
  state, bus, leafIds, orderedPanes, insertSplit, removeLeaf, buildGridTree,
  findFirstLeaf, equalizeSizes, selectionIds,
} from './state.js';
import { Pane } from './pane.js';

const gridRoot = document.getElementById('gridRoot');

let fitFrame = 0;
export function scheduleFit() {
  if (fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    for (const pane of state.panes.values()) pane.fit();
  });
}

/* ---------------------------------------------------------------- rendering */

function renderNode(node) {
  if (node.type === 'pane') {
    const pane = state.panes.get(node.id);
    return pane ? pane.el : null;
  }
  const container = document.createElement('div');
  container.className = `split-container split-${node.dir}`;
  node.children.forEach((child, i) => {
    const childEl = renderNode(child);
    if (!childEl) return;
    childEl.style.flex = `${node.sizes[i] ?? 1} 1 0`;
    container.appendChild(childEl);
    if (i < node.children.length - 1) {
      const divider = document.createElement('div');
      divider.className = 'divider';
      divider.addEventListener('mousedown', (e) => startDividerDrag(e, divider, node, i, container));
      container.appendChild(divider);
    }
  });
  return container;
}

export function render() {
  const zoomed = state.zoomedId ? state.panes.get(state.zoomedId) : null;

  if (!state.tree) {
    gridRoot.classList.remove('zoomed');
    gridRoot.replaceChildren(renderEmptyState());
    bus.emit('status:change');
    return;
  }

  const tree = renderNode(state.tree);
  const children = tree ? [tree] : [];

  if (zoomed) {
    gridRoot.classList.add('zoomed');
    zoomed.el.classList.add('zoomed');
    // The zoomed pane is pulled out of the tree so it can cover the grid, but
    // the rest of the tree stays mounted (and its PTYs keep running).
    children.push(zoomed.el);
  } else {
    gridRoot.classList.remove('zoomed');
    for (const pane of state.panes.values()) pane.el.classList.remove('zoomed');
  }

  gridRoot.replaceChildren(...children);
  refreshIndices();
  applySelectionClasses();

  requestAnimationFrame(() => {
    for (const pane of state.panes.values()) pane.mount();
    scheduleFit();
  });
  bus.emit('status:change');
}

function renderEmptyState() {
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';
  wrap.innerHTML = `
    <h2>Noch keine Terminals</h2>
    <p>Öffne mehrere Projektordner auf einmal und steuere alle laufenden CLIs
       von einer Stelle aus.</p>
    <div class="empty-actions">
      <button class="primary" data-action="open-folders">📁 Ordner öffnen</button>
      <button class="solid" data-action="new-terminal">＋ Terminal</button>
    </div>
    <div class="empty-hints">
      <kbd>Ctrl</kbd><span class="desc">+ <kbd>K</kbd> — Befehle</span>
      <kbd>Ctrl</kbd><span class="desc">+ <kbd>O</kbd> — Ordner öffnen</span>
      <kbd>Ctrl</kbd><span class="desc">+ <kbd>T</kbd> — Neues Terminal</span>
      <kbd>Alt</kbd><span class="desc">+ <kbd>1…9</kbd> — Terminal auswählen</span>
    </div>`;
  wrap.querySelector('[data-action="open-folders"]')
    .addEventListener('click', () => bus.emit('command', 'folders.open'));
  wrap.querySelector('[data-action="new-terminal"]')
    .addEventListener('click', () => bus.emit('command', 'pane.new'));
  return wrap;
}

export function refreshIndices() {
  orderedPanes().forEach((pane, i) => pane.setIndex(i + 1));
}

export function applySelectionClasses() {
  const selected = new Set(selectionIds());
  for (const pane of state.panes.values()) {
    pane.el.classList.toggle('selected', selected.has(pane.id));
    pane.el.classList.toggle('focused', pane.id === state.focusedId);
  }
}

/* ----------------------------------------------------------------- resizing */

function startDividerDrag(event, divider, node, index, container) {
  event.preventDefault();
  divider.classList.add('dragging');
  document.body.classList.add('resizing');

  const isRow = node.dir === 'row';
  const rect = container.getBoundingClientRect();
  const totalPx = isRow ? rect.width : rect.height;
  const startPos = isRow ? event.clientX : event.clientY;
  const startA = node.sizes[index];
  const startB = node.sizes[index + 1];
  const totalFlex = startA + startB;
  const minFlex = totalFlex * 0.08;

  // Children alternate [child, divider, child, divider, …].
  const elA = container.children[index * 2];
  const elB = container.children[index * 2 + 2];

  let frame = 0;
  function onMove(ev) {
    const pos = isRow ? ev.clientX : ev.clientY;
    const delta = totalPx ? ((pos - startPos) / totalPx) * totalFlex : 0;
    let a = startA + delta;
    let b = startB - delta;
    if (a < minFlex) { b -= minFlex - a; a = minFlex; }
    if (b < minFlex) { a -= minFlex - b; b = minFlex; }
    node.sizes[index] = a;
    node.sizes[index + 1] = b;
    elA.style.flex = `${a} 1 0`;
    elB.style.flex = `${b} 1 0`;
    // Re-fitting every terminal on every mousemove is what made dragging feel
    // sticky; one fit per animation frame is smooth and still live.
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        for (const pane of state.panes.values()) pane.fit();
      });
    }
  }

  function onUp() {
    divider.classList.remove('dragging');
    document.body.classList.remove('resizing');
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    scheduleFit();
    bus.emit('session:dirty');
  }

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

/* ------------------------------------------------------------ pane lifecycle */

export function createPane(opts = {}) {
  const pane = new Pane(opts);
  state.panes.set(pane.id, pane);
  return pane;
}

// New panes start in the folder you were just working in — splitting a pane to
// run a second tool against the same project is the common case, and having to
// re-`cd` every time is the kind of friction that adds up.
function withInheritedCwd(opts) {
  if (opts.cwd || opts.template?.cwd) return opts;
  const source = state.panes.get(state.focusedId);
  return source?.cwd ? { ...opts, cwd: source.cwd, name: opts.name } : opts;
}

export function addPane(opts = {}) {
  if (!state.tree) {
    const pane = createPane(opts);
    state.tree = { type: 'pane', id: pane.id };
    setFocus(pane.id);
    render();
    bus.emit('session:dirty');
    return pane;
  }
  // Adding a terminal splits the focused pane along its longer axis, which
  // keeps panes roughly square and — unlike rebuilding the grid — leaves every
  // divider the user already dragged exactly where it was.
  const anchor = state.panes.get(state.focusedId) || state.panes.get(findFirstLeaf(state.tree));
  const rect = anchor?.el.getBoundingClientRect();
  const dir = !rect || rect.width >= rect.height ? 'row' : 'col';
  return splitPane(dir, opts);
}

export function splitPane(dir, opts = {}) {
  if (!state.tree) return addPane(opts);
  const targetId = state.panes.has(state.focusedId) ? state.focusedId : findFirstLeaf(state.tree);
  const pane = createPane(withInheritedCwd(opts));
  state.tree = insertSplit(state.tree, targetId, dir, pane.id);
  setFocus(pane.id);
  render();
  bus.emit('session:dirty');
  return pane;
}

export function closePane(id) {
  const pane = state.panes.get(id);
  if (!pane) return;
  pane.dispose();
  state.panes.delete(id);
  state.selection.delete(id);
  state.tree = removeLeaf(state.tree, id);
  if (state.zoomedId === id) state.zoomedId = null;
  if (state.focusedId === id) state.focusedId = findFirstLeaf(state.tree);
  render();
  if (state.focusedId) state.panes.get(state.focusedId)?.focus();
  bus.emit('selection:change');
  bus.emit('session:dirty');
}

export function closeAllPanes() {
  for (const pane of [...state.panes.values()]) pane.dispose();
  state.panes.clear();
  state.selection.clear();
  state.tree = null;
  state.focusedId = null;
  state.zoomedId = null;
}

export function setFocus(id) {
  if (!state.panes.has(id)) return;
  state.focusedId = id;
  applySelectionClasses();
  state.panes.get(id).focus();
  bus.emit('focus:change', id);
}

export function toggleZoom(id) {
  const target = id || state.focusedId;
  if (!target || !state.panes.has(target)) return;
  state.zoomedId = state.zoomedId === target ? null : target;
  render();
  if (state.zoomedId) state.panes.get(state.zoomedId)?.focus();
}

// Alt+Arrow navigation: pick the pane whose centre is nearest in the requested
// direction, which behaves the way people expect in an arbitrary split tree.
export function navigate(direction) {
  const current = state.panes.get(state.focusedId) || orderedPanes()[0];
  if (!current) return;
  const from = current.el.getBoundingClientRect();
  const fx = from.left + from.width / 2;
  const fy = from.top + from.height / 2;

  let best = null;
  let bestScore = Infinity;
  for (const pane of state.panes.values()) {
    if (pane === current) continue;
    const r = pane.el.getBoundingClientRect();
    const dx = r.left + r.width / 2 - fx;
    const dy = r.top + r.height / 2 - fy;
    const matches = { left: dx < -8, right: dx > 8, up: dy < -8, down: dy > 8 }[direction];
    if (!matches) continue;
    const along = direction === 'left' || direction === 'right' ? Math.abs(dx) : Math.abs(dy);
    const across = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
    const score = along + across * 2;
    if (score < bestScore) { bestScore = score; best = pane; }
  }
  if (best) setFocus(best.id);
}

/* -------------------------------------------------------------- grid shapes */

export function balance() {
  const ids = leafIds();
  if (ids.length === 0) return;
  state.tree = buildGridTree(ids);
  render();
  bus.emit('session:dirty');
}

export function equalize() {
  if (!state.tree) return;
  equalizeSizes(state.tree);
  render();
  bus.emit('session:dirty');
}

// Reshapes into rows × cols WITHOUT killing running processes: existing panes
// are reused in order, missing ones are spawned, and surplus ones are only
// closed after the user confirms.
export async function applyPreset(rows, cols, { template } = {}) {
  const wanted = rows * cols;
  const existing = leafIds();

  if (existing.length > wanted) {
    const surplus = existing.length - wanted;
    const ok = await window.api.confirm({
      title: 'Layout anwenden',
      message: `${surplus} Terminal${surplus === 1 ? '' : 's'} schließen?`,
      detail: `Das Layout ${rows} × ${cols} fasst ${wanted} Terminals, offen sind ${existing.length}. Die überzähligen Prozesse werden beendet.`,
      confirmLabel: 'Schließen',
    });
    if (!ok) return;
    for (const id of existing.slice(wanted)) {
      state.panes.get(id)?.dispose();
      state.panes.delete(id);
      state.selection.delete(id);
    }
  }

  const ids = leafIds().filter((id) => state.panes.has(id)).slice(0, wanted);
  while (ids.length < wanted) ids.push(createPane(withInheritedCwd({ template })).id);

  state.tree = buildGridTree(ids, { rows, cols });
  state.zoomedId = null;
  if (!state.panes.has(state.focusedId)) state.focusedId = ids[0] || null;
  render();
  bus.emit('selection:change');
  bus.emit('session:dirty');
}

// Opens one pane per folder. `replace` closes what is open first; otherwise the
// new panes are appended and the whole grid is rebalanced.
export function openFolders(folders, { template, replace } = {}) {
  if (!folders || folders.length === 0) return [];
  if (replace) closeAllPanes();

  const created = folders.map((folder) => createPane({
    template,
    cwd: folder.path,
    name: folder.name || folder.path,
  }));

  state.tree = buildGridTree([...leafIds(), ...created.map((p) => p.id)]);
  state.zoomedId = null;
  setFocusSafe(created[0].id);
  render();
  bus.emit('session:dirty');
  return created;
}

function setFocusSafe(id) {
  if (state.panes.has(id)) {
    state.focusedId = id;
    applySelectionClasses();
  }
}

window.addEventListener('resize', scheduleFit);
