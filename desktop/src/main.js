'use strict';
/*
 * Relevo for Windows (Electron main process).
 *
 * Everything lives in one window: its own page is the tab strip (shell.html) and below it shows
 * either the dashboard or the open accounts (one, two side by side, or all in a grid).
 * Each Claude account opens in one of two ways:
 *  - "integrated" (default): a pane inside Relevo whose page lives in its own persistent session
 *    partition ("persist:relevo-sN"). Google does not allow signing in inside embedded pages, so
 *    Relevo stops that navigation and offers e-mail sign-in or the external browser instead.
 *  - "chrome": the user's real Chrome/Edge with a separate profile directory per account
 *    (chrome.js). Google sign-in works there. The pane only shows the account's control bar and
 *    moves prompts and status blocks through the clipboard.
 * Either way the toolbar drives the handoff: start/handoff prompt, CHECKPOINT, save the status
 * block and pass the project to another account.
 */
const path = require('path');
const {
  app, BrowserWindow, WebContentsView, ipcMain, Menu, Notification, shell, clipboard,
  screen, session, dialog, nativeTheme
} = require('electron');
const fs = require('fs');
const core = require('./shared/core');
const model = require('./model');
const inject = require('./inject');
const Store = require('./store');
const chrome = require('./chrome');

const UI = path.join(__dirname, 'ui');
const ICON = path.join(__dirname, 'ui', 'icon.png');
const SIGN_IN_DOMAINS = ['claude.ai', 'claude.com', 'anthropic.com', 'google.com', 'apple.com', 'github.com',
  'stripe.com', 'microsoftonline.com', 'live.com', 'okta.com', 'auth0.com'];

if (process.env.RELEVO_USER_DATA) app.setPath('userData', process.env.RELEVO_USER_DATA);

let store;
let main = null; // the Relevo window; its own page is the tab strip
let dash = null; // dashboard view inside it
const sessions = new Map(); // slot -> SessionPane | ChromePane
/** active: slot in front (0 = dashboard); mode: single | split | grid; recent: open slots, newest first. */
const tabs = { active: 0, mode: 'single', recent: [] };
const pauseTimers = new Map();
const bgColor = () => (nativeTheme.shouldUseDarkColors ? '#191817' : '#f6f4ef');

const partitionOf = (slot) => 'persist:relevo-s' + slot;

function hostMatches(url, domains) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return domains.some((d) => h === d || h.endsWith('.' + d));
  } catch (e) {
    return false;
  }
}

const isClaudeUrl = (url) => hostMatches(url, ['claude.ai', 'claude.com', 'anthropic.com']);
/** Google refuses sign-in inside embedded windows; those navigations are stopped and explained. */
const isGoogleSignIn = (url) => hostMatches(url, ['accounts.google.com']);
const profileDirOf = (slot) => path.join(app.getPath('userData'), 'chrome-profiles', 's' + slot);
const browserPath = () => chrome.find(store.data.browserPath);

// ------------------------------------------------------------------ sessions (cookie jars)

const configuredSessions = new Set();

function setupSession(slot) {
  const ses = session.fromPartition(partitionOf(slot));
  if (configuredSessions.has(ses)) return ses;
  configuredSessions.add(ses);
  // Microphone (voice mode), clipboard and notifications only for Claude's own pages.
  const allowed = ['media', 'clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen'];
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(allowed.includes(permission) && isClaudeUrl(details.requestingUrl || wc.getURL()));
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => allowed.includes(permission) && isClaudeUrl(origin));
  return ses;
}

// ------------------------------------------------------------------ context menus

