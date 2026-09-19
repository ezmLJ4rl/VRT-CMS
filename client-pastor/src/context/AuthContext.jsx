import { createContext, useContext, useEffect, useState } from 'react';
import api from '../api';
import { setLanguage } from '../i18n';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const stored = localStorage.getItem('vrt_user');
    return stored ? JSON.parse(stored) : null;
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('vrt_token');
    if (!token) {
      setLoading(false);
      return;
    }
    api
      .get('/auth/me')
      .then(({ data }) => {
        setUser(data.user);
        localStorage.setItem('vrt_user', JSON.stringify(data.user));
        if (data.user.language_pref) setLanguage(data.user.language_pref);
      })
      .catch((err) => {
        if (err.response?.status === 401) {
          localStorage.removeItem('vrt_token');
          localStorage.removeItem('vrt_user');
          setUser(null);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  function login(token, userObj) {
    localStorage.setItem('vrt_token', token);
    localStorage.setItem('vrt_user', JSON.stringify(userObj));
    setUser(userObj);
    if (userObj.language_pref) setLanguage(userObj.language_pref);
  }

  /**
   * Ends THIS device's session on the server, then clears the local copy.
   * Other signed-in devices are unaffected: the server revokes exactly the
   * session that made the request (see server/routes/auth.js). Network errors
   * still clear the local token — the device cannot stay signed in on a
   * credential it cannot present — and the response is marked so the api
   * interceptor does not double-handle the 401 as an expiry.
   */
  async function logout() {
    try {
      await api.post('/auth/logout', null, { headers: { 'X-Skip-Auth-Redirect': '1' } });
    } catch {
      // The session is cleared locally regardless; a server that cannot be
      // reached will expire the row naturally.
    }
    localStorage.removeItem('vrt_token');
    localStorage.removeItem('vrt_user');
    setUser(null);
  }

  return <AuthContext.Provider value={{ user, setUser, login, logout, loading }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
