// api.js — talks to the Apps Script backend.
//
// Every call is a POST with Content-Type text/plain (a "simple request",
// so the browser skips the CORS preflight that Apps Script cannot answer)
// whose body is one JSON string: { token, action, ...params }.

const LS_URL = 'fieldrep.apiUrl';
const LS_TOKEN = 'fieldrep.apiToken';

export function getCreds() {
  return {
    url: localStorage.getItem(LS_URL) || '',
    token: localStorage.getItem(LS_TOKEN) || '',
  };
}

export function saveCreds(url, token) {
  localStorage.setItem(LS_URL, url.trim());
  localStorage.setItem(LS_TOKEN, token.trim());
}

export function hasCreds() {
  const c = getCreds();
  return !!(c.url && c.token);
}

export function clearCreds() {
  localStorage.removeItem(LS_URL);
  localStorage.removeItem(LS_TOKEN);
}

export class ApiError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind; // 'network' | 'auth' | 'server'
  }
}

export async function api(action, params = {}) {
  const { url, token } = getCreds();
  if (!url || !token) throw new ApiError('App is not connected yet', 'auth');

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token, action, ...params }),
      redirect: 'follow', // Apps Script answers via a 302 to googleusercontent.com
    });
  } catch (err) {
    throw new ApiError('No connection to the server (are you offline?)', 'network');
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new ApiError('Unexpected reply from the server (HTTP ' + res.status + ')', 'server');
  }
  if (!data.ok) {
    throw new ApiError(data.error || 'Request failed',
      data.error === 'unauthorized' ? 'auth' : 'server');
  }
  return data;
}

// Convenience wrappers used by the views.
export const createRow = (table, row) => api('create', { table, row });
export const updateRow = (table, row) => api('update', { table, row });
export const softDelete = (table, id) => api('softDelete', { table, id });
