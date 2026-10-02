'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/shared/core');
const model = require('../src/model');

const ANSWER = [
  '<<<ESTADO', 'PROYECTO: Tienda', 'PROGRESO: 45%', 'RESUMEN: Backend listo, falta el frontend.',
  'HECHO:', '- API de productos', '- Autenticación', 'EN_PROGRESO:', '- Carrito (falta el total)',
  'SIGUIENTES_PASOS:', '- Terminar el carrito', '- Pagos con Stripe', 'DECISIONES:', '- PostgreSQL por las transacciones',
  'BLOQUEOS:', '- ninguno', 'ARCHIVOS_CLAVE:', '- api/server.ts: rutas', 'CONTEXTO_EXTRA:', 'npm run dev en el puerto 3000',
  'ESTADO>>>'
].join('\n');

const project = () => ({ name: 'Tienda', goal: 'Tienda online', repo: 'https://github.com/demo/tienda', branch: 'main', notes: '', state: '', stateTime: 0 });

test('finds the answer after the template in a conversation', () => {
  const page = 'Tú: ' + core.checkpoint(project()) + '\n\nClaude:\n```\n' + ANSWER + '\n```\nCopiar';
  const r = core.find(page, true);
  assert.ok(r.block);
  assert.equal(r.newestIsTemplate, false);
  assert.equal(core.progress(r.block), 45);
  assert.ok(r.block.startsWith(core.START) && r.block.endsWith(core.END));
});

test('reports an unanswered template', () => {
  const page = 'Claude:\n```\n' + ANSWER + '\n```\nTú: ' + core.checkpoint(project());
  const r = core.find(page, true);
  assert.equal(r.newestIsTemplate, true);
  assert.ok(r.block);
});

test('streaming block needs its end on the page but not on the clipboard', () => {
  const partial = ANSWER.substring(0, ANSWER.indexOf('DECISIONES'));
  assert.equal(core.find(partial, true).block, null);
  const clip = core.find(partial, false);
  assert.ok(clip.block);
  assert.equal(core.progress(clip.block), 45);
});

test('sections and items', () => {
  assert.deepEqual(core.items(ANSWER, 'SIGUIENTES_PASOS'), ['Terminar el carrito', 'Pagos con Stripe']);
  assert.equal(core.section(ANSWER, 'RESUMEN'), 'Backend listo, falta el frontend.');
  assert.equal(core.section(ANSWER, 'CONTEXTO_EXTRA'), 'npm run dev en el puerto 3000');
  assert.equal(core.items(ANSWER, 'HECHO').length, 2);
});

test('tolerates markdown decoration', () => {
  const md = '<<<ESTADO\n**PROGRESO:** 120 %\n**SIGUIENTES_PASOS:**\n* uno\n* dos\nESTADO>>>';
  assert.equal(core.progress(md), 100);
  assert.equal(core.items(md, 'SIGUIENTES_PASOS').length, 2);
});

test('missing progress and missing block', () => {
  assert.equal(core.progress('<<<ESTADO\nRESUMEN: x\nESTADO>>>'), -1);
  assert.equal(core.find('sin bloque', false).block, null);
});

test('normalize drops fences and trailing spaces', () => {
  assert.equal(core.normalize('```\n<<<ESTADO   \nRESUMEN: a  \n\n\n\nHECHO:\nESTADO>>>\n```'), '<<<ESTADO\nRESUMEN: a\n\nHECHO:\nESTADO>>>');
});

test('prompts carry state and repo; a pasted handoff is not a template', () => {
  const p = project();
  const start = core.start(p);
  assert.ok(start.includes('«Tienda»'));
  assert.ok(start.includes('HANDOFF.md'));
  assert.ok(core.isTemplate(start));
  p.state = core.find(ANSWER, true).block;
  p.stateTime = 1700000000000;
  const handoff = core.handoff(p);
  assert.ok(handoff.includes('SIGUIENTES_PASOS'));
  assert.ok(handoff.includes('github.com/demo/tienda'));
  assert.equal(core.isTemplate(handoff), false);
  const r = core.find('Tú: ' + handoff, true);
  assert.equal(r.newestIsTemplate, false);
  assert.equal(r.block, p.state);
  assert.equal(core.nextStep(p), 'Terminar el carrito');
});

test('same output as the Android implementation for the shared template', () => {
  // Guards the cross-platform format: the template must parse as a template with every key.
  const t = core.template('X');
  assert.equal(core.knownKeys(t), core.KEYS.length);
  assert.ok(core.isTemplate(t));
});