function attachContextMenu(wc) {
  wc.on('context-menu', (e, params) => {
    const items = [];
    if (params.linkURL) {
      items.push({ label: 'Abrir enlace en el navegador', click: () => shell.openExternal(params.linkURL) });
      items.push({ label: 'Copiar enlace', click: () => clipboard.writeText(params.linkURL) });
      items.push({ type: 'separator' });
    }
    if (params.isEditable) {
      items.push({ role: 'undo', label: 'Deshacer' }, { role: 'redo', label: 'Rehacer' }, { type: 'separator' },
        { role: 'cut', label: 'Cortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Pegar' },
        { role: 'selectAll', label: 'Seleccionar todo' });
    } else if (params.selectionText) {
      items.push({ role: 'copy', label: 'Copiar' });
    }
    if (params.mediaType === 'image' && params.srcURL) {
      items.push({ label: 'Copiar imagen', click: () => wc.copyImageAt(params.x, params.y) });
    }
    if (!items.length) {
      items.push({ label: 'Atrás', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Recargar', click: () => wc.reload() });
    }
    Menu.buildFromTemplate(items).popup();
  });
}

// ------------------------------------------------------------------ account panes

const BAR_HEIGHT = 50;
const STRIP_HEIGHT = 42; // tab strip at the top of the window (shell.html)
const ownPagePrefs = () => ({ preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true });

/** The views of one account inside the main window, hidden while the account is not on screen. */
class Pane {
  constructor(slot, views) {
    this.slot = slot;
    this.views = views;
    this.rect = null;
    this.overlay = false;
    for (const v of views) {
      v.setVisible(false);
      main.contentView.addChildView(v);
      v.webContents.on('focus', () => markActive(slot));
    }
  }

  /** Shows the pane in `rect` (window content coordinates), or hides it with null. */
  show(rect) {
    this.rect = rect;
    for (const v of this.views) v.setVisible(!!rect);
    this.layout();
  }

  send(channel, payload) {
    if (!this.bar.webContents.isDestroyed()) this.bar.webContents.send(channel, payload);
  }

  close() {
    for (const v of this.views) {
      if (main && !main.isDestroyed()) main.contentView.removeChildView(v);
      if (!v.webContents.isDestroyed()) v.webContents.close();
    }
  }
}

/** Claude inside Relevo: the toolbar on top and the account's page (own cookie jar) below. */
class SessionPane extends Pane {
  constructor(slot) {
    setupSession(slot);
    const site = new WebContentsView({
      webPreferences: { partition: partitionOf(slot), contextIsolation: true, sandbox: true, spellcheck: true }
    });
    const bar = new WebContentsView({ webPreferences: ownPagePrefs() });
    site.setBackgroundColor(bgColor());
    bar.setBackgroundColor('#00000000');
    super(slot, [site, bar]);
    this.kind = 'integrated';
    this.site = site;
    this.bar = bar;
    this.barHeight = BAR_HEIGHT;
    this.setupSite();
    attachContextMenu(bar.webContents);
    bar.webContents.loadFile(path.join(UI, 'toolbar.html'), { query: { slot: String(slot) } });
    site.webContents.loadURL(model.account(store.data, slot).startUrl || core.URL_CHAT);
  }

  layout() {
    if (!this.rect) return;
    const { x, y, width, height } = this.rect;
    this.bar.setBounds({ x, y, width, height: this.overlay ? height : this.barHeight });
    this.site.setBounds({ x, y: y + this.barHeight, width, height: Math.max(0, height - this.barHeight) });
  }

  setupSite() {
    const wc = this.site.webContents;
    const slot = this.slot;
    attachContextMenu(wc);
    const googleBlocked = () => this.send('command', 'google-blocked');
    wc.setWindowOpenHandler(({ url }) => {
      if (isGoogleSignIn(url)) {
        googleBlocked();
        return { action: 'deny' };
      }
      // Sign-in pop-ups stay in this account's session; other links go to the default browser.
      if (url === 'about:blank' || hostMatches(url, SIGN_IN_DOMAINS)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            parent: main, width: 520, height: 720, autoHideMenuBar: true, icon: ICON,
            webPreferences: { partition: partitionOf(slot), contextIsolation: true, sandbox: true }
          }
        };
      }
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('did-create-window', (child) => {
      attachContextMenu(child.webContents);
      const stopGoogle = (e, url) => {
        if (!isGoogleSignIn(url)) return;
        e.preventDefault();
        child.close();
        googleBlocked();
      };
      child.webContents.on('will-navigate', stopGoogle);
      child.webContents.on('will-redirect', stopGoogle);
    });
    wc.on('will-redirect', (e, url) => {
      if (isGoogleSignIn(url)) {
        e.preventDefault();
        googleBlocked();
      }
    });
    wc.on('will-navigate', (e, url) => {
      if (isGoogleSignIn(url)) {
        e.preventDefault();
        googleBlocked();
        return;
      }
      if (!/^(https?|about|data|blob):/i.test(url)) {
        e.preventDefault();
        shell.openExternal(url).catch(() => {});
      }
    });
    const notifyNav = () => this.send('nav', {
      canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(), url: wc.getURL()
    });
    wc.on('did-navigate', notifyNav);
    wc.on('did-navigate-in-page', notifyNav);
    wc.on('did-start-loading', () => this.send('loading', true));
    wc.on('did-stop-loading', () => this.send('loading', false));
    wc.on('render-process-gone', () => setTimeout(() => !wc.isDestroyed() && wc.reload(), 500));
  }

  async run(script) {
    return this.site.webContents.executeJavaScript(script, true);
  }
}

/**
 * An account that lives in the real browser. Its pane only holds the control bar (same toolbar
 * page, "chrome" mode); Relevo launches the browser with the account's own profile directory.
 */
class ChromePane extends Pane {
  constructor(slot) {
    const bar = new WebContentsView({ webPreferences: ownPagePrefs() });
    bar.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#252422' : '#ffffff');
    super(slot, [bar]);
    this.kind = 'chrome';
    this.bar = bar;
    attachContextMenu(bar.webContents);
    bar.webContents.loadFile(path.join(UI, 'toolbar.html'), { query: { slot: String(slot), mode: 'chrome' } });
  }

  /** Opens `url` (default: the account's start page) in the account's own browser profile. */
  openBrowser(url) {
    const exe = browserPath();
    if (!exe) throw new Error('No encontré Google Chrome ni Microsoft Edge. Instálalo o elige el navegador en Guía y ajustes.');
    const a = model.account(store.data, this.slot);
    const dir = profileDirOf(this.slot);
    chrome.prepareProfile(dir, 'Relevo · ' + (a ? a.name : 'Cuenta ' + this.slot));
    chrome.launch(exe, dir, url || (a && a.startUrl) || core.URL_CHAT);
  }

  layout() {
    if (this.rect) this.bar.setBounds(this.rect);
  }

  async run() {
    throw new Error('La cuenta está en el navegador');
  }
}

const usesChrome = (slot) => {
  const a = model.account(store.data, slot);
  return !!a && a.browser === 'chrome';
};

function isOnScreen(b) {
  return screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    return b.x < w.x + w.width - 80 && b.x + b.width > w.x + 80 && b.y >= w.y - 20 && b.y < w.y + w.height - 80;
  });
}

