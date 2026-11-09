import { defineConfig } from '@playwright/test';

// npm run e2e                         dev build (renderer built into $KOTOBA_RENDERER_DIR or out/e2e)
// npx playwright test --project=packaged   same smoke against dist/mac-arm64/Kotoba.app (npm run dist first)
export default defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.(spec|setup)\.mjs/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 2,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'build-renderer', testMatch: /build\.setup\.mjs/ },
    { name: 'dev', dependencies: ['build-renderer'], testIgnore: /\.setup\.mjs/ },
    {
      name: 'packaged',
      testIgnore: /\.setup\.mjs/,
      use: { executable: 'dist/mac-arm64/Kotoba.app/Contents/MacOS/Kotoba' },
    },
  ],
});
