import path from 'node:path';
import { app, Menu } from 'electron';
import { openMediaDialog, openPaths } from './files.mjs';
import { listMedia } from '../core/library.mjs';

const isMac = process.platform === 'darwin';

// Single-key shortcuts are handled by the renderer. On macOS a modifier-less menu
// accelerator would swallow those keys inside text fields, so they are only displayed elsewhere.
const key = (accelerator) => (isMac ? {} : { accelerator, registerAccelerator: false });

function recentMenu(ctx) {
  if (isMac) return { role: 'recentDocuments', submenu: [{ role: 'clearRecentDocuments' }] };
  let items = [];
  try {
    items = listMedia({ limit: 12 }).filter((m) => m.exists);
  } catch { /* library not ready yet */ }
  return {
    label: 'Open Recent',
    submenu: items.length
      ? items.map((m) => ({ label: `${m.title}  —  ${path.basename(m.folder)}`, click: () => openPaths(ctx, [m.path]) }))
      : [{ label: 'Nothing yet', enabled: false }],
  };
}

let watching = false;

export function buildMenu(ctx) {
  // Open Recent on non-mac platforms is built from the library, so refresh it on focus.
  if (!isMac && !watching) {
    watching = true;
    app.on('browser-window-focus', () => buildMenu(ctx));
  }
  const cmd = (command) => () => ctx.send('evt:command', command);
  const settings = { label: isMac ? 'Settings…' : 'Preferences…', accelerator: 'CmdOrCtrl+,', click: cmd('open-settings') };
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            settings,
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open File…', accelerator: 'CmdOrCtrl+O', click: () => openMediaDialog(ctx) },
        recentMenu(ctx),
        { type: 'separator' },
        { label: 'Add Subtitle File…', accelerator: 'CmdOrCtrl+Shift+S', click: cmd('attach-subtitle') },
        { type: 'separator' },
        { label: 'Close', accelerator: 'CmdOrCtrl+W', click: cmd('close') },
        ...(isMac ? [] : [settings, { type: 'separator' }, { role: 'quit' }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Playback',
      submenu: [
        { label: 'Play / Pause', ...key('Space'), click: cmd('toggle-play') },
        { type: 'separator' },
        { label: 'Previous Line', ...key(','), click: cmd('prev-line') },
        { label: 'Next Line', ...key('.'), click: cmd('next-line') },
        { label: 'Replay Line', ...key('R'), click: cmd('replay-line') },
        { type: 'separator' },
        { label: 'Previous File', accelerator: 'CmdOrCtrl+Left', click: cmd('prev-file') },
        { label: 'Next File', accelerator: 'CmdOrCtrl+Right', click: cmd('next-file') },
        { type: 'separator' },
        {
          label: 'Speed',
          submenu: [
            { label: 'Faster', ...key(']'), click: cmd('speed-up') },
            { label: 'Slower', ...key('['), click: cmd('speed-down') },
            { label: 'Normal Speed', ...key('='), click: cmd('speed-reset') },
          ],
        },
        {
          label: 'Volume',
          submenu: [
            { label: 'Louder', ...key('Up'), click: cmd('volume-up') },
            { label: 'Quieter', ...key('Down'), click: cmd('volume-down') },
            { label: 'Mute', ...key('M'), click: cmd('mute') },
          ],
        },
        {
          label: 'Subtitles',
          submenu: [
            { label: 'Show / Hide Subtitles', ...key('S'), click: cmd('toggle-subs') },
            { label: 'Next Subtitle Track', ...key('V'), click: cmd('cycle-subs') },
            { type: 'separator' },
            { label: 'Delay −100 ms', ...key('G'), click: cmd('delay-down') },
            { label: 'Delay +100 ms', ...key('H'), click: cmd('delay-up') },
            { label: 'Reset Delay', click: cmd('delay-reset') },
            { type: 'separator' },
            { label: 'Bigger Text', ...key('Plus'), click: cmd('font-up') },
            { label: 'Smaller Text', ...key('-'), click: cmd('font-down') },
          ],
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Library', accelerator: 'CmdOrCtrl+L', click: cmd('show-library') },
        { label: 'Transcript', ...key('T'), click: cmd('toggle-transcript') },
        { label: 'Playlist', ...key('P'), click: cmd('toggle-playlist') },
        { type: 'separator' },
        { label: 'Toggle Full Screen', accelerator: isMac ? 'Ctrl+Cmd+F' : 'F11', click: cmd('toggle-fullscreen') },
        ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }]),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: cmd('show-shortcuts') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
