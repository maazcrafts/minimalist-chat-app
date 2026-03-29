import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import { Send, UserPlus, LogOut, Users, Image as ImageIcon, X, Check, CheckCheck, CheckCircle, XCircle, ArrowLeft, Mic } from 'lucide-react';

const API_URL = 'https://minimalist-chat-app.onrender.com/api';
const ORIGIN_URL = 'https://minimalist-chat-app.onrender.com';
let socket;

const ChatDashboard = ({ user, setUser }) => {
  const [contacts, setContacts] = useState([]);
  const [groups, setGroups] = useState([]);
  const [friendRequests, setFriendRequests] = useState([]);
  const [activeChat, setActiveChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [addFriendUsername, setAddFriendUsername] = useState('');
  
  // Voice Recording
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  // Group Modal
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [selectedContacts, setSelectedContacts] = useState([]);

  // Notifications
  const [unreadCounts, setUnreadCounts] = useState({});
  const activeChatRef = useRef(null);

  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const fileInputRef = useRef(null);
  const isAtBottomRef = useRef(true);

  useEffect(() => {
    activeChatRef.current = activeChat;
    if (activeChat) {
      setUnreadCounts(prev => {
        const key = activeChat.is_group ? `group_${activeChat.id}` : `user_${activeChat.id}`;
        if (!prev[key]) return prev;
        const newCounts = { ...prev };
        delete newCounts[key];
        return newCounts;
      });
    }
  }, [activeChat]);

  useEffect(() => {
    if (Notification.permission === 'default') {
      Notification.requestPermission();
    }

    // Load cached lists immediately (prevents empty sidebar on reload)
    try {
      const cachedContacts = localStorage.getItem(`chat_contacts_${user.id}`);
      const cachedGroups = localStorage.getItem(`chat_groups_${user.id}`);
      if (cachedContacts) setContacts(JSON.parse(cachedContacts));
      if (cachedGroups) setGroups(JSON.parse(cachedGroups));
    } catch (_) {}

    fetchContacts();
    fetchGroups();
    fetchRequests();

    socket = io(ORIGIN_URL);
    socket.emit('join', user.id);

    socket.on('receive_message', (msgObj) => {
      const isCurrentChat = activeChatRef.current && (
        (msgObj.group_id && activeChatRef.current.is_group && activeChatRef.current.id === msgObj.group_id) ||
        (!msgObj.group_id && !activeChatRef.current?.is_group && 
          (activeChatRef.current.id === msgObj.sender_id || activeChatRef.current.id === msgObj.receiver_id))
      );

      if (isCurrentChat) {
        setMessages((prev) => [...prev, msgObj]);
        if (!msgObj.group_id && socket) {
           socket.emit('mark_read', { userId: user.id, friendId: msgObj.sender_id });
        }
      } else {
        const title = msgObj.group_id ? `New message in Group` : `New message from ${msgObj.sender_username || 'Friend'}`;
        if (Notification.permission === 'granted') {
          new Notification(title, { body: msgObj.type === 'image' ? '[Image]' : (msgObj.type === 'audio' ? '[Voice Message]' : msgObj.content) });
        }
        
        const key = msgObj.group_id ? `group_${msgObj.group_id}` : `user_${msgObj.sender_id}`;
        setUnreadCounts(prev => ({ ...prev, [key]: (prev[key] || 0) + 1 }));
      }
    });

    socket.on('message_sent', (msgObj) => {
      if (!msgObj.group_id && activeChatRef.current && !activeChatRef.current.is_group && activeChatRef.current.id === msgObj.receiver_id) {
        setMessages((prev) => [...prev, msgObj]);
      }
    });

    socket.on('new_friend_request', () => { fetchRequests(); });
    socket.on('friend_request_accepted', () => { fetchContacts(); });
    socket.on('messages_read', (data) => {
      setMessages((prev) => prev.map(m => 
        (m.receiver_id === user.id || m.sender_id === user.id) ? { ...m, status: 'seen' } : m
      ));
    });

    return () => {
      socket.disconnect();
    };
  }, [user.id]);

  useEffect(() => {
    if (activeChat) {
      fetchMessages(activeChat);
      if (!activeChat.is_group) {
        setTimeout(() => {
          if (socket) socket.emit('mark_read', { userId: user.id, friendId: activeChat.id });
        }, 300);
      }
    }
  }, [activeChat]);

  useEffect(() => {
    // Auto-scroll only if user is already near bottom (don't steal scroll when browsing history)
    if (!isAtBottomRef.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages]);

  const fetchContacts = async () => {
    try {
      const res = await axios.get(`${API_URL}/contacts/${user.id}`);
      setContacts(res.data);
      try { localStorage.setItem(`chat_contacts_${user.id}`, JSON.stringify(res.data)); } catch (_) {}
    } catch (err) { console.error(err); }
  };

  const fetchGroups = async () => {
    try {
      const res = await axios.get(`${API_URL}/groups/${user.id}`);
      setGroups(res.data);
      try { localStorage.setItem(`chat_groups_${user.id}`, JSON.stringify(res.data)); } catch (_) {}
    } catch (err) { console.error(err); }
  };

  const fetchRequests = async () => {
    try {
      const res = await axios.get(`${API_URL}/contacts/requests/${user.id}`);
      setFriendRequests(res.data);
    } catch (err) { console.error(err); }
  };

  const fetchMessages = async (chat) => {
    try {
      const res = await axios.get(`${API_URL}/messages/${user.id}/${chat.id}?isGroup=${chat.is_group ? 'true' : 'false'}`);
      setMessages(res.data);
      // After loading a chat, jump to bottom once
      isAtBottomRef.current = true;
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      });
    } catch (err) { console.error(err); }
  };

  const handleAddFriend = async (e) => {
    e.preventDefault();
    if (!addFriendUsername.trim()) return;

    try {
      const res = await axios.post(`${API_URL}/contacts/add`, {
        userId: user.id, friendUsername: addFriendUsername
      });
      alert(res.data.message || 'Friend request sent!');
      setAddFriendUsername('');
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to send request');
    }
  };

  const handleRespondRequest = async (requestId, status) => {
    try {
      const res = await axios.post(`${API_URL}/contacts/requests/respond`, { requestId, status });
      setFriendRequests(prev => prev.filter(r => r.request_id !== requestId));
      if (status === 'accepted' && res.data.newContact) {
        setContacts(prev => {
          const next = [...prev, res.data.newContact];
          try { localStorage.setItem(`chat_contacts_${user.id}`, JSON.stringify(next)); } catch (_) {}
          return next;
        });
      }
    } catch (err) { console.error('Failed to respond to request', err); }
  };

  const handleCreateGroup = async (e) => {
    e.preventDefault();
    if (!newGroupName.trim() || selectedContacts.length === 0) return alert('Groups need a name and at least 1 friend');

    try {
      const res = await axios.post(`${API_URL}/groups/create`, {
        name: newGroupName,
        creatorId: user.id,
        memberIds: selectedContacts
      });
      setGroups((prev) => [...prev, res.data]);
      socket.emit('join_new_group', res.data.id);
      
      setShowGroupModal(false);
      setNewGroupName('');
      setSelectedContacts([]);
      setActiveChat(res.data);
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to create group');
    }
  };

  const toggleContactSelection = (contactId) => {
    if (selectedContacts.includes(contactId)) {
      setSelectedContacts(selectedContacts.filter(id => id !== contactId));
    } else {
      setSelectedContacts([...selectedContacts, contactId]);
    }
  };

  const handleSendMessage = (e, customPayload) => {
    if (e) e.preventDefault();
    if (!activeChat) return;
    
    const content = customPayload?.content || newMessage.trim();
    const type = customPayload?.type || 'text';
    const imageUrl = customPayload?.imageUrl || null;

    if (!content && !imageUrl) return;

    socket.emit('send_message', {
      senderId: user.id,
      receiverId: activeChat.is_group ? null : activeChat.id,
      groupId: activeChat.is_group ? activeChat.id : null,
      content,
      imageUrl,
      type
    });

    if (!customPayload) setNewMessage('');
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file); // Use 'file' instead of 'image' as backend expects generic files

    try {
      const res = await axios.post(`${API_URL}/upload`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      
      handleSendMessage(null, {
        content: '',
        imageUrl: res.data.url,
        type: 'image'
      });
    } catch (err) {
      alert('Failed to upload image');
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const formData = new FormData();
        formData.append('file', audioBlob, 'voice.webm');

        try {
          const res = await axios.post(`${API_URL}/upload`, formData, {
            headers: { 'Content-Type': 'multipart/form-data' }
          });
          
          handleSendMessage(null, {
            content: '',
            imageUrl: res.data.url,
            type: 'audio'
          });
        } catch (err) {
          alert('Failed to send voice message');
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      alert('Microphone access denied');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      setIsRecording(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('chat_user');
    setUser(null);
  };

  const handleMessagesScroll = () => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const thresholdPx = 80;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAtBottomRef.current = distanceFromBottom <= thresholdPx;
  };

  return (
    <div className="app-container">
      <div className="chat-layout">
        <div className={`sidebar ${activeChat ? 'mobile-hidden' : ''}`}>
          <div className="sidebar-header">
            <div className="sidebar-header-actions">
              <div className="avatar" style={{width: 32, height: 32, fontSize: 14}}>
                {user.username.charAt(0).toUpperCase()}
              </div>
              <h2>MaazX</h2>
            </div>
            <button className="logout-btn" onClick={handleLogout} title="Log Out">
              <LogOut size={18} />
            </button>
          </div>
          
          <form className="add-friend-form" onSubmit={handleAddFriend}>
            <input 
              type="text" 
              className="add-friend-input"
              placeholder="Add by username..."
              value={addFriendUsername}
              onChange={(e) => setAddFriendUsername(e.target.value)}
            />
            <button type="submit" className="add-friend-btn" title="Add Friend">
              <UserPlus size={16} />
            </button>
          </form>

          <div className="section-header">
            <span>GROUPS & DIRECT</span>
            <button className="logout-btn" onClick={() => setShowGroupModal(true)} style={{padding: '4px', margin: 0}} title="Create Group">
              <Users size={14} />
            </button>
          </div>

          <div className="contacts-list">
            {friendRequests.length > 0 && (
              <div className="request-list">
                {friendRequests.map(req => (
                  <div key={req.request_id} className="request-item">
                    <div style={{fontSize: 13, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: 6}}>
                       <div className="avatar" style={{width: 24, height: 24, fontSize: 10}}>{req.sender_username.charAt(0).toUpperCase()}</div>
                       <span><strong style={{color: 'var(--text-main)'}}>{req.sender_username}</strong> wants to connect</span>
                    </div>
                    <div className="request-actions">
                      <button className="request-btn accept" onClick={() => handleRespondRequest(req.request_id, 'accepted')}><CheckCircle size={14} style={{display:'inline', verticalAlign:'middle', marginRight: 4}}/> Accept</button>
                      <button className="request-btn reject" onClick={() => handleRespondRequest(req.request_id, 'rejected')}><XCircle size={14} style={{display:'inline', verticalAlign:'middle', marginRight: 4}}/> Reject</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            
            {contacts.length === 0 && groups.length === 0 ? (
              <div className="empty-state">No contacts yet. Add a friend to start chatting!</div>
            ) : (
              <>
                {groups.map(group => {
                  const unread = unreadCounts[`group_${group.id}`] || 0;
                  return (
                    <div 
                      key={`g_${group.id}`} 
                      className={`contact-item ${activeChat?.id === group.id && activeChat?.is_group ? 'active' : ''}`}
                      onClick={() => setActiveChat(group)}
                    >
                      <div className="avatar group"><Users size={18} /></div>
                      <div className="contact-info">
                        <h4>{group.name}</h4>
                      </div>
                      {unread > 0 && <div className="unread-badge">{unread}</div>}
                    </div>
                  );
                })}

                {contacts.map(contact => {
                  const unread = unreadCounts[`user_${contact.id}`] || 0;
                  return (
                    <div 
                      key={`c_${contact.id}`} 
                      className={`contact-item ${activeChat?.id === contact.id && !activeChat?.is_group ? 'active' : ''}`}
                      onClick={() => setActiveChat(contact)}
                    >
                      <div className="avatar">{contact.username.charAt(0).toUpperCase()}</div>
                      <div className="contact-info">
                        <h4>{contact.username}</h4>
                      </div>
                      {unread > 0 && <div className="unread-badge">{unread}</div>}
                    </div>
                  );
                })}
              </>
            )}
          </div>
          <div style={{ padding: '15px', textAlign: 'center', fontSize: '11px', color: 'var(--text-muted)', borderTop: '1px solid var(--border-color)'}}>
            Created by Maaz
          </div>
        </div>

        <div className={`chat-area ${!activeChat ? 'mobile-hidden' : ''}`}>
          {activeChat ? (
            <>
              <div className="chat-header">
                <button className="mobile-back-btn" onClick={() => setActiveChat(null)}>
                  <ArrowLeft size={20} />
                </button>
                <div className={`avatar ${activeChat.is_group ? 'group' : ''}`} style={{width: 36, height: 36, fontSize: 16}}>
                  {activeChat.is_group ? <Users size={18} /> : (activeChat.username ? activeChat.username.charAt(0).toUpperCase() : '')}
                </div>
                <h2>{activeChat.is_group ? activeChat.name : activeChat.username}</h2>
              </div>

              <div
                className="chat-messages"
                ref={messagesContainerRef}
                onScroll={handleMessagesScroll}
              >
                {messages.map((msg, idx) => {
                  const isSentByMe = msg.sender_id === user.id;
                  
                  if (activeChat.is_group && msg.group_id !== activeChat.id) return null;
                  if (!activeChat.is_group && msg.group_id) return null;
                  if (!activeChat.is_group && !isSentByMe && msg.sender_id !== activeChat.id) return null;

                  return (
                    <div key={idx} className={`message ${isSentByMe ? 'sent' : 'received'}`} style={(msg.type === 'image' || msg.type === 'audio') ? {background: 'transparent', padding: 0, border: 'none'} : {}}>
                      {!isSentByMe && activeChat.is_group && msg.type !== 'image' && msg.type !== 'audio' && (
                        <div className="sender-name">{msg.sender_username}</div>
                      )}
                      
                      {msg.type === 'audio' ? (
                        <div>
                          {!isSentByMe && activeChat.is_group && <div className="sender-name" style={{color: 'var(--text-muted)'}}>{msg.sender_username}</div>}
                          <audio src={msg.image_url ? msg.image_url.replace('http://localhost:3000', 'https://minimalist-chat-app.onrender.com') : ''} controls style={{height: 36, outline: 'none', maxWidth: 240, borderRadius: 18}} />
                        </div>
                      ) : msg.type === 'image' ? (
                        <div>
                          {!isSentByMe && activeChat.is_group && <div className="sender-name" style={{color: 'var(--text-muted)'}}>{msg.sender_username}</div>}
                          <img src={msg.image_url ? msg.image_url.replace('http://localhost:3000', 'https://minimalist-chat-app.onrender.com') : ''} alt="Shared" className="message-image" />
                        </div>
                      ) : (
                        msg.content
                      )}

                      <div className="message-time-status" style={{justifyContent: isSentByMe ? 'flex-end' : 'flex-start'}}>
                        {msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>

              <div className="chat-input-area">
                <form className="message-form" onSubmit={handleSendMessage}>
                  <button type="button" className="file-upload-btn" onClick={() => fileInputRef.current?.click()}>
                    <ImageIcon size={20} />
                  </button>
                  <input 
                    type="file" 
                    accept="image/*,audio/*" 
                    style={{display: 'none'}} 
                    ref={fileInputRef} 
                    onChange={handleFileUpload}
                  />

                  <input 
                    type="text" 
                    className="message-input"
                    placeholder="Message..."
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                  />
                  
                  <button 
                    type="button" 
                    className="file-upload-btn"
                    title="Hold to Record"
                    style={{color: isRecording ? '#ef4444' : 'var(--text-muted)'}}
                    onMouseDown={startRecording}
                    onMouseUp={stopRecording}
                    onMouseLeave={stopRecording}
                    onTouchStart={startRecording}
                    onTouchEnd={stopRecording}
                  >
                    <Mic size={20} />
                  </button>

                  <button 
                    type="submit" 
                    className="send-btn" 
                    disabled={!newMessage.trim() && !isRecording}
                  >
                    <Send size={16} />
                  </button>
                </form>
              </div>
            </>
          ) : (
            <div style={{display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)'}}>
              Select a friend or group to start chatting
            </div>
          )}
        </div>
      </div>

      {showGroupModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3>Create Group</h3>
              <button type="button" className="close-btn" onClick={() => setShowGroupModal(false)}><X size={20} /></button>
            </div>
            <form onSubmit={handleCreateGroup}>
              <div className="form-group">
                <label>Group Name</label>
                <input 
                  type="text" 
                  className="form-input"
                  value={newGroupName}
                  onChange={e => setNewGroupName(e.target.value)}
                  placeholder="e.g. Work Team"
                  required
                />
              </div>
              <div className="form-group">
                <label>Select Friends</label>
                <div className="multi-select-list">
                  {contacts.length === 0 ? (
                    <div style={{padding: 15, fontSize: 13, color: 'var(--text-muted)'}}>No friends added yet.</div>
                  ) : (
                    contacts.map(contact => (
                      <div key={contact.id} className="select-item" onClick={() => toggleContactSelection(contact.id)}>
                        <div style={{width: '20px', height: '20px', borderRadius: '4px', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', background: selectedContacts.includes(contact.id) ? 'var(--primary)' : 'transparent'}}>
                           {selectedContacts.includes(contact.id) && <Check size={14} color="white" />}
                        </div>
                        <span style={{fontSize: 14}}>{contact.username}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
              <button type="submit" className="btn-primary" disabled={!newGroupName.trim() || selectedContacts.length === 0}>
                Create Group
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default ChatDashboard;
