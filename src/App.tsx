import { Routes, Route, Navigate } from 'react-router';
import { Toaster } from 'sonner';
import Softphone from './pages/Softphone';
import LiveAnalysis from './pages/LiveAnalysis';
import Contacts from './pages/Contacts';
import CallHistory from './pages/CallHistory';
import AdminDashboard from './pages/AdminDashboard';
import AdminAgents from './pages/AdminAgents';
import AdminLogs from './pages/AdminLogs';
import AdminSettings from './pages/AdminSettings';
import AdminVerification from './pages/AdminVerification';

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<Navigate to="/app" replace />} />
        <Route path="/app" element={<Softphone />} />
        <Route path="/app/live-analysis/:sessionId?" element={<LiveAnalysis />} />
        <Route path="/app/contacts" element={<Contacts />} />
        <Route path="/app/history" element={<CallHistory />} />
        <Route path="/admin" element={<AdminDashboard />} />
        <Route path="/admin/agents" element={<AdminAgents />} />
        <Route path="/admin/logs" element={<AdminLogs />} />
        <Route path="/admin/settings" element={<AdminSettings />} />
        <Route path="/admin/verification" element={<AdminVerification />} />
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Routes>
      <Toaster theme="dark" position="top-right" richColors={false} />
    </>
  );
}
