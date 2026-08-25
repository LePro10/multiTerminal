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

  const childEnv = {
    ...process.env,
    ...(env || {}),
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'multiTerminal',
  };
  // ConPTY drives the terminal itself and does not read TERM, but plenty of
  // cross-platform CLIs check it to decide whether to emit colour, so it is
  // still worth setting.
  childEnv.TERM = 'xterm-256color';

  const child = pty.spawn(shell, Array.isArray(args) ? args : [], {
    name: 'xterm-256color',
    // Clamp to something sane: a pane that has not been measured yet must not
    // spawn at 0 columns, which makes most CLIs render garbage.
    cols: Math.max(20, Math.floor(cols) || 80),
    rows: Math.max(5, Math.floor(rows) || 24),
    cwd: expandHome(cwd),
    env: childEnv,
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
  const { pid } = session.child;
  try { session.child.kill(); } catch (_) { /* already dead */ }

  // On Unix the PTY closing sends SIGHUP to the whole foreground process
  // group, so whatever the shell was running dies with it. Windows has no
  // equivalent: killing the ConPTY host leaves the shell's children (a running
  // `node`, an AI CLI, a dev server) orphaned and holding ports. taskkill /T
  // walks the process tree the way SIGHUP would.
  if (process.platform === 'win32' && pid) {
    try {
      require('child_process')
        .spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        .on('error', () => { /* taskkill missing — the kill above is all we get */ });
    } catch (_) {
      // Nothing more we can do; the pane is gone either way.
    }
  }
}

function has(id) {
  return sessions.has(id);
}

function destroyAll() {
  for (const id of [...sessions.keys()]) destroy(id);
}

module.exports = { create, write, resize, destroy, destroyAll, has };
