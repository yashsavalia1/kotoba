import { ipcMain } from 'electron';

const TRUSTED = [/^kotoba:\/\/app\//, /^http:\/\/localhost:\d+\//, /^http:\/\/127\.0\.0\.1:\d+\//];

/**
 * Registers an invoke handler that only answers our own renderer and returns a
 * `{ ok, value | error }` envelope so the renderer sees clean error messages.
 */
export function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    const url = event.senderFrame?.url ?? '';
    if (!TRUSTED.some((re) => re.test(url))) return { ok: false, error: `untrusted sender: ${url}` };
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      console.error(`[kotoba] ${channel}:`, e);
      return { ok: false, error: e?.message ?? String(e) };
    }
  });
}
