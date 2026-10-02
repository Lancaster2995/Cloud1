/* Relevo for Firefox, background: toolbar button, automatic status saving and "available again" notices. */
'use strict';
const C = self.RelevoCore;
const M = self.RelevoModel;
const J = self.RelevoInject;

browser.browserAction.onClicked.addListener(() => browser.sidebarAction.toggle());

/** One alarm per paused account, at the moment its pause ends. */
async function schedulePauses() {
  const { relevo } = await browser.storage.local.get('relevo');
  await browser.alarms.clearAll();
  const now = Date.now();
  for (const a of (relevo && relevo.accounts) || []) {
    if (a.pausedUntil > now) browser.alarms.create('pause-' + a.slot, { when: a.pausedUntil + 1000 });
  }
}

browser.alarms.onAlarm.addListener(async (alarm) => {
  const { relevo } = await browser.storage.local.get('relevo');
  const a = ((relevo && relevo.accounts) || []).find((x) => 'pause-' + x.slot === alarm.name);
  if (!a || C.isPaused(a, Date.now() + 60000)) return;
  browser.notifications.create(alarm.name, {
    type: 'basic', iconUrl: 'shared/icon.png',
    title: '«' + a.name + '» vuelve a estar disponible', message: 'Ábrela desde el panel de Relevo.'
  });
});

/**
 * Projects with the automatic state ask Claude to end every answer with the status block; this
 * keeps the newest one from the account that holds each project (its most recently used Claude
 * tab), so running out of messages loses nothing. Only blocks that name the project.
 * ponytail: same read-modify-write without a lock as the sidebar.
 */
let autoSaving = false;
async function autoSave() {
  if (autoSaving) return;
  autoSaving = true;
  try {
    const d = M.defaults((await browser.storage.local.get('relevo')).relevo);
    let changed = false;
    for (const a of d.accounts) {
      const p = M.project(d, a.activeProjectId);
      if (!a.cookieStoreId || !p || !p.autoState || p.currentSlot !== a.slot || p.pendingSlot) continue;
      const tabs = await browser.tabs.query({ cookieStoreId: a.cookieStoreId, url: 'https://claude.ai/*' });
      const tab = tabs.filter((t) => !t.discarded).sort((x, y) => y.lastAccessed - x.lastAccessed)[0];
      if (!tab) continue;
      const [text] = await browser.tabs.executeScript(tab.id, { code: J.PAGE_TEXT }).catch(() => ['']);
      const { block } = C.find(String(text || ''), true);
      if (block && C.isAbout(block, p) && M.saveCheckpoint(d, p.id, a.slot, block, 'auto')) changed = true;
    }
    if (changed) await browser.storage.local.set({ relevo: d });
  } finally {
    autoSaving = false;
  }
}

browser.storage.onChanged.addListener((changes) => { if (changes.relevo) schedulePauses(); });
schedulePauses();
setInterval(autoSave, 20000);
