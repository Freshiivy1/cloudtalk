import { Routes, Route, Navigate } from 'react-router';
import { Toaster } from 'sonner';
import RequireAuth from './components/RequireAuth';
import Softphone from './pages/Softphone';
import Contacts from './pages/Contacts';
import CallHistory from './pages/CallHistory';
import AdminDashboard from './pages/AdminDashboard';
import AdminAgents from './pages/AdminAgents';
import AdminLogs from './pages/AdminLogs';
import AdminSettings from './pages/AdminSettings';
import AdminVerification from './pages/AdminVerification';
import Login from './pages/Login';

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<Navigate to="/app" replace />} />
        <Route path="/app" element={<RequireAuth><Softphone /></RequireAuth>} />
        <Route path="/app/contacts" element={<RequireAuth><Contacts /></RequireAuth>} />
        <Route path="/app/history" element={<RequireAuth><CallHistory /></RequireAuth>} />
        <Route path="/admin" element={<RequireAuth requireAdmin><AdminDashboard /></RequireAuth>} />
        <Route path="/admin/agents" element={<RequireAuth requireAdmin><AdminAgents /></RequireAuth>} />
        <Route path="/admin/logs" element={<RequireAuth requireAdmin><AdminLogs /></RequireAuth>} />
        <Route path="/admin/settings" element={<RequireAuth requireAdmin><AdminSettings /></RequireAuth>} />
        <Route path="/admin/verification" element={<RequireAuth requireAdmin><AdminVerification /></RequireAuth>} />
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Routes>
      <Toaster theme="dark" position="top-right" richColors={false} />
    </>
  );
}