// ------------------------------------------------------------------ tabs and layout

const tabState = () => ({ active: tabs.active, mode: tabs.mode, open: [...sessions.keys()], shown: model.shownSlots(tabs) });

/** Places the dashboard or the accounts on screen under the tab strip and refreshes the strip. */
function relayout() {
  if (!main || main.isDestroyed()) return;
  const { width, height } = main.getContentBounds();
  const area = { x: 0, y: STRIP_HEIGHT, width, height: Math.max(0, height - STRIP_HEIGHT) };
  const shown = model.shownSlots(tabs);
  const cells = model.gridCells(area, shown.length);
  for (const s of sessions.values()) {
    const i = shown.indexOf(s.slot);
    s.show(i < 0 ? null : cells[i]);
  }
  dash.setBounds(area);
  dash.setVisible(!shown.length);
  sendTabs();
}

function sendTabs() {
  if (!main || main.isDestroyed()) return;
  const a = model.account(store.data, tabs.active);
  main.setTitle(a ? a.name + ' — Relevo' : 'Relevo');
  main.webContents.send('tabs', tabState());
}

function focusMain() {
  if (!main || main.isDestroyed()) return;
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
}

const touch = (slot) => store.edit((d) => { const a = model.account(d, slot); if (a) a.lastActive = Date.now(); });

/** Brings `slot` (0 = dashboard) to the front, optionally switching the layout mode. */
function showTab(slot, mode) {
  if (mode) tabs.mode = mode;
  const s = sessions.get(slot);
  tabs.active = s ? slot : 0;
  if (s) {
    tabs.recent = [slot, ...tabs.recent.filter((x) => x !== slot)];
    touch(slot);
  }
  relayout();
  focusMain();
  (s ? s.site || s.bar : dash).webContents.focus();
}

/** A pane got the keyboard focus (a click inside it when several are on screen). */
function markActive(slot) {
  if (tabs.active === slot || !sessions.has(slot)) return;
  tabs.active = slot;
  tabs.recent = [slot, ...tabs.recent.filter((x) => x !== slot)];
  touch(slot);
  relayout();
}

function closePane(slot) {
  const s = sessions.get(slot);
  if (!s) return;
  sessions.delete(slot);
  tabs.recent = tabs.recent.filter((x) => x !== slot);
  if (tabs.active === slot) tabs.active = tabs.recent[0] || 0;
  s.close();
  relayout();
}

/** Opens (or brings back) an account's tab. opts.beside shows that open account and this one side by side. */
function openSession(slot, opts = {}) {
  if (!model.account(store.data, slot)) {
    store.edit((d) => model.upsertAccount(d, { slot }));
  }
  const wantChrome = usesChrome(slot);
  let s = sessions.get(slot);
  if (s && (s.kind === 'chrome') !== wantChrome) {
    closePane(slot);
    s = null;
  }
  if (!s) {
    if (wantChrome && !browserPath()) throw new Error('No encontré Google Chrome ni Microsoft Edge. Instálalo o elige el navegador en Guía y ajustes.');
    s = wantChrome ? new ChromePane(slot) : new SessionPane(slot);
    sessions.set(slot, s);
    if (wantChrome) s.openBrowser();
  }
  let mode = null;
  if (opts.beside && opts.beside !== slot && sessions.has(opts.beside)) {
    tabs.recent = [opts.beside, ...tabs.recent.filter((x) => x !== opts.beside)];
    mode = 'split';
  }
  showTab(slot, mode);
  return s;
}

