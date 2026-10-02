/* Relevo dashboard: projects, accounts and guide. */
(function () {
  'use strict';
  const { h, toast, modal, field, autoStateBox } = window.UI;
  const C = window.RelevoCore;
  const api = (channel, ...args) => window.relevo.call(channel, ...args);

  const PAUSES = [
    ['No pausar', 0], ['1 hora', 3600e3], ['2 horas', 7200e3], ['3 horas', 10800e3],
    ['5 horas', 18000e3], ['8 horas', 28800e3], ['24 horas', 86400e3]
  ];

  let data = { accounts: [], projects: [], autoInsert: true };
  const view = { tab: 'projects', projectId: null, signature: '' };
  const content = document.getElementById('content');
  const tickers = [];

  const account = (slot) => data.accounts.find((a) => a.slot === slot) || null;
  const project = (id) => data.projects.find((p) => p.id === id) || null;
  const accounts = () => data.accounts.slice().sort((a, b) => a.slot - b.slot);
  const projects = () => data.projects.slice().sort((a, b) => b.updated - a.updated);
  const colorOf = (a) => (a && a.color) || '#888';

  // ------------------------------------------------------------------ rendering

  function signature(p) {
    return p ? [p.updated, p.stateTime, p.history.length, p.currentSlot, p.pendingSlot, p.progress, data.accounts.length].join('|') : 'none';
  }

  function render(force) {
    if (view.projectId) {
      const sig = signature(project(view.projectId));
      if (!force && sig === view.signature && content.querySelector('.detail')) return;
      view.signature = sig;
    }
    tickers.length = 0;
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', !view.projectId && t.dataset.tab === view.tab);
    const scroll = window.scrollY;
    content.replaceChildren();
    if (view.projectId) renderDetail();
    else if (view.tab === 'accounts') renderAccounts();
    else if (view.tab === 'guide') renderGuide();
    else renderProjects();
    if (!force) window.scrollTo(0, scroll);
  }

  function progressBar(v) {
    return h('div.progress', h('i', { style: { width: Math.max(0, Math.min(100, v)) + '%' } }));
  }

  // ------------------------------------------------------------------ projects

  function renderProjects() {
    content.appendChild(h('div.toolbar',
      h('button.btn.primary', { onclick: () => newProjectDialog(0) }, '+ Nuevo proyecto'),
      h('button.btn', { onclick: importDialog }, 'Importar'),
      h('button.btn', { onclick: async () => { const n = await api('project:import-file'); if (n) toast('Proyecto «' + n + '» importado'); } }, 'Importar archivo…')));

    if (!data.accounts.length) {
      content.appendChild(h('div.card.empty', { style: { marginBottom: '14px' } },
        h('h3', 'Empieza agregando tus cuentas'),
        h('p.muted', 'Cada cuenta se abre en su propia pestaña de Relevo con la sesión aislada (como perfiles separados de Chrome). Agrega al menos dos para poder pasar un proyecto de una a otra.'),
        h('div.buttons', h('button.btn', { onclick: () => { view.tab = 'accounts'; render(true); } }, 'Ir a Cuentas'))));
    }
    const list = projects();
    if (!list.length) {
      content.appendChild(h('div.card.empty',
        h('h3', 'Sin proyectos todavía'),
        h('p.muted', 'Crea un proyecto con su objetivo. Relevo genera el prompt de inicio, guarda los estados (checkpoints) que te da Claude y los traspasa a la siguiente cuenta con todo el contexto.')));
      return;
    }
    const grid = h('div.grid');
    for (const p of list) grid.appendChild(projectCard(p));
    content.appendChild(grid);
  }

  function projectCard(p) {
    const acc = account(p.currentSlot);
    const summary = C.summary(p) || p.goal;
    const next = C.nextStep(p);
    return h('div.card.pcard',
      h('div.title', h('h3', { title: p.name }, p.name), h('span.pct', p.progress + '%')),
      progressBar(p.progress),
      h('div.row.muted', acc ? h('span.dot', { style: { background: colorOf(acc) } }) : null,
        (acc ? acc.name : 'Sin cuenta asignada') + ' · actualizado ' + C.ago(p.updated)),
      p.pendingSlot ? h('div.pending', '⏳ Traspaso pendiente → ' + C.accountName(data, p.pendingSlot)) : null,
      summary ? h('p.summary', summary) : null,
      next ? h('div.next.muted', 'Siguiente: ' + next) : null,
      h('div.buttons',
        h('button.btn.primary', { onclick: () => continueProject(p.id).catch((e) => toast(e.message, 6000)) }, 'Continuar'),
        h('button.btn', { onclick: () => transferDialog(p.id, p.currentSlot) }, 'Pasar a…'),
        h('button.btn', { onclick: () => openDetail(p.id) }, 'Detalles')));
  }

  function openDetail(id) {
    view.projectId = id;
    view.signature = '';
    render(true);
    window.scrollTo(0, 0);
  }

  async function continueProject(id) {
    const p = project(id);
    if (!p) return;
    if (!p.currentSlot || !account(p.currentSlot)) {
      chooseAccount('¿En qué cuenta continuar «' + p.name + '»?', (slot) => api('project:continue', id, slot));
      return;
    }
    await api('project:continue', id, 0);
  }

  function chooseAccount(title, cb) {
    const list = accounts();
    if (!list.length) {
      toast('Primero agrega una cuenta en la pestaña Cuentas');
      return;
    }
    const now = Date.now();
    let dlg = null;
    const body = h('div.list', list.map((a) => h('button.btn', {
      onclick: async () => { dlg.close(); await cb(a.slot); }
    }, h('span.dot', { style: { background: colorOf(a) } }), C.accountLabel(a, now))));
    dlg = modal(title, body, [{ label: 'Cancelar' }]);
  }

  function transferDialog(id, fromSlot) {
    const p = project(id);
    if (!p) return;
    const now = Date.now();
    const targets = accounts().filter((a) => a.slot !== fromSlot);
    if (!targets.length) {
      toast('Agrega otra cuenta para poder pasar el proyecto');
      return;
    }
    const target = h('select', targets.map((a) => h('option', { value: a.slot }, C.accountLabel(a, now))));
    const firstFree = targets.find((a) => !C.isPaused(a, now));
    if (firstFree) target.value = String(firstFree.slot);
    const from = account(fromSlot);
    const pause = from ? h('select', PAUSES.map(([label, ms]) => h('option', { value: ms }, label))) : null;
    const side = h('input', { type: 'checkbox' });
    const body = h('div',
      h('p.muted', '«' + p.name + '» · ' + p.progress + '%' + (C.hasState(p) ? ' · estado guardado ' + C.ago(p.stateTime)
        : ' · aún no hay estado guardado: se enviará el prompt de inicio.')),
      field('PASAR A', target),
      pause ? field('PAUSAR «' + from.name + '» (límite alcanzado)', pause) : null,
      h('label.check', side, 'Ver las dos cuentas lado a lado'));
    modal('Pasar proyecto a otra cuenta', body, [
      { label: 'Cancelar' },
      { label: 'Pasar', kind: 'primary', onclick: () => api('project:transfer', id, fromSlot, Number(target.value), pause ? Number(pause.value) : 0, side.checked) }
    ]);
  }

  function newProjectDialog(slot) {
    const name = h('input', { type: 'text', placeholder: 'p. ej. App de inventario' });
    const goal = h('textarea', { placeholder: 'Qué debe quedar terminado', rows: 3 });
    const repo = h('input', { type: 'url', placeholder: 'https://github.com/usuario/repo (opcional)' });
    const branch = h('input', { type: 'text', placeholder: 'main (opcional)' });
    const auto = autoStateBox(true);
    modal('Nuevo proyecto', h('div', field('NOMBRE DEL PROYECTO', name), field('OBJETIVO', goal), field('REPOSITORIO', repo), field('RAMA', branch), auto.label), [
      { label: 'Cancelar' },
      { label: 'Crear', kind: 'primary', onclick: async () => {
        if (!name.value.trim()) { name.focus(); toast('Escribe un nombre'); return false; }
        const id = await api('project:create', { name: name.value, goal: goal.value, repo: repo.value, branch: branch.value, autoState: auto.input.checked }, slot);
        toast('Proyecto creado');
        return id;
      } }
    ]);
  }

  function importDialog() {
    const input = h('textarea.mono', { rows: 10, placeholder: '{ … }  o  <<<ESTADO …' });
    api('paste').then((t) => { if (t && (t.trim().startsWith('{') || t.includes(C.START))) input.value = t; });
    modal('Importar proyecto', h('div',
      h('p.muted', 'Pega el JSON exportado desde Relevo (en cualquier dispositivo) o un bloque de estado <<<ESTADO … ESTADO>>> para crear un proyecto con él.'),
      input), [
      { label: 'Cancelar' },
      { label: 'Importar', kind: 'primary', onclick: async () => { const n = await api('project:import', input.value); toast('Proyecto «' + n + '» importado'); } }
    ]);
  }

  // ------------------------------------------------------------------ project detail

  function renderDetail() {
    const p = project(view.projectId);
    if (!p) {
      view.projectId = null;
      render(true);
      return;
    }
    content.appendChild(h('div.detail-head',
      h('button.btn.icon', { onclick: () => { view.projectId = null; render(true); }, title: 'Volver' }, '←'),
      h('h2', p.name), h('span.pct', { style: { color: 'var(--accent)', fontWeight: 700, fontSize: '18px' } }, p.progress + '%')));

    const left = h('div');
    const right = h('div');
    content.appendChild(h('div.detail', left, right));

    left.appendChild(h('div.card',
      progressBar(p.progress),
      h('div.muted', 'Cuenta actual: ' + C.accountName(data, p.currentSlot) +
        (C.hasState(p) ? ' · estado del ' + C.stamp(p.stateTime) : ' · sin estado guardado')),
      p.pendingSlot ? h('div.pending', '⏳ Traspaso pendiente → ' + C.accountName(data, p.pendingSlot)) : null,
      h('div.buttons',
        h('button.btn.primary', { onclick: () => continueProject(p.id).catch((e) => toast(e.message, 6000)) }, 'Continuar'),
        h('button.btn', { onclick: () => transferDialog(p.id, p.currentSlot) }, 'Pasar a…'))));

    const copy = async (label, text) => { await api('copy', text); toast(label + ' copiado'); };
    left.appendChild(h('div.card',
      h('h3', 'Prompts'),
      h('p.muted', 'Cópialos para usarlos en cualquier sesión (también en Chrome, otro equipo o el teléfono).'),
      h('div.buttons',
        h('button.btn', { onclick: () => copy(C.hasState(p) ? 'Prompt de traspaso' : 'Prompt de inicio', C.next(p)) }, C.hasState(p) ? 'Copiar traspaso' : 'Copiar inicio'),
        h('button.btn', { onclick: () => copy('Prompt de checkpoint', C.checkpoint(p)) }, 'Copiar «Pedir estado»'),
        h('button.btn.quiet', { onclick: () => showText('Prompt', C.next(p)) }, 'Ver prompt'))));

    const state = h('textarea.mono.state', { placeholder: 'Aún no hay estado. Pulsa «Pedir estado» en la pestaña de la cuenta, o pega aquí el bloque.', value: p.state });
    left.appendChild(h('div.card',
      h('h3', 'Estado actual'),
      h('p.muted', 'Bloque <<<ESTADO … ESTADO>>> que se envía en el traspaso. Puedes editarlo o pegar uno nuevo.'),
      state,
      h('div.buttons',
        h('button.btn', { onclick: async () => {
          const r = C.find(await api('paste'), false);
          if (!r.block) toast('El portapapeles no tiene un bloque <<<ESTADO');
          else state.value = r.block;
        } }, 'Pegar'),
        h('button.btn.primary', { onclick: async () => {
          const changed = await api('project:state', p.id, state.value, 'edit');
          toast(changed ? 'Estado guardado' : 'Sin cambios');
        } }, 'Guardar estado'))));

    const name = h('input', { type: 'text', value: p.name });
    const goal = h('textarea', { rows: 3, value: p.goal });
    const repo = h('input', { type: 'url', value: p.repo, placeholder: 'https://github.com/usuario/repo' });
    const branch = h('input', { type: 'text', value: p.branch, placeholder: 'main' });
    const notes = h('textarea', { rows: 4, value: p.notes, placeholder: 'Stack, estilo, restricciones… se incluyen en cada prompt' });
    const auto = autoStateBox(p.autoState);
    right.appendChild(h('div.card',
      h('h3', 'Datos del proyecto'),
      field('NOMBRE', name), field('OBJETIVO', goal), field('REPOSITORIO', repo), field('RAMA', branch),
      field('INDICACIONES PARA CADA SESIÓN', notes), auto.label,
      h('div.buttons', h('button.btn.primary', { onclick: async () => {
        await api('project:update', p.id, { name: name.value, goal: goal.value, repo: repo.value, branch: branch.value, notes: notes.value, autoState: auto.input.checked });
        toast('Datos guardados');
      } }, 'Guardar datos'))));

    const hist = h('div.history');
    if (!p.history.length) hist.appendChild(h('div.muted', 'Sin eventos.'));
    for (let i = p.history.length - 1; i >= 0; i--) {
      const e = p.history[i];
      const idx = i;
      hist.appendChild(e.text
        ? h('div.ev.link', { onclick: () => showText(C.describe(e), e.text, 'Restaurar', async () => { await api('project:restore', p.id, idx); toast('Estado restaurado'); }) }, '▸ ' + C.describe(e))
        : h('div.ev', '• ' + C.describe(e)));
    }
    right.appendChild(h('div.card', h('h3', 'Historial'), hist));

    right.appendChild(h('div.card',
      h('h3', 'Exportar'),
      h('div.buttons',
        h('button.btn', { onclick: () => copy('Resumen en Markdown', C.markdown(p, data)) }, 'Copiar resumen'),
        h('button.btn', { onclick: async () => { await api('copy', JSON.stringify(p, null, 2)); toast('JSON copiado: impórtalo en otro equipo o en el teléfono'); } }, 'Copiar JSON'),
        h('button.btn', { onclick: async () => { const f = await api('project:export', p.id); if (f) toast('Guardado en ' + f); } }, 'Guardar archivo…')),
      h('div.buttons', h('button.btn.danger', { onclick: () => modal('Eliminar «' + p.name + '»', h('p', 'Se borrarán su estado y su historial en este equipo.'), [
        { label: 'Cancelar' },
        { label: 'Eliminar', kind: 'primary', onclick: async () => { await api('project:delete', p.id); view.projectId = null; render(true); } }
      ]) }, 'Eliminar proyecto'))));
  }

  function showText(title, text, action, onAction) {
    const buttons = [
      { label: 'Copiar', onclick: async () => { await api('copy', text); toast('Copiado'); return false; } },
      { label: 'Cerrar' }
    ];
    if (action) buttons.push({ label: action, kind: 'primary', onclick: onAction });
    modal(title, h('pre.view.mono', text), buttons);
  }

  // ------------------------------------------------------------------ accounts

  function renderAccounts() {
    content.appendChild(h('div.toolbar',
      h('button.btn.primary', { onclick: () => accountDialog(null) }, '+ Agregar cuenta'),
      h('button.btn', { onclick: async () => {
        try {
          const n = await api('account:open-all');
          toast(n ? 'Abiertas ' + n + ' cuentas' : 'No hay cuentas disponibles');
        } catch (e) {
          toast(e.message, 6000);
        }
      } }, 'Abrir disponibles'),
      h('button.btn', { onclick: async () => { const n = await api('tile'); if (!n) toast('No hay cuentas abiertas'); } }, 'Ver todas en mosaico')));
    const list = accounts();
    if (!list.length) {
      content.appendChild(h('div.card.empty',
        h('h3', 'Agrega tu primera cuenta'),
        h('p.muted', 'Cada cuenta se abre en su propia pestaña con cookies separadas: puedes tener varias cuentas de Claude abiertas al mismo tiempo y verlas una al lado de la otra. Después de agregarla, pulsa Abrir e inicia sesión.')));
      return;
    }
    const grid = h('div.grid');
    for (const a of list) grid.appendChild(accountCard(a));
    content.appendChild(grid);
  }

  function accountCard(a) {
    const status = h('div.status');
    const update = () => {
      const now = Date.now();
      if (C.isPaused(a, now)) {
        status.className = 'status warn';
        status.textContent = 'En pausa · vuelve en ' + C.duration(a.pausedUntil - now) + ' (' + C.clock(a.pausedUntil) + ')';
      } else {
        status.className = 'status ok';
        status.textContent = 'Disponible';
      }
    };
    update();
    tickers.push(update);
    const p = project(a.activeProjectId);
    const info = (p ? 'Proyecto: ' + p.name + ' (' + p.progress + '%)' : 'Sin proyecto activo') + ' · activa ' + C.ago(a.lastActive)
      + (a.startUrl === C.URL_CODE ? ' · Claude Code' : '')
      + (a.browser === 'chrome' ? ' · se abre en el navegador externo' : ' · dentro de Relevo');
    return h('div.card.acard',
      h('div.head', h('span.dot', { style: { background: colorOf(a) } }),
        h('div.grow', h('h3', a.name), a.note ? h('div.muted', a.note) : null),
        h('span.muted', '#' + a.slot)),
      status,
      h('div.muted', info),
      h('div.buttons',
        h('button.btn.primary', { onclick: () => api('account:open', a.slot, 'normal').catch((e) => toast(e.message, 6000)) }, 'Abrir'),
        h('button.btn', { onclick: () => api('account:open', a.slot, 'side').catch((e) => toast(e.message, 6000)) }, 'Al lado'),
        h('button.btn', { onclick: () => pauseDialog(a.slot) }, 'Pausa'),
        h('button.btn', { onclick: () => accountDialog(a) }, 'Editar')),
      h('div.buttons',
        h('button.btn.quiet', { onclick: () => modal('Cerrar sesión de «' + a.name + '»', h('p', a.browser === 'chrome'
          ? 'Se borrará el perfil del navegador de esta cuenta (cookies, historial y sesión). Cierra antes sus ventanas del navegador.'
          : 'Se borrarán las cookies y los datos de navegación de esta cuenta en este equipo.'), [
          { label: 'Cancelar' }, { label: 'Cerrar sesión', kind: 'primary', onclick: async () => { await api('account:logout', a.slot); toast('Sesión cerrada'); } }]) }, 'Cerrar sesión'),
        h('button.btn.quiet', { onclick: () => modal('Eliminar «' + a.name + '»', h('p', 'Se cerrará su pestaña y se borrarán sus datos de sesión. Los proyectos se conservan.'), [
          { label: 'Cancelar' }, { label: 'Eliminar', kind: 'primary', onclick: () => api('account:delete', a.slot) }]) }, 'Eliminar')));
  }

  function accountDialog(a) {
    const browser = h('select',
      h('option', { value: 'integrated' }, 'Dentro de Relevo (pestaña) — iniciar sesión con correo'),
      h('option', { value: 'chrome' }, 'Navegador externo (Chrome o Edge) — solo si necesitas «Continuar con Google»'));
    browser.value = a ? (a.browser || 'integrated') : 'integrated';
    const browserNote = h('p.muted', { style: { margin: '6px 0 0' } });
    api('browser:info').then((info) => {
      browserNote.textContent = info.path
        ? 'Con el navegador externo la cuenta usa su propio perfil de ' + info.name + ', pero queda fuera de Relevo. Las cuentas de Google también pueden entrar dentro de Relevo con su correo.'
        : 'No encontré Chrome ni Edge instalados: usa «Dentro de Relevo» o elige el navegador en Guía y ajustes.';
    });
    const name = h('input', { type: 'text', value: a ? a.name : '', placeholder: 'p. ej. Personal' });
    const note = h('input', { type: 'text', value: a ? a.note : '', placeholder: 'correo, plan, uso… (opcional)' });
    let color = a ? a.color : C.COLORS[data.accounts.length % C.COLORS.length];
    const sw = h('div.swatches');
    const paint = () => sw.replaceChildren(...C.COLORS.map((c) => h('button', {
      type: 'button', className: c.toLowerCase() === String(color).toLowerCase() ? 'on' : '', style: { background: c },
      title: c, onclick: () => { color = c; paint(); }
    })));
    paint();
    const current = a ? a.startUrl : C.URL_CHAT;
    const start = h('select',
      h('option', { value: C.URL_CHAT }, 'Chat (claude.ai)'),
      h('option', { value: C.URL_CODE }, 'Claude Code (claude.ai/code)'),
      h('option', { value: 'other' }, 'Otra URL'));
    const url = h('input', { type: 'url', value: current, placeholder: 'https://…' });
    start.value = current === C.URL_CHAT || current === C.URL_CODE ? current : 'other';
    const syncUrl = () => { url.hidden = start.value !== 'other'; };
    start.addEventListener('change', syncUrl);
    syncUrl();
    modal(a ? 'Editar cuenta' : 'Nueva cuenta', h('div',
      field('NOMBRE', name), field('NOTA', note), h('span.label', 'COLOR'), sw,
      field('ABRIR CON', browser), browserNote,
      field('PÁGINA DE INICIO', start), url), [
      { label: 'Cancelar' },
      { label: 'Guardar', kind: 'primary', onclick: async () => {
        let startUrl = start.value === 'other' ? url.value.trim() : start.value;
        if (startUrl && !/^https?:\/\//i.test(startUrl)) startUrl = 'https://' + startUrl;
        const slot = await api('account:save', { slot: a ? a.slot : 0, name: name.value, note: note.value, color,
          startUrl: startUrl || C.URL_CHAT, browser: browser.value });
        if (!a) toast('Cuenta agregada: ábrela con su pestaña de arriba e inicia sesión');
      } }
    ]);
  }

  function pauseDialog(slot) {
    const a = account(slot);
    if (!a) return;
    const now = Date.now();
    const options = PAUSES.slice(1).map(([label, ms]) => h('button.btn', { onclick: async () => { dlg.close(); await setPause(slot, Date.now() + ms); } }, label));
    const time = h('input', { type: 'time' });
    let dlg = null;
    dlg = modal('¿Hasta cuándo pausar «' + a.name + '»?', h('div',
      h('div.list', options),
      h('span.label', 'O HASTA UNA HORA EXACTA'),
      h('div.row', time, h('button.btn', { onclick: async () => {
        if (!time.value) return;
        const [hh, mm] = time.value.split(':').map(Number);
        const at = new Date();
        at.setHours(hh, mm, 0, 0);
        if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
        dlg.close();
        await setPause(slot, at.getTime());
      } }, 'Pausar'))),
    C.isPaused(a, now)
      ? [{ label: 'Quitar la pausa', onclick: () => setPause(slot, 0) }, { label: 'Cancelar' }]
      : [{ label: 'Cancelar' }]);
  }

  async function setPause(slot, until) {
    await api('account:pause', slot, until);
    toast(until ? 'En pausa hasta las ' + C.clock(until) + '. Te avisaré.' : 'Cuenta disponible');
  }

  // ------------------------------------------------------------------ guide

  function renderGuide() {
    const auto = h('input', { type: 'checkbox', checked: !!data.autoInsert, onchange: () => api('set', 'autoInsert', auto.checked) });
    const section = (title, ...nodes) => h('div.card', h('h3', title), ...nodes);
    const browserLine = h('p.muted', 'Buscando navegador…');
    const loadBrowser = () => api('browser:info').then((info) => {
      browserLine.textContent = info.path ? 'Navegador para las cuentas «en el navegador»: ' + info.name + ' (' + info.path + ')'
        : 'No encontré Chrome ni Edge. Instala Google Chrome o elige el ejecutable del navegador.';
    });
    loadBrowser();
    content.appendChild(h('div.guide',
      section('Ajustes', h('label.check', auto, 'Insertar los prompts directamente en el cuadro de mensaje de las cuentas dentro de Relevo (si no, solo se copian al portapapeles)'),
        browserLine,
        h('div.buttons', h('button.btn', { onclick: async () => { const n = await api('browser:choose'); if (n) { toast('Navegador: ' + n); loadBrowser(); } } }, 'Elegir otro navegador…'))),
      section('Iniciar sesión con Google', h('p', 'Google no permite «Continuar con Google» dentro de apps porque no son un navegador completo. Para que la cuenta quede dentro de Relevo, entra con tu correo: escribe tu dirección de Gmail en el campo de correo de Claude y usa el código o enlace que te llega (un enlace se abre con ⋯ → «Abrir un enlace aquí»).'),
        h('p', 'Si prefieres «Continuar con Google», elige «Abrir con: Navegador externo» al editar la cuenta: se abre en tu Chrome (o Edge) con un perfil propio, fuera de Relevo, y su pestaña queda con los botones. Ahí los prompts se copian al portapapeles (pega con Ctrl+V) y para «Guardar» copias la respuesta de Claude con el botón Copiar del bloque de código.')),
      section('Cómo funciona', h('ol',
        h('li', 'Cuentas: agrega cada cuenta de Claude que uses. Cada una es una pestaña de Relevo con su sesión separada, así varias sesiones funcionan al mismo tiempo.'),
        h('li', 'Inicia sesión una vez en cada cuenta con tu correo; si te llega un enlace, cópialo y ábrelo con ⋯ → «Abrir un enlace aquí» (ver «Iniciar sesión con Google»).'),
        h('li', 'Proyectos: crea un proyecto con su objetivo (y repositorio, si lo hay). En la pestaña de una cuenta elige el proyecto en su barra y pulsa «📨 Traspaso»: el prompt de inicio queda en el cuadro de mensaje. Revísalo y envíalo.'))),
      section('Pasar el proyecto a otra cuenta', h('ol',
        h('li', 'Pulsa «🧭 Pedir estado» y envía el mensaje. Claude responde con un bloque <<<ESTADO … ESTADO>>>.'),
        h('li', 'Pulsa «💾 Guardar»: Relevo lee ese bloque de la conversación (o del portapapeles) y lo guarda como checkpoint con su % de progreso.'),
        h('li', 'Pulsa «⇄ Pasar», elige la cuenta destino y, si la actual llegó a su límite, cuánto pausarla. Relevo registra el traspaso, te avisa cuando la cuenta vuelve a estar disponible y abre la pestaña de la otra cuenta (si quieres, las dos lado a lado).'),
        h('li', 'En la cuenta destino aparece «Traspaso pendiente»: pulsa «Insertar prompt» y envía el mensaje. Repite hasta terminar.'))),
      section('Varias cuentas a la vez', h('ul',
        h('li', 'Todo queda en una sola ventana: arriba están el Panel y una pestaña por cuenta. ', h('span.kbd', 'Ctrl+Tab'), ' pasa a la siguiente.'),
        h('li', '«Una», «Dos» y «Todas» (arriba a la derecha) eligen cuántas cuentas ves a la vez: una, dos lado a lado o todas en mosaico (', h('span.kbd', 'Ctrl+Shift+M'), ').'),
        h('li', 'Atajos en una cuenta: ', h('span.kbd', 'Ctrl+R'), ' recargar, ', h('span.kbd', 'Alt+←'), ' atrás, ',
          h('span.kbd', 'Ctrl+Shift+O'), ' chat nuevo, ', h('span.kbd', 'Ctrl+Shift+H'), ' panel principal.'))),
      section('Con código (Claude Code)', h('p', 'Si el proyecto tiene repositorio, los prompts piden a Claude hacer commit y push de cada avance y mantener el bloque de estado en HANDOFF.md, así el estado viaja también con el código. Puedes poner claude.ai/code como página de inicio de una cuenta.')),
      section('Entre dispositivos', h('p', 'Los proyectos usan el mismo formato en Windows, Android e iPhone: en Detalles → «Copiar JSON» o «Guardar archivo…», y en el otro dispositivo Proyectos → Importar.')),
      section('Privacidad y límites', h('ul',
        h('li', 'Relevo no envía mensajes ni automatiza Claude: solo coloca texto en el cuadro de mensaje cuando pulsas un botón, y tú decides enviarlo.'),
        h('li', 'Todo se guarda solo en este equipo.'),
        h('li', 'Usa solo tus propias cuentas y respeta los Términos de uso de Anthropic.')))));
    api('info').then((i) => content.appendChild(h('p.muted', { style: { textAlign: 'center', marginTop: '18px' } }, 'Relevo ' + i.version)));
  }

  // ------------------------------------------------------------------ boot

  for (const t of document.querySelectorAll('.tab')) {
    t.addEventListener('click', () => { view.tab = t.dataset.tab; view.projectId = null; render(true); window.scrollTo(0, 0); });
  }
  window.relevo.on('data', (d) => { data = d; render(false); });
  window.relevo.on('command', (c) => {
    if (c !== 'add-account') return;
    view.tab = 'accounts';
    view.projectId = null;
    render(true);
    accountDialog(null);
  });
  setInterval(() => tickers.forEach((f) => f()), 30000);
  api('data').then((d) => { data = d; render(true); });
})();
