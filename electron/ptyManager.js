'use strict';

// Owns every node-pty child process. The renderer only ever refers to panes by
// id; this module is the single place that knows about real OS processes, so
// shutting the app down cleanly is one call.

const pty = require('node-pty');
const { expandHome, defaultShell } = require('./store');

/** @type {Map<string, {child: import('node-pty').IPty, webContents: Electron.WebContents}>} */
const sessions = new Map();

function create(webContents, opts) {
  const { id, command, args, cwd, env, cols, rows } = opts;

  // A pane may be recreated after a crash or a restart-pane action; make sure
  // we never leak the previous process for the same id.
  destroy(id);

  const shell = command && String(command).trim() ? command : defaultShell();
  const child = pty.spawn(shell, Array.isArray(args) ? args : [], {
    name: 'xterm-256color',
    // Clamp to something sane: a pane that has not been measured yet must not
    // spawn at 0 columns, which makes most CLIs render garbage.
    cols: Math.max(20, Math.floor(cols) || 80),
    rows: Math.max(5, Math.floor(rows) || 24),
    cwd: expandHome(cwd),
    env: {
      ...process.env,
      ...(env || {}),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'multiTerminal',
    },
  });

  sessions.set(id, { child, webContents });

  child.onData((data) => {
    if (!webContents.isDestroyed()) webContents.send(`pty:data:${id}`, data);
  });

  child.onExit(({ exitCode, signal }) => {
    sessions.delete(id);
    if (!webContents.isDestroyed()) webContents.send(`pty:exit:${id}`, { exitCode, signal });
  });

  return { pid: child.pid, shell };
}

function write(id, data) {
  const session = sessions.get(id);
  if (!session) return false;
  try {
    session.child.write(data);
    return true;
  } catch (_) {
    // Process died between the renderer's check and this write.
    return false;
  }
}

function resize(id, cols, rows) {
  const session = sessions.get(id);
  if (!session) return;
  try {
    session.child.resize(Math.max(2, Math.floor(cols) || 80), Math.max(1, Math.floor(rows) || 24));
  } catch (_) {
    // Pane already exited.
  }
}

function destroy(id) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  try { session.child.kill(); } catch (_) { /* already dead */ }
}

function has(id) {
  return sessions.has(id);
}

function destroyAll() {
  for (const id of [...sessions.keys()]) destroy(id);
}

module.exports = { create, write, resize, destroy, destroyAll, has };
