import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { syncPushSubscription } from './push';
import { UnreadProvider, useUnread } from './context/UnreadContext';
import ProtectedRoute from './components/ProtectedRoute';
import ErrorBoundary from './components/ErrorBoundary';
import AppShell from './components/AppShell';
import Login from './pages/Login';
import Home from './pages/Home';
import Records from './pages/Records';
import Emergencies from './pages/Emergencies';
import Messages from './pages/Messages';
import MessageDetail from './pages/MessageDetail';
import MessageThreadDetail from './pages/MessageThreadDetail';
import GroupDetail from './pages/GroupDetail';
import Events from './pages/Events';
import Settings from './pages/Settings';
import Projects from './pages/Projects';
import ProjectDetail from './pages/ProjectDetail';
import Appointments from './pages/Appointments';

function RootRedirect() {
  const { user, loading } = useAuth();
  if (loading) return null;
  return <Navigate to={user ? '/home' : '/login'} replace />;
}

// One provider owns the counts for the whole signed-in app; the shell renders
// them and each screen refreshes them after an action. No screen reports a
// count upward, so no screen can leave the badge stale when it unmounts.
function ShellRoutes() {
  const { messages, emergencies } = useUnread();

  return (
    <AppShell openEmergencyCount={emergencies} openMessageCount={messages}>
      <Routes>
        <Route path="/home" element={<Home />} />
        <Route path="/records" element={<Records />} />
        <Route path="/emergencies" element={<Emergencies />} />
        <Route path="/messages" element={<Messages />} />
        <Route path="/messages/thread/:threadKey" element={<MessageThreadDetail />} />
        <Route path="/messages/:id" element={<MessageDetail />} />
        <Route path="/appointments" element={<Appointments />} />
        {/* Where a group update points: the group's live membership, read from
            the group's own records rather than from the message that announced
            the change. Not a tab of its own: the pastor reaches it from the
            update, which is the only way they learn the group's name. */}
        <Route path="/groups/:id" element={<GroupDetail />} />
        <Route path="/events" element={<Events />} />
        {/* Read-only progress on the church's special projects. */}
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>
    </AppShell>
  );
}

function AuthenticatedShell() {
  // Every signed-in start re-asserts this device's push subscription if the
  // pastor has already granted permission. A subscription can go stale (a shared
  // device, or the server pruning an endpoint the push service dropped) and then
  // every alert is lost silently; this closes that hole without a prompt and
  // without the pastor having to notice anything.
  useEffect(() => {
    syncPushSubscription();
  }, []);

  return (
    <UnreadProvider>
      <ShellRoutes />
    </UnreadProvider>
  );
}

function Router() {
  return (
    <ErrorBoundary
      title="Something went wrong"
      message="The page hit an unexpected error. Reloading usually fixes it: your data is safe."
      reloadLabel="Reload"
    >
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/*"
          element={
            <ProtectedRoute>
              <AuthenticatedShell />
            </ProtectedRoute>
          }
        />
        <Route path="/" element={<RootRedirect />} />
      </Routes>
    </BrowserRouter>
    </ErrorBoundary>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Router />
    </AuthProvider>
  );
}
