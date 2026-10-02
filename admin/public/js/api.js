let onUnauthorized = () => {};
export const setUnauthorizedHandler = fn => { onUnauthorized = fn; };

async function request(method, path, body, extra = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'x-admin': '1',
      ...(body !== undefined && !extra.raw ? { 'content-type': 'application/json' } : {}),
      ...(extra.headers || {}),
    },
    body: body === undefined ? undefined : (extra.raw ? body : JSON.stringify(body)),
  });
  if (res.status === 401) {
    onUnauthorized();
    throw new Error('нужен вход');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

export const api = {
  get: path => request('GET', path),
  post: (path, body) => request('POST', path, body ?? {}),
  patch: (path, body) => request('PATCH', path, body),
  put: (path, body) => request('PUT', path, body),
  del: path => request('DELETE', path),

  login: (login, password) => request('POST', '/api/login', { login, password }),
  logout: () => request('POST', '/api/logout', {}),

  uploadThumb(key, blob) {
    return request('POST', `/api/media/${encodeURIComponent(key)}/thumb`, blob, { raw: true, headers: { 'content-type': 'image/jpeg' } });
  },

  upload(file, { key, kind }) {
    const query = new URLSearchParams({ key, kind, filename: file.name, mime: file.type || 'application/octet-stream' });
    return request('POST', `/api/media?${query}`, file, { raw: true, headers: { 'content-type': file.type || 'application/octet-stream' } });
  },
};
