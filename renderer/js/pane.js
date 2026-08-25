import { Terminal } from '../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { SearchAddon } from '../../node_modules/@xterm/addon-search/lib/addon-search.mjs';
import { WebLinksAddon } from '../../node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs';
import { WebglAddon } from '../../node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs';

import { state, bus, genId, GROUPS } from './state.js';

const api = window.api;

const TERMINAL_THEME = {
  background: '#0d1017',
  foreground: '#e8edf5',
  cursor: '#5b9dff',
  cursorAccent: '#0d1017',
  selectionBackground: 'rgba(91, 157, 255, 0.30)',
  black: '#1c2128',
  red: '#f85149',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ff7b72',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
};

// Heuristics for "this CLI is waiting for me". Deliberately conservative: a
// false positive costs an orange dot, so it only matches shapes that really do
// block on input (approval prompts, y/n questions, pagers).
const WAITING_PATTERNS = [
  /\((?:y|yes)\/(?:n|no)\)\s*[:?]?\s*$/i,
  /\[(?:y|yes)\/(?:n|no)\]\s*[:?]?\s*$/i,
  /\b(?:do you want|would you like|proceed|continue|overwrite|are you sure)\b[^\n]{0,60}\?\s*$/i,
  /\bpress\s+(?:enter|return|any key)\b/i,
  /^\s*(?:\d+\.|[❯>»])\s+.*\b(?:yes|no|allow|deny|accept|reject)\b/im,
  /\bpassword\s*(?:for [^\s:]+)?:\s*$/i,
  /\bpassphrase[^\n]{0,40}:\s*$/i,
  /--More--|\(END\)/,
];

