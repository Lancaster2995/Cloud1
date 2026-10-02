'use strict';
/* Tells the Windows app that GitHub has a newer Relevo for Windows (it does not update itself). */
const RELEASES = 'https://api.github.com/repos/Lancaster2995/Cloud1/releases?per_page=30';

function newer(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

// Newest windows-vX.Y.Z release above `current` as { version, url } (the installer when present), or null.
function pick(releases, current) {
  let best = null;
  for (const r of releases || []) {
    const m = /^windows-v(\d+\.\d+\.\d+)$/.exec(r.tag_name || '');
    if (!m || r.draft || r.prerelease || !newer(m[1], best ? best.version : current)) continue;
    const setup = (r.assets || []).find((a) => /^Relevo-Setup-.*\.exe$/.test(a.name));
    best = { version: m[1], url: setup ? setup.browser_download_url : r.html_url };
  }
  return best;
}

async function check(current) {
  try {
    const res = await fetch(RELEASES, { headers: { 'User-Agent': 'Relevo' }, signal: AbortSignal.timeout(10000) });
    return res.ok ? pick(await res.json(), current) : null;
  } catch {
    return null; // offline or rate-limited: no notice
  }
}

module.exports = { newer, pick, check };
