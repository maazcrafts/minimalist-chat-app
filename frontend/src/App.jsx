import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import AuthPage from './components/AuthPage';
import ChatDashboard from './components/ChatDashboard';
import AdminDashboard from './components/AdminDashboard';
import MaintenancePage from './components/MaintenancePage';

const KEEP_ALIVE_URL = 'https://minimalist-chat-app.onrender.com/health';
const KEEP_ALIVE_INTERVAL_MS = 10 * 60 * 1000;

function App() {
  const [user, setUser] = useState(null);
  const [publicSettings, setPublicSettings] = useState(null);

  useEffect(() => {
    const savedUser = localStorage.getItem('chat_user');
    if (savedUser) {
      const parsed = JSON.parse(savedUser);
      setUser(parsed);
    }
  }, []);

  useEffect(() => {
    if (user?.token) {
      axios.defaults.headers.common['Authorization'] = `Bearer ${user.token}`;
    } else {
      delete axios.defaults.headers.common['Authorization'];
    }
  }, [user]);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await axios.get('https://minimalist-chat-app.onrender.com/api/settings/public');
        setPublicSettings(res.data);
      } catch (_) {}
    };
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    // Keep Render free tier awake (best-effort ping)
    let timer;
    const ping = () => {
      try {
        // no-cors so it won't be blocked by missing CORS headers
        fetch(KEEP_ALIVE_URL, { mode: 'no-cors', cache: 'no-store' }).catch(() => {});
      } catch (_) {}
    };

    ping();
    timer = setInterval(ping, KEEP_ALIVE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const isAdmin = user?.username === 'maaz_khan' || user?.role === 'admin';
  const maintenanceMode = !!publicSettings?.maintenance_mode;

  return (
    <Router>
      <Routes>
        <Route 
          path="/" 
          element={
            maintenanceMode && !isAdmin
              ? <MaintenancePage message={publicSettings?.welcome_message} />
              : (user ? <Navigate to="/chat" /> : <AuthPage setUser={setUser} publicSettings={publicSettings} />)
          } 
        />
        <Route 
          path="/chat" 
          element={
            maintenanceMode && !isAdmin
              ? <MaintenancePage message={publicSettings?.welcome_message} />
              : (user ? <ChatDashboard user={user} setUser={setUser} /> : <Navigate to="/" />)
          } 
        />
        <Route
          path="/admin"
          element={
            maintenanceMode && !isAdmin
              ? <MaintenancePage message={publicSettings?.welcome_message} />
              : (user ? <AdminDashboard user={user} /> : <Navigate to="/" />)
          }
        />
      </Routes>
    </Router>
  );
}

export default App;
