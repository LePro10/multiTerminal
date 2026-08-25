'use strict';

const { ipcMain, dialog, shell, clipboard, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const store = require('./store');
const ptyManager = require('./ptyManager');

const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'requirements.txt',
  'pom.xml',
  'build.gradle',
  'composer.json',
  'Gemfile',
  'CLAUDE.md',
];

// Windows has no dot-file convention; these are the directories that clutter a
// drive root and that nobody wants a terminal in.
const WINDOWS_NOISE = new Set([
  '$recycle.bin', 'system volume information', 'recovery', 'msocache',
  '$windows.~ws', '$windows.~bt', 'documents and settings',
]);

function isHidden(name) {
  if (name.startsWith('.')) return true;
  return process.platform === 'win32' && WINDOWS_NOISE.has(name.toLowerCase());
}

// On Windows the filesystem has no single root, so the folder browser needs the
// list of drives to let people move between C:, D: and mapped network drives.
function listDrives() {
  if (process.platform !== 'win32') return [];
  const drives = [];
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if (fs.existsSync(root)) drives.push(root);
    } catch (_) {
      // Empty removable drive or a disconnected network share.
    }
  }
  return drives;
}

function describeFolder(fullPath, name) {
  let marker = null;
  for (const candidate of PROJECT_MARKERS) {
    try {
      if (fs.existsSync(path.join(fullPath, candidate))) {
        marker = candidate;
        break;
      }
    } catch (_) {
      // Unreadable entry — treat as a plain folder.
    }
  }
  return {
    name,
    path: fullPath,
    hidden: isHidden(name),
    isGit: marker === '.git',
    marker,
  };
}

function listDir(dirPath) {
  let target = store.expandHome(dirPath || os.homedir());
  try {
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) target = os.homedir();
  } catch (_) {
    target = os.homedir();
  }

  let entries = [];
  let error = null;
  try {
    entries = fs
      .readdirSync(target, { withFileTypes: true })
      .filter((d) => {
        if (d.isDirectory()) return true;
        // Follow symlinked directories too — plenty of dev setups symlink
        // project folders into a workspace directory.
        if (!d.isSymbolicLink()) return false;
        try { return fs.statSync(path.join(target, d.name)).isDirectory(); } catch (_) { return false; }
      })
      .map((d) => describeFolder(path.join(target, d.name), d.name))
      .sort((a, b) => {
        if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      });
  } catch (err) {
    error = err.code === 'EACCES' ? 'Keine Berechtigung für diesen Ordner.' : err.message;
  }

  const parent = path.dirname(target);
  return {
    path: target,
    // At a drive root (Windows) or `/` (POSIX) dirname returns the path
    // itself; that is the signal there is nothing above it.
    parent: parent === target ? null : parent,
    home: os.homedir(),
    drives: listDrives(),
    entries,
    error,
  };
}

// Walks below `root` looking for project folders. Stops descending into a
// directory once it is recognised as a project, so a monorepo's node_modules
// never shows up as 400 "projects".
function findProjects(root, maxDepth) {
  const start = store.expandHome(root);
  const depth = Math.min(Math.max(Number(maxDepth) || 2, 1), 4);
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.next', '.cache']);
  const found = [];

  function walk(current, level) {
    if (level > depth || found.length >= 200) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      const info = describeFolder(full, entry.name);
      if (info.marker) {
        found.push(info);
        continue; // Do not descend into a project.
      }
      walk(full, level + 1);
    }
  }

  walk(start, 1);
  found.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { root: start, projects: found };
}

