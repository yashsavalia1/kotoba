import { execFileSync } from 'node:child_process';
import { test } from '@playwright/test';
import { ROOT, RENDERER_DIR } from './fixtures.mjs';

test('build renderer', () => {
  test.setTimeout(120_000);
  execFileSync('npx', ['vite', 'build', '--config', 'vite.config.mjs', '--logLevel', 'warn'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, KOTOBA_RENDERER_DIR: RENDERER_DIR },
  });
});
