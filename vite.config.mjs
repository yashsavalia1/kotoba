import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(here, 'src', 'renderer'),
  base: './',
  plugins: [react()],
  server: { port: Number(process.env.KOTOBA_VITE_PORT) || 5173, strictPort: true },
  build: { outDir: path.resolve(process.env.KOTOBA_RENDERER_DIR || path.join(here, 'out', 'renderer')), emptyOutDir: true },
});
