const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

/** @type {Map<string, import('node-pty').IPty>} */
const ptys = new Map();

function expandHome(p) {
  if (!p) return os.homedir();
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function defaultShell() {
  return process.env.SHELL || '/bin/bash';
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'multiTerminal',
    backgroundColor: '#1e1e1e',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.on('closed', () => {
    for (const p of ptys.values()) {
      try { p.kill(); } catch (_) { /* already dead */ }
    }
    ptys.clear();
  });

  return win;
}

function readTemplates() {
  try {
    if (!fs.existsSync(TEMPLATES_DIR)) return [];
    return fs
      .readdirSync(TEMPLATES_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const raw = fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8');
          const parsed = JSON.parse(raw);
          return {
            id: f.replace(/\.json$/, ''),
            name: parsed.name || f.replace(/\.json$/, ''),
            command: parsed.command || defaultShell(),
            args: parsed.args || [],
            cwd: parsed.cwd || '~',
            env: parsed.env || {},
            color: parsed.color || '#4EC9B0',
          };
        } catch (err) {
          console.error(`Failed to parse template ${f}:`, err.message);
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    console.error('Failed to read templates dir:', err.message);
    return [];
  }
}

app.whenReady().then(() => {
  const win = createWindow();

  ipcMain.handle('templates:list', () => readTemplates());

  ipcMain.handle('folder:pickAndListSubfolders', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    const parent = result.filePaths[0];
    const subfolders = fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ path: path.join(parent, d.name), name: d.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { parent, subfolders };
  });

  ipcMain.handle('pty:create', (event, opts) => {
    const { id, command, args, cwd, env, cols, rows } = opts;
    const shell = command || defaultShell();
    const child = pty.spawn(shell, args || [], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: expandHome(cwd),
      env: { ...process.env, ...(env || {}) },
    });

    ptys.set(id, child);

    child.onData((data) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(`pty:data:${id}`, data);
      }
    });

    child.onExit(({ exitCode, signal }) => {
      ptys.delete(id);
      if (!event.sender.isDestroyed()) {
        event.sender.send(`pty:exit:${id}`, { exitCode, signal });
      }
    });

    return { pid: child.pid };
  });

  ipcMain.on('pty:write', (event, { id, data }) => {
    ptys.get(id)?.write(data);
  });

  ipcMain.on('pty:resize', (event, { id, cols, rows }) => {
    try {
      ptys.get(id)?.resize(cols, rows);
    } catch (_) {
      // pane may have already exited
    }
  });

  ipcMain.on('pty:kill', (event, { id }) => {
    try {
      ptys.get(id)?.kill();
    } catch (_) {
      // already dead
    }
    ptys.delete(id);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const p of ptys.values()) {
    try { p.kill(); } catch (_) { /* already dead */ }
  }
  ptys.clear();
  if (process.platform !== 'darwin') app.quit();
});
