'use strict';
/*
 * Drives the real Electron app: one window with the tab strip, the dashboard and two accounts as
 * tabs, prompt insertion, saving the status block, transfer with banner in the destination,
 * cookie isolation and the side-by-side / grid layouts. A local chat page stands in for
 * claude.ai. Screenshots go to test-results/screens. Linux: run under xvfb-run.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { _electron: electron } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, 'test-results', 'screens');
const FIXTURE = 'file://' + path.join(__dirname, 'fixtures', 'chat.html').replace(/\\/g, '/');

function seed(dir) {
  const now = Date.now();
  const data = {
    version: 1,
    autoInsert: true,
    windows: {},
    accounts: [
      { slot: 1, name: 'Personal', note: 'yo@gmail.com · Pro', color: '#D97757', startUrl: FIXTURE + '?who=1', pausedUntil: 0, lastActive: now - 600e3, activeProjectId: 'p1' },
      { slot: 2, name: 'Trabajo', note: '', color: '#4F7DF3', startUrl: FIXTURE + '?who=2', pausedUntil: 0, lastActive: now - 1200e3, activeProjectId: '' },
      { slot: 3, name: 'Respaldo', note: '', color: '#2DA44E', startUrl: FIXTURE + '?who=3', pausedUntil: now + 2 * 3600e3 + 900e3, lastActive: now - 1800e3, activeProjectId: '' }
    ],
    projects: [
      { id: 'p1', name: 'App de inventario', goal: 'App móvil para controlar el inventario de la tienda', repo: 'https://github.com/usuario/inventario',
        branch: 'main', notes: '', state: '', progress: 0, currentSlot: 1, pendingSlot: 0, stateTime: 0, created: now - 86400e3,
        updated: now - 600e3, history: [{ time: now - 86400e3, type: 'create', slot: 1, toSlot: 0, progress: 0, accountName: 'Personal', toAccountName: '', text: '' }] },
      { id: 'p2', name: 'Landing page', goal: 'Sitio de una página para el lanzamiento', repo: '', branch: '', notes: '', state: '', progress: 0,
        currentSlot: 3, pendingSlot: 0, stateTime: 0, created: now - 3600e3, updated: now - 3000e3, history: [] }
    ]
  };
  fs.writeFileSync(path.join(dir, 'relevo.json'), JSON.stringify(data));
}

async function pageMatching(app, pred, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const p = app.windows().find((w) => pred(w.url()));
    if (p) return p;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('no apareció la página esperada');
}

/** Starts Relevo with a 1280x800 window and returns its pages: tab strip and dashboard. */
async function launch(env) {
  const app = await electron.launch({ args: [ROOT, '--no-sandbox'], env: Object.assign({}, process.env, env) });
  await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
  const shell = await pageMatching(app, (u) => u.includes('shell.html'));
  const dash = await pageMatching(app, (u) => u.includes('dashboard.html'));
  return { app, shell, dash };
}

/**
 * Captures the whole Relevo window (tab strip + whatever is on screen below it) as one PNG.
 * Screenshots only illustrate the README: if the compositor has no frame yet (UnknownVizError
 * under xvfb right after a resize) it retries and finally skips the picture without failing.
 */
async function shot(app, dash, file) {
  const parts = await app.evaluate(async ({ BrowserWindow }) => {
    const grab = async (wc, rect) => {
      for (let i = 0; ; i++) {
        try {
          return (await wc.capturePage(rect)).toDataURL();
        } catch (e) {
          if (i >= 5) throw e;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    };
    const win = BrowserWindow.getAllWindows()[0];
    const { width, height } = win.getContentBounds();
    const shots = [{ x: 0, y: 0, w: width, h: height, src: await grab(win.webContents) }];
    for (const v of win.contentView.children) {
      const b = v.getBounds();
      if (!v.getVisible() || !v.webContents || !b.width || !b.height) continue;
      shots.push({ x: b.x, y: b.y, w: b.width, h: b.height, src: await grab(v.webContents, { x: 0, y: 0, width: b.width, height: b.height }) });
    }
    return { width, height, shots };
  }).catch((e) => {
    console.warn('captura omitida (' + file + '): ' + e.message);
    return null;
  });
  if (!parts) return;
  const png = await dash.evaluate(async (p) => {
    const c = document.createElement('canvas');
    c.width = p.width;
    c.height = p.height;
    const g = c.getContext('2d');
    for (const s of p.shots) {
      const img = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = s.src; });
      g.drawImage(img, s.x, s.y, s.w, s.h);
    }
    return c.toDataURL('image/png');
  }, parts);
  fs.writeFileSync(path.join(SHOTS, file), Buffer.from(png.split(',')[1], 'base64'));
}