/** Shows every open account at once, in a grid. */
function tileSessions() {
  if (sessions.size) showTab(tabs.active || tabs.recent[0], 'grid');
  return sessions.size;
}

/** Ctrl+Tab: next tab (dashboard first, then the open accounts by slot). */
function cycleTab(step) {
  const order = [0, ...[...sessions.keys()].sort((a, b) => a - b)];
  const i = Math.max(0, order.indexOf(tabs.active));
  showTab(order[(i + step + order.length) % order.length]);
}

function sessionFor(sender) {
  for (const s of sessions.values()) if (s.bar.webContents === sender) return s;
  return null;
}

// ------------------------------------------------------------------ main window

function createMain() {
  const saved = store.data.windows.main;
  const wa = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1440, Math.round(wa.width * 0.92));
  const height = Math.min(980, Math.round(wa.height * 0.92));
  const b = saved && isOnScreen(saved) ? saved
    : { x: wa.x + Math.round((wa.width - width) / 2), y: wa.y + Math.round((wa.height - height) / 2), width, height };
  main = new BrowserWindow(Object.assign({}, b, {
    minWidth: 640, minHeight: 480, title: 'Relevo', icon: ICON, autoHideMenuBar: true, show: false,
    backgroundColor: bgColor(), webPreferences: ownPagePrefs()
  }));
  main.on('page-title-updated', (e) => e.preventDefault());
  attachContextMenu(main.webContents);
  main.loadFile(path.join(UI, 'shell.html'));
  dash = new WebContentsView({ webPreferences: ownPagePrefs() });
  dash.setBackgroundColor(bgColor());
  main.contentView.addChildView(dash);
  attachContextMenu(dash.webContents);
  dash.webContents.loadFile(path.join(UI, 'dashboard.html'));
  main.once('ready-to-show', () => (store.data.windows.mainMaximized ? main.maximize() : main.show()));
  const save = () => {
    if (main.isDestroyed() || main.isMinimized()) return;
    store.data.windows.mainMaximized = main.isMaximized();
    if (!main.isMaximized()) store.data.windows.main = main.getBounds();
    store.write();
  };
  for (const ev of ['resize', 'maximize', 'unmaximize', 'restore']) main.on(ev, relayout);
  for (const ev of ['resized', 'moved', 'maximize', 'unmaximize']) main.on(ev, save);
  main.on('closed', () => { main = null; });
  relayout();
}

function broadcast() {
  const payload = store.data;
  for (const v of [main, dash]) if (v && !v.webContents.isDestroyed()) v.webContents.send('data', payload);
  for (const s of sessions.values()) s.send('data', payload);
  sendTabs();
}


function schedulePauses() {
  for (const t of pauseTimers.values()) clearTimeout(t);
  pauseTimers.clear();
  const now = Date.now();
  for (const a of store.data.accounts) {
    if (a.pausedUntil > now) {
      const delay = Math.min(a.pausedUntil - now + 1000, 2 ** 31 - 1);
      pauseTimers.set(a.slot, setTimeout(() => notifyReady(a.slot), delay));
    }
  }
}

function notifyReady(slot) {
  const a = model.account(store.data, slot);
  if (!a || a.pausedUntil > Date.now() + 60000) return;
  broadcast();
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: '«' + a.name + '» vuelve a estar disponible', body: 'Haz clic para abrir su ventana.', icon: ICON });
  n.on('click', () => openSession(slot));
  n.show();
}

// ------------------------------------------------------------------ handoff actions

function currentProjectOf(slot) {
  const a = model.account(store.data, slot);
  return a ? model.project(store.data, a.activeProjectId) : null;
}

/** Copies the text and, if enabled, places it in the chat box (never sends it). */
async function deliver(s, text, retries = 8) {
  clipboard.writeText(text);
  if (s.kind === 'chrome') return 'chrome';
  if (!store.data.autoInsert) return 'copied';
  for (let i = 0; i <= retries; i++) {
    let r = 'fail';
    try {
      r = await s.run(inject.insert(text));
    } catch (e) {
      r = 'fail';
    }
    if (r !== 'noel') return r;
    await new Promise((res) => setTimeout(res, 700));
  }
  return 'noel';
}

function newChatUrlIfInConversation(s) {
  if (s.kind === 'chrome') return null;
  try {
    const u = new URL(s.site.webContents.getURL());
    if (!u.hostname.endsWith('claude.ai')) return null;
    if (/^\/chat\/.+/.test(u.pathname)) return core.URL_CHAT;
    if (/^\/code\/.+/.test(u.pathname)) return core.URL_CODE;
  } catch (e) { /* no page yet */ }
  return null;
}

async function readPageBlock(s) {
  if (s.kind === 'chrome') return { block: null, newestIsTemplate: false };
  try {
    const text = await s.run(inject.PAGE_TEXT);
    return core.find(text, true);
  } catch (e) {
    return { block: null, newestIsTemplate: false };
  }
}

