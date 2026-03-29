import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import { Send, UserPlus, LogOut, Users, Image as ImageIcon, X } from 'lucide-react';

const API_URL = 'http://localhost:3000/api';
let socket;

const ChatDashboard = ({ user, setUser }) => {
  const [contacts, setContacts] = useState([]);
  const [groups, setGroups] = useState([]);
  const [activeChat, setActiveChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [addFriendUsername, setAddFriendUsername] = useState('');
  
  // Group Modal
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [selectedContacts, setSelectedContacts] = useState([]);

  // Notifications
  const [unreadCounts, setUnreadCounts] = useState({});
  const activeChatRef = useRef(null);

  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    activeChatRef.current = activeChat;
    
    // Clear unread count when opening a chat
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

    fetchContacts();
    fetchGroups();

    socket = io('http://localhost:3000');
    socket.emit('join', user.id);

    socket.on('receive_message', (msgObj) => {
      const isCurrentChat = activeChatRef.current && (
        (msgObj.group_id && activeChatRef.current.is_group && activeChatRef.current.id === msgObj.group_id) ||
        (!msgObj.group_id && !activeChatRef.current?.is_group && 
          (activeChatRef.current.id === msgObj.sender_id || activeChatRef.current.id === msgObj.receiver_id))
      );

      if (isCurrentChat) {
        setMessages((prev) => [...prev, msgObj]);
      } else {
        // Notification & Badge
        const title = msgObj.group_id ? `New message in Group` : `New message from ${msgObj.sender_username || 'Friend'}`;
        if (Notification.permission === 'granted') {
          new Notification(title, { body: msgObj.type === 'image' ? '[Image]' : msgObj.content });
        }
        
        const key = msgObj.group_id ? `group_${msgObj.group_id}` : `user_${msgObj.sender_id}`;
        setUnreadCounts(prev => ({ ...prev, [key]: (prev[key] || 0) + 1 }));
      }
    });

    socket.on('message_sent', (msgObj) => {
      // Add locally if we sent it and it's for the current non-group chat
      // Group broadcasts back to us automatically natively in backend logic
      if (!msgObj.group_id && activeChatRef.current && !activeChatRef.current.is_group && activeChatRef.current.id === msgObj.receiver_id) {
        setMessages((prev) => [...prev, msgObj]);
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [user.id]);

  useEffect(() => {
    if (activeChat) {
      fetchMessages(activeChat);
    }
  }, [activeChat]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const fetchContacts = async () => {
    try {
      const res = await axios.get(`${API_URL}/contacts/${user.id}`);
      setContacts(res.data);
    } catch (err) { console.error(err); }
  };

  const fetchGroups = async () => {
    try {
      const res = await axios.get(`${API_URL}/groups/${user.id}`);
      setGroups(res.data);
    } catch (err) { console.error(err); }
  };

  const fetchMessages = async (chat) => {
    try {
      const res = await axios.get(`${API_URL}/messages/${user.id}/${chat.id}?isGroup=${chat.is_group ? 'true' : 'false'}`);
      setMessages(res.data);
    } catch (err) { console.error(err); }
  };

  const handleAddFriend = async (e) => {
    e.preventDefault();
    if (!addFriendUsername.trim()) return;

    try {
      const res = await axios.post(`${API_URL}/contacts/add`, {
        userId: user.id, friendUsername: addFriendUsername
      });
      setContacts((prev) => [...prev, res.data]);
      setAddFriendUsername('');
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to add friend');
    }
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
    formData.append('image', file);

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

  const handleLogout = () => {
    localStorage.removeItem('chat_user');
    setUser(null);
  };

  return (
    <div className="app-container">
      <div className="chat-layout">
        <div className="sidebar">
          <div className="sidebar-header">
            <div className="sidebar-header-actions">
              <div className="avatar" style={{width: 35, height: 35, fontSize: 14}}>
                {user.username.charAt(0).toUpperCase()}
              </div>
              <h2>Chats</h2>
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
              <UserPlus size={18} />
            </button>
          </form>

          <div style={{padding: '10px 20px', background: '#f8fafc', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
            <span style={{fontSize: 13, fontWeight: 600, color: 'var(--text-muted)'}}>GROUPS & DIRECT</span>
            <button className="add-friend-btn" onClick={() => setShowGroupModal(true)} style={{padding: '4px 8px'}} title="Create Group">
              <Users size={14} />
            </button>
          </div>

          <div className="contacts-list">
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
                      <div className="avatar" style={{background: '#8b5cf6'}}><Users size={20} color="white"/></div>
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
        </div>

        <div className="chat-area">
          {activeChat ? (
            <>
              <div className="chat-header">
                <div className="avatar" style={activeChat.is_group ? {background: '#8b5cf6'} : {}}>
                  {activeChat.is_group ? <Users size={20} color="white"/> : (activeChat.username ? activeChat.username.charAt(0).toUpperCase() : '')}
                </div>
                <h2>{activeChat.is_group ? activeChat.name : activeChat.username}</h2>
              </div>

              <div className="chat-messages">
                {messages.map((msg, idx) => {
                  const isSentByMe = msg.sender_id === user.id;
                  
                  // Filter valid messages for active chat just in case
                  if (activeChat.is_group && msg.group_id !== activeChat.id) return null;
                  if (!activeChat.is_group && msg.group_id) return null;
                  if (!activeChat.is_group && !isSentByMe && msg.sender_id !== activeChat.id) return null;

                  return (
                    <div key={idx} className={`message ${isSentByMe ? 'sent' : 'received'}`} style={msg.type === 'image' ? {background: 'transparent', padding: 0} : {}}>
                      {!isSentByMe && activeChat.is_group && msg.type !== 'image' && (
                        <div className="sender-name">{msg.sender_username}</div>
                      )}
                      
                      {msg.type === 'image' ? (
                        <div>
                          {!isSentByMe && activeChat.is_group && <div className="sender-name" style={{color: 'var(--text-muted)'}}>{msg.sender_username}</div>}
                          <img src={msg.image_url} alt="Shared" className="message-image" />
                        </div>
                      ) : (
                        msg.content
                      )}
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
                    accept="image/*" 
                    style={{display: 'none'}} 
                    ref={fileInputRef} 
                    onChange={handleFileUpload}
                  />

                  <input 
                    type="text" 
                    className="message-input"
                    placeholder="Type a message..."
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                  />
                  <button 
                    type="submit" 
                    className="send-btn" 
                    disabled={!newMessage.trim()}
                  >
                    <Send size={18} />
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
              <button type="button" className="close-btn" onClick={() => setShowGroupModal(false)}><X size={24} /></button>
            </div>
            <form onSubmit={handleCreateGroup}>
              <div className="form-group">
                <label>Group Name</label>
                <input 
                  type="text" 
                  className="form-input"
                  value={newGroupName}
                  onChange={e => setNewGroupName(e.target.value)}
                  placeholder="e.g. Weekend Plans"
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
                        <input type="checkbox" checked={selectedContacts.includes(contact.id)} readOnly />
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
