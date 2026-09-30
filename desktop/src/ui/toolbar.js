/* Toolbar on top of each account window: project selector and handoff actions. */
(function () {
  'use strict';
  const { h, toast, modal, field, hooks } = window.UI;
  const C = window.RelevoCore;
  const api = (channel, ...args) => window.relevo.call(channel, ...args);
  const $ = (id) => document.getElementById(id);

  const slot = Number(new URLSearchParams(location.search).get('slot')) || 0;
  const PAUSES = [
    ['No pausar', 0], ['1 hora', 3600e3], ['2 horas', 7200e3], ['3 horas', 10800e3],
    ['5 horas', 18000e3], ['8 horas', 28800e3], ['24 horas', 86400e3]
  ];
  let data = { accounts: [], projects: [], autoInsert: true };
  let overlayOpen = false;

  // Dialogs need the whole window: the toolbar view grows over the page while one is open.
  hooks.onOpen = () => { overlayOpen = true; api('bar:overlay', true); };
  hooks.onClose = () => { overlayOpen = false; api('bar:overlay', false); };

  const statusEl = $('status');
  let statusTimer = null;
  function say(msg, ms) {
    if (overlayOpen) return toast(msg, ms);
    statusEl.textContent = msg;
    statusEl.title = msg;
    statusEl.hidden = false;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { statusEl.hidden = true; }, ms || 7000);
  }

  const account = () => data.accounts.find((a) => a.slot === slot) || { slot, name: 'Cuenta ' + slot, color: '#D97757' };
  const project = (id) => data.projects.find((p) => p.id === id) || null;
  const activeProject = () => project(account().activeProjectId);
  const projects = () => data.projects.slice().sort((a, b) => b.updated - a.updated);

  // ------------------------------------------------------------------ render

  const select = $('project');
  function render() {
    const a = account();
    $('account').textContent = a.name;
    $('account').title = a.note || a.name;
    $('dot').style.background = a.color;
    $('strip').style.background = a.color;
    document.title = 'Relevo · ' + a.name;

    if (document.activeElement !== select) {
      select.replaceChildren(
        h('option', { value: '' }, 'Sin proyecto'),
        ...projects().map((p) => h('option', { value: p.id }, p.name + ' · ' + p.progress + '%')),
        h('option', { value: '+' }, '+ Nuevo proyecto…'));
      select.value = activeProject() ? a.activeProjectId : '';
    }

    const pending = data.projects.find((p) => p.pendingSlot === slot);
    $('banner').hidden = !pending;
    if (pending) {
      $('bannerText').textContent = (C.hasState(pending)
        ? 'Traspaso pendiente: «' + pending.name + '» (' + pending.progress + '%).'
        : 'Proyecto nuevo asignado a esta cuenta: «' + pending.name + '».')
        + ' Pulsa «Insertar prompt» para continuarlo aquí.';
      $('banner').dataset.id = pending.id;
    }
  }

  new ResizeObserver(() => {
    if (!overlayOpen) api('bar:height', $('bar').offsetHeight);
  }).observe($('bar'));

  // ------------------------------------------------------------------ actions

  const DELIVERED = {
    ok: 'Listo en el cuadro de mensaje: revísalo y envíalo.',
    copied: 'Copiado al portapapeles: pega con Ctrl+V en el cuadro de mensaje.',
    noel: 'Copiado. Abre un chat y pega con Ctrl+V.',
    fail: 'Copiado. Haz clic en el cuadro de mensaje y pega con Ctrl+V.'
  };

  async function insert(kind, projectId) {
    const pid = projectId || account().activeProjectId;
    if (!project(pid)) {
      chooseProject(() => insert(kind));
      return;
    }
    let r = await api('bar:insert', kind, pid, 'auto');
    if (r.status === 'ask') {
      const where = await new Promise((resolve) => {
        modal('Hay una conversación abierta', h('p', 'El traspaso funciona mejor en un chat nuevo. ¿Dónde lo inserto?'), [
          { label: 'Cancelar', onclick: () => resolve(null) },
          { label: 'Aquí', onclick: () => resolve('here') },
          { label: 'Chat nuevo', kind: 'primary', onclick: () => resolve('new') }
        ]);
      });
      if (!where) return;
      say('Insertando…');
      r = await api('bar:insert', kind, pid, where);
    }
    if (r.status === 'no-project') chooseProject(() => insert(kind));
    else say(DELIVERED[r.status] || DELIVERED.fail);
  }

  async function saveState() {
    if (!activeProject()) {
      chooseProject(saveState);
      return;
    }
    const r = await api('bar:save-state');
    if (r.status === 'saved') say('Estado guardado desde ' + r.source + (r.progress >= 0 ? ' · ' + r.progress + '%' : ''));
    else if (r.status === 'same') say('Ese estado ya estaba guardado.');
    else if (r.status === 'template') say('Claude aún no ha respondido con el estado. Espera a que termine y vuelve a pulsar Guardar.', 9000);
    else if (r.status === 'no-project') chooseProject(saveState);
    else noBlockFound();
  }

  function noBlockFound() {
    modal('No encontré el bloque de estado', h('p',
      'Pulsa «Pedir estado», envía el mensaje y, cuando Claude responda con el bloque <<<ESTADO … ESTADO>>>, vuelve a pulsar «Guardar». También puedes pegarlo a mano.'), [
      { label: 'Cerrar' },
      { label: 'Pegar a mano', onclick: () => { setTimeout(manualState, 50); } },
      { label: 'Pedir estado', kind: 'primary', onclick: () => { insert('checkpoint'); } }
    ]);
  }

  async function startTransfer() {
    const p = activeProject();
    if (!p) {
      chooseProject(startTransfer);
      return;
    }
    // Keep the newest state shown in this conversation before handing over.
    const r = await api('bar:save-state', true).catch(() => ({}));
    if (r.status === 'saved') say('Estado de la conversación guardado' + (r.progress >= 0 ? ' · ' + r.progress + '%' : ''));
    transferDialog(p.id, r.status === 'template' || r.template);
  }

  function transferDialog(id, unanswered) {
    const p = project(id);
    const now = Date.now();
    const targets = data.accounts.filter((a) => a.slot !== slot).sort((a, b) => a.slot - b.slot);
    if (!targets.length) {
      say('Agrega otra cuenta en el panel principal para poder pasar el proyecto.', 9000);
      return;
    }
    const target = h('select', targets.map((a) => h('option', { value: a.slot }, C.accountLabel(a, now))));
    const free = targets.find((a) => !C.isPaused(a, now));
    if (free) target.value = String(free.slot);
    const pause = h('select', PAUSES.map(([label, ms]) => h('option', { value: ms }, label)));
    const side = h('input', { type: 'checkbox' });
    modal('Pasar proyecto a otra cuenta', h('div',
      h('p.muted', '«' + p.name + '» · ' + p.progress + '%' + (C.hasState(p) ? ' · estado guardado ' + C.ago(p.stateTime)
        : ' · aún no hay estado guardado: se enviará el prompt de inicio.')),
      unanswered ? h('p.warn', 'Ojo: Claude aún no respondió al último «Pedir estado»; se pasará el estado guardado anterior.') : null,
      field('PASAR A', target),
      field('PAUSAR «' + account().name + '» (límite alcanzado)', pause),
      h('label.check', side, 'Abrir al lado (mitad de la pantalla cada una)')), [
      { label: 'Cancelar' },
      { label: 'Pasar', kind: 'primary', onclick: () => api('project:transfer', id, slot, Number(target.value), Number(pause.value), side.checked) }
    ]);
  }

  function chooseProject(then) {
    let dlg = null;
    const list = h('div.list',
      projects().map((p) => h('button.btn', {
        onclick: async () => { dlg.close(); await api('account:open-project', slot, p.id); setTimeout(then, 60); }
      }, p.name + ' · ' + p.progress + '%')),
      h('button.btn', { onclick: () => { dlg.close(); setTimeout(() => newProject(then), 50); } }, '+ Nuevo proyecto…'));
    dlg = modal('¿En qué proyecto trabaja esta ventana?', list, [{ label: 'Cancelar' }]);
  }

  function newProject(then) {
    const name = h('input', { type: 'text', placeholder: 'p. ej. App de inventario' });
    const goal = h('textarea', { rows: 3, placeholder: 'Qué debe quedar terminado' });
    const repo = h('input', { type: 'url', placeholder: 'https://github.com/usuario/repo (opcional)' });
    const branch = h('input', { type: 'text', placeholder: 'main (opcional)' });
    modal('Nuevo proyecto', h('div', field('NOMBRE DEL PROYECTO', name), field('OBJETIVO', goal), field('REPOSITORIO', repo), field('RAMA', branch)), [
      { label: 'Cancelar', onclick: () => render() },
      { label: 'Crear', kind: 'primary', onclick: async () => {
        if (!name.value.trim()) { name.focus(); toast('Escribe un nombre'); return false; }
        await api('project:create', { name: name.value, goal: goal.value, repo: repo.value, branch: branch.value }, slot);
        if (then) setTimeout(then, 80);
      } }
    ]);
  }

  async function manualState() {
    const p = activeProject();
    if (!p) {
      chooseProject(manualState);
      return;
    }
    const input = h('textarea.mono', { rows: 14, value: p.state, placeholder: '<<<ESTADO …' });
    modal('Estado de «' + p.name + '»', input, [
      { label: 'Pegar', onclick: async () => { input.value = await api('paste'); return false; } },
      { label: 'Cancelar' },
      { label: 'Guardar', kind: 'primary', onclick: async () => {
        const changed = await api('project:state', p.id, input.value, 'edit');
        say(changed ? 'Estado guardado' : 'Sin cambios');
      } }
    ]);
  }

  function pauseDialog() {
    const a = account();
    let dlg = null;
    const time = h('input', { type: 'time' });
    const pauseUntil = async (until) => {
      dlg.close();
      await api('account:pause', slot, until);
      say(until ? 'En pausa hasta las ' + C.clock(until) + '. Te avisaré.' : 'Cuenta disponible');
    };
    dlg = modal('¿Hasta cuándo pausar «' + a.name + '»?', h('div',
      h('div.list', PAUSES.slice(1).map(([label, ms]) => h('button.btn', { onclick: () => pauseUntil(Date.now() + ms) }, label))),
      h('span.label', 'O HASTA UNA HORA EXACTA'),
      h('div.row', time, h('button.btn', { onclick: () => {
        if (!time.value) return;
        const [hh, mm] = time.value.split(':').map(Number);
        const at = new Date();
        at.setHours(hh, mm, 0, 0);
        if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
        pauseUntil(at.getTime());
      } }, 'Pausar'))),
    C.isPaused(a) ? [{ label: 'Quitar la pausa', onclick: () => pauseUntil(0) }, { label: 'Cancelar' }] : [{ label: 'Cancelar' }]);
  }

  async function openLink() {
    const clip = ((await api('paste')) || '').trim();
    const url = h('input', { type: 'url', value: /^https?:\/\//i.test(clip) ? clip : '', placeholder: 'https://claude.ai/…' });
    modal('Abrir enlace en esta ventana', h('div',
      h('p.muted', 'Útil para el enlace de inicio de sesión que llega por correo: cópialo y pégalo aquí para que la sesión se abra en esta cuenta y no en tu navegador.'),
      url), [
      { label: 'Cancelar' },
      { label: 'Abrir', kind: 'primary', onclick: () => url.value.trim() && api('bar:nav', 'load', url.value.trim()) }
    ]);
  }

  function openBeside() {
    const now = Date.now();
    const others = data.accounts.filter((a) => a.slot !== slot).sort((a, b) => a.slot - b.slot);
    if (!others.length) {
      say('Agrega otra cuenta en el panel principal.');
      return;
    }
    let dlg = null;
    dlg = modal('Abrir al lado', h('div.list', others.map((a) => h('button.btn', {
      onclick: () => { dlg.close(); api('account:open', a.slot, 'side'); }
    }, h('span.dot', { style: { background: a.color } }), C.accountLabel(a, now)))), [{ label: 'Cancelar' }]);
  }

  function logout() {
    modal('Cerrar sesión', h('p', 'Se borrarán las cookies y datos de «' + account().name + '» en este equipo. Tendrás que volver a iniciar sesión.'), [
      { label: 'Cancelar' },
      { label: 'Cerrar sesión', kind: 'primary', onclick: async () => { await api('account:logout', slot); say('Sesión cerrada'); } }
    ]);
  }

  // ------------------------------------------------------------------ wiring

  const run = (fn) => async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      say(e.message || String(e), 9000);
    }
  };

  for (const b of document.querySelectorAll('[data-act]')) {
    const act = b.dataset.act;
    b.addEventListener('click', run(async () => {
      if (act === 'handoff') await insert('handoff');
      else if (act === 'checkpoint') await insert('checkpoint');
      else if (act === 'save') await saveState();
      else if (act === 'transfer') await startTransfer();
    }));
  }
  select.addEventListener('change', run(async () => {
    const v = select.value;
    if (v === '+') {
      newProject(null);
      return;
    }
    await api('account:open-project', slot, v);
    select.blur();
  }));
  $('insertPending').addEventListener('click', run(() => insert('handoff', $('banner').dataset.id)));
  $('dismiss').addEventListener('click', run(() => api('bar:dismiss-pending', $('banner').dataset.id)));
  $('back').addEventListener('click', () => api('bar:nav', 'back'));
  $('forward').addEventListener('click', () => api('bar:nav', 'forward'));
  $('reload').addEventListener('click', () => api('bar:nav', 'reload'));
  $('home').addEventListener('click', () => api('dashboard'));
  $('more').addEventListener('click', () => api('bar:menu'));

  const COMMANDS = { 'open-beside': openBeside, pause: pauseDialog, 'manual-state': manualState, 'open-link': openLink, logout };
  window.relevo.on('command', (c) => COMMANDS[c] && run(COMMANDS[c])());
  window.relevo.on('data', (d) => { data = d; render(); });
  window.relevo.on('nav', (n) => { $('back').disabled = !n.canGoBack; $('forward').disabled = !n.canGoForward; });
  window.relevo.on('loading', (on) => { $('loading').hidden = !on; });
  $('back').disabled = true;
  $('forward').disabled = true;
  api('data').then((d) => { data = d; render(); });
})();