const tabsOf = (page) => page.evaluate(() => window.relevo.call('tabs'));

test('handoff between two accounts as tabs of the one Relevo window', async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-e2e-'));
  seed(dir);
  const { app, shell, dash } = await launch({ RELEVO_USER_DATA: dir });
  try {
    await dash.waitForSelector('text=App de inventario');
    await shell.waitForSelector('.tab:has-text("Respaldo") .badge');
    await shot(app, dash, 'desktop-1-proyectos.png');

    await dash.click('.tab[data-tab=accounts]');
    await dash.waitForSelector('text=Respaldo');
    assert.ok(await dash.isVisible('text=En pausa'));
    await shot(app, dash, 'desktop-2-cuentas.png');

    // Open account 1 from its tab and insert the start prompt.
    await shell.click('.tab:has-text("Personal")');
    const bar1 = await pageMatching(app, (u) => u.includes('toolbar.html') && u.includes('slot=1'));
    const site1 = await pageMatching(app, (u) => u.includes('chat.html?who=1'));
    await site1.waitForSelector('.ProseMirror');
    await bar1.waitForSelector('#account:has-text("Personal")');
    await bar1.click('[data-act=handoff]');
    await site1.waitForFunction(() => document.querySelector('.ProseMirror').innerText.includes('Vamos a desarrollar el proyecto'));
    await site1.click('#send');

    // Ask for the status, "Claude" answers, save it.
    await bar1.click('[data-act=checkpoint]');
    await site1.waitForFunction(() => document.querySelector('.ProseMirror').innerText.startsWith('CHECKPOINT'));
    await site1.click('#send');
    await site1.waitForSelector('pre');
    await bar1.click('[data-act=save]');
    await bar1.waitForSelector('#status:has-text("Estado guardado")');
    let data = await dash.evaluate(() => window.relevo.call('data'));
    let p = data.projects.find((x) => x.id === 'p1');
    assert.equal(p.progress, 60);
    assert.ok(p.state.includes('SIGUIENTES_PASOS'));
    await shot(app, dash, 'desktop-3-ventana-cuenta.png');

    // Pass it to account 2.
    await bar1.click('[data-act=transfer]');
    await bar1.waitForSelector('.dialog');
    await shot(app, dash, 'desktop-4-pasar.png');
    await bar1.selectOption('.dialog select >> nth=0', '2');
    await bar1.click('.dialog .btn.primary');
    const bar2 = await pageMatching(app, (u) => u.includes('toolbar.html') && u.includes('slot=2'));
    const site2 = await pageMatching(app, (u) => u.includes('chat.html?who=2'));
    await bar2.waitForSelector('#banner:not([hidden])');
    assert.ok((await bar2.textContent('#bannerText')).includes('App de inventario'));
    await site2.waitForSelector('.ProseMirror');
    await bar2.click('#insertPending');
    await site2.waitForFunction(() => document.querySelector('.ProseMirror').innerText.includes('Continúo el proyecto'));
    data = await dash.evaluate(() => window.relevo.call('data'));
    p = data.projects.find((x) => x.id === 'p1');
    assert.equal(p.currentSlot, 2);
    assert.equal(p.pendingSlot, 0);
    assert.equal(p.history[p.history.length - 1].type, 'transfer');

    // Everything stays inside the one window: account 2 in front, account 1 open in its tab.
    assert.equal(await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length), 1);
    let t = await tabsOf(shell);
    assert.equal(t.active, 2);
    assert.deepEqual(t.open.sort(), [1, 2]);
    assert.deepEqual(t.shown, [2]);

    // Each account keeps its own cookies.
    const iso = await app.evaluate(async ({ session }) => {
      const s1 = session.fromPartition('persist:relevo-s1');
      const s2 = session.fromPartition('persist:relevo-s2');
      await s1.cookies.set({ url: 'https://claude.ai', name: 'sessionKey', value: 'cuenta-1' });
      return { one: (await s1.cookies.get({ url: 'https://claude.ai' })).length, two: (await s2.cookies.get({ url: 'https://claude.ai' })).length };
    });
    assert.deepEqual(iso, { one: 1, two: 0 });

    // Side by side, then all in a grid.
    await shell.click('[data-mode=split]');
    assert.deepEqual((await tabsOf(shell)).shown, [1, 2]);
    assert.equal(await dash.evaluate(() => window.relevo.call('tile')), 2);
    assert.equal((await tabsOf(shell)).mode, 'grid');
    await shot(app, dash, 'desktop-5-traspaso-recibido.png');

    // Closing a tab leaves the other account on screen.
    await shell.click('.tab:has-text("Personal") .x');
    t = await tabsOf(shell);
    assert.deepEqual(t.open, [2]);
    assert.equal(t.active, 2);

    // Project detail in the dashboard.
    await shell.click('.tab.panel');
    assert.equal((await tabsOf(shell)).active, 0);
    await dash.click('.tab[data-tab=projects]');
    await dash.click('.pcard:has-text("App de inventario") >> text=Detalles');
    await dash.waitForSelector('text=Historial');
    await shot(app, dash, 'desktop-6-proyecto.png');
  } finally {
    await app.close();
  }
});


