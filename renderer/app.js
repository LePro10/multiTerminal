let nextId = 1;
const genId = () => `p${nextId++}`;

const state = {
  tree: null, // null | {type:'pane', id} | {type:'split', dir:'row'|'col', children:[node,node], sizes:[n,n]}
  panes: new Map(),
  focusedId: null,
  templates: [],
};

const gridRoot = document.getElementById('gridRoot');
const templateSelect = document.getElementById('templateSelect');
const addFirstBtn = document.getElementById('addFirstBtn');
const splitRowBtn = document.getElementById('splitRowBtn');
const splitColBtn = document.getElementById('splitColBtn');
const presetSelect = document.getElementById('presetSelect');
const openFolderBtn = document.getElementById('openFolderBtn');
const broadcastInput = document.getElementById('broadcastInput');
const broadcastEnter = document.getElementById('broadcastEnter');
const broadcastBtn = document.getElementById('broadcastBtn');

async function loadTemplates() {
  state.templates = await window.api.listTemplates();
  templateSelect.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = 'Blank Shell';
  templateSelect.appendChild(blank);
  for (const t of state.templates) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    templateSelect.appendChild(opt);
  }
}

function getSelectedTemplate() {
  return state.templates.find((t) => t.id === templateSelect.value) || null;
}

function createPaneRuntime(template, overrides = {}) {
  const id = genId();
  const cwd = overrides.cwd || (template ? template.cwd : '~');
  const displayName = overrides.name || (template ? template.name : 'Shell');

  const el = document.createElement('div');
  el.className = 'pane';
  el.dataset.paneId = id;

  const header = document.createElement('div');
  header.className = 'pane-header';

  const dot = document.createElement('span');
  dot.className = 'pane-color-dot';
  dot.style.background = template ? template.color : '#888';

  const nameEl = document.createElement('span');
  nameEl.className = 'pane-name';
  nameEl.textContent = displayName;
  nameEl.title = cwd;

  const includeLabel = document.createElement('label');
  const includeCheckbox = document.createElement('input');
  includeCheckbox.type = 'checkbox';
  includeCheckbox.checked = true;
  includeCheckbox.title = 'Include this pane in broadcasts';
  includeCheckbox.addEventListener('change', () => {
    pane.excluded = !includeCheckbox.checked;
  });
  includeLabel.appendChild(includeCheckbox);
  includeLabel.appendChild(document.createTextNode('bcast'));

  const closeBtn = document.createElement('button');
  closeBtn.className = 'pane-close';
  closeBtn.textContent = '✕';
  closeBtn.title = 'Close terminal';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closePane(id);
  });

  header.appendChild(dot);
  header.appendChild(nameEl);
  header.appendChild(includeLabel);
  header.appendChild(closeBtn);

  const termContainer = document.createElement('div');
  termContainer.className = 'pane-term';

  el.appendChild(header);
  el.appendChild(termContainer);
  el.addEventListener('mousedown', () => setFocused(id));

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    theme: { background: '#1e1e1e' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(termContainer);

  const pane = { id, excluded: false, term, fit, el, termContainer };
  state.panes.set(id, pane);

  window.api.createTerminal(id, {
    command: template ? template.command : undefined,
    args: template ? template.args : undefined,
    cwd,
    env: template ? template.env : undefined,
    cols: 80,
    rows: 24,
  });

  term.onData((data) => window.api.writeTerminal(id, data));
  term.onResize(({ cols, rows }) => window.api.resizeTerminal(id, cols, rows));

  pane.unsubData = window.api.onTerminalData(id, (data) => term.write(data));
  pane.unsubExit = window.api.onTerminalExit(id, () => {
    term.write('\r\n\x1b[31m[process exited]\x1b[0m\r\n');
  });

  return pane;
}

function disposePane(id) {
  const pane = state.panes.get(id);
  if (!pane) return;
  pane.unsubData?.();
  pane.unsubExit?.();
  try { pane.term.dispose(); } catch (_) { /* already disposed */ }
  window.api.killTerminal(id);
  state.panes.delete(id);
}