// A prompt back on the last line means the command finished. Covers POSIX
// shells, and PowerShell / cmd, which both end their prompt with `>`.
const SHELL_PROMPT = /(?:[$#%❯➜»]|[A-Za-z]:\\[^\n]*>|PS [^\n]*>)\s*$/;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Pane headers are narrow, so show the tail of the path — the part that
// actually identifies the project — rather than an ellipsised prefix.
// Splits on either separator so a Windows path shortens the same way.
function shortenPath(p, home) {
  if (!p) return '';
  const sep = state.info.sep || '/';
  if (home && p === home) return '~';
  const rooted = home && p.toLowerCase().startsWith(`${home.toLowerCase()}${sep}`)
    ? `~${p.slice(home.length)}`
    : p;
  const parts = rooted.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return rooted;
  return `…${sep}${parts.slice(-2).join(sep)}`;
}

export class Pane {
  constructor({ template, cwd, name, group, muted, id } = {}) {
    this.id = id || genId();
    this.template = template || null;
    this.templateId = template ? template.id : null;
    this.cwd = cwd || (template && template.cwd) || '';
    this.startCwd = this.cwd;
    this.name = name || (template ? template.name : basename(this.cwd)) || 'Shell';
    this.color = template?.color || '#5b9dff';
    this.group = group || null;
    this.muted = !!muted;

    this.status = 'idle';
    this.attention = false;
    this.exited = false;
    this.mounted = false;
    this.ptyStarted = false;
    this.pendingInitialInput = template?.initialInput || '';
    this.lastActivity = Date.now();
    this._idleTimer = null;
    this._disposers = [];

    this._buildDom();
    this._buildTerminal();
  }

  /* ------------------------------------------------------------------ DOM */

  _buildDom() {
    const root = el('div', 'pane');
    root.dataset.paneId = this.id;
    root.tabIndex = -1;

    const header = el('div', 'pane-header');
    if (this.template) {
      // A hairline in the template's colour, so a grid mixing Claude Code
      // panes with plain shells is readable at a glance.
      header.style.boxShadow = `inset 0 2px 0 0 ${this.color}`;
      header.title = `Template: ${this.template.name}`;
    }
    this.indexEl = el('span', 'pane-index', '1');
    this.statusEl = el('span', 'pane-status');
    this.statusEl.title = 'Status';

    const title = el('div', 'pane-title');
    this.nameEl = el('span', 'pane-name', this.name);
    this.cwdEl = el('span', 'pane-cwd', '');
    title.append(this.nameEl, this.cwdEl);

    this.badgesEl = el('div', 'pane-badges');

    const actions = el('div', 'pane-actions');
    const menuBtn = el('button', '', '⋮');
    menuBtn.title = 'Pane-Menü (Rechtsklick)';
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const rect = menuBtn.getBoundingClientRect();
      bus.emit('pane:menu', { pane: this, x: rect.left, y: rect.bottom + 4 });
    });
    const zoomBtn = el('button', '', '⛶');
    zoomBtn.title = 'Zoomen (Ctrl+Shift+Z)';
    zoomBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      bus.emit('pane:zoom', this.id);
    });
    const closeBtn = el('button', 'close', '✕');
    closeBtn.title = 'Schließen (Ctrl+W)';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      bus.emit('pane:close', this.id);
    });
    actions.append(menuBtn, zoomBtn, closeBtn);

    header.append(this.indexEl, this.statusEl, title, this.badgesEl, actions);

    header.addEventListener('click', (e) => {
      if (e.detail > 1) return; // double-click is handled below
      bus.emit('pane:headerClick', { pane: this, event: e });
    });
    header.addEventListener('dblclick', () => bus.emit('pane:zoom', this.id));
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      bus.emit('pane:menu', { pane: this, x: e.clientX, y: e.clientY });
    });

    this.termEl = el('div', 'pane-term');

    this.quickbar = el('div', 'pane-quickbar');
    for (const [label, payload, tip] of [
      ['y', 'y\r', 'y + Enter'],
      ['n', 'n\r', 'n + Enter'],
      ['⏎', '\r', 'Enter'],
      ['esc', '\x1b', 'Escape'],
      ['^C', '\x03', 'Ctrl+C'],
    ]) {
      const btn = el('button', '', label);
      btn.title = tip;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.write(payload);
        this.clearAttention();
      });
      this.quickbar.appendChild(btn);
    }

    this.overlay = el('div', 'pane-overlay');
    this.overlayMsg = el('div', 'msg', 'Prozess beendet');
    const restartBtn = el('button', 'primary', 'Neu starten');
    restartBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.restart();
    });
    const overlayClose = el('button', '', 'Pane schließen');
    overlayClose.addEventListener('click', (e) => {
      e.stopPropagation();
      bus.emit('pane:close', this.id);
    });
    const overlayRow = el('div', 'empty-actions');
    overlayRow.append(restartBtn, overlayClose);
    this.overlay.append(this.overlayMsg, overlayRow);

    this.searchBox = el('div', 'pane-search');
    this.searchInput = document.createElement('input');
    this.searchInput.type = 'text';
    this.searchInput.placeholder = 'Suchen…';
    this.searchInput.spellcheck = false;
    const prevBtn = el('button', 'icon', '↑');
    const nextBtn = el('button', 'icon', '↓');
    const closeSearch = el('button', 'icon', '✕');
    prevBtn.addEventListener('click', () => this.findPrevious());
    nextBtn.addEventListener('click', () => this.findNext());
    closeSearch.addEventListener('click', () => this.toggleSearch(false));
    this.searchInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') (e.shiftKey ? this.findPrevious() : this.findNext());
      if (e.key === 'Escape') this.toggleSearch(false);
    });
    this.searchInput.addEventListener('input', () => this.findNext(true));
    this.searchBox.append(this.searchInput, prevBtn, nextBtn, closeSearch);

    this.termEl.append(this.quickbar, this.overlay, this.searchBox);

    root.append(header, this.termEl);
    root.addEventListener('mousedown', () => bus.emit('pane:focus', this.id));

    this.el = root;
    this.headerEl = header;
    this._renderMeta();
  }

  _renderMeta() {
    this.nameEl.textContent = this.name;
    const short = shortenPath(this.cwd, state.info.home);
    this.cwdEl.textContent = short;
    this.cwdEl.title = this.cwd || '';
    this.el.title = `${this.name}${this.cwd ? ` — ${this.cwd}` : ''}`;

    this.badgesEl.innerHTML = '';
    if (this.group) {
      const group = GROUPS.find((g) => g.id === this.group);
      if (group) {
        const badge = el('span', 'group-badge', group.label);
        badge.style.background = group.color;
        badge.title = `Gruppe ${group.label}`;
        this.badgesEl.appendChild(badge);
      }
    }
    if (this.muted) {
      const badge = el('span', 'mute-badge', 'stumm');
      badge.title = 'Wird von "Alle" ausgenommen';
      this.badgesEl.appendChild(badge);
    }
  }

  setIndex(n) {
    this.indexEl.textContent = String(n);
    this.indexEl.title = n <= 9 ? `Alt+${n} wählt dieses Pane` : `Pane ${n}`;
  }

  /* ------------------------------------------------------------- terminal */

  _buildTerminal() {
    const settings = state.settings;
    this.term = new Terminal({
      cursorBlink: settings.cursorBlink !== false,
      cursorStyle: 'bar',
      fontSize: settings.fontSize || 13,
      fontFamily: settings.fontFamily
        || '"JetBrains Mono","Fira Code","Cascadia Mono","SF Mono","DejaVu Sans Mono",Menlo,Consolas,monospace',
      lineHeight: 1.2,
      scrollback: settings.scrollback || 10000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: TERMINAL_THEME,
      scrollOnUserInput: true,
    });

    this.fitAddon = new FitAddon();
    this.searchAddon = new SearchAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(this.searchAddon);
    this.term.loadAddon(new WebLinksAddon((event, uri) => {
      event.preventDefault();
      window.open(uri, '_blank');
    }));

    this.term.onData((data) => {
      this.write(data);
      // Typing into a pane is an explicit answer to whatever it was asking.
      this.clearAttention();
    });
    this.term.onResize(({ cols, rows }) => {
      if (this.ptyStarted) api.resizeTerminal(this.id, cols, rows);
    });
    this.term.onBell(() => this.raiseAttention('Terminal-Glocke'));
    this.term.onTitleChange((title) => {
      this.termTitle = title;
      // Many shells put the cwd in the window title. Accept a POSIX path or a
      // Windows drive path, but nothing else — a title is free-form text.
      if (title && (title.startsWith('/') || /^[A-Za-z]:[\\/]/.test(title))) this.setCwd(title);
    });
    if (state.settings.copyOnSelect) {
      this.term.onSelectionChange(() => {
        const sel = this.term.getSelection();
        if (sel) api.clipboard.write(sel);
      });
    }

    // OSC 7 is how modern shells report their working directory; it keeps the
    // pane header honest after the user cd's around.
    this.term.parser.registerOscHandler(7, (data) => {
      const match = /^file:\/\/[^/]*(\/.*)$/.exec(data || '');
      if (!match) return true;
      let dir = match[1];
      try { dir = decodeURIComponent(dir); } catch (_) { /* keep it encoded */ }
      // A Windows shell reports file:///C:/Users/me — strip the leading slash
      // that belongs to the URL, not to the path.
      if (/^\/[A-Za-z]:/.test(dir)) dir = dir.slice(1).replace(/\//g, '\\');
      this.setCwd(dir);
      return true;
    });
    // OSC 9 / OSC 777 are the two common "desktop notification" escapes. AI
    // CLIs use them to say "I need you" — exactly what we want to surface.
    this.term.parser.registerOscHandler(9, (data) => {
      this.raiseAttention(String(data || '').slice(0, 140));
      return true;
    });
    this.term.parser.registerOscHandler(777, (data) => {
      const parts = String(data || '').split(';');
      if (parts[0] === 'notify') this.raiseAttention(parts.slice(2).join(';').slice(0, 140) || parts[1]);
      return true;
    });

    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const mod = e.ctrlKey && e.shiftKey;
      if (mod && e.code === 'KeyC') {
        const sel = this.term.getSelection();
        if (sel) {
          api.clipboard.write(sel);
          bus.emit('toast', { text: 'Kopiert' });
        }
        return false;
      }
      if (mod && e.code === 'KeyV') { this.paste(); return false; }
      if (mod && e.code === 'KeyF') { this.toggleSearch(true); return false; }
      // Let the app-level shortcut handler see these instead of the shell.
      if (mod && (e.code === 'KeyZ' || e.code === 'KeyA' || e.code === 'Backslash')) return false;
      if (e.ctrlKey && !e.shiftKey && !e.altKey
          && ['KeyT', 'KeyW', 'KeyK', 'KeyO', 'Backslash', 'Comma'].includes(e.code)) return false;
      if (e.altKey && /^(Digit[1-9]|Arrow(Up|Down|Left|Right))$/.test(e.code)) return false;
      return true;
    });

    this.termEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const sel = this.term.getSelection();
      if (sel) {
        api.clipboard.write(sel);
        this.term.clearSelection();
        bus.emit('toast', { text: 'Kopiert' });
      } else {
        this.paste();
      }
    });

    this._disposers.push(api.onTerminalData(this.id, (data) => this._onData(data)));
    this._disposers.push(api.onTerminalExit(this.id, (payload) => this._onExit(payload)));
  }

  // Called by the layout once the pane element is really in the document and
  // has a measurable size. Opening xterm before that produces a terminal that
  // thinks it is 0 columns wide, which is where most of the old rendering
  // glitches came from.
  mount() {
    if (!this.el.isConnected) return;
    if (!this.mounted) {
      this.term.open(this.termEl);
      this.mounted = true;
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        this.term.loadAddon(webgl);
        this.webgl = webgl;
      } catch (_) {
        // No GPU in this environment — the DOM renderer is the fallback.
      }
    }
    this.fit();
    if (!this.ptyStarted) this._startPty();
  }

  async _startPty() {
    this.ptyStarted = true;
    const result = await api.createTerminal(this.id, {
      command: this.template?.command,
      args: this.template?.args,
      cwd: this.cwd || undefined,
      env: this.template?.env,
      cols: this.term.cols,
      rows: this.term.rows,
    });
    if (!result || result.ok === false) {
      this.ptyStarted = false;
      const detail = result?.error || 'unbekannt';
      this.term.write(`\r\n\x1b[31mStart fehlgeschlagen: ${detail}\x1b[0m\r\n`);
      this._setStatus('exited');
      this.exited = true;
      this.el.classList.add('exited');
      this.overlayMsg.textContent = `Start fehlgeschlagen: ${detail}`;
      return;
    }
    this.pid = result.pid;
    // The main process has the last word on where the terminal actually
    // opened: it falls back when the requested folder is gone, so trust its
    // answer over what this pane asked for.
    if (result.cwd && result.cwd !== this.cwd) {
      this.cwd = result.cwd;
      this._renderMeta();
    }
    if (result.warning) {
      this.term.write(`\x1b[33m${result.warning}\x1b[0m\r\n`);
    }
    if (this.pendingInitialInput) {
      const payload = this.pendingInitialInput;
      this.pendingInitialInput = '';
      // Give the shell a moment to print its prompt before typing into it.
      setTimeout(() => this.write(payload.endsWith('\n') ? payload : `${payload}\r`), 350);
    }
  }

  fit() {
    if (!this.mounted) return;
    const rect = this.termEl.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) return;
    try { this.fitAddon.fit(); } catch (_) { /* not measurable yet */ }
  }

  write(data) {
    if (this.exited) return false;
    api.writeTerminal(this.id, data);
    return true;
  }

  async paste() {
    const text = await api.clipboard.read();
    if (text) this.write(text);
  }

  focus() {
    if (this.mounted) this.term.focus();
    else this.el.focus();
  }

  setCwd(next) {
    if (!next || next === this.cwd) return;
    this.cwd = next;
    // A pane the user renamed keeps its name; an auto-named one follows the
    // folder it is actually in, so `cd` keeps the header honest.
    if (!this.renamed) this.name = basename(next) || this.name;
    this._renderMeta();
    bus.emit('session:dirty');
  }

  rename(next) {
    this.name = next || this.name;
    this.renamed = true;
    this._renderMeta();
    bus.emit('session:dirty');
  }

  setGroup(group) {
    this.group = this.group === group ? null : group;
    this._renderMeta();
    bus.emit('session:dirty');
    bus.emit('target:change');
  }

  setMuted(muted) {
    this.muted = muted;
    this._renderMeta();
    bus.emit('session:dirty');
    bus.emit('target:change');
  }

  /* --------------------------------------------------------- status logic */

  _onData(data) {
    this.term.write(data);
    this.lastActivity = Date.now();
    this._pendingTail = `${(this._pendingTail || '') + data}`.slice(-600);
    if (!this.attention) this._setStatus('running');
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => this._settle(), state.settings.idleAfterMs || 1200);
  }

  // Output stopped flowing. Look at what is actually on screen to tell "done"
  // apart from "waiting for you".
  _settle() {
    // Attention is sticky: once a pane has asked for the user it stays flagged
    // until they actually answer it, even if the CLI keeps printing.
    if (this.exited || this.attention) return;
    const tail = this._readTail();
    this._pendingTail = '';
    if (WAITING_PATTERNS.some((re) => re.test(tail))) {
      this.raiseAttention('Wartet auf Eingabe');
      return;
    }
    // A bare shell prompt means the command finished, so the pane is ready
    // again rather than merely quiet.
    this.atShellPrompt = SHELL_PROMPT.test(tail.trimEnd());
    this._setStatus('idle');
  }

  _readTail(lines = 6) {
    if (!this.mounted) return this._pendingTail || '';
    try {
      const buffer = this.term.buffer.active;
      const out = [];
      const end = buffer.baseY + buffer.cursorY;
      for (let y = Math.max(0, end - lines + 1); y <= end; y++) {
        out.push(buffer.getLine(y)?.translateToString(true) ?? '');
      }
      return out.join('\n');
    } catch (_) {
      return this._pendingTail || '';
    }
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.statusEl.className = `pane-status ${status}`;
    this.statusEl.title = {
      running: 'Läuft',
      idle: 'Bereit',
      attention: 'Wartet auf dich',
      exited: 'Beendet',
    }[status] || status;
    bus.emit('status:change');
  }

  raiseAttention(reason) {
    if (this.exited) return;
    const wasAttention = this.attention;
    this.attention = true;
    this.el.classList.add('attention');
    this._setStatus('attention');
    if (!wasAttention) bus.emit('pane:attention', { pane: this, reason });
  }

  clearAttention() {
    if (!this.attention) return;
    this.attention = false;
    this.el.classList.remove('attention');
    this._setStatus(Date.now() - this.lastActivity < 800 ? 'running' : 'idle');
  }

  _onExit({ exitCode, signal }) {
    this.exited = true;
    this.attention = false;
    clearTimeout(this._idleTimer);
    this.el.classList.remove('attention');
    this.el.classList.add('exited');
    this._setStatus('exited');
    const how = signal ? `Signal ${signal}` : `Code ${exitCode}`;
    this.overlayMsg.textContent = `Prozess beendet (${how})`;
    this.term.write(`\r\n\x1b[90m── beendet (${how}) ──\x1b[0m\r\n`);
    bus.emit('status:change');
  }

  restart() {
    this.exited = false;
    this.ptyStarted = false;
    this.el.classList.remove('exited');
    this.term.reset();
    this.pendingInitialInput = this.template?.initialInput || '';
    this._setStatus('idle');
    this.fit();
    this._startPty();
    bus.emit('status:change');
  }

  /* ----------------------------------------------------------- search box */

  toggleSearch(open) {
    const next = open === undefined ? !this.searchBox.classList.contains('open') : open;
    this.searchBox.classList.toggle('open', next);
    if (next) this.searchInput.focus();
    else {
      this.searchAddon.clearDecorations?.();
      this.term.focus();
    }
  }

  findNext(fromStart = false) {
    const q = this.searchInput.value;
    if (!q) return;
    this.searchAddon.findNext(q, {
      incremental: fromStart,
      decorations: {
        matchOverviewRuler: '#5b9dff',
        activeMatchColorOverviewRuler: '#ffa028',
        activeMatchBackground: '#ffa028',
        matchBackground: '#254b7a',
      },
    });
  }

  findPrevious() {
    const q = this.searchInput.value;
    if (q) this.searchAddon.findPrevious(q);
  }

  /* ---------------------------------------------------------------- teardown */

  dispose() {
    clearTimeout(this._idleTimer);
    for (const off of this._disposers) {
      try { off(); } catch (_) { /* already detached */ }
    }
    this._disposers = [];
    try { this.webgl?.dispose(); } catch (_) { /* no webgl */ }
    try { this.term.dispose(); } catch (_) { /* already disposed */ }
    api.killTerminal(this.id);
    this.el.remove();
  }
}

// Works for both `/home/me/proj` and `C:\Users\me\proj`.
function basename(p) {
  if (!p) return '';
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
