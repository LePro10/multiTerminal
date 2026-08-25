'use strict';

const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');

const ipc = require('./ipc');
const ptyManager = require('./ptyManager');
const store = require('./store');

/** @type {BrowserWindow | null} */
let mainWindow = null;

function buildMenu() {
  // The default Electron menu is noise for a terminal app, but dropping the
  // menu entirely also drops the accelerators the OS routes through it. Keep a
  // hidden, minimal menu so copy/paste/zoom/devtools still work.
  const template = [
    {
      label: 'multiTerminal',
      submenu: [
        {
          label: 'Konfigurationsordner öffnen',
          click: () => shell.openPath(store.dir()),
        },
        { type: 'separator' },
        { role: 'quit', label: 'Beenden' },
      ],
    },
    {
      label: 'Bearbeiten',
      submenu: [
        { role: 'copy', label: 'Kopieren' },
        { role: 'paste', label: 'Einfügen' },
        { role: 'selectAll', label: 'Alles auswählen' },
      ],
    },
    {
      label: 'Ansicht',
      submenu: [
        { role: 'reload', label: 'Neu laden' },
        { role: 'toggleDevTools', label: 'Entwicklertools' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Zoom zurücksetzen' },
        { role: 'zoomIn', label: 'Größer' },
        { role: 'zoomOut', label: 'Kleiner' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Vollbild' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 720,
    minHeight: 480,
    title: 'multiTerminal',
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => win.show());

  win.on('focus', () => {
    win.flashFrame(false);
    if (!win.isDestroyed()) win.webContents.send('window:focus', true);
  });
  win.on('blur', () => {
    if (!win.isDestroyed()) win.webContents.send('window:focus', false);
  });

  win.on('closed', () => {
    mainWindow = null;
    ptyManager.destroyAll();
  });

  // Never let a link inside a terminal navigate the app window away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow = win;
  return win;
}

// A single instance keeps one set of PTYs; a second launch just focuses the
// existing window instead of orphaning the running terminals.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    ipc.register(() => mainWindow);
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('before-quit', () => ptyManager.destroyAll());

app.on('window-all-closed', () => {
  ptyManager.destroyAll();
  if (process.platform !== 'darwin') app.quit();
});
