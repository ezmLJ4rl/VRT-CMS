import axios from 'axios';

const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || '/api' });

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
      localStorage.removeItem('vrt_token');
      localStorage.removeItem('vrt_user');
      // Flag the expiry so the login screen can explain WHY the user is there
      // ("session expired") instead of showing a bare login form.
      localStorage.setItem('vrt_session_expired', '1');
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

export function apiErrorMessage(err, fallback) {
  return err?.response?.data?.error || fallback || 'Something went wrong. Please try again.';
}

export default api;
