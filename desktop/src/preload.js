'use strict';
/* Narrow bridge between Relevo's own pages (tab strip, dashboard, toolbar) and the main process. */
const { contextBridge, ipcRenderer } = require('electron');

const CALLS = new Set([
  'data', 'info', 'copy', 'paste', 'external', 'set', 'dashboard', 'tile', 'browser:info', 'browser:choose',
  'account:use-chrome', 'tabs', 'tab:show', 'tab:close', 'tab:mode', 'tab:add',
  'account:save', 'account:delete', 'account:logout', 'account:open', 'account:open-all', 'account:pause',
  'account:open-project',
  'project:create', 'project:update', 'project:delete', 'project:state', 'project:restore', 'project:continue',
  'project:transfer', 'project:import', 'project:export', 'project:import-file',
  'bar:height', 'bar:overlay', 'bar:nav', 'bar:insert', 'bar:save-state', 'bar:dismiss-pending', 'bar:menu', 'bar:conversation'
]);
const EVENTS = new Set(['data', 'nav', 'loading', 'command', 'tabs']);

contextBridge.exposeInMainWorld('relevo', {
  call: async (channel, ...args) => {
    if (!CALLS.has(channel)) throw new Error('canal no permitido: ' + channel);
    const r = await ipcRenderer.invoke(channel, ...args);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  },
  on: (channel, cb) => {
    if (EVENTS.has(channel)) ipcRenderer.on(channel, (e, payload) => cb(payload));
  }
});
