#!/usr/bin/env node
'use strict';

// Launches Electron with the flags the current platform actually needs.
//
// On most Linux dev machines `node_modules/electron/dist/chrome-sandbox` is not
// owned by root with the setuid bit, so Chromium refuses to start without
// --no-sandbox. Windows and macOS have no such problem, and passing the flag
// there would weaken the sandbox for no reason — so it is added only where it
// is required, and only when the sandbox binary really is unusable.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const electron = require('electron');
const appDir = path.join(__dirname, '..');

function needsNoSandbox() {
  if (process.platform !== 'linux') return false;
  const sandbox = path.join(appDir, 'node_modules', 'electron', 'dist', 'chrome-sandbox');
  try {
    const stat = fs.statSync(sandbox);
    const setuidRoot = stat.uid === 0 && (stat.mode & 0o4000) !== 0;
    return !setuidRoot;
  } catch (_) {
    // No sandbox binary to inspect — assume it cannot be used.
    return true;
  }
}

const args = [appDir, ...process.argv.slice(2)];
if (needsNoSandbox()) args.push('--no-sandbox');

const child = spawn(electron, args, { stdio: 'inherit', windowsHide: false });
child.on('close', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error(`Failed to launch Electron: ${err.message}`);
  process.exit(1);
});
