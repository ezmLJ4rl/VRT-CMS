import axios from 'axios';

// Vite dev proxies /api, but its preview server does not reliably do so
// across older Vite versions. Point local production previews directly at the
// local API; deployed builds still use VITE_API_URL (or same-origin /api).
const isLocalPreview = ['localhost', '127.0.0.1'].includes(window.location.hostname)
  && ['4173', '4174'].includes(window.location.port);
const apiBase = import.meta.env.VITE_API_URL || (isLocalPreview ? 'http://localhost:4000/api' : '/api');
const api = axios.create({ baseURL: apiBase });

// Request config fields the interceptors own. A request carrying
// `_skipAuthRedirect` (the deliberate logout) must never leak onto the wire.
// A request carrying the `X-Skip-Auth-Redirect` header (the deliberate
// logout) is the CLIENT signing itself out, so a 401 answer to it is expected
// and must not be re-handled as an expired session. A header, not a custom
// config field, because axios guarantees headers survive onto err.config.
const SKIP_AUTH_REDIRECT_HEADER = 'X-Skip-Auth-Redirect';

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('vrt_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  // Server-side messages (validation errors, refusals) come back in the language
  // the app is showing, not always English. Read per request so a language
  // switch applies immediately.
  const language = localStorage.getItem('vrt_language');
  if (language) config.headers['X-Language'] = language;
  return config;
});

api.interceptors.response.use(
  (res) => {
    // Sliding renewal: the API re-issues the token once it is past half its life
    // and returns it here, so the pastor PWA is not signed out between visits.
    const renewed = res.headers?.['x-refreshed-token'];
    if (renewed) localStorage.setItem('vrt_token', renewed);
    return res;
  },
  (err) => {
    if (err.response?.status === 401) {
      // A deliberate logout clears its own token; a 401 from the API itself is
      // an expired/revoked session and clears the credential + explains why.
      const skipRedirect = !!err.config?.headers?.[SKIP_AUTH_REDIRECT_HEADER];
      if (!skipRedirect) {
        localStorage.removeItem('vrt_token');
        localStorage.removeItem('vrt_user');
        // Flag the expiry so the login screen can explain WHY the user is there
        // ("session expired") instead of showing a bare login form.
        localStorage.setItem('vrt_session_expired', '1');
        if (!window.location.pathname.startsWith('/login')) {
          window.location.href = '/login';
        }
      }
    }
    return Promise.reject(err);
  }
);

export function apiErrorMessage(err, fallback) {
  return err?.response?.data?.error || fallback || 'Something went wrong. Please try again.';
}

export default api;