test('passing an account that ran out of messages carries the conversation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-e2e-limit-'));
  seed(dir);
  const { app, shell, dash } = await launch({ RELEVO_USER_DATA: dir });
  try {
    // Account 1 works on the project with its own message and never gives a status block.
    await shell.click('.tab:has-text("Personal")');
    const bar1 = await pageMatching(app, (u) => u.includes('toolbar.html') && u.includes('slot=1'));
    const site1 = await pageMatching(app, (u) => u.includes('chat.html?who=1'));
    await site1.waitForSelector('.ProseMirror');
    await site1.evaluate(() => { document.querySelector('.ProseMirror').textContent = 'Mejora esta consulta técnica con los PDF'; });
    await site1.click('#send');
    await site1.waitForSelector('.font-claude-response');
    await bar1.waitForSelector('#account:has-text("Personal")');

    // Out of messages: "Pasar" offers the conversation itself, already checked.
    await bar1.click('[data-act=transfer]');
    await bar1.waitForSelector('.dialog:has-text("Claude no dejó un bloque de estado")');
    assert.equal(await bar1.isChecked('.dialog label.check:has-text("Pasar la conversación") input'), true);
    await bar1.selectOption('.dialog select >> nth=0', '2');
    await bar1.click('.dialog .btn.primary');

    const bar2 = await pageMatching(app, (u) => u.includes('toolbar.html') && u.includes('slot=2'));
    const site2 = await pageMatching(app, (u) => u.includes('chat.html?who=2'));
    await bar2.waitForSelector('#banner:not([hidden])');
    await site2.waitForSelector('.ProseMirror');
    await bar2.click('#insertPending');
    await site2.waitForFunction(() => document.querySelector('.ProseMirror').innerText.includes('| Yo: Mejora esta consulta técnica con los PDF'));
    assert.ok((await site2.evaluate(() => document.querySelector('.ProseMirror').innerText)).startsWith('Continúo el proyecto'));
    const p = (await dash.evaluate(() => window.relevo.call('data'))).projects.find((x) => x.id === 'p1');
    assert.equal(p.history[p.history.length - 2].type, 'conversation');
    assert.ok(p.state.includes('| Claude: Entendido.'));
  } finally {
    await app.close();
  }
});

