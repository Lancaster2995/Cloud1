/* Toolbar on top of each account pane: project selector and handoff actions. */
(function () {
  'use strict';
  const { h, toast, modal, field, hooks } = window.UI;
  const C = window.RelevoCore;
  const api = (channel, ...args) => window.relevo.call(channel, ...args);
  const $ = (id) => document.getElementById(id);

  const params = new URLSearchParams(location.search);
  const slot = Number(params.get('slot')) || 0;
  /** "chrome": the account lives in the real browser; prompts and status go through the clipboard. */
  const chromeMode = params.get('mode') === 'chrome';
  if (chromeMode) document.body.classList.add('chrome');
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
    chrome: 'Copiado. Pega con Ctrl+V en el chat de esta cuenta en el navegador y envíalo.',
    'chrome-new': 'Abrí un chat nuevo en el navegador y copié el prompt: pega con Ctrl+V y envíalo.',
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
    else if (r.status === 'none-clipboard') noBlockInClipboard();
    else noBlockFound();
  }

  function noBlockInClipboard() {
    modal('Copia primero la respuesta de Claude', h('p',
      'En el navegador, cuando Claude responda al «Pedir estado», pulsa el botón Copiar del bloque de código (o selecciona el bloque <<<ESTADO … ESTADO>>> y pulsa Ctrl+C). Luego vuelve a pulsar «Guardar» aquí.'), [
      { label: 'Cerrar' },
      { label: 'Pegar a mano', onclick: () => { setTimeout(manualState, 50); } },
      { label: 'Pedir estado', kind: 'primary', onclick: () => { insert('checkpoint'); } }
    ]);
  }

  /** Google refuses sign-in inside embedded pages; explain the two ways that work. */
  function googleBlocked() {
    modal('Google no permite iniciar sesión aquí', h('div',
      h('p', 'Google bloquea el inicio de sesión dentro de apps porque no son un navegador completo, y Relevo no intenta saltarse esa protección. Tienes dos opciones:'),
      h('ol',
        h('li', h('strong', 'Entrar con tu correo'), ' (recomendado, todo queda dentro de Relevo): en la página de Claude escribe tu dirección de Gmail en el campo de correo y continúa; Claude te envía un código o enlace. Si es un enlace, cópialo y ábrelo con ⋯ → «Abrir un enlace aquí».'),
        h('li', h('strong', 'Abrir esta cuenta en Chrome'), ': se abre en tu Google Chrome (o Edge) con un perfil propio, fuera de Relevo. Ahí «Continuar con Google» funciona y esta pestaña queda con los botones para copiar los prompts y guardar el estado.'))), [
      { label: 'Abrir en Chrome', onclick: async () => { await api('account:use-chrome', slot); } },
      { label: 'Usar mi correo', kind: 'primary' }
    ]);
  }

  function noBlockFound() {
    modal('No encontré el bloque de estado', h('p',
      'Pulsa «Pedir estado», envía el mensaje y, cuando Claude responda con el bloque <<<ESTADO … ESTADO>>>, vuelve a pulsar «Guardar». También puedes pegarlo a mano.'), [
      { label: 'Cerrar' },
      { label: 'Pegar a mano', onclick: () => { setTimeout(manualState, 50); } },
      { label: 'Guardar la conversación', onclick: () => { run(saveConversation)(); } },
      { label: 'Pedir estado', kind: 'primary', onclick: () => { insert('checkpoint'); } }
    ]);
  }

  /** When Claude can no longer give the state (out of messages), the conversation itself is kept. */
  async function saveConversation() {
    const p = activeProject();
    const text = await api('bar:conversation');
    if (!text) return say('No pude leer la conversación de esta página.');
    const changed = await api('project:state', p.id, C.conversationBlock(p, text), 'conversation');
    say(changed ? 'Conversación guardada: viaja en el próximo traspaso.' : 'Esa conversación ya estaba guardada.');
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
    const conversation = await api('bar:conversation').catch(() => '');
    transferDialog(p.id, r.status === 'template' || r.template, conversation, r.status !== 'saved' && r.status !== 'same');
  }

  function transferDialog(id, unanswered, conversation, noBlock) {
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
    const withConversation = h('input', { type: 'checkbox', checked: !!noBlock });
    modal('Pasar proyecto a otra cuenta', h('div',
      h('p.muted', '«' + p.name + '» · ' + p.progress + '%' + (C.hasState(p) ? ' · estado guardado ' + C.ago(p.stateTime)
        : ' · aún no hay estado guardado: se enviará el prompt de inicio.')),
      unanswered ? h('p.warn', 'Ojo: Claude aún no respondió al último «Pedir estado»; se pasará el estado guardado anterior.') : null,
      field('PASAR A', target),
      field('PAUSAR «' + account().name + '» (límite alcanzado)', pause),
      conversation ? h('label.check', withConversation, noBlock
        ? 'Pasar la conversación de esta pestaña (Claude no dejó un bloque de estado)'
        : 'Pasar la conversación de esta pestaña en lugar del último estado') : null,
      h('label.check', side, 'Ver las dos cuentas lado a lado')), [
      { label: 'Cancelar' },
      { label: 'Pasar', kind: 'primary', onclick: async () => {
        if (conversation && withConversation.checked) await api('project:state', id, C.conversationBlock(p, conversation), 'conversation');
        await api('project:transfer', id, slot, Number(target.value), Number(pause.value), side.checked);
      } }
    ]);
  }

  function chooseProject(then) {
    let dlg = null;
    const list = h('div.list',
      projects().map((p) => h('button.btn', {
        onclick: async () => { dlg.close(); await api('account:open-project', slot, p.id); setTimeout(then, 60); }
      }, p.name + ' · ' + p.progress + '%')),
      h('button.btn', { onclick: () => { dlg.close(); setTimeout(() => newProject(then), 50); } }, '+ Nuevo proyecto…'));
    dlg = modal('¿En qué proyecto trabaja esta cuenta?', list, [{ label: 'Cancelar' }]);
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
    modal('Abrir enlace en esta pestaña', h('div',
      h('p.muted', 'Útil para el enlace de inicio de sesión que llega por correo: cópialo y pégalo aquí para que la sesión se abra en esta cuenta, dentro de Relevo, y no en tu navegador.'),
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
    dlg = modal('Ver al lado', h('div.list', others.map((a) => h('button.btn', {
      onclick: () => { dlg.close(); api('account:open', a.slot, 'side'); }
    }, h('span.dot', { style: { background: a.color } }), C.accountLabel(a, now)))), [{ label: 'Cancelar' }]);
  }

  function logout() {
    if (chromeMode) {
      modal('Borrar el perfil del navegador', h('p', 'Se borrará el perfil del navegador de «' + account().name + '» (cookies, historial y sesión de Claude) en este equipo. Cierra antes sus ventanas del navegador.'), [
        { label: 'Cancelar' },
        { label: 'Borrar perfil', kind: 'primary', onclick: async () => { await api('account:logout', slot); say('Perfil borrado'); } }
      ]);
      return;
    }
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
  $('more').addEventListener('click', () => api('bar:menu'));

  const COMMANDS = { 'open-beside': openBeside, pause: pauseDialog, 'manual-state': manualState, 'open-link': openLink, logout,
    'google-blocked': googleBlocked };
  window.relevo.on('command', (c) => COMMANDS[c] && run(COMMANDS[c])());
  window.relevo.on('data', (d) => { data = d; render(); });
  window.relevo.on('nav', (n) => { $('back').disabled = !n.canGoBack; $('forward').disabled = !n.canGoForward; });
  window.relevo.on('loading', (on) => { $('loading').hidden = !on; });
  $('openBrowser').addEventListener('click', run(() => api('bar:nav', 'open-browser')));
  $('hintBrowser').addEventListener('click', run(() => api('bar:nav', 'open-browser')));
  $('hintInside').addEventListener('click', run(async () => {
    await api('account:save', { slot, browser: 'integrated' });
    await api('account:open', slot, 'normal');
  }));
  if (chromeMode) {
    for (const b of document.querySelectorAll('[data-act]')) {
      const tips = {
        handoff: 'Abre un chat nuevo en el navegador y copia el prompt para pegarlo',
        checkpoint: 'Copia el mensaje que pide a Claude el bloque de estado',
        save: 'Guarda el bloque de estado que copiaste de la respuesta de Claude',
        transfer: 'Pasa el proyecto a otra cuenta'
      };
      b.title = tips[b.dataset.act] || b.title;
    }
  }
  $('back').disabled = true;
  $('forward').disabled = true;
  api('data').then((d) => { data = d; render(); });
})();
