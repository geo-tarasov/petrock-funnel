// Единственная дверь к данным: админка ходит на RU API своим токеном.
// Браузер этот токен не видит — только cookie сессии.

const API_URL = (process.env.API_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.API_TOKEN || '';

if (!API_URL || !API_TOKEN) throw new Error('API_URL and API_TOKEN are required');

export async function callApi(method, path, { json, body, contentType, actor, timeout = 30000 } = {}) {
  const headers = { authorization: `Bearer ${API_TOKEN}` };
  if (json !== undefined) headers['content-type'] = 'application/json';
  if (contentType) headers['content-type'] = contentType;
  if (actor) {
    headers['x-actor-id'] = String(actor.id);
    headers['x-actor-login'] = actor.login;
  }
  return fetch(API_URL + path, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : body,
    signal: AbortSignal.timeout(timeout),
  });
}

// Прокидывает ответ RU API в браузер как есть, сохраняя коды ошибок.
export async function passthrough(res, method, path, options) {
  const upstream = await callApi(method, path, options);
  const text = await upstream.text();
  res.status(upstream.status);
  res.type(upstream.headers.get('content-type') || 'application/json');
  res.send(text);
}

export async function fetchJson(method, path, options) {
  const res = await callApi(method, path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `API ${method} ${path} -> ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}
