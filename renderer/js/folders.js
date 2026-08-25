import { state, bus } from './state.js';
import { openFolders } from './layout.js';

const api = window.api;

const sheet = document.getElementById('folderSheet');
const listEl = document.getElementById('folderList');
const pathInput = document.getElementById('folderPath');
const filterInput = document.getElementById('folderFilter');
const pickedStrip = document.getElementById('folderPicked');
const hintEl = document.getElementById('folderHint');
const showHidden = document.getElementById('folderShowHidden');
const replaceToggle = document.getElementById('folderReplace');
const drivesEl = document.getElementById('folderDrives');
const dropZone = document.getElementById('dropZone');

const view = {
  path: null,
  parent: null,
  entries: [],
  drives: [],
  /** @type {Map<string, {path:string,name:string}>} */
  picked: new Map(),
  cursor: 0,
  mode: 'browse', // 'browse' | 'projects'
  error: null,
};

function visibleEntries() {
  const needle = filterInput.value.trim().toLowerCase();
  return view.entries.filter((entry) => {
    if (!showHidden.checked && entry.hidden && !needle) return false;
    if (!needle) return true;
    return entry.name.toLowerCase().includes(needle) || entry.path.toLowerCase().includes(needle);
  });
}

function getTemplate() {
  const select = document.getElementById('templateSelect');
  return state.templates.find((t) => t.id === select.value) || null;
}

/* ---------------------------------------------------------------- rendering */

function renderList() {
  const rows = visibleEntries();
  view.cursor = Math.max(0, Math.min(view.cursor, rows.length - 1));

  listEl.innerHTML = '';
  if (view.error) {
    listEl.innerHTML = `<div class="list-empty">${view.error}</div>`;
    return;
  }
  if (rows.length === 0) {
    listEl.innerHTML = `<div class="list-empty">${
      view.mode === 'projects'
        ? 'Keine Projekte unterhalb dieses Ordners gefunden.'
        : filterInput.value ? 'Nichts gefunden.' : 'Keine Unterordner hier.'
    }</div>`;
    return;
  }

  rows.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'folder-row';
    row.classList.toggle('picked', view.picked.has(entry.path));
    row.classList.toggle('cursor', i === view.cursor);
    row.classList.toggle('is-hidden', !!entry.hidden);

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = view.picked.has(entry.path);
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('change', () => togglePick(entry));

    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = entry.name;
    name.title = entry.path;

    row.append(box, name);

    if (entry.marker) {
      const tag = document.createElement('span');
      tag.className = `tag${entry.isGit ? ' git' : ''}`;
      tag.textContent = entry.isGit ? 'git' : entry.marker.replace(/\.json$|\.toml$|\.md$/, '');
      tag.title = `Enthält ${entry.marker}`;
      row.appendChild(tag);
    }
    if (view.mode === 'projects') {
      const where = document.createElement('span');
      where.className = 'enter';
      where.style.opacity = '1';
      where.textContent = entry.path.replace(state.info.home || '', '~');
      where.style.maxWidth = '280px';
      where.style.overflow = 'hidden';
      where.style.textOverflow = 'ellipsis';
      where.style.whiteSpace = 'nowrap';
      where.style.direction = 'rtl';
      row.appendChild(where);
    } else {
      const enter = document.createElement('span');
      enter.className = 'enter';
      enter.textContent = 'öffnen →';
      row.appendChild(enter);
    }

    row.addEventListener('click', () => {
      view.cursor = i;
      if (view.mode === 'projects') togglePick(entry);
      else navigate(entry.path);
    });
    row.addEventListener('dblclick', () => togglePick(entry));
    listEl.appendChild(row);
  });

  const cursorEl = listEl.querySelector('.folder-row.cursor');
  cursorEl?.scrollIntoView({ block: 'nearest' });
}

function renderPicked() {
  pickedStrip.innerHTML = '';
  for (const entry of view.picked.values()) {
    const pill = document.createElement('span');
    pill.className = 'picked-pill';
    pill.textContent = entry.name;
    pill.title = entry.path;
    const remove = document.createElement('button');
    remove.textContent = '✕';
    remove.addEventListener('click', () => {
      view.picked.delete(entry.path);
      renderPicked();
      renderList();
    });
    pill.appendChild(remove);
    pickedStrip.appendChild(pill);
  }
  const n = view.picked.size;
  hintEl.textContent = n === 0
    ? 'Ein Terminal pro Ordner'
    : `${n} Ordner → ${n} Terminal${n === 1 ? '' : 's'}`;
  document.getElementById('folderConfirmBtn').disabled = n === 0;
}

function togglePick(entry) {
  if (view.picked.has(entry.path)) view.picked.delete(entry.path);
  else view.picked.set(entry.path, { path: entry.path, name: entry.name });
  renderPicked();
  renderList();
}

/* -------------------------------------------------------------- navigation */

async function navigate(dirPath) {
  const result = await api.fs.listDir(dirPath);
  view.path = result.path;
  view.parent = result.parent;
  view.entries = result.entries;
  view.drives = result.drives || [];
  view.error = result.error;
  view.mode = 'browse';
  view.cursor = 0;
  pathInput.value = result.path;
  filterInput.value = '';
  renderDrives();
  renderList();
}

// Empty on POSIX, so the row simply collapses.
function renderDrives() {
  drivesEl.innerHTML = '';
  for (const drive of view.drives) {
    const chip = document.createElement('button');
    chip.className = 'drive-chip';
    chip.textContent = drive.replace(/[\\/]+$/, '');
    chip.title = `Zu ${drive} wechseln`;
    chip.classList.toggle('active', (view.path || '').toLowerCase().startsWith(drive.toLowerCase()));
    chip.addEventListener('click', () => navigate(drive));
    drivesEl.appendChild(chip);
  }
}

