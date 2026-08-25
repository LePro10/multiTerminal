'use strict';

// Owns every node-pty child process. The renderer only ever refers to panes by
// id; this module is the single place that knows about real OS processes, so
// shutting the app down cleanly is one call.

const pty = require('node-pty');
const { resolveCwd, defaultShell } = require('./store');

/** @type {Map<string, {child: import('node-pty').IPty, webContents: Electron.WebContents}>} */
const sessions = new Map();

function create(webContents, opts) {
  const { id, command, args, cwd, env, cols, rows } = opts;

  // A pane may be recreated after a crash or a restart-pane action; make sure
  // we never leak the previous process for the same id.
  destroy(id);

  const requestedShell = command && String(command).trim() ? String(command).trim() : null;
  const shell = requestedShell || defaultShell();
  const { cwd: workingDir, fellBack, requested } = resolveCwd(cwd);

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

  const spawnOptions = {
    name: 'xterm-256color',
    // Clamp to something sane: a pane that has not been measured yet must not
    // spawn at 0 columns, which makes most CLIs render garbage.
    cols: Math.max(20, Math.floor(cols) || 80),
    rows: Math.max(5, Math.floor(rows) || 24),
    cwd: workingDir,
    env: childEnv,
  };
  const spawnArgs = Array.isArray(args) ? args : [];

  let child;
  let usedShell = shell;
  try {
    child = pty.spawn(shell, spawnArgs, spawnOptions);
  } catch (err) {
    // A template pointing at a tool that isn't installed is the common case.
    // Rather than leaving a dead pane, fall back to a plain shell and let the
    // renderer say what happened — the user still gets a usable terminal in
    // the right folder.
    const fallback = defaultShell();
    if (requestedShell && fallback !== shell) {
      child = pty.spawn(fallback, [], spawnOptions);
      usedShell = fallback;
      sessions.set(id, { child, webContents });
      wire(id, child, webContents);
      return {
        pid: child.pid,
        shell: usedShell,
        cwd: workingDir,
        warning: `"${shell}" konnte nicht gestartet werden (${err.message}) — stattdessen ${fallback}.`,
      };
    }
    throw new Error(`${err.message} — Shell: ${shell}, Ordner: ${workingDir}`);
  }

  sessions.set(id, { child, webContents });
  wire(id, child, webContents);

  return {
    pid: child.pid,
    shell: usedShell,
    cwd: workingDir,
    warning: fellBack
      ? `Ordner "${requested}" existiert nicht — geöffnet in ${workingDir}.`
      : null,
  };
}

function wire(id, child, webContents) {
  child.onData((data) => {
    if (!webContents.isDestroyed()) webContents.send(`pty:data:${id}`, data);
  });

  child.onExit(({ exitCode, signal }) => {
    sessions.delete(id);
    if (!webContents.isDestroyed()) webContents.send(`pty:exit:${id}`, { exitCode, signal });
  });
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
