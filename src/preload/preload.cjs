const { contextBridge, ipcRenderer, webUtils } = require('electron');

const CHANNEL = /^[a-z]+:[A-Za-z]+$/;
const EVENT = /^evt:[a-z-]+$/;

contextBridge.exposeInMainWorld('kotoba', {
  async invoke(channel, ...args) {
    if (!CHANNEL.test(channel)) throw new Error(`bad channel: ${channel}`);
    const res = await ipcRenderer.invoke(channel, ...args);
    if (!res?.ok) throw new Error(res?.error ?? 'IPC failed');
    return res.value;
  },
  on(event, callback) {
    if (!EVENT.test(event)) throw new Error(`bad event: ${event}`);
    const listener = (_e, payload) => callback(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  platform: process.platform,
});