// ------------------------------------------------------------------ automatic checkpoints

/**
 * Projects with the automatic state ask Claude to end every answer with the status block; this
 * keeps the newest one of the account that holds each project, so running out of messages
 * loses nothing. Only blocks that name the project, and never from an account it already left.
 */
let autoSaving = false;
async function autoSave() {
  if (autoSaving) return;
  autoSaving = true;
  try {
    for (const s of [...sessions.values()]) {
      const p = s.kind === 'integrated' ? currentProjectOf(s.slot) : null;
      if (!p || !p.autoState || p.currentSlot !== s.slot || p.pendingSlot) continue;
      const { block } = await readPageBlock(s);
      if (!block || !core.isAbout(block, p) || block === core.normalize(p.state)) continue;
      store.edit((d) => model.saveCheckpoint(d, p.id, s.slot, block, 'auto'));
      s.send('autosaved', core.progress(block));
    }
  } finally {
    autoSaving = false;
  }
}

// ------------------------------------------------------------------ IPC

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, value: await fn(event, ...args) };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
}

function registerIpc() {
  handle('data', () => store.data);
  handle('info', (e) => {
    const s = sessionFor(e.sender);
    return { slot: s ? s.slot : 0, version: app.getVersion(), platform: process.platform };
  });
  handle('copy', (e, text) => clipboard.writeText(String(text)));
  handle('paste', async () => String(await clipboard.readText()));
  handle('external', (e, url) => { if (/^https?:/i.test(url)) shell.openExternal(url); });
  handle('set', (e, key, value) => {
    if (!['autoInsert'].includes(key)) throw new Error('ajuste desconocido');
    store.edit((d) => { d[key] = value; });
  });
  handle('browser:info', () => {
    const exe = browserPath();
    return { path: exe || '', name: chrome.browserName(exe), custom: !!store.data.browserPath };
  });
  handle('browser:choose', async (e) => {
    const win = main;
    const opts = { title: 'Elegir navegador (chrome.exe o msedge.exe)', properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Programa', extensions: ['exe'] }] : [] };
    const r = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
    if (r.canceled || !r.filePaths.length) return null;
    store.edit((d) => { d.browserPath = r.filePaths[0]; });
    return chrome.browserName(r.filePaths[0]);
  });

  // Accounts / windows.
  handle('account:save', (e, fields) => store.edit((d) => model.upsertAccount(d, fields)).slot);
  handle('account:delete', async (e, slot) => {
    closePane(slot);
    await session.fromPartition(partitionOf(slot)).clearStorageData();
    await session.fromPartition(partitionOf(slot)).clearCache();
    try {
      fs.rmSync(profileDirOf(slot), { recursive: true, force: true });
    } catch (err) {
      // The browser may still have the profile open; it is reused if the slot is taken again.
    }
    store.edit((d) => model.deleteAccount(d, slot));
    schedulePauses();
  });
  handle('account:logout', async (e, slot) => {
    if (usesChrome(slot)) {
      try {
        fs.rmSync(profileDirOf(slot), { recursive: true, force: true });
      } catch (err) {
        throw new Error('Cierra primero las ventanas del navegador de esta cuenta y vuelve a intentarlo.');
      }
      return;
    }
    await session.fromPartition(partitionOf(slot)).clearStorageData();
    await session.fromPartition(partitionOf(slot)).clearCache();
    const s = sessions.get(slot);
    const a = model.account(store.data, slot);
    if (s && s.site) s.site.webContents.loadURL((a && a.startUrl) || core.URL_CHAT);
  });
  handle('account:use-chrome', (e, slot) => {
    if (!browserPath()) throw new Error('No encontré Google Chrome ni Microsoft Edge. Instálalo o elige el navegador en Guía y ajustes.');
    store.edit((d) => { const a = model.account(d, slot); if (a) a.browser = 'chrome'; });
    openSession(slot);
  });
  handle('account:open', (e, slot, mode) => {
    const from = sessionFor(e.sender);
    const beside = mode === 'side' ? (from ? from.slot : tabs.recent.find((x) => x !== slot)) : 0;
    openSession(slot, { beside });
  });
  handle('account:open-all', () => {
    const now = Date.now();
    const list = model.sortedAccounts(store.data).filter((a) => !core.isPaused(a, now));
    for (const a of list) openSession(a.slot);
    if (list.length > 1) tileSessions();
    return list.length;
  });
  handle('tile', () => tileSessions());
  handle('account:pause', (e, slot, until) => {
    store.edit((d) => { const a = model.account(d, slot); if (a) a.pausedUntil = until; });
    schedulePauses();
  });
  handle('account:open-project', (e, slot, projectId) => {
    store.edit((d) => { const a = model.account(d, slot); if (a) a.activeProjectId = projectId || ''; });
  });

  // Projects.
  handle('project:create', (e, fields, slot) => store.edit((d) => model.createProject(d, fields, slot || 0)).id);
  handle('project:update', (e, id, fields) => { store.edit((d) => model.updateProject(d, id, fields)); });
  handle('project:delete', (e, id) => store.edit((d) => model.deleteProject(d, id)));
  handle('project:state', (e, id, text, type) => {
    const r = core.find(text, false);
    const block = r.block || String(text).trim();
    if (!block) throw new Error('El estado está vacío');
    const s = sessionFor(e.sender);
    return store.edit((d) => model.saveCheckpoint(d, id, s ? s.slot : 0, block, type || 'edit'));
  });
  handle('project:restore', (e, id, index) => {
    const p = model.project(store.data, id);
    const ev = p && p.history[index];
    if (!ev || !ev.text) throw new Error('Ese evento no tiene estado');
    return store.edit((d) => model.saveCheckpoint(d, id, 0, ev.text, 'restore'));
  });
  handle('project:continue', (e, id, slot) => {
    const p = model.project(store.data, id);
    if (!p) throw new Error('Proyecto no encontrado');
    if (slot && slot !== p.currentSlot) {
      store.edit((d) => model.transfer(d, id, 0, slot, 0));
      openSession(slot);
      return;
    }
    store.edit((d) => {
      const pr = model.project(d, id);
      const a = model.account(d, pr.currentSlot);
      if (a) a.activeProjectId = id;
      if (!core.hasState(pr)) pr.pendingSlot = pr.currentSlot;
    });
    openSession(p.currentSlot);
  });
  handle('project:transfer', (e, id, fromSlot, toSlot, pauseMs, side) => {
    const until = store.edit((d) => model.transfer(d, id, fromSlot, toSlot, pauseMs || 0));
    if (until) schedulePauses();
    openSession(toSlot, { beside: side ? fromSlot : 0 });
  });
  handle('project:import', (e, text) => store.edit((d) => model.importText(d, text)).name);
  handle('project:export', async (e, id) => {
    const p = model.project(store.data, id);
    if (!p) throw new Error('Proyecto no encontrado');
    const win = main;
    const opts = {
      title: 'Exportar proyecto', defaultPath: p.name.replace(/[\\/:*?"<>|]/g, '_') + '.relevo.json',
      filters: [{ name: 'Proyecto Relevo', extensions: ['json'] }]
    };
    const r = await (win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts));
    if (r.canceled || !r.filePath) return false;
    fs.writeFileSync(r.filePath, JSON.stringify(p, null, 2));
    return r.filePath;
  });
  handle('project:import-file', async (e) => {
    const win = main;
    const opts = { properties: ['openFile'], filters: [{ name: 'Proyecto Relevo', extensions: ['json', 'txt', 'md'] }] };
    const r = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
    if (r.canceled || !r.filePaths.length) return null;
    const text = fs.readFileSync(r.filePaths[0], 'utf8');
    return store.edit((d) => model.importText(d, text)).name;
  });
  handle('dashboard', () => showTab(0));

  // Tab strip.
  handle('tabs', () => tabState());
  handle('tab:show', (e, slot) => { if (slot) openSession(slot); else showTab(0); });
  handle('tab:close', (e, slot) => closePane(slot));
  handle('tab:mode', (e, mode) => {
    if (!['single', 'split', 'grid'].includes(mode)) throw new Error('modo desconocido');
    showTab(tabs.active || tabs.recent[0] || 0, mode);
  });
  handle('tab:add', () => {
    showTab(0);
    dash.webContents.send('command', 'add-account');
  });

  // Toolbar of a session window.
  handle('bar:height', (e, h) => {
    const s = sessionFor(e.sender);
    if (s) { s.barHeight = Math.max(36, Math.min(400, Math.round(h))); s.layout(); }
  });
  handle('bar:overlay', (e, on) => {
    const s = sessionFor(e.sender);
    if (s) { s.overlay = !!on; s.layout(); if (on) s.bar.webContents.focus(); }
  });
  handle('bar:nav', (e, action, url) => {
    const s = sessionFor(e.sender);
    if (!s) return;
    if (s.kind === 'chrome') {
      if (action === 'load' && url) s.openBrowser(/^https?:\/\//i.test(url) ? url : 'https://' + url);
      else if (action === 'open-browser') s.openBrowser();
      return;
    }
    const wc = s.site.webContents;
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (action === 'reload') wc.reload();
    else if (action === 'load' && url) wc.loadURL(/^https?:\/\//i.test(url) ? url : 'https://' + url);
    else if (action === 'external') shell.openExternal(wc.getURL());
    else if (action === 'copy-url') clipboard.writeText(wc.getURL());
    else if (action === 'devtools') wc.openDevTools({ mode: 'detach' });
  });
  handle('bar:insert', async (e, kind, projectId, where) => {
    const s = sessionFor(e.sender);
    if (!s) throw new Error('ventana no encontrada');
    const p = model.project(store.data, projectId) || currentProjectOf(s.slot);
    if (!p) return { status: 'no-project' };
    if (kind === 'checkpoint') return { status: await deliver(s, core.checkpoint(p)) };
    const text = core.next(p);
    if (s.kind === 'chrome') {
      // A fresh chat in the account's browser, with the prompt ready to paste.
      const a = model.account(store.data, s.slot);
      s.openBrowser(a && a.startUrl === core.URL_CODE ? core.URL_CODE : core.URL_CHAT);
      clipboard.writeText(text);
      store.edit((d) => model.handoffDone(d, p.id, s.slot));
      return { status: 'chrome-new' };
    }
    const newChat = newChatUrlIfInConversation(s);
    if (newChat && where !== 'here' && where !== 'new') return { status: 'ask' };
    if (newChat && where === 'new') {
      await s.site.webContents.loadURL(newChat).catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
    }
    const status = await deliver(s, text, 14);
    store.edit((d) => model.handoffDone(d, p.id, s.slot));
    return { status };
  });
  handle('bar:save-state', async (e, quiet) => {
    const s = sessionFor(e.sender);
    const p = s && currentProjectOf(s.slot);
    if (!p) return { status: 'no-project' };
    const page = await readPageBlock(s);
    let block = page.block, source = 'la conversación';
    if (!block || page.newestIsTemplate) {
      // clipboard.readText() returns a promise in recent Electron versions; await works either way.
      const text = String(await clipboard.readText());
      const clip = core.isOwnPrompt(text) ? { block: null } : core.find(text, false);
      if (clip.block) { block = clip.block; source = 'el portapapeles'; }
      else if (page.newestIsTemplate) return { status: 'template' };
    }
    if (!block) return { status: s.kind === 'chrome' ? 'none-clipboard' : 'none' };
    const changed = store.edit((d) => model.saveCheckpoint(d, p.id, s.slot, block, 'checkpoint'));
    return { status: changed ? 'saved' : 'same', source, progress: core.progress(block), template: page.newestIsTemplate };
  });
  handle('bar:conversation', async (e) => {
    const s = sessionFor(e.sender);
    if (!s || s.kind === 'chrome') return { text: '', files: [] };
    const read = async (script) => String((await s.run(script).catch(() => '')) || '');
    return { text: await read(inject.CONVERSATION), files: core.fileNames(await read(inject.MAIN_TEXT)) };
  });
  handle('bar:dismiss-pending', (e, id) => {
    const s = sessionFor(e.sender);
    store.edit((d) => { const p = model.project(d, id); if (p && s && p.pendingSlot === s.slot) p.pendingSlot = 0; });
  });
  handle('bar:menu', (e) => {
    const s = sessionFor(e.sender);
    if (!s) return;
    const a = model.account(store.data, s.slot);
    if (s.kind === 'chrome') {
      Menu.buildFromTemplate([
        { label: 'Abrir la ventana del navegador', click: () => s.openBrowser() },
        { label: 'Nuevo chat', click: () => s.openBrowser(core.URL_CHAT) },
        { label: 'Claude Code', click: () => s.openBrowser(core.URL_CODE) },
        { type: 'separator' },
        { label: 'Panel principal', click: () => showTab(0) },
        { label: 'Ver otra cuenta al lado…', click: () => s.send('command', 'open-beside') },
        { label: 'Ver todas en mosaico', click: () => tileSessions() },
        { type: 'separator' },
        { label: 'Pausar esta cuenta…', click: () => s.send('command', 'pause') },
        { label: 'Pegar estado a mano…', click: () => s.send('command', 'manual-state') },
        { label: 'Abrir en una ventana integrada de Relevo', click: () => {
          store.edit((d) => { const acc = model.account(d, s.slot); if (acc) acc.browser = 'integrated'; });
          openSession(s.slot);
        } },
        { type: 'separator' },
        { label: 'Borrar el perfil del navegador de esta cuenta…', click: () => s.send('command', 'logout') },
        { label: 'Cerrar pestaña', click: () => closePane(s.slot) }
      ]).popup();
      return;
    }
    const wc = s.site.webContents;
    Menu.buildFromTemplate([
      { label: 'Nuevo chat', click: () => wc.loadURL(core.URL_CHAT) },
      { label: 'Claude Code', click: () => wc.loadURL(core.URL_CODE) },
      { label: 'Página de inicio de la cuenta', click: () => wc.loadURL((a && a.startUrl) || core.URL_CHAT) },
      { type: 'separator' },
      { label: 'Panel principal', click: () => showTab(0) },
      { label: 'Ver otra cuenta al lado…', click: () => s.send('command', 'open-beside') },
      { label: 'Ver todas en mosaico', click: () => tileSessions() },
      { type: 'separator' },
      { label: 'Pausar esta cuenta…', click: () => s.send('command', 'pause') },
      { label: 'Pegar estado a mano…', click: () => s.send('command', 'manual-state') },
      { label: 'Abrir un enlace aquí (p. ej. de inicio de sesión)…', click: () => s.send('command', 'open-link') },
      { label: 'Abrir esta cuenta en Chrome (para iniciar sesión con Google)', click: () => s.send('command', 'google-blocked') },
      { type: 'checkbox', label: 'Insertar prompts en el chat', checked: store.data.autoInsert,
        click: (item) => store.edit((d) => { d.autoInsert = item.checked; }) },
      { type: 'separator' },
      { label: 'Abrir página en el navegador', click: () => shell.openExternal(wc.getURL()) },
      { label: 'Copiar enlace', click: () => clipboard.writeText(wc.getURL()) },
      { label: 'Acercar', click: () => wc.setZoomLevel(wc.getZoomLevel() + 0.5) },
      { label: 'Alejar', click: () => wc.setZoomLevel(wc.getZoomLevel() - 0.5) },
      { label: 'Tamaño normal', click: () => wc.setZoomLevel(0) },
      { type: 'separator' },
      { label: 'Cerrar sesión de esta cuenta…', click: () => s.send('command', 'logout') },
      { label: 'Cerrar pestaña', click: () => closePane(s.slot) }
    ]).popup();
  });
}

// ------------------------------------------------------------------ application menu

const focusedSession = () => sessions.get(tabs.active) || null;

function buildAppMenu() {
  const onSite = (fn) => () => { const s = focusedSession(); if (s && s.site) fn(s.site.webContents, s); };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Archivo', submenu: [
      { label: 'Panel principal', accelerator: 'CmdOrCtrl+Shift+H', click: () => showTab(0) },
      { label: 'Ver todas las cuentas en mosaico', accelerator: 'CmdOrCtrl+Shift+M', click: () => tileSessions() },
      { label: 'Pestaña siguiente', accelerator: 'Ctrl+Tab', click: () => cycleTab(1) },
      { label: 'Pestaña anterior', accelerator: 'Ctrl+Shift+Tab', click: () => cycleTab(-1) },
      { type: 'separator' },
      { role: 'quit', label: 'Salir' }
    ] },
    { label: 'Edición', submenu: [
      { role: 'undo', label: 'Deshacer' }, { role: 'redo', label: 'Rehacer' }, { type: 'separator' },
      { role: 'cut', label: 'Cortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Pegar' },
      { role: 'selectAll', label: 'Seleccionar todo' }
    ] },
    { label: 'Sesión', submenu: [
      { label: 'Recargar', accelerator: 'CmdOrCtrl+R', click: onSite((wc) => wc.reload()) },
      { label: 'Atrás', accelerator: 'Alt+Left', click: onSite((wc) => wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack()) },
      { label: 'Adelante', accelerator: 'Alt+Right', click: onSite((wc) => wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward()) },
      { label: 'Nuevo chat', accelerator: 'CmdOrCtrl+Shift+O', click: onSite((wc) => wc.loadURL(core.URL_CHAT)) },
      { type: 'separator' },
      { label: 'Acercar', accelerator: 'CmdOrCtrl+=', click: onSite((wc) => wc.setZoomLevel(wc.getZoomLevel() + 0.5)) },
      { label: 'Alejar', accelerator: 'CmdOrCtrl+-', click: onSite((wc) => wc.setZoomLevel(wc.getZoomLevel() - 0.5)) },
      { label: 'Tamaño normal', accelerator: 'CmdOrCtrl+0', click: onSite((wc) => wc.setZoomLevel(0)) },
      { type: 'separator' },
      { label: 'Herramientas de desarrollo', accelerator: 'CmdOrCtrl+Shift+I', click: () => {
        const s = focusedSession();
        if (s && s.site) s.site.webContents.openDevTools({ mode: 'detach' });
        else if (!tabs.active) dash.webContents.openDevTools({ mode: 'detach' });
      } }
    ] }
  ]));
}

// ------------------------------------------------------------------ lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => focusMain());
  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('io.github.lancaster2995.relevo');
    store = new Store(path.join(app.getPath('userData'), 'relevo.json'));
    store.onChange(() => broadcast());
    registerIpc();
    buildAppMenu();
    schedulePauses();
    store.onChange(() => schedulePauses());
    setInterval(autoSave, Number(process.env.RELEVO_AUTOSAVE_MS) || 20000);
    createMain();
  });
  app.on('window-all-closed', () => app.quit());
}

module.exports = { tileSessions, openSession };
