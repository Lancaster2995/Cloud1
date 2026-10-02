/*
 * Data operations on the persisted document. Same JSON schema as the Android app
 * (accounts with numbered slots, projects with state + history). Pure functions: no Electron,
 * so they are unit-tested directly. Works in Node (require) and in the Firefox extension (<script>).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./shared/core'));
  else root.RelevoModel = factory(root.RelevoCore);
})(typeof self !== 'undefined' ? self : this, function (core) {
  'use strict';

  const MAX_SLOTS = 12;

  function defaults(d) {
    d = d && typeof d === 'object' ? d : {};
    d.version = 1;
    d.accounts = Array.isArray(d.accounts) ? d.accounts : [];
    d.projects = Array.isArray(d.projects) ? d.projects : [];
    if (typeof d.autoInsert !== 'boolean') d.autoInsert = true;
    d.windows = d.windows && typeof d.windows === 'object' ? d.windows : {};
    for (const a of d.accounts) {
      a.name = a.name || 'Cuenta ' + a.slot;
      a.note = a.note || '';
      a.color = a.color || core.COLORS[(a.slot - 1) % core.COLORS.length];
      a.startUrl = a.startUrl || core.URL_CHAT;
      a.pausedUntil = a.pausedUntil || 0;
      a.lastActive = a.lastActive || 0;
      a.activeProjectId = a.activeProjectId || '';
      a.browser = a.browser === 'chrome' ? 'chrome' : 'integrated';
    }
    for (const p of d.projects) normalizeProject(p);
    return d;
  }

  function normalizeProject(p) {
    p.id = p.id || globalThis.crypto.randomUUID();
    for (const k of ['name', 'goal', 'repo', 'branch', 'notes', 'state']) p[k] = p[k] || '';
    for (const k of ['progress', 'currentSlot', 'pendingSlot', 'stateTime', 'created', 'updated']) p[k] = Number(p[k]) || 0;
    p.history = Array.isArray(p.history) ? p.history : [];
    return p;
  }

  const account = (d, slot) => d.accounts.find((a) => a.slot === slot) || null;
  const project = (d, id) => (id ? d.projects.find((p) => p.id === id) || null : null);
  const sortedAccounts = (d) => d.accounts.slice().sort((a, b) => a.slot - b.slot);
  const sortedProjects = (d) => d.projects.slice().sort((a, b) => b.updated - a.updated);

  function freeSlot(d) {
    for (let s = 1; s <= MAX_SLOTS; s++) if (!account(d, s)) return s;
    return 0;
  }

  function addEvent(p, e) {
    p.history.push(Object.assign({ time: Date.now(), type: 'checkpoint', slot: 0, toSlot: 0, progress: -1,
      accountName: '', toAccountName: '', text: '' }, e));
    while (p.history.length > core.MAX_HISTORY) p.history.shift();
  }

  function upsertAccount(d, fields) {
    let a = fields.slot ? account(d, fields.slot) : null;
    if (!a) {
      const slot = fields.slot || freeSlot(d);
      if (!slot) throw new Error('Máximo ' + MAX_SLOTS + ' cuentas');
      a = { slot, name: '', note: '', color: core.COLORS[(slot - 1) % core.COLORS.length], startUrl: core.URL_CHAT,
        pausedUntil: 0, lastActive: 0, activeProjectId: '', browser: 'integrated' };
      d.accounts.push(a);
    }
    for (const k of ['name', 'note', 'color', 'startUrl']) if (fields[k] !== undefined) a[k] = String(fields[k]).trim();
    if (fields.browser !== undefined) a.browser = fields.browser === 'chrome' ? 'chrome' : 'integrated';
    if (!a.name) a.name = 'Cuenta ' + a.slot;
    if (!a.startUrl) a.startUrl = core.URL_CHAT;
    return a;
  }

  function deleteAccount(d, slot) {
    d.accounts = d.accounts.filter((a) => a.slot !== slot);
    for (const p of d.projects) {
      if (p.pendingSlot === slot) p.pendingSlot = 0;
      if (p.currentSlot === slot) p.currentSlot = 0;
    }
    delete d.windows[slot];
  }

  function createProject(d, fields, slot) {
    const now = Date.now();
    const p = normalizeProject({
      id: globalThis.crypto.randomUUID(), name: String(fields.name || '').trim(), goal: String(fields.goal || '').trim(),
      repo: String(fields.repo || '').trim(), branch: String(fields.branch || '').trim(),
      notes: String(fields.notes || '').trim(), created: now, updated: now, currentSlot: slot || 0
    });
    if (!p.name) throw new Error('Escribe un nombre');
    addEvent(p, { time: now, type: 'create', slot: slot || 0, accountName: slot ? core.accountName(d, slot) : '', progress: 0 });
    d.projects.push(p);
    const a = account(d, slot);
    if (a) a.activeProjectId = p.id;
    return p;
  }

  function updateProject(d, id, fields) {
    const p = project(d, id);
    if (!p) return null;
    for (const k of ['name', 'goal', 'repo', 'branch', 'notes']) if (fields[k] !== undefined) p[k] = String(fields[k]).trim();
    if (!p.name) throw new Error('Escribe un nombre');
    p.updated = Date.now();
    return p;
  }

  function deleteProject(d, id) {
    d.projects = d.projects.filter((p) => p.id !== id);
    for (const a of d.accounts) if (a.activeProjectId === id) a.activeProjectId = '';
  }

  /** Stores a new state block. Returns false when it equals the current one. */
  function saveCheckpoint(d, id, slot, block, type) {
    const p = project(d, id);
    if (!p) return false;
    const normalized = core.normalize(block);
    if (normalized === core.normalize(p.state || '')) return false;
    const now = Date.now();
    const prog = core.progress(normalized);
    p.state = normalized;
    if (prog >= 0) p.progress = prog;
    p.stateTime = now;
    p.updated = now;
    if (slot > 0) p.currentSlot = slot;
    addEvent(p, { time: now, type: type || 'checkpoint', slot, accountName: core.accountName(d, slot),
      progress: prog >= 0 ? prog : p.progress, text: normalized });
    return true;
  }

  /** Hands a project to another slot; returns the source account's new pausedUntil (or 0). */
  function transfer(d, id, fromSlot, toSlot, pauseMs) {
    const p = project(d, id);
    if (!p) throw new Error('Proyecto no encontrado');
    const now = Date.now();
    addEvent(p, { time: now, type: 'transfer', slot: fromSlot, toSlot, accountName: core.accountName(d, fromSlot),
      toAccountName: core.accountName(d, toSlot), progress: p.progress });
    p.currentSlot = toSlot;
    p.pendingSlot = toSlot;
    p.updated = now;
    const to = account(d, toSlot);
    if (to) to.activeProjectId = p.id;
    const from = account(d, fromSlot);
    if (from && pauseMs > 0 && fromSlot !== toSlot) {
      from.pausedUntil = now + pauseMs;
      return from.pausedUntil;
    }
    return 0;
  }

  /** Marks the handoff for a slot as done (prompt inserted there). */
  function handoffDone(d, id, slot) {
    const p = project(d, id);
    if (!p) return;
    if (p.pendingSlot === slot) p.pendingSlot = 0;
    p.currentSlot = slot;
    const a = account(d, slot);
    if (a) a.activeProjectId = id;
  }

  /** Imports an exported project (JSON) or creates one from a pasted state block. Returns it. */
  function importText(d, text) {
    text = String(text || '').trim();
    const now = Date.now();
    if (text.startsWith('{')) {
      const p = normalizeProject(JSON.parse(text));
      if (!p.name) throw new Error('el JSON no parece un proyecto');
      if (project(d, p.id)) p.id = globalThis.crypto.randomUUID();
      if (!account(d, p.currentSlot)) p.currentSlot = 0;
      p.pendingSlot = 0;
      p.updated = now;
      d.projects.push(p);
      return p;
    }
    const r = core.find(text, false);
    if (!r.block) throw new Error('no encontré JSON ni un bloque <<<ESTADO');
    const name = (core.section(r.block, 'PROYECTO') || '').split('\n')[0] || 'Proyecto importado';
    const p = normalizeProject({ name, state: r.block, progress: Math.max(0, core.progress(r.block)),
      stateTime: now, created: now, updated: now });
    addEvent(p, { time: now, type: 'checkpoint', accountName: 'importación', progress: p.progress, text: r.block });
    d.projects.push(p);
    return p;
  }

  // Layout of the open accounts inside the window (tabs: {active, mode, recent}; recent = open slots, newest first).

  /** Slots on screen: none (dashboard), the active one, the two most recent side by side, or all. */
  function shownSlots(tabs) {
    if (!tabs.active) return [];
    if (tabs.mode === 'grid') return tabs.recent.slice().sort((a, b) => a - b);
    if (tabs.mode === 'split') return tabs.recent.slice(0, 2).sort((a, b) => a - b);
    return [tabs.active];
  }

  /** n cells filling `area` row by row; the last row stretches so no cell is left empty. */
  function gridCells(area, n) {
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const gap = n > 1 ? 2 : 0;
    const h = (area.height - gap * (rows - 1)) / rows;
    return Array.from({ length: n }, (_, i) => {
      const row = Math.floor(i / cols);
      const inRow = row === rows - 1 ? n - row * cols : cols;
      const w = (area.width - gap * (inRow - 1)) / inRow;
      const col = i - row * cols;
      return { x: Math.round(area.x + col * (w + gap)), y: Math.round(area.y + row * (h + gap)), width: Math.floor(w), height: Math.floor(h) };
    });
  }

  return {
    MAX_SLOTS, defaults, account, project, sortedAccounts, sortedProjects, freeSlot, upsertAccount,
    deleteAccount, createProject, updateProject, deleteProject, saveCheckpoint, transfer, handoffDone, importText,
    shownSlots, gridCells
  };
});
