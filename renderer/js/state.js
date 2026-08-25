// Central app state, a tiny event bus, and pure helpers for the layout tree.
// Nothing in here touches the DOM.

const listeners = new Map();

export const bus = {
  on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => listeners.get(event)?.delete(handler);
  },
  emit(event, payload) {
    for (const handler of listeners.get(event) || []) {
      try { handler(payload); } catch (err) { console.error(`[${event}]`, err); }
    }
  },
};

export const GROUPS = [
  { id: 'g1', label: 'A', color: 'var(--g1)' },
  { id: 'g2', label: 'B', color: 'var(--g2)' },
  { id: 'g3', label: 'C', color: 'var(--g3)' },
  { id: 'g4', label: 'D', color: 'var(--g4)' },
  { id: 'g5', label: 'E', color: 'var(--g5)' },
  { id: 'g6', label: 'F', color: 'var(--g6)' },
];

export const state = {
  /** @type {null | {type:'pane', id:string} | {type:'split', dir:'row'|'col', children:any[], sizes:number[]}} */
  tree: null,
  /** @type {Map<string, import('./pane.js').Pane>} */
  panes: new Map(),
  focusedId: null,
  zoomedId: null,
  /** @type {Set<string>} */
  selection: new Set(),
  /** Broadcast target: 'all' | 'selection' | a group id. */
  target: 'all',
  templates: [],
  settings: {},
  prompts: [],
  info: {},
  windowFocused: true,
  restoring: false,
};

let idCounter = 0;
export function genId() {
  idCounter += 1;
  return `p${Date.now().toString(36)}${idCounter}`;
}

/* --------------------------------------------------------------- tree ops */

export function leafIds(node = state.tree, out = []) {
  if (!node) return out;
  if (node.type === 'pane') {
    out.push(node.id);
    return out;
  }
  for (const child of node.children) leafIds(child, out);
  return out;
}

export function findFirstLeaf(node) {
  if (!node) return null;
  if (node.type === 'pane') return node.id;
  for (const child of node.children) {
    const found = findFirstLeaf(child);
    if (found) return found;
  }
  return null;
}

export function insertSplit(node, targetId, dir, newId) {
  if (!node) return { type: 'pane', id: newId };
  if (node.type === 'pane') {
    if (node.id !== targetId) return node;
    return { type: 'split', dir, children: [node, { type: 'pane', id: newId }], sizes: [1, 1] };
  }
  // Splitting a child along the container's own direction extends that
  // container instead of nesting another one — this keeps grids flat and
  // resizing predictable.
  const index = node.children.findIndex((c) => c.type === 'pane' && c.id === targetId);
  if (index !== -1 && node.dir === dir) {
    const children = [...node.children];
    const sizes = [...node.sizes];
    const half = sizes[index] / 2;
    sizes[index] = half;
    children.splice(index + 1, 0, { type: 'pane', id: newId });
    sizes.splice(index + 1, 0, half);
    return { ...node, children, sizes };
  }
  return { ...node, children: node.children.map((c) => insertSplit(c, targetId, dir, newId)) };
}

// Removes a leaf while preserving the sizes the user dragged: the space freed
// up by the removed child is handed to its siblings proportionally.
export function removeLeaf(node, id) {
  if (!node) return null;
  if (node.type === 'pane') return node.id === id ? null : node;

  const kept = [];
  const keptSizes = [];
  let freed = 0;
  node.children.forEach((child, i) => {
    const next = removeLeaf(child, id);
    if (next === null) {
      freed += node.sizes[i] ?? 1;
    } else {
      kept.push(next);
      keptSizes.push(node.sizes[i] ?? 1);
    }
  });

  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];

  if (freed > 0) {
    const total = keptSizes.reduce((a, b) => a + b, 0) || 1;
    for (let i = 0; i < keptSizes.length; i++) {
      keptSizes[i] += (keptSizes[i] / total) * freed;
    }
  }
  return { ...node, children: kept, sizes: keptSizes };
}

export function replaceLeaf(node, id, replacement) {
  if (!node) return null;
  if (node.type === 'pane') return node.id === id ? replacement : node;
  return { ...node, children: node.children.map((c) => replaceLeaf(c, id, replacement)) };
}

