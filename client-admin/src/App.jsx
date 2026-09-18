import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import ErrorBoundary from './components/ErrorBoundary';
import Login from './pages/Login';
import ReceptionistDashboard from './pages/ReceptionistDashboard';
import AdminDashboard from './pages/AdminDashboard';
import Emergencies from './pages/Emergencies';
import Reports from './pages/Reports';
import Settings from './pages/Settings';
import ServiceTypes from './pages/ServiceTypes';
import Members from './pages/Members';
import MemberDetails from './pages/MemberDetails';
import Groups from './pages/Groups';
import GroupDetail from './pages/GroupDetail';
import Centers from './pages/Centers';
import CenterDetails from './pages/CenterDetails';
import Events from './pages/Events';
import Messages from './pages/Messages';
import Projects from './pages/Projects';
import ProjectDetail from './pages/ProjectDetail';
import Receipts from './pages/Receipts';
import Reconciliation from './pages/Reconciliation';

const HOME_BY_ROLE = { receptionist: '/receptionist', admin: '/admin', superadmin: '/admin' };

function RootRedirect() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={HOME_BY_ROLE[user.role] || '/login'} replace />;
}

function Router() {
  return (
    <ErrorBoundary
      title="Something went wrong"
      message="The page hit an unexpected error. Reloading usually fixes it, and your data is safe."
      reloadLabel="Reload"
    >
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/receptionist"
            element={
              <ProtectedRoute roles={['receptionist', 'admin', 'superadmin']}>
                <ReceptionistDashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <ProtectedRoute roles={['admin', 'superadmin']}>
                <AdminDashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/emergencies"
            element={
              <ProtectedRoute roles={['receptionist', 'admin', 'superadmin']}>
                <Emergencies />
              </ProtectedRoute>
            }
          />
          <Route
            path="/reports"
            element={
              <ProtectedRoute roles={['receptionist', 'admin', 'superadmin']}>
                <Reports />
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute roles={['admin', 'superadmin']}>
                <Settings />
              </ProtectedRoute>
            }
          />
          <Route
            path="/service-types"
            element={
              <ProtectedRoute roles={['admin', 'superadmin']}>
                <ServiceTypes />
              </ProtectedRoute>
            }
          />
          <Route
            path="/members"
            element={
              // The front desk registers members, so the directory is theirs to
              // read and edit. The destructive half stays admin-only: the API
              // refuses a receptionist's delete and any status change, and the
              // page hides both controls to match.
              <ProtectedRoute roles={['receptionist', 'admin', 'superadmin']}>
                <Members />
              </ProtectedRoute>
            }
          />
          <Route
            path="/members/:id"
            element={
              <ProtectedRoute roles={['receptionist', 'admin', 'superadmin']}>
                <MemberDetails />
              </ProtectedRoute>
            }
          />
          <Route
            path="/groups"
            element={
              // The front desk manages small groups too: same section as an admin.
              <ProtectedRoute roles={['receptionist', 'admin', 'superadmin']}>
                <Groups />
              </ProtectedRoute>
            }
          />
          <Route
            path="/groups/:id"
            element={
              // Same reach as the list: the front desk reads a group's roster.
              <ProtectedRoute roles={['receptionist', 'admin', 'superadmin']}>
                <GroupDetail />
              </ProtectedRoute>
            }
          />
          <Route
            path="/centers/:id"
            element={
              <ProtectedRoute roles={['receptionist', 'admin', 'superadmin']}>
                <CenterDetails />
              </ProtectedRoute>
            }
          />
          <Route
            path="/centers"
            element={
              // Receptionists use this page to register members at a center;
              // center/zone management itself stays admin-only (gated in the page).
              <ProtectedRoute roles={['receptionist', 'admin', 'superadmin']}>
                <Centers />
              </ProtectedRoute>
            }
          />
          <Route
            path="/projects"
            element={
              <ProtectedRoute roles={['admin', 'superadmin']}>
                <Projects />
              </ProtectedRoute>
            }
          />
          <Route
            path="/projects/:id"
            element={
              <ProtectedRoute roles={['admin', 'superadmin']}>
                <ProjectDetail />
              </ProtectedRoute>
            }
          />
          <Route
            path="/events"
            element={
              <ProtectedRoute roles={['admin', 'superadmin']}>
                <Events />
              </ProtectedRoute>
            }
          />
          <Route
            path="/messages"
            element={
              <ProtectedRoute roles={['receptionist', 'admin', 'superadmin']}>
                <Messages />
              </ProtectedRoute>
            }
          />
          <Route
            path="/reconciliation"
            element={
              // Incoming payments carry payer names and phone numbers, so this is
              // an administrator's screen, never the front desk's.
              <ProtectedRoute roles={['admin', 'superadmin']}>
                <Reconciliation />
              </ProtectedRoute>
            }
          />
          <Route
            path="/receipts"
            element={
              // Receipt verification management is an admin function: the front
              // desk prints receipts but never revokes or audits one.
              <ProtectedRoute roles={['admin', 'superadmin']}>
                <Receipts />
              </ProtectedRoute>
            }
          />
          <Route path="/" element={<RootRedirect />} />
          <Route path="*" element={<RootRedirect />} />
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
