'use strict';
/*
 * The extension reuses the Windows app's logic and styles. Firefox only loads files inside the
 * extension folder, so they are copied into firefox/shared:
 *   node firefox/sync.js     copies them
 * The desktop unit tests call stale() so a copy that falls behind fails the build.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'desktop', 'src');
const DEST = path.join(__dirname, 'shared');
const FILES = {
  'core.js': 'shared/core.js',
  'model.js': 'model.js',
  'inject.js': 'inject.js',
  'common.js': 'ui/common.js',
  'styles.css': 'ui/styles.css',
  'icon.png': 'ui/icon.png'
};

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p) : null);

/** Names of the copies that differ from the desktop originals. */
function stale() {
  return Object.keys(FILES).filter((name) => {
    const copy = read(path.join(DEST, name));
    return !copy || !copy.equals(read(path.join(SRC, FILES[name])));
  });
}

if (require.main === module) {
  fs.mkdirSync(DEST, { recursive: true });
  for (const [name, from] of Object.entries(FILES)) fs.copyFileSync(path.join(SRC, from), path.join(DEST, name));
  console.log('Copiados: ' + Object.keys(FILES).join(', '));
}

module.exports = { stale };