async function scanProjects() {
  hintEl.textContent = 'Suche Projekte…';
  const result = await api.fs.findProjects(view.path, 3);
  view.entries = result.projects;
  view.mode = 'projects';
  view.cursor = 0;
  filterInput.value = '';
  renderList();
  renderPicked();
  if (result.projects.length) {
    bus.emit('toast', { text: `${result.projects.length} Projekte gefunden` });
  }
}

/* ------------------------------------------------------------------- sheet */

export async function openFolderSheet(startPath) {
  view.picked.clear();
  const recent = await api.fs.recentFolders();
  await navigate(startPath || view.path || recent[0] || state.info.home);
  sheet.hidden = false;
  renderPicked();
  filterInput.value = '';
  filterInput.focus();
}

export function closeFolderSheet() {
  sheet.hidden = true;
}

function confirmSheet() {
  const folders = [...view.picked.values()];
  if (folders.length === 0) return;
  api.fs.rememberFolders(folders.map((f) => f.path));
  openFolders(folders, { template: getTemplate(), replace: replaceToggle.checked });
  bus.emit('toast', { text: `${folders.length} Terminal${folders.length === 1 ? '' : 's'} geöffnet` });
  closeFolderSheet();
}

export async function pickFoldersNative() {
  const folders = await api.fs.pickFolders(view.path || state.info.home);
  if (!folders.length) return [];
  if (sheet.hidden) {
    api.fs.rememberFolders(folders.map((f) => f.path));
    openFolders(folders, { template: getTemplate() });
    bus.emit('toast', { text: `${folders.length} Terminal${folders.length === 1 ? '' : 's'} geöffnet` });
  } else {
    for (const folder of folders) view.picked.set(folder.path, folder);
    renderPicked();
    renderList();
  }
  return folders;
}

export async function openRecent() {
  const recent = await api.fs.recentFolders();
  if (!recent.length) {
    bus.emit('toast', { text: 'Noch keine zuletzt verwendeten Ordner', kind: 'warn' });
    return;
  }
  await openFolderSheet(recent[0]);
}

/* ------------------------------------------------------------ drag and drop */

function initDragAndDrop() {
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    depth += 1;
    dropZone.classList.add('active');
  });
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) dropZone.classList.remove('active');
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    dropZone.classList.remove('active');

    const paths = [...(e.dataTransfer.files || [])]
      .map((file) => api.fs.pathForFile(file))
      .filter(Boolean);
    if (paths.length === 0) return;

    // A dropped file resolves to its parent folder, so dragging a source file
    // in still lands you in the right project.
    const described = (await Promise.all(paths.map((p) => api.fs.describe(p)))).filter(Boolean);
    const unique = new Map(described.map((d) => [d.path, d]));
    const folders = [...unique.values()];
    if (folders.length === 0) return;

    if (!sheet.hidden) {
      for (const folder of folders) view.picked.set(folder.path, folder);
      renderPicked();
      renderList();
      return;
    }
    api.fs.rememberFolders(folders.map((f) => f.path));
    openFolders(folders, { template: getTemplate() });
    bus.emit('toast', { text: `${folders.length} Terminal${folders.length === 1 ? '' : 's'} geöffnet` });
  });
}

/* ------------------------------------------------------------------- wiring */

export function initFolders() {
  document.getElementById('folderUpBtn').addEventListener('click', () => {
    if (view.parent) navigate(view.parent);
  });
  document.getElementById('folderHomeBtn')
    .addEventListener('click', () => navigate(state.info.home));
  document.getElementById('folderCancelBtn').addEventListener('click', closeFolderSheet);
  document.getElementById('folderConfirmBtn').addEventListener('click', confirmSheet);
  document.getElementById('folderNativeBtn').addEventListener('click', pickFoldersNative);
  document.getElementById('folderScanBtn').addEventListener('click', scanProjects);
  document.getElementById('folderRevealBtn')
    .addEventListener('click', () => api.fs.reveal(view.path));
  document.getElementById('folderSelectAllBtn').addEventListener('click', () => {
    for (const entry of visibleEntries()) view.picked.set(entry.path, entry);
    renderPicked();
    renderList();
  });
  document.getElementById('folderClearBtn').addEventListener('click', () => {
    view.picked.clear();
    renderPicked();
    renderList();
  });

  showHidden.addEventListener('change', renderList);
  filterInput.addEventListener('input', () => {
    view.cursor = 0;
    renderList();
  });

  pathInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') navigate(pathInput.value);
  });

  filterInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    const rows = visibleEntries();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      view.cursor = Math.min(view.cursor + 1, rows.length - 1);
      renderList();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      view.cursor = Math.max(view.cursor - 1, 0);
      renderList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const entry = rows[view.cursor];
      if (!entry) return;
      if (e.ctrlKey || e.metaKey || view.mode === 'projects') togglePick(entry);
      else navigate(entry.path);
    } else if (e.key === ' ' && filterInput.value === '') {
      e.preventDefault();
      const entry = rows[view.cursor];
      if (entry) togglePick(entry);
    } else if (e.key === 'Backspace' && filterInput.value === '') {
      e.preventDefault();
      if (view.parent) navigate(view.parent);
    } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      for (const entry of rows) view.picked.set(entry.path, entry);
      renderPicked();
      renderList();
    }
  });

  sheet.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeFolderSheet();
    }
  });
  sheet.addEventListener('mousedown', (e) => {
    if (e.target === sheet) closeFolderSheet();
  });

  initDragAndDrop();
}
