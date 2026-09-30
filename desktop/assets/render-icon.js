// Renders assets/icon.svg to PNG with Playwright's Chromium: node assets/render-icon.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
  const browser = await chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
  for (const [size, out] of [[512, 'assets/icon.png'], [256, 'src/ui/icon.png']]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('width="512" height="512"', `width="${size}" height="${size}"`)}</body></html>`);
    await page.screenshot({ path: path.join(__dirname, '..', out), omitBackground: true });
    await page.close();
  }
  await browser.close();
})();