function setFocused(id) {
  state.focusedId = id;
  for (const p of state.panes.values()) {
    p.el.classList.toggle('focused', p.id === id);
  }
  state.panes.get(id)?.term.focus();
}

function getAnyLeafId(node) {
  if (!node) return null;
  if (node.type === 'pane') return node.id;
  return getAnyLeafId(node.children[0]);
}

function insertSplit(node, targetId, dir, newId) {
  if (node.type === 'pane') {
    if (node.id !== targetId) return node;
    return {
      type: 'split',
      dir,
      children: [node, { type: 'pane', id: newId }],
      sizes: [1, 1],
    };
  }
  return { ...node, children: node.children.map((c) => insertSplit(c, targetId, dir, newId)) };
}

function removeLeaf(node, id) {
  if (!node) return null;
  if (node.type === 'pane') {
    return node.id === id ? null : node;
  }
  const newChildren = node.children.map((c) => removeLeaf(c, id)).filter((c) => c !== null);
  if (newChildren.length === 0) return null;
  if (newChildren.length === 1) return newChildren[0];
  return { ...node, children: newChildren, sizes: newChildren.map(() => 1) };
}

function addFirstTerminal() {
  const template = getSelectedTemplate();
  const pane = createPaneRuntime(template);
  state.tree = { type: 'pane', id: pane.id };
  setFocused(pane.id);
  render();
}

function splitFocused(dir) {
  if (!state.tree) {
    addFirstTerminal();
    return;
  }
  const targetId = state.panes.has(state.focusedId) ? state.focusedId : getAnyLeafId(state.tree);
  const template = getSelectedTemplate();
  const newPane = createPaneRuntime(template);
  state.tree = insertSplit(state.tree, targetId, dir, newPane.id);
  setFocused(newPane.id);
  render();
}

function closePane(id) {
  if (!state.panes.has(id)) return;
  disposePane(id);
  state.tree = removeLeaf(state.tree, id);
  if (state.focusedId === id) state.focusedId = null;
  render();
}

function disposeAllPanes() {
  for (const id of [...state.panes.keys()]) disposePane(id);
  state.focusedId = null;
}

function applyPreset(rows, cols) {
  disposeAllPanes();

  const template = getSelectedTemplate();
  const rowNodes = [];
  for (let r = 0; r < rows; r++) {
    const colNodes = [];
    for (let c = 0; c < cols; c++) {
      const pane = createPaneRuntime(template);
      colNodes.push({ type: 'pane', id: pane.id });
    }
    rowNodes.push(
      colNodes.length === 1
        ? colNodes[0]
        : { type: 'split', dir: 'row', children: colNodes, sizes: colNodes.map(() => 1) }
    );
  }
  state.tree = rowNodes.length === 1
    ? rowNodes[0]
    : { type: 'split', dir: 'col', children: rowNodes, sizes: rowNodes.map(() => 1) };

  render();
}

// Near-square auto layout: rows = floor(sqrt(n)), cols = ceil(n/rows).
// For n=3 this gives a single row of 3 (each 33% wide), matching a simple
// "split evenly" expectation instead of e.g. an uneven 2+1 grid.
function computeGridDims(n) {
  const rows = Math.max(1, Math.floor(Math.sqrt(n)));
  const cols = Math.ceil(n / rows);
  return { rows, cols };
}

function buildAutoGridTree(paneIds) {
  const n = paneIds.length;
  if (n === 0) return null;
  const { rows, cols } = computeGridDims(n);

  const rowNodes = [];
  let idx = 0;
  for (let r = 0; r < rows && idx < n; r++) {
    const count = Math.min(cols, n - idx);
    const nodes = paneIds.slice(idx, idx + count).map((id) => ({ type: 'pane', id }));
    idx += count;
    rowNodes.push(
      nodes.length === 1
        ? nodes[0]
        : { type: 'split', dir: 'row', children: nodes, sizes: nodes.map(() => 1) }
    );
  }
  return rowNodes.length === 1
    ? rowNodes[0]
    : { type: 'split', dir: 'col', children: rowNodes, sizes: rowNodes.map(() => 1) };
}