function register(getWindow) {
  ipcMain.handle('app:info', () => ({
    platform: process.platform,
    sep: path.sep,
    home: os.homedir(),
    configDir: store.dir(),
    shell: store.defaultShell(),
  }));

  ipcMain.on('dev:toggleDevTools', () => {
    const win = getWindow();
    if (!win) return;
    if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
    else win.webContents.openDevTools({ mode: 'bottom' });
  });

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, patch) => store.setSettings(patch));

  ipcMain.handle('templates:list', () => store.listTemplates());
  ipcMain.handle('templates:save', (_e, template) => store.saveTemplate(template));
  ipcMain.handle('templates:delete', (_e, id) => store.deleteTemplate(id));
  ipcMain.handle('templates:openDir', () => {
    const dir = path.join(store.dir(), 'templates');
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return dir;
  });

  ipcMain.handle('session:get', () => store.getSession());
  ipcMain.handle('session:set', (_e, session) => store.setSession(session));

  ipcMain.handle('prompts:get', () => store.getPrompts());
  ipcMain.handle('prompts:set', (_e, prompts) => store.setPrompts(prompts));

  ipcMain.handle('fs:listDir', (_e, dirPath) => listDir(dirPath));
  ipcMain.handle('fs:findProjects', (_e, { root, depth }) => findProjects(root, depth));
  ipcMain.handle('fs:recentFolders', () => store.getRecentFolders());
  ipcMain.handle('fs:rememberFolders', (_e, paths) => store.pushRecentFolders(paths));

  ipcMain.handle('fs:pickFolders', async (_e, defaultPath) => {
    const win = getWindow();
    const result = await dialog.showOpenDialog(win, {
      title: 'Ordner auswählen',
      defaultPath: defaultPath ? store.expandHome(defaultPath) : os.homedir(),
      buttonLabel: 'Öffnen',
      properties: ['openDirectory', 'multiSelections', 'createDirectory'],
    });
    if (result.canceled) return [];
    return result.filePaths.map((p) => describeFolder(p, path.basename(p) || p));
  });

  ipcMain.handle('fs:reveal', (_e, target) => {
    const resolved = store.expandHome(target);
    // openPath on a directory hands it to the OS file manager (Nautilus,
    // Dolphin, Finder, Explorer) rather than opening a second app window.
    return shell.openPath(resolved);
  });

  ipcMain.handle('fs:describe', (_e, target) => {
    const resolved = store.expandHome(target);
    try {
      if (!fs.statSync(resolved).isDirectory()) {
        const parent = path.dirname(resolved);
        return describeFolder(parent, path.basename(parent));
      }
    } catch (_) {
      return null;
    }
    return describeFolder(resolved, path.basename(resolved) || resolved);
  });

  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(String(text ?? '')));

  ipcMain.on('notify', (_e, { title, body }) => {
    if (!Notification.isSupported()) return;
    const win = getWindow();
    if (win && win.isFocused()) return; // Don't nag while the user is looking.
    const notification = new Notification({ title: title || 'multiTerminal', body: body || '' });
    notification.on('click', () => {
      const target = getWindow();
      if (target) {
        if (target.isMinimized()) target.restore();
        target.focus();
      }
    });
    notification.show();
  });

  ipcMain.on('window:flash', () => {
    const win = getWindow();
    if (win && !win.isFocused()) win.flashFrame(true);
  });

  ipcMain.on('window:control', (_e, action) => {
    const win = getWindow();
    if (!win) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize());
    else if (action === 'close') win.close();
  });

  ipcMain.handle('pty:create', (event, opts) => {
    try {
      return { ok: true, ...ptyManager.create(event.sender, opts) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.on('pty:write', (_e, { id, data }) => ptyManager.write(id, data));
  ipcMain.on('pty:resize', (_e, { id, cols, rows }) => ptyManager.resize(id, cols, rows));
  ipcMain.on('pty:kill', (_e, { id }) => ptyManager.destroy(id));

  ipcMain.handle('dialog:confirm', async (_e, { title, message, detail, confirmLabel }) => {
    const win = getWindow();
    const result = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [confirmLabel || 'OK', 'Abbrechen'],
      defaultId: 0,
      cancelId: 1,
      title: title || 'multiTerminal',
      message: message || '',
      detail: detail || '',
    });
    return result.response === 0;
  });
}

module.exports = { register, listDir, findProjects };
