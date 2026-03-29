import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import AuthPage from './components/AuthPage';
import ChatDashboard from './components/ChatDashboard';

const KEEP_ALIVE_URL = 'https://minimalist-chat-app.onrender.com';
const KEEP_ALIVE_INTERVAL_MS = 10 * 60 * 1000;

function App() {
  const [user, setUser] = useState(null);

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

  return (
    <Router>
      <Routes>
        <Route 
          path="/" 
          element={user ? <Navigate to="/chat" /> : <AuthPage setUser={setUser} />} 
        />
        <Route 
          path="/chat" 
          element={user ? <ChatDashboard user={user} setUser={setUser} /> : <Navigate to="/" />} 
        />
      </Routes>
    </Router>
  );
}

export default App;
