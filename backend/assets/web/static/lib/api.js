export function redirectToLogin() {
  if (window.location.pathname !== '/login') {
    window.location.assign('/login');
  }
}

export function csrfToken() {
  const meta = document.querySelector('meta[name="csrf-token"]');
  return meta ? (meta.getAttribute('content') || '') : '';
}

export function fetchJson(url, options) {
  const opts = options || {};
  const method = (opts.method || 'GET').toUpperCase();
  const headers = { 'Accept': 'application/json' };
  if (opts.headers) {
    for (const key in opts.headers) {
      if (Object.prototype.hasOwnProperty.call(opts.headers, key)) {
        headers[key] = opts.headers[key];
      }
    }
  }
  if (method !== 'GET' && method !== 'HEAD') {
    const token = csrfToken();
    if (token) { headers['X-CSRF-Token'] = token; }
    if (typeof opts.body === 'string') {
      headers['Content-Type'] = 'application/json';
    }
  }
  const base = {
    credentials: 'same-origin',
    headers: headers,
  };
  if (opts.method) { base.method = opts.method; }
  if (opts.body !== undefined) { base.body = opts.body; }

  return fetch(url, base).then(function (response) {
    if (response.status === 401) {
      redirectToLogin();
      return null;
    }
    if (!response.ok) {
      return response.json().catch(function () { return null; }).then(function (payload) {
        const detail = payload && (payload.error || payload.detail || payload.message);
        fetchJson.lastError = detail ? String(detail) : '';
        return null;
      });
    }
    fetchJson.lastError = '';
    const contentType = response.headers.get('content-type') || '';
    if (contentType.indexOf('application/json') === -1) {
      return null;
    }
    return response.json();
  });
}

fetchJson.lastError = '';
