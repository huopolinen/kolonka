// Renders assets/icon.svg into icon.png (256) and icon.ico (16..256). Run: electron tools/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const svg = fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.svg'), 'utf8');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const w = new BrowserWindow({ width: 256, height: 256, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  const tmp = path.join(app.getPath('temp'), 'kolonka-icon.html');
  fs.writeFileSync(tmp, `<html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace('<svg', '<svg width="256" height="256"')}</body></html>`);
  await w.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 500));
  const big = await w.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  w.destroy();
  const pngs = sizes.map((s) => (s === 256 ? big : big.resize({ width: s, height: s, quality: 'best' })).toPNG());
  const out = path.join(__dirname, '..', 'assets');
  fs.writeFileSync(path.join(out, 'icon.png'), pngs[pngs.length - 1]);
  // ICO with PNG frames
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let off = 6 + dir.length;
  pngs.forEach((p, i) => {
    const s = sizes[i];
    dir.writeUInt8(s >= 256 ? 0 : s, i * 16); dir.writeUInt8(s >= 256 ? 0 : s, i * 16 + 1);
    dir.writeUInt16LE(1, i * 16 + 4); dir.writeUInt16LE(32, i * 16 + 6);
    dir.writeUInt32LE(p.length, i * 16 + 8); dir.writeUInt32LE(off, i * 16 + 12);
    off += p.length;
  });
  fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([head, dir, ...pngs]));
  console.log('ok', sizes.join(','));
  app.quit();
});