async function openFolderTerminals() {
  const result = await window.api.pickFolderAndListSubfolders();
  if (!result) return;
  if (!result.subfolders || result.subfolders.length === 0) {
    alert(`No subfolders found in "${result.parent}".`);
    return;
  }

  disposeAllPanes();

  const template = getSelectedTemplate();
  const paneIds = result.subfolders.map(
    (f) => createPaneRuntime(template, { cwd: f.path, name: f.name }).id
  );
  state.tree = buildAutoGridTree(paneIds);
  render();
}

function attachDividerDrag(divider, node, index, container) {
  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    divider.classList.add('dragging');
    const isRow = node.dir === 'row';
    const rect = container.getBoundingClientRect();
    const totalSize = isRow ? rect.width : rect.height;
    const startPos = isRow ? e.clientX : e.clientY;
    const startA = node.sizes[index];
    const startB = node.sizes[index + 1];
    const totalFlex = startA + startB;
    const minSize = totalFlex * 0.05;

    function onMove(ev) {
      const pos = isRow ? ev.clientX : ev.clientY;
      const delta = ((pos - startPos) / totalSize) * totalFlex;
      let newA = startA + delta;
      let newB = startB - delta;
      if (newA < minSize) { newB -= (minSize - newA); newA = minSize; }
      if (newB < minSize) { newA -= (minSize - newB); newB = minSize; }
      node.sizes[index] = newA;
      node.sizes[index + 1] = newB;
      const children = container.children;
      children[index * 2].style.flex = `${newA} 1 0`;
      children[index * 2 + 2].style.flex = `${newB} 1 0`;
      fitAll();
    }
    function onUp() {
      divider.classList.remove('dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

function renderNode(node) {
  if (node.type === 'pane') {
    return state.panes.get(node.id).el;
  }
  const container = document.createElement('div');
  container.className = `split-container split-${node.dir}`;
  node.children.forEach((child, i) => {
    const childEl = renderNode(child);
    childEl.style.flex = `${node.sizes[i]} 1 0`;
    container.appendChild(childEl);
    if (i < node.children.length - 1) {
      const divider = document.createElement('div');
      divider.className = 'divider';
      attachDividerDrag(divider, node, i, container);
      container.appendChild(divider);
    }
  });
  return container;
}

function render() {
  gridRoot.innerHTML = '';
  addFirstBtn.style.display = state.tree ? 'none' : '';
  splitRowBtn.style.display = state.tree ? '' : 'none';
  splitColBtn.style.display = state.tree ? '' : 'none';

  if (!state.tree) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Click "+ Terminal" to get started';
    gridRoot.appendChild(empty);
    return;
  }
  gridRoot.appendChild(renderNode(state.tree));
  requestAnimationFrame(fitAll);
}

function fitAll() {
  for (const pane of state.panes.values()) {
    try { pane.fit.fit(); } catch (_) { /* container not measurable yet */ }
  }
}

function doBroadcast() {
  const text = broadcastInput.value;
  if (!text) return;
  const payload = text + (broadcastEnter.checked ? '\r' : '');
  for (const pane of state.panes.values()) {
    if (!pane.excluded) window.api.writeTerminal(pane.id, payload);
  }
  broadcastInput.value = '';
  broadcastInput.focus();
}

addFirstBtn.addEventListener('click', addFirstTerminal);
splitRowBtn.addEventListener('click', () => splitFocused('row'));
splitColBtn.addEventListener('click', () => splitFocused('col'));
presetSelect.addEventListener('change', (e) => {
  const val = e.target.value;
  e.target.value = '';
  if (!val) return;
  const [rows, cols] = val.split('x').map(Number);
  applyPreset(rows, cols);
});
openFolderBtn.addEventListener('click', openFolderTerminals);
broadcastBtn.addEventListener('click', doBroadcast);
broadcastInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doBroadcast();
});
window.addEventListener('resize', fitAll);

render();
loadTemplates();
