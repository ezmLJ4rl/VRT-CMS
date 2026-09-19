import axios from 'axios';

// In development the Vite dev server proxies /api to the backend (see vite.config.js).
// In production, set VITE_API_URL to the deployed API's base URL (e.g. https://api.yourchurch.org/api).
const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || '/api' });

// The app is deployed under a sub-path (/admin/) when served by the API server,
// so full-page navigations must respect Vite's base: a hard-coded /login would
// land on the Pastor PWA, which owns the root path in that setup.
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');

// A request carrying the `X-Skip-Auth-Redirect` header (the deliberate
// logout) is the CLIENT signing itself out, so a 401 answer to it is expected
// and must not be re-handled as an expired session. A header, not a custom
// config field, because axios guarantees headers survive onto err.config.
const SKIP_AUTH_REDIRECT_HEADER = 'X-Skip-Auth-Redirect';

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('vrt_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  // Ask the API to answer in the language the app is currently showing, so
  // server-side messages (validation errors, refusals) arrive translated rather
  // than always in English. Read per request, so switching language applies to
  // the very next call.
  const language = localStorage.getItem('vrt_language');
  if (language) config.headers['X-Language'] = language;
  return config;
});

api.interceptors.response.use(
  (res) => {
    // Sessions renew as they are used: the API re-issues the token once it is
    // past half its life and returns it in this header, so an active user is
    // never signed out mid-work (see server/utils/token.js).
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
        const loginPath = `${BASE}/login`;
        if (window.location.pathname !== loginPath) {
          window.location.href = loginPath;
        }
      }
    }
    return Promise.reject(err);
  }
);

export function apiErrorMessage(err, fallback) {
  return err?.response?.data?.error || fallback || 'Something went wrong. Please try again.';
}

// Base URL for direct resource links (receipt PDFs/print views).
export const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '') || '/api';

export default api;
