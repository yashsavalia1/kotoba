import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import { app } from 'electron';

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Tee console.* to main.log in the app's logs dir (~/Library/Logs/Kotoba, or
 * $KOTOBA_USER_DATA/logs), since a Finder launch discards stdout. Returns the file path.
 */
export function startLog() {
  app.setAppLogsPath(process.env.KOTOBA_USER_DATA ? path.join(process.env.KOTOBA_USER_DATA, 'logs') : undefined);
  const file = path.join(app.getPath('logs'), 'main.log');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.old`);
  } catch { /* no log yet */ }
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      fs.appendFile(file, `${new Date().toISOString()} ${level} ${format(...args)}\n`, () => {});
    };
  }
  return file;
}

/** Renderer errors, warnings and crashes go to the same log. */
export function logRenderer(wc) {
  wc.on('console-message', ({ level, message, sourceId, lineNumber }) => {
    if (level === 'error' || level === 'warning') console[level === 'error' ? 'error' : 'warn'](`[renderer] ${message} (${sourceId}:${lineNumber})`);
  });
  wc.on('render-process-gone', (_e, d) => console.error('[renderer] process gone:', d.reason, d.exitCode));
  wc.on('unresponsive', () => console.error('[renderer] unresponsive'));
}
