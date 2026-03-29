import React, { useState } from 'react';
import axios from 'axios';

const API_URL = 'https://minimalist-chat-app.onrender.com/api/auth';

const AuthPage = ({ setUser, publicSettings }) => {
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const inviteOnly = !!publicSettings?.invite_only;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    
    try {
      const endpoint = isLogin ? '/login' : '/register';
      const res = await axios.post(`${API_URL}${endpoint}`, { username, password });
      
      localStorage.setItem('chat_user', JSON.stringify(res.data));
      axios.defaults.headers.common['Authorization'] = `Bearer ${res.data.token}`;
      setUser(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'An error occurred. Please try again.');
    }
  };

  return (
    <div className="app-container">
      <div className="auth-card">
        <div className="auth-header">
          <h1>[MaazX]</h1>
          <p>{publicSettings?.welcome_message || (isLogin ? 'Welcome Back - Sign in to connect' : 'Create Account - Sign up to chat')}</p>
        </div>

        {error && <div className="error-text">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Username</label>
            <input 
              type="text" 
              className="form-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter your username"
              required
            />
          </div>
          
          <div className="form-group">
            <label>Password</label>
            <input 
              type="password" 
              className="form-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              required
            />
          </div>

          <button type="submit" className="btn-primary">
            {isLogin ? 'Sign In' : 'Sign Up'}
          </button>
        </form>

        <div className="auth-switch">
          {isLogin ? "Don't have an account? " : "Already have an account? "}
          <span onClick={() => { setIsLogin(!isLogin); setError(''); setUsername(''); setPassword(''); }}>
            {isLogin ? 'Sign Up' : 'Sign In'}
          </span>
        </div>
        {!isLogin && inviteOnly && (
          <div className="error-text" style={{ marginTop: 12 }}>
            Registrations are currently invite-only.
          </div>
        )}
        <div style={{ marginTop: '30px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>
          Created by Maaz
        </div>
      </div>
    </div>
  );
};

export default AuthPage;
