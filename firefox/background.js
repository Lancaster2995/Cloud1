/* Relevo for Firefox, background: toolbar button and "account available again" notices. */
'use strict';
const C = self.RelevoCore;

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

browser.storage.onChanged.addListener((changes) => { if (changes.relevo) schedulePauses(); });
schedulePauses();
