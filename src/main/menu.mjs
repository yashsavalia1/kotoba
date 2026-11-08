import { app, Menu } from 'electron';
import { openMediaDialog } from './files.mjs';

const isMac = process.platform === 'darwin';

export function buildMenu(ctx) {
  const cmd = (command) => () => ctx.send('evt:command', command);
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open File…', accelerator: 'CmdOrCtrl+O', click: () => openMediaDialog(ctx) },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => openMediaDialog(ctx, { folders: true }) },
        { role: 'recentDocuments', submenu: [{ role: 'clearRecentDocuments' }] },
        { type: 'separator' },
        { label: 'Add Subtitle File…', click: cmd('attach-subtitle') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Playback',
      submenu: [
        { label: 'Play / Pause', click: cmd('toggle-play') },
        { label: 'Previous Line', click: cmd('prev-line') },
        { label: 'Next Line', click: cmd('next-line') },
        { label: 'Replay Line', click: cmd('replay-line') },
        { type: 'separator' },
        { label: 'Previous File', accelerator: 'CmdOrCtrl+Left', click: cmd('prev-file') },
        { label: 'Next File', accelerator: 'CmdOrCtrl+Right', click: cmd('next-file') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Library', accelerator: 'CmdOrCtrl+L', click: cmd('show-library') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }]),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
