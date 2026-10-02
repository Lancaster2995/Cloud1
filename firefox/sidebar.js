/*
 * Relevo sidebar for Firefox. Each Claude account is a Firefox container (own cookies), so all of
 * them stay signed in as tabs of one window, and "Continue with Google" works because this is the
 * real browser. The panel drives the handoff for the account of the active tab: start/handoff
 * prompt, CHECKPOINT, save the status block and pass the project to another account.
 * Same data and logic as the Windows app (shared/ is copied from desktop/src by sync.js).
 */
(function () {
  'use strict';
  const { h, toast, modal, field, autoStateBox } = window.UI;
  const C = window.RelevoCore;
  const M = window.RelevoModel;
  const J = window.RelevoInject;
  const KEY = 'relevo';
  // Firefox containers only take these color names; same order as C.COLORS.
  const FX_COLORS = ['orange', 'blue', 'green', 'purple', 'yellow', 'red', 'turquoise', 'toolbar'];
  const PAUSES = [
    ['No pausar', 0], ['1 hora', 3600e3], ['2 horas', 7200e3], ['3 horas', 10800e3],
    ['5 horas', 18000e3], ['8 horas', 28800e3], ['24 horas', 86400e3]
  ];
  const DELIVERED = {
    ok: 'Listo en el cuadro de mensaje: revísalo y envíalo.',
    copied: 'Copiado al portapapeles: pega con Ctrl+V en el cuadro de mensaje.',
    noel: 'Copiado. Abre un chat de Claude en esta pestaña y pega con Ctrl+V.',
    fail: 'Copiado. Haz clic en el cuadro de mensaje y pega con Ctrl+V.'
  };

  let data = M.defaults({});
  let tab = null; // active tab of this window
  let windowId = null;
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const say = (msg, ms) => toast(msg, ms || 6000);

  // ------------------------------------------------------------------ storage

  async function load() {
    const r = await browser.storage.local.get(KEY);
    return M.defaults(r[KEY]);
  }

  /**
   * Applies fn to the stored document, saves it and returns fn's result.
   * ponytail: read-modify-write without a lock; two panels saving in the same instant could lose
   * one edit. Move the writes to background.js if that ever shows up.
   */
  async function edit(fn) {
    const d = await load();
    const result = fn(d);
    await browser.storage.local.set({ [KEY]: d });
    data = d;
    render();
    return result;
  }

  const account = (slot) => M.account(data, slot);
  const project = (id) => M.project(data, id);
  const accounts = () => M.sortedAccounts(data);
  const projects = () => M.sortedProjects(data);
  /** Account whose container the active tab belongs to. */
  const current = () => (tab && data.accounts.find((a) => a.cookieStoreId && a.cookieStoreId === tab.cookieStoreId)) || null;
  const fxColor = (hex) => FX_COLORS[Math.max(0, C.COLORS.findIndex((c) => c.toLowerCase() === String(hex).toLowerCase()))];

  // ------------------------------------------------------------------ containers and tabs

  /** The account's container, created again if it was removed in Firefox's settings. */
  async function containerOf(a) {
    if (a.cookieStoreId) {
      try {
        await browser.contextualIdentities.get(a.cookieStoreId);
        return a.cookieStoreId;
      } catch (e) {
        // Gone: make a new one below.
      }
    }
    const ci = await browser.contextualIdentities.create({ name: 'Relevo · ' + a.name, color: fxColor(a.color), icon: 'circle' });
    await edit((d) => { const x = M.account(d, a.slot); if (x) x.cookieStoreId = ci.cookieStoreId; });
    return ci.cookieStoreId;
  }

  /** Brings the account's tab to the front in this window, or opens one in its container. */
  async function openAccount(slot) {
    const a = account(slot);
    if (!a) return;
    const id = await containerOf(a);
    const [t] = await browser.tabs.query({ cookieStoreId: id, windowId });
    if (t) await browser.tabs.update(t.id, { active: true });
    else await browser.tabs.create({ cookieStoreId: id, url: a.startUrl || C.URL_CHAT, windowId });
    await edit((d) => { const x = M.account(d, slot); if (x) x.lastActive = Date.now(); });
  }

  async function refreshTab() {
    [tab] = await browser.tabs.query({ active: true, windowId });
    render();
  }

  async function run(code) {
    const [r] = await browser.tabs.executeScript(tab.id, { code });
    return r;
  }

  /** Copies the text and, if enabled, places it in the chat box of the active tab (never sends it). */
  async function deliver(text, retries = 8) {
    await navigator.clipboard.writeText(text).catch(() => {});
    if (!data.autoInsert) return 'copied';
    for (let i = 0; i <= retries; i++) {
      // While the page is still loading the script cannot run yet: same as "no chat box yet".
      const r = await run(J.insert(text)).catch(() => 'noel');
      if (r !== 'noel') return r;
      await sleep(700);
    }
    return 'noel';
  }

  const pathOf = (url) => { try { return new URL(url).pathname; } catch (e) { return ''; } };

  // ------------------------------------------------------------------ handoff actions

  async function insert(kind, projectId) {
    await refreshTab();
    const a = current();
    if (!a) return say('Abre primero la pestaña de una cuenta (abajo, en Cuentas).');
    const p = project(projectId || a.activeProjectId);
    if (!p) return chooseProject(a, () => insert(kind));
    if (kind === 'checkpoint') return say(DELIVERED[await deliver(C.checkpoint(p))] || DELIVERED.fail);
    const path = pathOf(tab.url);
    if (/^\/(chat|code)\/.+/.test(path)) {
      const where = await new Promise((resolve) => {
        modal('Hay una conversación abierta', h('p', 'El traspaso funciona mejor en un chat nuevo. ¿Dónde lo inserto?'), [
          { label: 'Cancelar', onclick: () => resolve(null) },
          { label: 'Aquí', onclick: () => resolve('here') },
          { label: 'Chat nuevo', kind: 'primary', onclick: () => resolve('new') }
        ]);
      });
      if (!where) return;
      if (where === 'new') {
        await browser.tabs.update(tab.id, { url: path.startsWith('/code/') ? C.URL_CODE : C.URL_CHAT });
        await sleep(1200);
      }
    }
    say('Insertando…');
    const status = await deliver(C.next(p), 14);
    await edit((d) => M.handoffDone(d, p.id, a.slot));
    say(DELIVERED[status] || DELIVERED.fail);
  }

  /** Reads the newest status block of the conversation (or the clipboard) and stores it. */
  async function readState() {
    await refreshTab();
    const a = current();
    const p = a && project(a.activeProjectId);
    if (!p) return { status: 'no-project' };
    let page = { block: null, newestIsTemplate: false };
    try {
      page = C.find(String((await run(J.PAGE_TEXT)) || ''), true);
    } catch (e) {
      // Not a Claude page: fall back to the clipboard.
    }
    let block = page.block, source = 'la conversación';
    if (!block || page.newestIsTemplate) {
      const text = String(await navigator.clipboard.readText().catch(() => ''));
      const clip = C.isOwnPrompt(text) ? { block: null } : C.find(text, false);
      if (clip.block) { block = clip.block; source = 'el portapapeles'; }
      else if (page.newestIsTemplate) return { status: 'template' };
    }
    if (!block) return { status: 'none' };
    const changed = await edit((d) => M.saveCheckpoint(d, p.id, a.slot, block, 'checkpoint'));
    return { status: changed ? 'saved' : 'same', source, progress: C.progress(block), template: page.newestIsTemplate };
  }

  async function saveState() {
    const a = current();
    if (!a) return say('Abre primero la pestaña de una cuenta.');
    if (!project(a.activeProjectId)) return chooseProject(a, saveState);
    const r = await readState();
    if (r.status === 'saved') say('Estado guardado desde ' + r.source + (r.progress >= 0 ? ' · ' + r.progress + '%' : ''));
    else if (r.status === 'same') say('Ese estado ya estaba guardado.');
    else if (r.status === 'template') say('Claude aún no ha respondido con el estado. Espera a que termine y vuelve a pulsar Guardar.', 9000);
    else modal('No encontré el bloque de estado', h('p',
      'Pulsa «Pedir estado», envía el mensaje y, cuando Claude responda con el bloque <<<ESTADO … ESTADO>>>, vuelve a pulsar «Guardar». También puedes pegarlo a mano en «Estado» del proyecto.'), [
      { label: 'Cerrar' },
      { label: 'Guardar la conversación', onclick: guard(saveConversation) },
      { label: 'Pedir estado', kind: 'primary', onclick: () => { insert('checkpoint'); } }
    ]);
  }

  /** The conversation of the active tab and the file names on it ({text: ''} when it is not a Claude page). */
  async function readConversation() {
    await refreshTab();
    const read = async (code) => String((await run(code).catch(() => '')) || '');
    return { text: await read(J.CONVERSATION), files: C.fileNames(await read(J.MAIN_TEXT)) };
  }

  /** When Claude can no longer give the state (out of messages), the conversation itself is kept. */
  async function saveConversation() {
    const a = current();
    const p = a && project(a.activeProjectId);
    if (!p) return;
    const { text, files } = await readConversation();
    if (!text) return say('No pude leer la conversación de esta pestaña.');
    const changed = await edit((d) => M.saveCheckpoint(d, p.id, a.slot, C.conversationBlock(p, text, files), 'conversation'));
    say(changed ? 'Conversación guardada: viaja en el próximo traspaso.' : 'Esa conversación ya estaba guardada.');
  }

  async function startTransfer() {
    const a = current();
    if (!a) return say('Abre primero la pestaña de una cuenta.');
    const p = project(a.activeProjectId);
    if (!p) return chooseProject(a, startTransfer);
    // Keep the newest state shown in this conversation before handing over.
    const r = await readState().catch(() => ({}));
    if (r.status === 'saved') say('Estado de la conversación guardado' + (r.progress >= 0 ? ' · ' + r.progress + '%' : ''));
    const page = await readConversation();
    transferDialog(a, p.id, r.status === 'template' || r.template, page, r.status !== 'saved' && r.status !== 'same');
  }

  function transferDialog(from, id, unanswered, page, noBlock) {
    const conversation = page.text;
    const files = page.files;
    const p = project(id);
    const now = Date.now();
    const targets = accounts().filter((a) => a.slot !== from.slot);
    if (!targets.length) return say('Agrega otra cuenta para poder pasar el proyecto.');
    const target = h('select', targets.map((a) => h('option', { value: a.slot }, C.accountLabel(a, now))));
    const free = targets.find((a) => !C.isPaused(a, now));
    if (free) target.value = String(free.slot);
    const pause = h('select', PAUSES.map(([label, ms]) => h('option', { value: ms }, label)));
    const withConversation = h('input', { type: 'checkbox', checked: !!noBlock });
    modal('Pasar proyecto a otra cuenta', h('div',
      h('p.muted', '«' + p.name + '» · ' + p.progress + '%' + (C.hasState(p) ? ' · estado guardado ' + C.ago(p.stateTime)
        : ' · aún no hay estado guardado: se enviará el prompt de inicio.')),
      unanswered ? h('p.warn', 'Ojo: Claude aún no respondió al último «Pedir estado»; se pasará el estado guardado anterior.') : null,
      field('PASAR A', target),
      field('PAUSAR «' + from.name + '» (límite alcanzado)', pause),
      files.length ? h('p.warn', 'Archivos en esta conversación: ' + files.join(', ') + '. No viajan con el traspaso: descarga los que generó Claude y vuelve a adjuntar los que necesites en la otra cuenta.') : null,
      conversation ? h('label.check', withConversation, noBlock
        ? 'Pasar la conversación de esta pestaña (Claude no dejó un bloque de estado)'
        : 'Pasar la conversación de esta pestaña en lugar del último estado') : null), [
      { label: 'Cancelar' },
      { label: 'Pasar', kind: 'primary', onclick: async () => {
        if (conversation && withConversation.checked) {
          await edit((d) => M.saveCheckpoint(d, id, from.slot, C.conversationBlock(p, conversation, files), 'conversation'));
        }
        await moveProject(id, from.slot, Number(target.value), Number(pause.value));
      } }
    ]);
  }

  async function moveProject(id, fromSlot, toSlot, pauseMs) {
    await edit((d) => M.transfer(d, id, fromSlot, toSlot, pauseMs || 0));
    await openAccount(toSlot);
  }

  async function continueProject(p) {
    if (!p.currentSlot || !account(p.currentSlot)) {
      return chooseAccount('¿En qué cuenta continuar «' + p.name + '»?', (slot) => moveProject(p.id, 0, slot, 0));
    }
    await edit((d) => {
      const pr = M.project(d, p.id);
      const a = M.account(d, pr.currentSlot);
      if (a) a.activeProjectId = pr.id;
      if (!C.hasState(pr)) pr.pendingSlot = pr.currentSlot;
    });
    await openAccount(p.currentSlot);
  }

  // ------------------------------------------------------------------ dialogs

  function chooseAccount(title, then) {
    const now = Date.now();
    let dlg = null;
    dlg = modal(title, h('div.list', accounts().map((a) => h('button.btn', { onclick: () => { dlg.close(); then(a.slot); } },
      h('span.dot', { style: { background: a.color } }), C.accountLabel(a, now)))), [{ label: 'Cancelar' }]);
  }

  function chooseProject(a, then) {
    let dlg = null;
    dlg = modal('¿En qué proyecto trabaja «' + a.name + '»?', h('div.list',
      projects().map((p) => h('button.btn', {
        onclick: async () => { dlg.close(); await setProject(a.slot, p.id); setTimeout(then, 60); }
      }, p.name + ' · ' + p.progress + '%')),
      h('button.btn', { onclick: () => { dlg.close(); setTimeout(() => newProject(a, then), 50); } }, '+ Nuevo proyecto…')),
    [{ label: 'Cancelar' }]);
  }

  const setProject = (slot, id) => edit((d) => { const a = M.account(d, slot); if (a) a.activeProjectId = id || ''; });

  function newProject(a, then) {
    const name = h('input', { type: 'text', placeholder: 'p. ej. App de inventario' });
    const goal = h('textarea', { rows: 3, placeholder: 'Qué debe quedar terminado' });
    const repo = h('input', { type: 'url', placeholder: 'https://github.com/usuario/repo (opcional)' });
    const branch = h('input', { type: 'text', placeholder: 'main (opcional)' });
    const auto = autoStateBox(true);
    modal('Nuevo proyecto', h('div', field('NOMBRE DEL PROYECTO', name), field('OBJETIVO', goal), field('REPOSITORIO', repo), field('RAMA', branch), auto.label), [
      { label: 'Cancelar', onclick: () => render() },
      { label: 'Crear', kind: 'primary', onclick: async () => {
        if (!name.value.trim()) { name.focus(); toast('Escribe un nombre'); return false; }
        await edit((d) => M.createProject(d, { name: name.value, goal: goal.value, repo: repo.value, branch: branch.value, autoState: auto.input.checked }, a ? a.slot : 0));
        if (then) setTimeout(then, 80);
      } }
    ]);
  }

  function importDialog() {
    const input = h('textarea.mono', { rows: 10, placeholder: 'JSON exportado desde Relevo (Windows, Android o iPhone) o un bloque <<<ESTADO' });
    modal('Importar proyecto', h('div', h('p.muted', 'En la app de Windows: Proyecto → Detalles → «Copiar JSON». Pégalo aquí.'), input), [
      { label: 'Pegar', onclick: async () => { input.value = await navigator.clipboard.readText().catch(() => ''); return false; } },
      { label: 'Cancelar' },
      { label: 'Importar', kind: 'primary', onclick: async () => {
        const p = await edit((d) => M.importText(d, input.value));
        say('Proyecto «' + p.name + '» importado');
      } }
    ]);
  }

  function stateDialog(p) {
    const input = h('textarea.mono', { rows: 14, value: p.state, placeholder: '<<<ESTADO …' });
    const auto = autoStateBox(p.autoState);
    modal('Estado de «' + p.name + '»', h('div', input, auto.label), [
      { label: 'Copiar JSON', onclick: async () => { await navigator.clipboard.writeText(JSON.stringify(project(p.id), null, 2)); toast('JSON copiado: impórtalo en otro dispositivo'); return false; } },
      { label: 'Cancelar' },
      { label: 'Guardar', kind: 'primary', onclick: async () => {
        await edit((d) => M.updateProject(d, p.id, { autoState: auto.input.checked }));
        const r = C.find(input.value, false);
        const block = r.block || input.value.trim();
        const changed = block ? await edit((d) => M.saveCheckpoint(d, p.id, 0, block, 'edit')) : false;
        say(changed ? 'Estado guardado' : 'Guardado');
      } }
    ]);
  }

  function accountDialog(a) {
    const name = h('input', { type: 'text', value: a ? a.name : '', placeholder: 'p. ej. Personal' });
    const note = h('input', { type: 'text', value: a ? a.note : '', placeholder: 'correo, plan, uso… (opcional)' });
    let color = a ? a.color : C.COLORS[data.accounts.length % C.COLORS.length];
    const sw = h('div.swatches');
    const paint = () => sw.replaceChildren(...C.COLORS.map((c) => h('button', {
      type: 'button', className: c.toLowerCase() === String(color).toLowerCase() ? 'on' : '', style: { background: c },
      title: c, onclick: () => { color = c; paint(); }
    })));
    paint();
    const start = h('select',
      h('option', { value: C.URL_CHAT }, 'Chat (claude.ai)'),
      h('option', { value: C.URL_CODE }, 'Claude Code (claude.ai/code)'));
    start.value = a && a.startUrl === C.URL_CODE ? C.URL_CODE : C.URL_CHAT;
    modal(a ? 'Editar cuenta' : 'Nueva cuenta', h('div',
      field('NOMBRE', name), field('NOTA', note), h('span.label', 'COLOR'), sw, field('PÁGINA DE INICIO', start),
      a ? null : h('p.muted', 'Relevo crea un contenedor de Firefox para esta cuenta: sus cookies quedan separadas de las demás y todas siguen con la sesión iniciada. Ahí funciona «Continuar con Google».')), [
      { label: 'Cancelar' },
      { label: 'Guardar', kind: 'primary', onclick: async () => {
        const saved = await edit((d) => M.upsertAccount(d, { slot: a ? a.slot : 0, name: name.value, note: note.value, color, startUrl: start.value }));
        if (a && a.cookieStoreId) {
          await browser.contextualIdentities.update(a.cookieStoreId, { name: 'Relevo · ' + saved.name, color: fxColor(saved.color) }).catch(() => {});
        }
        if (!a) await openAccount(saved.slot);
      } }
    ]);
  }

  function accountMenu(a) {
    let dlg = null;
    const act = (label, fn) => h('button.btn', { onclick: () => { dlg.close(); setTimeout(fn, 50); } }, label);
    dlg = modal(a.name, h('div.list',
      act('Editar', () => accountDialog(a)),
      act(C.isPaused(a) ? 'Cambiar o quitar la pausa' : 'Pausar (límite alcanzado)', () => pauseDialog(a)),
      act('Eliminar…', () => modal('Eliminar «' + a.name + '»', h('p', 'Se borra su contenedor de Firefox: se cierran sus pestañas y se borra su sesión. Los proyectos se conservan.'), [
        { label: 'Cancelar' },
        { label: 'Eliminar', kind: 'primary', onclick: async () => {
          if (a.cookieStoreId) await browser.contextualIdentities.remove(a.cookieStoreId).catch(() => {});
          await edit((d) => M.deleteAccount(d, a.slot));
        } }
      ]))), [{ label: 'Cerrar' }]);
  }

  function pauseDialog(a) {
    let dlg = null;
    const time = h('input', { type: 'time' });
    const pauseUntil = async (until) => {
      dlg.close();
      await edit((d) => { const x = M.account(d, a.slot); if (x) x.pausedUntil = until; });
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

  // ------------------------------------------------------------------ render

  const guard = (fn) => async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      say(e.message || String(e), 9000);
    }
  };

  function renderHere() {
    const a = current();
    const sec = $('here');
    if (!a) {
      sec.replaceChildren(h('div.card',
        h('strong', data.accounts.length ? 'Esta pestaña no es de ninguna cuenta' : 'Empieza agregando tus cuentas'),
        h('p.muted', data.accounts.length
          ? 'Abre una cuenta en «Cuentas»: se abre en su propio contenedor, con su sesión separada.'
          : 'Cada cuenta de Claude se abre en su propio contenedor de Firefox, así todas siguen con la sesión iniciada en pestañas de esta ventana.')));
      return;
    }
    const p = project(a.activeProjectId);
    const select = h('select', { title: 'Proyecto en el que trabaja esta cuenta', onchange: guard(async () => {
      select.blur();
      if (select.value === '+') newProject(a, null);
      else await setProject(a.slot, select.value);
    }) },
    h('option', { value: '' }, 'Sin proyecto'),
    ...projects().map((x) => h('option', { value: x.id }, x.name + ' · ' + x.progress + '%')),
    h('option', { value: '+' }, '+ Nuevo proyecto…'));
    select.value = p ? p.id : '';
    const pending = data.projects.find((x) => x.pendingSlot === a.slot);
    const btn = (label, title, fn, primary) => h('button.btn' + (primary ? '.primary' : ''), { title, onclick: guard(fn) }, label);
    const card = h('div.card.here',
      h('div.who', h('span.dot', { style: { background: a.color } }), h('strong.grow', a.name),
        C.isPaused(a) ? h('span.warn.small', 'en pausa hasta ' + C.clock(a.pausedUntil)) : null),
      select,
      pending ? h('div.banner',
        (C.hasState(pending) ? 'Traspaso pendiente: «' + pending.name + '» (' + pending.progress + '%).'
          : 'Proyecto nuevo asignado a esta cuenta: «' + pending.name + '».'),
        h('div.buttons',
          h('button.btn.quiet', { onclick: guard(() => edit((d) => { const x = M.project(d, pending.id); if (x) x.pendingSlot = 0; })) }, 'Descartar'),
          h('button.btn.primary', { onclick: guard(() => insert('handoff', pending.id)) }, 'Insertar prompt'))) : null,
      h('div.acts',
        btn('📨 Traspaso', 'Inserta el prompt de inicio o de continuación', () => insert('handoff')),
        btn('🧭 Pedir estado', 'Pide a Claude el bloque de estado', () => insert('checkpoint')),
        btn('💾 Guardar', 'Guarda el último bloque de estado de la conversación', saveState),
        btn('⇄ Pasar', 'Pasa el proyecto a otra cuenta', startTransfer, true)));
    card.style.borderTopColor = a.color;
    sec.replaceChildren(card);
  }

  function renderAccounts() {
    const now = Date.now();
    $('accounts').replaceChildren(
      h('div.sec', h('h2', 'CUENTAS'), h('button.btn.sm', { onclick: () => accountDialog(null) }, '+ Agregar')),
      ...accounts().map((a) => h('div.card',
        h('div.line', h('span.dot', { style: { background: a.color } }), h('span.name', { title: a.note || a.name }, a.name),
          h('button.btn.sm' + (current() === a ? '' : '.primary'), { onclick: guard(() => openAccount(a.slot)) }, current() === a ? 'Aquí' : 'Abrir'),
          h('button.btn.sm', { title: 'Editar, pausar o eliminar', onclick: () => accountMenu(a) }, '⋯')),
        h('div.small.' + (C.isPaused(a, now) ? 'warn' : 'muted'), C.isPaused(a, now)
          ? 'En pausa · vuelve en ' + C.duration(a.pausedUntil - now) + ' (' + C.clock(a.pausedUntil) + ')'
          : (a.note ? a.note + ' · ' : '') + 'disponible'))));
  }

  function renderProjects() {
    $('projects').replaceChildren(
      h('div.sec', h('h2', 'PROYECTOS'),
        h('button.btn.sm', { onclick: importDialog }, 'Importar'),
        h('button.btn.sm', { onclick: () => newProject(current(), null) }, '+ Nuevo')),
      ...projects().map((p) => {
        const acc = account(p.currentSlot);
        const next = C.nextStep(p);
        return h('div.card',
          h('div.line', h('span.name', { title: p.name }, p.name), h('span.pct', p.progress + '%')),
          h('div.progress', h('i', { style: { width: Math.max(0, Math.min(100, p.progress)) + '%' } })),
          h('div.small.muted', (acc ? acc.name : 'Sin cuenta asignada') + ' · actualizado ' + C.ago(p.updated)),
          p.pendingSlot ? h('div.small.warn', 'Traspaso pendiente → ' + C.accountName(data, p.pendingSlot)) : null,
          next ? h('div.small.muted', 'Siguiente: ' + next) : null,
          h('div.buttons',
            h('button.btn.primary', { onclick: guard(() => continueProject(p)) }, 'Continuar'),
            h('button.btn', { onclick: () => stateDialog(p) }, 'Estado')));
      }));
  }

  function render() {
    // Rebuilding would close a project list the user has open.
    if (document.activeElement && document.activeElement.tagName === 'SELECT') return;
    renderHere();
    renderAccounts();
    renderProjects();
  }

  // ------------------------------------------------------------------ boot

  $('ver').textContent = 'versión ' + browser.runtime.getManifest().version;
  browser.storage.onChanged.addListener((changes) => {
    if (!changes[KEY]) return;
    const before = M.defaults(changes[KEY].oldValue);
    data = M.defaults(changes[KEY].newValue);
    // The background saved a state by itself: say so, like the Windows toolbar.
    const auto = data.projects.find((p) => {
      const last = p.history[p.history.length - 1];
      const old = M.project(before, p.id);
      return last && last.type === 'auto' && (!old || old.stateTime !== p.stateTime);
    });
    if (auto) say('Estado de «' + auto.name + '» guardado solo' + (auto.progress >= 0 ? ' · ' + auto.progress + '%' : ''));
    render();
  });
  browser.tabs.onActivated.addListener((info) => { if (info.windowId === windowId) refreshTab(); });
  setInterval(render, 30000);
  (async () => {
    windowId = (await browser.windows.getCurrent()).id;
    data = await load();
    await refreshTab();
  })();
})();
