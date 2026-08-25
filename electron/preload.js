'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Everything the renderer is allowed to do, in one explicit surface. No raw
// ipcRenderer, no node access.
contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },

  templates: {
    list: () => ipcRenderer.invoke('templates:list'),
    save: (template) => ipcRenderer.invoke('templates:save', template),
    remove: (id) => ipcRenderer.invoke('templates:delete', id),
    openDir: () => ipcRenderer.invoke('templates:openDir'),
  },

  session: {
    get: () => ipcRenderer.invoke('session:get'),
    set: (session) => ipcRenderer.invoke('session:set', session),
  },

  prompts: {
    get: () => ipcRenderer.invoke('prompts:get'),
    set: (prompts) => ipcRenderer.invoke('prompts:set', prompts),
  },

  fs: {
    listDir: (dirPath) => ipcRenderer.invoke('fs:listDir', dirPath),
    findProjects: (root, depth) => ipcRenderer.invoke('fs:findProjects', { root, depth }),
    pickFolders: (defaultPath) => ipcRenderer.invoke('fs:pickFolders', defaultPath),
    reveal: (target) => ipcRenderer.invoke('fs:reveal', target),
    describe: (target) => ipcRenderer.invoke('fs:describe', target),
    recentFolders: () => ipcRenderer.invoke('fs:recentFolders'),
    rememberFolders: (paths) => ipcRenderer.invoke('fs:rememberFolders', paths),
    // Chromium stopped exposing File.path in Electron 32+; webUtils is the
    // supported way to turn a dropped item back into a filesystem path.
    pathForFile: (file) => {
      try { return webUtils.getPathForFile(file); } catch (_) { return file?.path || null; }
    },
  },

  clipboard: {
    read: () => ipcRenderer.invoke('clipboard:read'),
    write: (text) => ipcRenderer.send('clipboard:write', text),
  },

  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
  flashWindow: () => ipcRenderer.send('window:flash'),
  windowControl: (action) => ipcRenderer.send('window:control', action),
  confirm: (options) => ipcRenderer.invoke('dialog:confirm', options),

  createTerminal: (id, opts) => ipcRenderer.invoke('pty:create', { id, ...opts }),
  writeTerminal: (id, data) => ipcRenderer.send('pty:write', { id, data }),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  killTerminal: (id) => ipcRenderer.send('pty:kill', { id }),

  onTerminalData: (id, callback) => {
    const channel = `pty:data:${id}`;
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onTerminalExit: (id, callback) => {
    const channel = `pty:exit:${id}`;
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onWindowFocus: (callback) => {
    const listener = (_event, focused) => callback(focused);
    ipcRenderer.on('window:focus', listener);
    return () => ipcRenderer.removeListener('window:focus', listener);
  },
});
