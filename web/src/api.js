async function call(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
  if (body.error) throw new Error(body.error);
  return body;
}

const post = (url, data) =>
  call(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });

export const getStatus = () => call('/api/status');
export const getLibrary = () => call('/api/library');
export const getMedia = (id) => call(`/api/media/${id}`);
export const prepare = (id) => post(`/api/media/${id}/prepare`, {});
export const getSubs = (id, track) => call(`/api/media/${id}/subs?track=${track}`);
export const lookupWord = (word) => post('/api/lookup', { word });
export const previewCards = (body) => post('/api/cards/preview', body);
export const createCards = (body) => post('/api/cards', body);
export const ankiSetup = () => post('/api/anki/setup', {});
export const getMined = (word) => call(`/api/mined/${encodeURIComponent(word)}`);
