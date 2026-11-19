// Check playback:plan against what Chromium actually does: each fixture plays in a bare
// <video src=plan.url> inside the real app, and what it decodes must be the plan's `video` and
// `audio`, so a file plays or is reported unsupported. Never audible: the app is muted.
//   node scripts/verify-playback.mjs [files…]      default: data/fixtures/* (scripts/make-fixtures.mjs)
// Exits non-zero on any mismatch.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let files = process.argv.slice(2).map((f) => path.resolve(f));
if (!files.length) {
  const dir = path.join(ROOT, 'data', 'fixtures');
  files = fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort().map((f) => path.join(dir, f));
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kotoba-verify-'));
const app = await electron.launch({
  args: ['--mute-audio', ROOT],
  cwd: ROOT,
  env: { ...process.env, KOTOBA_USER_DATA: userData, KOTOBA_BACKGROUND: '1' },
});
const win = await app.firstWindow();
await win.waitForFunction(() => window.kotoba);

const records = await win.evaluate((ps) => window.kotoba.invoke('library:open', ps), files);
// Opening shows the player; go back so only the bare element below plays.
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('evt:command', 'show-library'));

let failures = 0;
for (const file of files) {
  const name = path.basename(file);
  const rec = records.find((r) => r.path === file);
  if (!rec) {
    console.log(`ok   ${name.padEnd(36)} refused: not a media extension`);
    continue;
  }
  const plan = await win.evaluate((id) => window.kotoba.invoke('playback:plan', id), rec.id);
  const got = await win.evaluate(async (url) => {
    const v = Object.assign(document.createElement('video'), { src: url, muted: true });
    document.body.append(v);
    try {
      const loaded = await new Promise((res) => {
        v.onloadeddata = () => res(null);
        v.onerror = () => res(v.error?.message || `media error ${v.error?.code}`);
        setTimeout(() => res('timed out'), 15000);
      });
      if (loaded) return { error: loaded };
      await v.play();
      await new Promise((res) => setTimeout(res, 1500));
      return { video: v.webkitVideoDecodedByteCount > 0, audio: v.webkitAudioDecodedByteCount > 0 };
    } finally {
      v.removeAttribute('src');
      v.load();
      v.remove();
    }
  }, plan.url);
  const problems = [];
  if (Boolean(plan.video) !== Boolean(got.video)) problems.push(`plan video ${plan.video?.codec ?? 'none'}, Chromium ${got.video ? 'decoded video' : 'showed none'}`);
  if (Boolean(plan.audio) !== Boolean(got.audio)) problems.push(`plan audio ${plan.audio?.codec ?? 'none'}, Chromium ${got.audio ? 'decoded audio' : 'played none'}`);
  failures += problems.length ? 1 : 0;
  const plays = `${got.video ? 'V' : '-'}${got.audio ? 'A' : '-'}`;
  console.log(
    `${problems.length ? 'FAIL' : 'ok  '} ${name.padEnd(36)} ${got.error ? 'error' : plays.padEnd(5)} ${plan.unsupported ?? 'plays'}` +
      (got.error ? `\n     ${got.error}` : '') +
      (problems.length ? `\n     ${problems.join('; ')}` : '')
  );
}

await app.close();
fs.rmSync(userData, { recursive: true, force: true });
process.exitCode = failures ? 1 : 0;
