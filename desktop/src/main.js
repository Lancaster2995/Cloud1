'use strict';
/*
 * Relevo for Windows (Electron main process).
 *
 * Each Claude account opens in one of two ways:
 *  - "chrome": the user's real Chrome/Edge with a separate profile directory per account
 *    (chrome.js). Google sign-in works there. Relevo shows a small control bar for the account
 *    and moves prompts and status blocks through the clipboard.
 *  - "integrated": a Relevo window whose page lives in its own persistent session partition
 *    ("persist:relevo-sN"). Google does not allow signing in inside embedded windows, so
 *    Relevo stops that navigation and offers Chrome or e-mail sign-in instead.
 * Either way the toolbar drives the handoff: start/handoff prompt, CHECKPOINT, save the status
 * block and pass the project to another account.
 */
const path = require('path');
const {
  app, BaseWindow, BrowserWindow, WebContentsView, ipcMain, Menu, Notification, shell, clipboard,
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
let dashboard = null;
const sessions = new Map(); // slot -> SessionWindow
const pauseTimers = new Map();

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

// ------------------------------------------------------------------ session windows

const BAR_HEIGHT = 50;

class SessionWindow {
  constructor(slot, region) {
    this.kind = 'integrated';
    this.slot = slot;
    const a = model.account(store.data, slot);
    const saved = store.data.windows[slot];
    const bounds = region || (saved && isOnScreen(saved) ? saved : defaultBounds(slot));
    this.win = new BaseWindow(Object.assign({}, bounds, {
      minWidth: 420, minHeight: 360, title: 'Relevo · ' + a.name, icon: ICON,
      autoHideMenuBar: true, backgroundColor: nativeTheme.shouldUseDarkColors ? '#191817' : '#f6f4ef', show: false
    }));
    setupSession(slot);
    this.site = new WebContentsView({
      webPreferences: { partition: partitionOf(slot), contextIsolation: true, sandbox: true, spellcheck: true }
    });
    this.bar = new WebContentsView({
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
    });
    this.bar.setBackgroundColor('#00000000');
    this.win.contentView.addChildView(this.site);
    this.win.contentView.addChildView(this.bar);
    this.barHeight = BAR_HEIGHT;
    this.overlay = false;
    this.layout();

    this.win.on('resize', () => this.layout());
    this.win.on('resized', () => this.saveBounds());
    this.win.on('moved', () => this.saveBounds());
    this.win.on('focus', () => {
      store.edit((d) => {
        const acc = model.account(d, slot);
        if (acc) acc.lastActive = Date.now();
      });
    });
    this.win.on('closed', () => {
      sessions.delete(slot);
      for (const v of [this.site, this.bar]) if (!v.webContents.isDestroyed()) v.webContents.close();
    });

    this.setupSite();
    attachContextMenu(this.bar.webContents);
    this.bar.webContents.loadFile(path.join(UI, 'toolbar.html'), { query: { slot: String(slot) } });
    this.site.webContents.loadURL(a.startUrl || core.URL_CHAT);
    this.win.show();
  }

  layout() {
    if (this.win.isDestroyed()) return;
    const { width, height } = this.win.getContentBounds();
    this.bar.setBounds({ x: 0, y: 0, width, height: this.overlay ? height : this.barHeight });
    this.site.setBounds({ x: 0, y: this.barHeight, width, height: Math.max(0, height - this.barHeight) });
  }

  saveBounds() {
    if (this.win.isDestroyed() || this.win.isMinimized() || this.win.isMaximized()) return;
    const b = this.win.getBounds();
    store.data.windows[this.slot] = b;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => store.write(), 800);
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
            width: 520, height: 720, autoHideMenuBar: true, icon: ICON,
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
    wc.on('page-title-updated', (e, title) => {
      const a = model.account(store.data, slot);
      if (a && !this.win.isDestroyed()) this.win.setTitle(a.name + ' · ' + title + ' — Relevo');
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

  send(channel, payload) {
    if (!this.bar.webContents.isDestroyed()) this.bar.webContents.send(channel, payload);
  }

  focus() {
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }

  async run(script) {
    return this.site.webContents.executeJavaScript(script, true);
  }

  place(bounds) {
    if (this.win.isMinimized()) this.win.restore();
    if (this.win.isMaximized()) this.win.unmaximize();
    this.win.setBounds(bounds);
  }
}

const CHROME_BAR_FRAME = 40; // approximate title bar height of the control window

/**
 * An account that lives in the real browser. Relevo only shows its control bar (same toolbar
 * page, "chrome" mode) and launches the browser with the account's own profile directory.
 */
class ChromeSession {
  constructor(slot, region) {
    this.kind = 'chrome';
    this.slot = slot;
    this.barHeight = 92;
    this.overlay = false;
    const a = model.account(store.data, slot);
    const area = region || defaultBounds(slot);
    const saved = store.data.windows['bar' + slot];
    const barBounds = !region && saved && isOnScreen(saved) ? saved
      : { x: area.x, y: area.y, width: area.width, height: this.barHeight + CHROME_BAR_FRAME };
    this.win = new BrowserWindow({
      x: barBounds.x, y: barBounds.y, width: barBounds.width, height: this.barHeight + CHROME_BAR_FRAME,
      minWidth: 420, minHeight: 80, title: 'Relevo · ' + a.name + ' (Chrome)', icon: ICON, autoHideMenuBar: true,
      maximizable: false, fullscreenable: false, show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#252422' : '#ffffff',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
    });
    this.bar = { webContents: this.win.webContents };
    attachContextMenu(this.win.webContents);
    this.win.loadFile(path.join(UI, 'toolbar.html'), { query: { slot: String(slot), mode: 'chrome' } });
    this.win.once('ready-to-show', () => this.win.show());
    this.win.on('moved', () => this.saveBounds());
    this.win.on('resized', () => this.saveBounds());
    this.win.on('focus', () => store.edit((d) => { const acc = model.account(d, slot); if (acc) acc.lastActive = Date.now(); }));
    this.win.on('closed', () => sessions.delete(slot));
    this.browserArea = { x: area.x, y: area.y + this.barHeight + CHROME_BAR_FRAME + 4, width: area.width,
      height: Math.max(360, area.height - this.barHeight - CHROME_BAR_FRAME - 4) };
  }

  /** Opens `url` (default: the account's start page) in the account's own browser profile. */
  openBrowser(url) {
    const exe = browserPath();
    if (!exe) throw new Error('No encontré Google Chrome ni Microsoft Edge. Instálalo o elige el navegador en Guía y ajustes.');
    const a = model.account(store.data, this.slot);
    const dir = profileDirOf(this.slot);
    chrome.prepareProfile(dir, 'Relevo · ' + (a ? a.name : 'Cuenta ' + this.slot));
    chrome.launch(exe, dir, url || (a && a.startUrl) || core.URL_CHAT, this.browserArea);
  }

  layout() {
    if (this.win.isDestroyed()) return;
    const [width] = this.win.getContentSize();
    this.win.setContentSize(width, this.overlay ? Math.max(this.barHeight, 620) : this.barHeight);
  }

  saveBounds() {
    if (this.win.isDestroyed() || this.overlay) return;
    store.data.windows['bar' + this.slot] = this.win.getBounds();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => store.write(), 800);
  }

  place(bounds) {
    this.win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: this.win.getBounds().height });
    this.browserArea = { x: bounds.x, y: bounds.y + this.win.getBounds().height + 4, width: bounds.width,
      height: Math.max(360, bounds.height - this.win.getBounds().height - 4) };
  }

  send(channel, payload) {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  focus() {
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
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

function defaultBounds(slot) {
  const wa = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1100, Math.round(wa.width * 0.62));
  const height = Math.min(900, Math.round(wa.height * 0.86));
  const step = 32 * ((slot - 1) % 8);
  return { x: wa.x + Math.min(40 + step, wa.width - width), y: wa.y + Math.min(20 + step, wa.height - height), width, height };
}

/**
 * Opens (or brings back) an account. opts.region places it; opts.beside puts that window on the
 * left half of its display and this account on the right half.
 */
function openSession(slot, opts = {}) {
  if (!model.account(store.data, slot)) {
    store.edit((d) => model.upsertAccount(d, { slot }));
  }
  let region = opts.region || null;
  if (opts.beside && !opts.beside.isDestroyed()) {
    const wa = screen.getDisplayMatching(opts.beside.getBounds()).workArea;
    const half = Math.floor(wa.width / 2);
    const left = { x: wa.x, y: wa.y, width: half, height: wa.height };
    const owner = [...sessions.values()].find((x) => x.win === opts.beside);
    if (owner) {
      owner.place(left);
    } else {
      if (opts.beside.isMaximized()) opts.beside.unmaximize();
      opts.beside.setBounds(left);
    }
    region = { x: wa.x + half, y: wa.y, width: wa.width - half, height: wa.height };
  }
  const wantChrome = usesChrome(slot);
  let s = sessions.get(slot);
  if (s && (s.kind === 'chrome') !== wantChrome) {
    s.win.close();
    sessions.delete(slot);
    s = null;
  }
  if (!s) {
    if (wantChrome) {
      if (!browserPath()) throw new Error('No encontré Google Chrome ni Microsoft Edge. Instálalo o elige el navegador en Guía y ajustes.');
      s = new ChromeSession(slot, region);
      sessions.set(slot, s);
      s.openBrowser();
      return s;
    }
    s = new SessionWindow(slot, region);
    sessions.set(slot, s);
    return s;
  }
  if (region) s.place(region);
  s.focus();
  if (s.kind === 'chrome' && !opts.barOnly) s.openBrowser();
  return s;
}

function gridCells(n) {
  const wa = screen.getPrimaryDisplay().workArea;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const w = Math.floor(wa.width / cols), h = Math.floor(wa.height / rows);
  return Array.from({ length: n }, (_, i) => ({ x: wa.x + (i % cols) * w, y: wa.y + Math.floor(i / cols) * h, width: w, height: h }));
}

/**
 * Arranges the open accounts in a grid. Integrated windows move into their cell; for accounts in
 * the browser only the control bar can be moved (the browser places its own windows).
 */
function tileSessions() {
  const list = [...sessions.values()].filter((s) => !s.win.isDestroyed()).sort((a, b) => a.slot - b.slot);
  if (!list.length) return 0;
  const cells = gridCells(list.length);
  list.forEach((s, i) => {
    s.place(cells[i]);
    s.win.show();
  });
  return list.length;
}

function sessionFor(sender) {
  for (const s of sessions.values()) if (s.bar.webContents === sender) return s;
  return null;
}

// ------------------------------------------------------------------ dashboard

function openDashboard() {
  if (dashboard && !dashboard.isDestroyed()) {
    if (dashboard.isMinimized()) dashboard.restore();
    dashboard.show();
    dashboard.focus();
    return dashboard;
  }
  const saved = store.data.windows.dashboard;
  const b = saved && isOnScreen(saved) ? saved : { width: 1040, height: 780 };
  dashboard = new BrowserWindow(Object.assign({}, b, {
    minWidth: 420, minHeight: 480, title: 'Relevo', icon: ICON, autoHideMenuBar: true, show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191817' : '#f6f4ef',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  }));
  attachContextMenu(dashboard.webContents);
  dashboard.loadFile(path.join(UI, 'dashboard.html'));
  dashboard.once('ready-to-show', () => dashboard.show());
  const save = () => {
    if (dashboard.isDestroyed() || dashboard.isMinimized() || dashboard.isMaximized()) return;
    store.data.windows.dashboard = dashboard.getBounds();
    store.write();
  };
  dashboard.on('resized', save);
  dashboard.on('moved', save);
  dashboard.on('closed', () => { dashboard = null; });
  return dashboard;
}

function broadcast() {
  const payload = store.data;
  if (dashboard && !dashboard.isDestroyed()) dashboard.webContents.send('data', payload);
  for (const s of sessions.values()) {
    s.send('data', payload);
    const a = model.account(store.data, s.slot);
    if (a && !s.win.isDestroyed() && !s.win.getTitle().startsWith(a.name)) s.win.setTitle('Relevo · ' + a.name);
  }
}

// ------------------------------------------------------------------ pauses

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
    const win = BrowserWindow.fromWebContents(e.sender);
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
    const s = sessions.get(slot);
    if (s) s.win.close();
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
    const beside = mode === 'side' ? BrowserWindow.fromWebContents(e.sender) || (sessionFor(e.sender) || {}).win : null;
    openSession(slot, { beside });
  });
  handle('account:open-all', () => {
    const now = Date.now();
    const list = model.sortedAccounts(store.data).filter((a) => !core.isPaused(a, now));
    const cells = gridCells(Math.max(1, list.length));
    list.forEach((a, i) => openSession(a.slot, { region: list.length > 1 ? cells[i] : null }));
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
    const from = sessions.get(fromSlot);
    openSession(toSlot, { beside: side ? (from ? from.win : BrowserWindow.fromWebContents(e.sender)) : null });
  });
  handle('project:import', (e, text) => store.edit((d) => model.importText(d, text)).name);
  handle('project:export', async (e, id) => {
    const p = model.project(store.data, id);
    if (!p) throw new Error('Proyecto no encontrado');
    const win = BrowserWindow.fromWebContents(e.sender);
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
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { properties: ['openFile'], filters: [{ name: 'Proyecto Relevo', extensions: ['json', 'txt', 'md'] }] };
    const r = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
    if (r.canceled || !r.filePaths.length) return null;
    const text = fs.readFileSync(r.filePaths[0], 'utf8');
    return store.edit((d) => model.importText(d, text)).name;
  });
  handle('dashboard', () => { openDashboard(); });

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
      const clip = core.find(String(await clipboard.readText()), false);
      if (clip.block) { block = clip.block; source = 'el portapapeles'; }
      else if (page.newestIsTemplate) return { status: 'template' };
    }
    if (!block) return { status: s.kind === 'chrome' ? 'none-clipboard' : 'none' };
    const changed = store.edit((d) => model.saveCheckpoint(d, p.id, s.slot, block, 'checkpoint'));
    return { status: changed ? 'saved' : 'same', source, progress: core.progress(block), template: page.newestIsTemplate };
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
        { label: 'Panel principal', click: () => openDashboard() },
        { label: 'Abrir otra cuenta al lado…', click: () => s.send('command', 'open-beside') },
        { label: 'Organizar en mosaico', click: () => tileSessions() },
        { type: 'checkbox', label: 'Mantener esta barra siempre visible', checked: s.win.isAlwaysOnTop(),
          click: (item) => s.win.setAlwaysOnTop(item.checked) },
        { type: 'separator' },
        { label: 'Pausar esta cuenta…', click: () => s.send('command', 'pause') },
        { label: 'Pegar estado a mano…', click: () => s.send('command', 'manual-state') },
        { label: 'Abrir en una ventana integrada de Relevo', click: () => {
          store.edit((d) => { const acc = model.account(d, s.slot); if (acc) acc.browser = 'integrated'; });
          openSession(s.slot);
        } },
        { type: 'separator' },
        { label: 'Borrar el perfil del navegador de esta cuenta…', click: () => s.send('command', 'logout') },
        { label: 'Cerrar esta barra', click: () => s.win.close() }
      ]).popup();
      return;
    }
    const wc = s.site.webContents;
    Menu.buildFromTemplate([
      { label: 'Nuevo chat', click: () => wc.loadURL(core.URL_CHAT) },
      { label: 'Claude Code', click: () => wc.loadURL(core.URL_CODE) },
      { label: 'Página de inicio de la cuenta', click: () => wc.loadURL((a && a.startUrl) || core.URL_CHAT) },
      { type: 'separator' },
      { label: 'Panel principal', click: () => openDashboard() },
      { label: 'Abrir otra cuenta al lado…', click: () => s.send('command', 'open-beside') },
      { label: 'Organizar ventanas en mosaico', click: () => tileSessions() },
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
      { label: 'Cerrar ventana', click: () => s.win.close() }
    ]).popup();
  });
}

// ------------------------------------------------------------------ application menu

function focusedSession() {
  for (const s of sessions.values()) if (!s.win.isDestroyed() && s.win.isFocused()) return s;
  return null;
}

function buildAppMenu() {
  const onSite = (fn) => () => { const s = focusedSession(); if (s && s.site) fn(s.site.webContents, s); };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Archivo', submenu: [
      { label: 'Panel principal', accelerator: 'CmdOrCtrl+Shift+H', click: () => openDashboard() },
      { label: 'Organizar ventanas en mosaico', accelerator: 'CmdOrCtrl+Shift+M', click: () => tileSessions() },
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
        else if (dashboard && dashboard.isFocused()) dashboard.webContents.openDevTools({ mode: 'detach' });
      } }
    ] }
  ]));
}

// ------------------------------------------------------------------ lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openDashboard());
  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('io.github.lancaster2995.relevo');
    store = new Store(path.join(app.getPath('userData'), 'relevo.json'));
    store.onChange(() => broadcast());
    registerIpc();
    buildAppMenu();
    schedulePauses();
    store.onChange(() => schedulePauses());
    openDashboard();
  });
  app.on('window-all-closed', () => app.quit());
}

module.exports = { tileSessions, openSession };
