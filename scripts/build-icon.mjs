// Render build/icon.svg with Electron offscreen and pack it into build/icon.icns (macOS iconutil).
//   npx electron scripts/build-icon.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';

const BUILD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
const svg = fs.readFileSync(path.join(BUILD, 'icon.svg'), 'utf8');

app.dock?.hide();
// Top-level await on whenReady deadlocks an ESM main module.
app.whenReady().then(render);

async function render() {
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true,
    webPreferences: { offscreen: true },
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(
    `<style>html,body{margin:0;background:transparent;overflow:hidden}</style>${svg}`
  )}`);
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(requestAnimationFrame))');
  const png = (await win.webContents.capturePage()).resize({ width: 1024, height: 1024, quality: 'best' }).toPNG();
  fs.writeFileSync(path.join(BUILD, 'icon.png'), png);

  const set = fs.mkdtempSync(path.join(os.tmpdir(), 'kotoba-icon-')) + '/icon.iconset';
  fs.mkdirSync(set);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const [scale, suffix] of [[1, ''], [2, '@2x']]) {
      const px = size * scale;
      execFileSync('sips', ['-z', px, px, path.join(BUILD, 'icon.png'), '--out', `${set}/icon_${size}x${size}${suffix}.png`], { stdio: 'ignore' });
    }
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(BUILD, 'icon.icns')]);
  fs.rmSync(path.dirname(set), { recursive: true, force: true });
  console.log('wrote build/icon.png, build/icon.icns');
  app.quit();
}
