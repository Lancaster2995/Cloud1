/* Tab strip at the top of the Relevo window: the dashboard, one tab per account and the layout. */
(function () {
  'use strict';
  const { h, toast } = window.UI;
  const C = window.RelevoCore;
  const api = (channel, ...args) => window.relevo.call(channel, ...args).catch((e) => toast(e.message || String(e), 6000));
  const list = document.getElementById('tabs');

  let data = { accounts: [] };
  let tabs = { active: 0, mode: 'single', open: [], shown: [] };

  function tab(slot, icon, label, opts) {
    const el = h('div.tab', {
      role: 'tab', tabIndex: 0, title: opts.title || label, ariaSelected: String(tabs.active === slot),
      onclick: () => api('tab:show', slot),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); api('tab:show', slot); } },
      onauxclick: (e) => { if (e.button === 1 && opts.open) api('tab:close', slot); }
    }, icon, h('span.name', label), opts.badge ? h('span.badge', opts.badge) : null,
    slot && opts.open ? h('button.x', {
      type: 'button', title: 'Cerrar pestaña', ariaLabel: 'Cerrar ' + label,
      onclick: (e) => { e.stopPropagation(); api('tab:close', slot); }
    }, '×') : null);
    el.classList.toggle('on', tabs.active === slot);
    el.classList.toggle('open', !!opts.open);
    // Accounts on screen are underlined with their color (two or more at once).
    if (opts.color && tabs.shown.includes(slot)) el.style.boxShadow = 'inset 0 -2px 0 ' + opts.color;
    return el;
  }

  function render() {
    const now = Date.now();
    const accounts = data.accounts.slice().sort((a, b) => a.slot - b.slot);
    const panel = tab(0, h('img', { src: 'icon.png', alt: '', width: 18, height: 18 }), 'Panel', { title: 'Proyectos, cuentas y guía (Ctrl+Shift+H)' });
    panel.classList.add('panel');
    list.replaceChildren(panel, h('span.sep'),
      ...accounts.map((a) => {
        const open = tabs.open.includes(a.slot);
        const paused = C.isPaused(a, now);
        const dot = h('span.dot', { style: open ? { background: a.color } : { boxShadow: 'inset 0 0 0 2px ' + a.color } });
        return tab(a.slot, dot, a.name, {
          open, color: a.color, badge: paused ? 'pausa' : '',
          title: a.name + (paused ? ' · en pausa hasta las ' + C.clock(a.pausedUntil) : '') + (open ? '' : ' · clic para abrir')
        });
      }),
      h('button.add', { type: 'button', title: 'Agregar cuenta', ariaLabel: 'Agregar cuenta', onclick: () => api('tab:add') }, '+'));
    for (const b of document.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === tabs.mode));
    const active = list.querySelector('.tab.on');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  for (const b of document.querySelectorAll('[data-mode]')) {
    b.addEventListener('click', () => {
      if (b.dataset.mode !== 'single' && tabs.open.length < 2) toast('Abre al menos dos cuentas para verlas a la vez', 4000);
      api('tab:mode', b.dataset.mode);
    });
  }
  window.relevo.on('data', (d) => { data = d; render(); });
  window.relevo.on('tabs', (t) => { tabs = t; render(); });
  Promise.all([api('data'), api('tabs')]).then(([d, t]) => { data = d || data; tabs = t || tabs; render(); });
})();
