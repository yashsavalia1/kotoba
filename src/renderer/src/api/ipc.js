const bridge = () => {
  if (!window.kotoba) throw new Error('Kotoba bridge missing: run inside the desktop app');
  return window.kotoba;
};

export const invoke = (channel, ...args) => bridge().invoke(channel, ...args);
export const on = (event, callback) => bridge().on(event, callback);
export const pathForFile = (file) => bridge().pathForFile(file);
