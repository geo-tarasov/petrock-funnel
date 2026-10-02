import { config } from './config.js';

async function call(method, path, body) {
  const res = await fetch(config.apiUrl + path, {
    method,
    headers: {
      authorization: `Bearer ${config.apiToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`API ${method} ${path} -> ${res.status} ${data.error || ''}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  start: payload => call('POST', '/users/start', payload),
  user: id => call('GET', `/users/${id}`).then(r => r.user),
  userByTg: tgId => call('GET', `/users/by-tg/${tgId}`).then(r => r.user).catch(err => {
    if (err.status === 404) return null;
    throw err;
  }),
  userByToken: token => call('GET', `/users/by-token/${encodeURIComponent(token)}`).then(r => r.user),
  mark: (id, what, data) => call('POST', `/users/${id}/mark`, { what, data }),
  payment: payload => call('POST', '/payments', payload).then(r => r.users),
  event: (userId, type, data) => call('POST', '/events', { user_id: userId, type, data }),
  schedule: (userId, step, delaySec) => call('POST', '/jobs', { user_id: userId, step, delay_sec: delaySec }),
  cancel: (userId, steps) => call('POST', '/jobs/cancel', { user_id: userId, steps }),
  claim: limit => call('POST', '/jobs/claim', { limit }).then(r => r.jobs),
  done: id => call('POST', `/jobs/${id}/done`),
  fail: (id, error, retryInSec) => call('POST', `/jobs/${id}/fail`, { error, retry_in_sec: retryInSec }),
  stats: () => call('GET', '/stats'),
  resetByTg: tgId => call('DELETE', `/users/by-tg/${tgId}`),

  // Воронка и медиа лежат в базе на RU — бот читает их отсюда.
  config: () => call('GET', '/config'),
  broadcastClaim: limit => call('POST', '/broadcasts/claim', { limit }),
  broadcastResults: results => call('POST', '/broadcasts/targets/result', { results }),

  async mediaThumb(key) {
    const res = await fetch(`${config.apiUrl}/media/${encodeURIComponent(key)}/thumb`, {
      headers: { authorization: `Bearer ${config.apiToken}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`thumb ${key} -> ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  },

  async mediaFile(key) {
    const res = await fetch(`${config.apiUrl}/media/${encodeURIComponent(key)}/file`, {
      headers: { authorization: `Bearer ${config.apiToken}` },
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`media ${key} -> ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  },
};