test('model: accounts, projects, checkpoints and transfers', () => {
  const d = model.defaults({});
  const a1 = model.upsertAccount(d, { name: 'Personal' });
  const a2 = model.upsertAccount(d, { name: 'Trabajo' });
  assert.deepEqual([a1.slot, a2.slot], [1, 2]);
  const p = model.createProject(d, { name: 'Tienda', goal: 'x' }, 1);
  assert.equal(d.accounts[0].activeProjectId, p.id);
  assert.equal(model.saveCheckpoint(d, p.id, 1, ANSWER, 'checkpoint'), true);
  assert.equal(model.saveCheckpoint(d, p.id, 1, ANSWER, 'checkpoint'), false);
  assert.equal(p.progress, 45);
  const until = model.transfer(d, p.id, 1, 2, 3600e3);
  assert.ok(until > Date.now());
  assert.equal(p.currentSlot, 2);
  assert.equal(p.pendingSlot, 2);
  assert.equal(d.accounts[1].activeProjectId, p.id);
  assert.equal(p.history[p.history.length - 1].type, 'transfer');
  assert.equal(core.describe(p.history[p.history.length - 1]).includes('Personal → Trabajo'), true);
  model.handoffDone(d, p.id, 2);
  assert.equal(p.pendingSlot, 0);
  model.deleteAccount(d, 2);
  assert.equal(p.currentSlot, 0);
});

test('model: import JSON (from any device) and state blocks', () => {
  const d = model.defaults({});
  const p = model.createProject(d, { name: 'Tienda' }, 0);
  model.saveCheckpoint(d, p.id, 0, ANSWER, 'edit');
  const copy = model.importText(d, JSON.stringify(p));
  assert.notEqual(copy.id, p.id);
  assert.equal(copy.progress, 45);
  const fromBlock = model.importText(d, 'hola\n' + ANSWER);
  assert.equal(fromBlock.name, 'Tienda');
  assert.equal(fromBlock.progress, 45);
  assert.equal(d.projects.length, 3);
  assert.throws(() => model.importText(d, 'nada'), /no encontré/);
});

test('model: Android export imports as-is', () => {
  // Field names written by Data.Project.toJson() on Android.
  const android = { id: 'abc', name: 'Desde Android', goal: 'g', repo: '', branch: '', notes: '', state: ANSWER,
    progress: 45, currentSlot: 3, pendingSlot: 0, stateTime: 1, created: 1, updated: 1,
    history: [{ time: 1, type: 'checkpoint', slot: 3, toSlot: 0, progress: 45, accountName: 'Cel', toAccountName: '', text: ANSWER }] };
  const d = model.defaults({});
  const p = model.importText(d, JSON.stringify(android));
  assert.equal(p.name, 'Desde Android');
  assert.equal(p.currentSlot, 0);
  assert.equal(p.history.length, 1);
});

test('model: accounts open in the browser or in an integrated window', () => {
  const d = model.defaults({ accounts: [{ slot: 1, name: 'Vieja' }] });
  assert.equal(d.accounts[0].browser, 'integrated');
  const a = model.upsertAccount(d, { name: 'Google', browser: 'chrome' });
  assert.equal(a.browser, 'chrome');
  model.upsertAccount(d, { slot: a.slot, browser: 'otra-cosa' });
  assert.equal(a.browser, 'integrated');
});

test('layout: dashboard, one, two side by side or all open accounts', () => {
  const tabs = { active: 0, mode: 'single', recent: [3, 1, 2] };
  assert.deepEqual(model.shownSlots(tabs), []);
  tabs.active = 3;
  assert.deepEqual(model.shownSlots(tabs), [3]);
  tabs.mode = 'split';
  assert.deepEqual(model.shownSlots(tabs), [1, 3]);
  tabs.mode = 'grid';
  assert.deepEqual(model.shownSlots(tabs), [1, 2, 3]);

  const area = { x: 0, y: 40, width: 1000, height: 600 };
  assert.deepEqual(model.gridCells(area, 1), [area]);
  const [a, b, c] = model.gridCells(area, 3);
  assert.deepEqual([a.x, a.y, a.width, a.height], [0, 40, 499, 299]);
  assert.deepEqual([b.x, b.y], [501, 40]);
  assert.deepEqual([c.x, c.y, c.width, c.height], [0, 341, 1000, 299]); // last row uses the full width
});