// Balances an arbitrary list of pane ids into a near-square grid. rows =
// floor(sqrt(n)) so 3 panes become one row of three rather than an uneven 2+1.
export function buildGridTree(paneIds, forced) {
  const n = paneIds.length;
  if (n === 0) return null;
  if (n === 1) return { type: 'pane', id: paneIds[0] };

  let rows;
  let cols;
  if (forced) {
    rows = forced.rows;
    cols = forced.cols;
  } else {
    rows = Math.max(1, Math.floor(Math.sqrt(n)));
    cols = Math.ceil(n / rows);
  }

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

export function equalizeSizes(node = state.tree) {
  if (!node || node.type === 'pane') return node;
  node.sizes = node.children.map(() => 1);
  node.children.forEach((c) => equalizeSizes(c));
  return node;
}

/* -------------------------------------------------------------- selection */

export function selectionIds() {
  // Selection can outlive the panes it referenced (closed panes); filter here
  // rather than trying to keep every removal path in sync.
  const alive = [...state.selection].filter((id) => state.panes.has(id));
  if (alive.length !== state.selection.size) {
    state.selection = new Set(alive);
  }
  return alive;
}

// Panes in visual (tree) order — everything user-facing should use this rather
// than Map insertion order, which drifts as panes are opened and closed.
export function orderedPanes() {
  return leafIds().map((id) => state.panes.get(id)).filter(Boolean);
}

export function targetPanes() {
  const ordered = orderedPanes();
  if (state.target === 'selection') {
    const selected = new Set(selectionIds());
    return ordered.filter((p) => selected.has(p.id));
  }
  if (state.target.startsWith('g')) {
    return ordered.filter((p) => p.group === state.target);
  }
  return ordered.filter((p) => !p.muted);
}

export function setTarget(target) {
  state.target = target;
  bus.emit('target:change');
}

export function setSelection(ids) {
  state.selection = new Set(ids.filter((id) => state.panes.has(id)));
  bus.emit('selection:change');
}

export function toggleSelection(id, exclusive = false) {
  if (exclusive) {
    const only = state.selection.size === 1 && state.selection.has(id);
    state.selection = only ? new Set() : new Set([id]);
  } else if (state.selection.has(id)) {
    state.selection.delete(id);
  } else {
    state.selection.add(id);
  }
  // Selecting anything is a strong signal the user wants to talk to exactly
  // those panes, so point the composer at the selection automatically.
  if (state.selection.size > 0 && state.target === 'all') state.target = 'selection';
  if (state.selection.size === 0 && state.target === 'selection') state.target = 'all';
  bus.emit('selection:change');
  bus.emit('target:change');
}

export function selectRange(fromId, toId) {
  const ids = leafIds();
  const a = ids.indexOf(fromId);
  const b = ids.indexOf(toId);
  if (a === -1 || b === -1) return;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (const id of ids.slice(lo, hi + 1)) state.selection.add(id);
  if (state.target === 'all') state.target = 'selection';
  bus.emit('selection:change');
  bus.emit('target:change');
}

/* --------------------------------------------------------- serialisation */

// The tree stored on disk references panes by a stable "slot" so restoring can
// map old ids onto freshly spawned ones.
export function serializeSession() {
  const ids = leafIds();
  const slotOf = new Map(ids.map((id, i) => [id, i]));

  function walk(node) {
    if (!node) return null;
    if (node.type === 'pane') {
      return slotOf.has(node.id) ? { type: 'pane', slot: slotOf.get(node.id) } : null;
    }
    const children = node.children.map(walk).filter(Boolean);
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return { type: 'split', dir: node.dir, children, sizes: node.sizes.slice(0, children.length) };
  }

  return {
    version: 2,
    savedAt: Date.now(),
    tree: walk(state.tree),
    panes: ids.map((id) => {
      const pane = state.panes.get(id);
      return {
        name: pane.name,
        renamed: !!pane.renamed,
        cwd: pane.cwd,
        templateId: pane.templateId || null,
        group: pane.group || null,
        muted: !!pane.muted,
      };
    }),
    target: state.target,
  };
}

export function hydrateTree(node, idBySlot) {
  if (!node) return null;
  if (node.type === 'pane') {
    const id = idBySlot.get(node.slot);
    return id ? { type: 'pane', id } : null;
  }
  const children = node.children.map((c) => hydrateTree(c, idBySlot)).filter(Boolean);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const sizes = children.map((_, i) => node.sizes?.[i] ?? 1);
  return { type: 'split', dir: node.dir === 'col' ? 'col' : 'row', children, sizes };
}
