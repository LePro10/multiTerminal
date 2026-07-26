const { contextBridge, ipcRenderer, clipboard } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listTemplates: () => ipcRenderer.invoke('templates:list'),
  listDir: (dirPath) => ipcRenderer.invoke('folder:listDir', dirPath),
  copyToClipboard: (text) => clipboard.writeText(text),

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
});
