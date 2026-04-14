let _token = null;

export const setApiToken = (t) => { _token = t; };
export const getApiToken = () => _token;

export function apiFetch(url, opts = {}) {
  const headers = { ...opts.headers };
  if (_token) headers['Authorization'] = `Bearer ${_token}`;
  return fetch(url, { ...opts, headers });
}
