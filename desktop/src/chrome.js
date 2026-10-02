'use strict';
/*
 * Opens accounts in the user's real browser (Google Chrome, or Edge/Brave/Chromium) with a
 * separate profile directory per account. Each directory is an independent browser profile with
 * its own cookies, so every account stays signed in on its own and Google sign-in works there,
 * because it is the real browser. Relevo does not control those windows: it only launches them.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function candidates() {
  const env = process.env;
  if (process.platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    const list = [];
    for (const parts of [['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe']]) {
      for (const r of roots) list.push(path.join(r, ...parts));
    }
    return list;
  }
  if (process.platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge', '/usr/bin/brave-browser'];
}

/** Path of the browser to use: the one the user picked, else the first installed. */
function find(custom) {
  for (const p of [custom, process.env.RELEVO_BROWSER, ...candidates()]) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function browserName(exe) {
  if (!exe) return '';
  if (/msedge|edge/i.test(exe)) return 'Microsoft Edge';
  if (/brave/i.test(exe)) return 'Brave';
  if (/chromium|chrome-linux|pw-browsers/i.test(exe)) return 'Chromium';
  return 'Google Chrome';
}

/** Names the profile "Relevo · <account>" the first time, so its windows are easy to tell apart. */
function prepareProfile(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const localState = path.join(dir, 'Local State');
  if (!fs.existsSync(localState)) {
    fs.writeFileSync(localState, JSON.stringify({
      profile: { info_cache: { Default: { name, is_using_default_name: false } } }
    }));
  }
}

/**
 * Opens `url` in the account's profile. If that profile is already open, the browser just adds a
 * tab to it; otherwise it starts a new window at `bounds`.
 */
function launch(exe, dir, url, bounds) {
  const args = ['--user-data-dir=' + dir, '--no-first-run', '--no-default-browser-check'];
  if (bounds) {
    args.push('--window-position=' + Math.round(bounds.x) + ',' + Math.round(bounds.y),
      '--window-size=' + Math.round(bounds.width) + ',' + Math.round(bounds.height));
  }
  // Only for automated tests (e.g. "--no-sandbox" when running as root in a container).
  if (process.env.RELEVO_BROWSER_ARGS) args.push(...process.env.RELEVO_BROWSER_ARGS.split(' ').filter(Boolean));
  if (url) args.push(url);
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return child;
}

module.exports = { find, browserName, prepareProfile, launch, candidates };
