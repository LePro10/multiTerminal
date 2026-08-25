'use strict';

// Persistent storage for settings, workspace sessions, the prompt library and
// user-defined templates. Everything lives in Electron's userData directory
// (~/.config/multiterminal on Linux) so the repo itself stays clean and the
// app keeps its data across `git pull`.

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO_TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

let userDir = null;

function dir() {
  if (!userDir) {
    userDir = app.getPath('userData');
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(path.join(userDir, 'templates'), { recursive: true });
  }
  return userDir;
}

function filePath(name) {
  return path.join(dir(), name);
}

function readJson(name, fallback) {
  try {
    const raw = fs.readFileSync(filePath(name), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function writeJson(name, value) {
  const target = filePath(name);
  const tmp = `${target}.tmp`;
  // Write-then-rename so a crash mid-write can never leave a truncated file
  // that would lose the user's whole session on next start.
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, target);
  return true;
}

const DEFAULT_SETTINGS = {
  restoreSession: true,
  fontSize: 13,
  fontFamily: '',
  scrollback: 10000,
  cursorBlink: true,
  copyOnSelect: false,
  staggerMs: 0,
  confirmClose: true,
  notifyOnAttention: true,
  bellSound: false,
  idleAfterMs: 1200,
  sendEnter: true,
  useVars: true,
  lastTemplateId: '',
};

function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson('settings.json', {}) };
}

function setSettings(patch) {
  const next = { ...getSettings(), ...(patch || {}) };
  writeJson('settings.json', next);
  return next;
}

function expandHome(p) {
  if (!p) return os.homedir();
  const trimmed = String(p).trim();
  if (trimmed === '~') return os.homedir();
  // Accept both `~/projects` and the `~\projects` a Windows user would type.
  if (/^~[\\/]/.test(trimmed)) return path.join(os.homedir(), trimmed.slice(2));
  return path.normalize(trimmed);
}

function defaultShell() {
  if (process.platform === 'win32') {
    // PowerShell 7 renders colour and Unicode far better than cmd.exe, so
    // prefer it, then Windows PowerShell, then whatever COMSPEC points at.
    for (const candidate of ['pwsh.exe', 'powershell.exe']) {
      if (whichWindows(candidate)) return candidate;
    }
    return process.env.COMSPEC || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

// node-pty resolves a bare executable name through PATH itself, but we need to
// know up front whether a shell actually exists before picking it.
function whichWindows(exe) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => {
    try { return fs.existsSync(path.join(dir, exe)); } catch (_) { return false; }
  });
}

function normalizeTemplate(id, parsed, source) {
  return {
    id,
    source,
    name: parsed.name || id,
    command: parsed.command || '',
    args: Array.isArray(parsed.args) ? parsed.args : [],
    cwd: parsed.cwd || '',
    env: parsed.env && typeof parsed.env === 'object' ? parsed.env : {},
    color: parsed.color || '#6ea8fe',
    icon: parsed.icon || '',
    // Free-form text sent into the pane right after it starts, e.g. to
    // auto-launch an AI CLI while keeping the shell underneath.
    initialInput: parsed.initialInput || '',
  };
}

function readTemplatesFrom(directory, source) {
  try {
    if (!fs.existsSync(directory)) return [];
    return fs
      .readdirSync(directory)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(directory, f), 'utf8'));
          return normalizeTemplate(f.replace(/\.json$/, ''), parsed, source);
        } catch (err) {
          console.error(`Failed to parse template ${f}:`, err.message);
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    console.error(`Failed to read templates from ${directory}:`, err.message);
    return [];
  }
}

function listTemplates() {
  const builtin = readTemplatesFrom(REPO_TEMPLATES_DIR, 'builtin');
  const user = readTemplatesFrom(path.join(dir(), 'templates'), 'user');
  // A user template with the same id shadows the bundled one, so people can
  // tweak a shipped template without editing the repo.
  const byId = new Map();
  for (const t of builtin) byId.set(t.id, t);
  for (const t of user) byId.set(t.id, t);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function saveTemplate(template) {
  const id = String(template.id || template.name || 'template')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'template';
  const target = path.join(dir(), 'templates', `${id}.json`);
  const payload = normalizeTemplate(id, template, 'user');
  delete payload.source;
  fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8');
  return listTemplates();
}

function deleteTemplate(id) {
  const target = path.join(dir(), 'templates', `${id}.json`);
  try { fs.unlinkSync(target); } catch (_) { /* already gone */ }
  return listTemplates();
}

function getSession() {
  return readJson('session.json', null);
}

function setSession(session) {
  writeJson('session.json', session);
  return true;
}

function getPrompts() {
  const stored = readJson('prompts.json', null);
  if (Array.isArray(stored)) return stored;
  return [
    { id: 'p-status', label: 'Status', text: 'Fasse in 3 Sätzen zusammen, woran du gerade arbeitest und was der nächste Schritt ist.' },
    { id: 'p-tests', label: 'Tests', text: 'Führe die Tests aus und behebe alles, was fehlschlägt.' },
    { id: 'p-review', label: 'Review', text: 'Review deinen eigenen Diff kritisch und behebe gefundene Probleme.' },
    { id: 'p-commit', label: 'Commit', text: 'Committe die Änderungen mit einer aussagekräftigen Message.' },
  ];
}

function setPrompts(prompts) {
  writeJson('prompts.json', Array.isArray(prompts) ? prompts : []);
  return true;
}

function getRecentFolders() {
  const list = readJson('recent-folders.json', []);
  return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
}

function pushRecentFolders(paths) {
  const incoming = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  const merged = [...incoming, ...getRecentFolders()];
  const unique = [];
  for (const p of merged) {
    if (!unique.includes(p)) unique.push(p);
    if (unique.length >= 20) break;
  }
  writeJson('recent-folders.json', unique);
  return unique;
}

module.exports = {
  dir,
  expandHome,
  defaultShell,
  getSettings,
  setSettings,
  listTemplates,
  saveTemplate,
  deleteTemplate,
  getSession,
  setSession,
  getPrompts,
  setPrompts,
  getRecentFolders,
  pushRecentFolders,
};
