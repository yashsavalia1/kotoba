import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, protocol, shell } from 'electron';
import { configurePaths, ROOT } from '../core/paths.mjs';
import { migrateLegacy } from '../core/migrate-legacy.mjs';
import { registerProtocol, registerPlaybackIpc } from './protocol.mjs';
import { registerCoreIpc, loadApiKey } from './ipc-core.mjs';
import { registerLibraryIpc, openPaths, argvFiles } from './files.mjs';
import { buildMenu } from './menu.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.KOTOBA_RENDERER_URL;

// Separate userData per instance lets parallel dev/test instances coexist (the
// single-instance lock lives in userData).
if (process.env.KOTOBA_USER_DATA) app.setPath('userData', process.env.KOTOBA_USER_DATA);

protocol.registerSchemesAsPrivileged([
  { scheme: 'kotoba', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);
app.commandLine.appendSwitch('enable-blink-features', 'AudioVideoTracks');

let mainWindow = null;
let ready = false;
const pending = [];

const ctx = {
  getWindow: () => mainWindow,
  send: (event, payload) => {
    if (!mainWindow || mainWindow.webContents.isLoading()) {
      mainWindow?.webContents.once('did-finish-load', () => mainWindow?.webContents.send(event, payload));
    } else {
      mainWindow.webContents.send(event, payload);
    }
  },
};

function open(paths) {
  if (!paths.length) return;
  if (!ready) return void pending.push(...paths);
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.focus();
  openPaths(ctx, paths);
}

function resolveDictDb() {
  if (process.env.KOTOBA_DICT_DB) return process.env.KOTOBA_DICT_DB;
  return app.isPackaged ? path.join(process.resourcesPath, 'dict.db') : path.join(ROOT, 'data', 'dict.db');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0c0d10',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      preload: path.join(HERE, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => (mainWindow = null));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(DEV_URL ?? 'kotoba://app/')) e.preventDefault();
  });

  const target = DEV_URL ?? 'kotoba://app/index.html';
  const load = (attempt = 0) =>
    mainWindow?.loadURL(target).catch((e) => {
      // The dev server may still be starting when Electron boots.
      if (DEV_URL && attempt < 40) setTimeout(() => load(attempt + 1), 250);
      else console.error('[kotoba] failed to load renderer:', e.message);
    });
  load();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('open-file', (e, file) => {
    e.preventDefault();
    open([file]);
  });
  app.on('second-instance', (_e, argv, cwd) => {
    if (!mainWindow) createWindow();
    open(argvFiles(argv, cwd));
    mainWindow?.focus();
  });

  app.whenReady().then(() => {
    configurePaths({
      userDataDir: app.getPath('userData'),
      dictDbPath: resolveDictDb(),
      tempDir: path.join(app.getPath('temp'), 'kotoba'),
    });
    const legacy = path.join(ROOT, 'data', 'kotoba.db');
    if (!app.isPackaged && fs.existsSync(legacy)) {
      try {
        const report = migrateLegacy(legacy);
        if (!report.skipped) console.log('[kotoba] migrated legacy data:', report);
      } catch (e) {
        console.error('[kotoba] legacy migration failed:', e);
      }
    }
    loadApiKey();
    registerProtocol();
    registerCoreIpc();
    registerLibraryIpc(ctx);
    registerPlaybackIpc(ctx);
    buildMenu(ctx);
    createWindow();
    ready = true;
    open([...pending.splice(0), ...argvFiles(process.argv)]);

    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().length) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
