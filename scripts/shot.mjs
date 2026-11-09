// Launch the real Electron app, optionally open files, run JS in the renderer, and screenshot.
//   node scripts/shot.mjs --out shot.png [--open file ...] [--wait 3000] [--eval "js"] [--user-data dir]
//                         [--size 1440x900] [--keep]   (--keep leaves the app open for --eval-loop debugging)
// Uses out/renderer unless KOTOBA_RENDERER_URL is set. Prints the eval result and console errors as JSON.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const all = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));

const out = path.resolve(opt('out', path.join(os.tmpdir(), 'kotoba-shot.png')));
const userData = opt('user-data', process.env.KOTOBA_USER_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'kotoba-shot-')));
const [w, h] = opt('size', '1440x900').split('x').map(Number);

const app = await electron.launch({
  args: [ROOT, ...all('open').map((p) => path.resolve(p))],
  cwd: ROOT,
  env: { KOTOBA_BACKGROUND: '1', ...process.env, KOTOBA_USER_DATA: userData },
});
const errors = [];
const win = await app.firstWindow();
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
win.on('pageerror', (e) => errors.push(String(e)));
await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]?.setContentSize(w, h), [w, h]);
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(Number(opt('wait', 2500)));

let result = null;
const code = opt('eval');
if (code) result = await win.evaluate(`(async () => { ${code} })()`);
await win.waitForTimeout(Number(opt('after', 300)));
await win.screenshot({ path: out });
console.log(JSON.stringify({ out, userData, result, errors }, null, 1));
if (!args.includes('--keep')) await app.close();