test('account in the real browser (own profile) and Google sign-in notice', async (t) => {
  // Use the test machine's Chromium/Chrome as "the user's browser".
  const browser = ['/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
  if (!browser) {
    t.skip('no hay navegador Chrome/Chromium en esta máquina');
    return;
  }
  fs.mkdirSync(SHOTS, { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-e2e-chrome-'));
  seed(dir);
  const file = path.join(dir, 'relevo.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const respaldo = data.accounts.find((a) => a.slot === 3);
  respaldo.browser = 'chrome';
  respaldo.pausedUntil = 0;
  respaldo.activeProjectId = 'p2';
  fs.writeFileSync(file, JSON.stringify(data));

  const { app, dash } = await launch({
    RELEVO_USER_DATA: dir, RELEVO_BROWSER: browser, RELEVO_BROWSER_ARGS: '--no-sandbox --disable-gpu --password-store=basic'
  });
  const profile = path.join(dir, 'chrome-profiles', 's3');
  try {
    await dash.waitForSelector('text=App de inventario');

    // Opening the account starts the browser with the account's own profile; its tab shows the bar.
    await dash.evaluate(() => window.relevo.call('account:open', 3, 'normal'));
    const bar = await pageMatching(app, (u) => u.includes('toolbar.html') && u.includes('slot=3') && u.includes('mode=chrome'));
    await bar.waitForSelector('#account:has-text("Respaldo")');
    assert.ok(await bar.isVisible('#openBrowser'));
    assert.ok(await bar.isVisible('#chromeHint'));
    assert.equal(await bar.isVisible('#back'), false);
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(path.join(profile, 'Local State')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    assert.ok(fs.existsSync(path.join(profile, 'Local State')), 'perfil del navegador creado');
    assert.ok(execSync('ps -eo args').toString().includes('--user-data-dir=' + profile), 'navegador abierto con el perfil de la cuenta');

    // Handoff: the prompt goes to the clipboard to paste in the browser.
    await bar.click('[data-act=handoff]');
    await bar.waitForSelector('#status:has-text("pega con Ctrl+V")');
    const prompt = await app.evaluate(({ clipboard }) => clipboard.readText());
    assert.ok(prompt.includes('Vamos a desarrollar el proyecto «Landing page»'));

    // Save: the user copied Claude's status block in the browser.
    await app.evaluate(({ clipboard }) => clipboard.writeText('<<<ESTADO\nPROYECTO: Landing page\nPROGRESO: 70%\nRESUMEN: Maquetada.\nSIGUIENTES_PASOS:\n- Publicar\nESTADO>>>'));
    await bar.click('[data-act=save]');
    await bar.waitForSelector('#status:has-text("Estado guardado desde el portapapeles")');
    const saved = (await dash.evaluate(() => window.relevo.call('data'))).projects.find((x) => x.id === 'p2');
    assert.equal(saved.progress, 70);
    await shot(app, dash, 'desktop-7-barra-navegador.png');

    // An account inside Relevo stops Google sign-in and explains the options.
    await dash.evaluate(() => window.relevo.call('account:open', 1, 'normal'));
    const bar1 = await pageMatching(app, (u) => u.includes('toolbar.html') && u.includes('slot=1') && !u.includes('mode=chrome'));
    const site1 = await pageMatching(app, (u) => u.includes('chat.html?who=1'));
    await site1.waitForSelector('.ProseMirror');
    await site1.evaluate(() => { location.href = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=prueba'; });
    await bar1.waitForSelector('.dialog:has-text("Google no permite iniciar sesión aquí")');
    assert.ok(site1.url().includes('chat.html'), 'la página no salió hacia Google');
    await shot(app, dash, 'desktop-8-google.png');

    // "Abrir en Chrome" switches the account to the browser.
    await bar1.click('.dialog .btn:has-text("Abrir en Chrome")');
    await pageMatching(app, (u) => u.includes('toolbar.html') && u.includes('slot=1') && u.includes('mode=chrome'));
    const after = (await dash.evaluate(() => window.relevo.call('data'))).accounts.find((a) => a.slot === 1);
    assert.equal(after.browser, 'chrome');
  } finally {
    // Close the test browser first: it inherited the test harness's pipe to Electron, which would
    // otherwise keep app.close() waiting. (In normal use the browser windows stay open on purpose.)
    try {
      execSync('pkill -f "user-data-dir=' + path.join(dir, 'chrome-profiles') + '"');
    } catch (e) {
      // Nothing left running.
    }
    await app.close();
  }
});
