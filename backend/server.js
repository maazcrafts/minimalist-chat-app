const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-1234';
const ADMIN_USERNAME = 'maaz_khan';

const app = express();
app.use(cors());
app.use(express.json());

// Health checks / keep-alive
app.get('/health', (req, res) => res.status(200).send('ok'));
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Admin (no auth required by request)
app.get('/api/admin/users', (req, res) => {
    try {
        const rows = db.prepare('SELECT username, created_at FROM users ORDER BY created_at DESC, id DESC').all();
        res.json(rows || []);
    } catch (err) {
        return res.status(500).json({ error: 'Database error' });
    }
});

// Admin dashboard APIs (authenticated)
app.get('/api/admin/dashboard/stats', authenticateToken, requireAdmin, (req, res) => {
    try {
        const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users WHERE username != ?').get('__system__').c;
        const totalMessages = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
        const totalGroups = db.prepare('SELECT COUNT(*) as c FROM groups').get().c;
        const activeUsersToday = db.prepare("SELECT COUNT(DISTINCT id) as c FROM users WHERE last_seen >= datetime('now','-1 day') AND username != ?").get('__system__').c;

        const days = 14;
        const messagesPerDay = db.prepare(`
            SELECT date(timestamp) as day, COUNT(*) as count
            FROM messages
            WHERE timestamp >= datetime('now', ?)
            GROUP BY date(timestamp)
            ORDER BY day ASC
        `).all(`-${days} day`);

        const signupsPerDay = db.prepare(`
            SELECT date(created_at) as day, COUNT(*) as count
            FROM users
            WHERE created_at >= datetime('now', ?) AND username != ?
            GROUP BY date(created_at)
            ORDER BY day ASC
        `).all(`-${days} day`, '__system__');

        res.json({
            totals: { users: totalUsers, messages: totalMessages, groups: totalGroups, activeUsersToday },
            series: { messagesPerDay, signupsPerDay }
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/admin/dashboard/settings', authenticateToken, requireAdmin, (req, res) => {
    res.json({
        maintenance_mode: getSetting('maintenance_mode', 'false') === 'true',
        invite_only: getSetting('invite_only', 'false') === 'true',
        welcome_message: getSetting('welcome_message', 'Welcome to MaazX')
    });
});

app.put('/api/admin/dashboard/settings', authenticateToken, requireAdmin, (req, res) => {
    try {
        const { maintenance_mode, invite_only, welcome_message } = req.body || {};
        if (typeof maintenance_mode === 'boolean') setSetting('maintenance_mode', maintenance_mode ? 'true' : 'false');
        if (typeof invite_only === 'boolean') setSetting('invite_only', invite_only ? 'true' : 'false');
        if (typeof welcome_message === 'string') setSetting('welcome_message', welcome_message.slice(0, 200));
        res.json({ ok: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to update settings' });
    }
});

app.get('/api/admin/dashboard/users', authenticateToken, requireAdmin, (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT id, username, role, banned, created_at, last_seen
            FROM users
            WHERE username != ?
            ORDER BY created_at DESC, id DESC
        `).all('__system__') || [];

        const enriched = rows.map(u => {
            const room = io.sockets.adapter.rooms.get(`user_${u.id}`);
            const online = room && room.size > 0;
            return { ...u, online: !!online };
        });

        res.json(enriched);
    } catch (err) {
        return res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/admin/dashboard/users/:id/ban', authenticateToken, requireAdmin, (req, res) => {
    try {
        const id = Number(req.params.id);
        const banned = !!req.body?.banned;
        db.prepare('UPDATE users SET banned = ? WHERE id = ? AND username != ?').run(banned ? 1 : 0, id, ADMIN_USERNAME);
        res.json({ ok: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to update user' });
    }
});

app.delete('/api/admin/dashboard/users/:id', authenticateToken, requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    try {
        const userRow = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
        if (!userRow) return res.status(404).json({ error: 'User not found' });
        if (userRow.username === ADMIN_USERNAME || userRow.username === '__system__') return res.status(400).json({ error: 'Cannot delete this user' });

        const tx = db.transaction(() => {
            db.prepare('DELETE FROM message_reactions WHERE user_id = ?').run(id);
            db.prepare('DELETE FROM contacts WHERE user_id = ? OR friend_id = ?').run(id, id);
            db.prepare('DELETE FROM friend_requests WHERE sender_id = ? OR receiver_id = ?').run(id, id);
            db.prepare('DELETE FROM group_members WHERE user_id = ?').run(id);
            db.prepare('DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?').run(id, id);
            db.prepare('DELETE FROM users WHERE id = ?').run(id);
        });
        tx();

        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to delete user' });
    }
});

app.get('/api/admin/dashboard/messages', authenticateToken, requireAdmin, (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));
    try {
        const rows = db.prepare(`
            SELECT m.id, m.sender_id, su.username as sender_username,
                   m.receiver_id, ru.username as receiver_username,
                   m.group_id, g.name as group_name,
                   m.type, m.content, m.image_url, m.timestamp
            FROM messages m
            LEFT JOIN users su ON su.id = m.sender_id
            LEFT JOIN users ru ON ru.id = m.receiver_id
            LEFT JOIN groups g ON g.id = m.group_id
            ORDER BY m.timestamp DESC
            LIMIT ?
        `).all(limit) || [];
        res.json(rows);
    } catch (err) {
        return res.status(500).json({ error: 'Database error' });
    }
});

app.delete('/api/admin/dashboard/messages/:id', authenticateToken, requireAdmin, (req, res) => {
    const messageId = Number(req.params.id);
    try {
        db.prepare('DELETE FROM message_reactions WHERE message_id = ?').run(messageId);
        db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
        res.json({ ok: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to delete message' });
    }
});

app.post('/api/admin/dashboard/broadcast', authenticateToken, requireAdmin, (req, res) => {
    try {
        const content = String(req.body?.content || '').trim();
        if (!content) return res.status(400).json({ error: 'Message required' });
        if (!systemUser) return res.status(500).json({ error: 'System user not available' });

        const users = db.prepare('SELECT id FROM users WHERE username != ?').all('__system__') || [];
        const stmt = db.prepare("INSERT INTO messages (sender_id, receiver_id, group_id, content, type, status) VALUES (?, ?, NULL, ?, 'system', 'sent')");
        const insertMany = db.transaction((rows) => {
            for (const u of rows) {
                if (u.id === systemUser.id) continue;
                stmt.run(systemUser.id, u.id, content);
            }
        });
        insertMany(users);

        // Deliver in real-time to online users
        for (const u of users) {
            if (u.id === systemUser.id) continue;
            const room = io.sockets.adapter.rooms.get(`user_${u.id}`);
            const online = room && room.size > 0;
            if (online) {
                io.to(`user_${u.id}`).emit('receive_message', {
                    id: null,
                    sender_id: systemUser.id,
                    sender_username: systemUser.username,
                    receiver_id: u.id,
                    group_id: null,
                    content,
                    image_url: null,
                    type: 'system',
                    status: 'sent',
                    timestamp: new Date().toISOString(),
                    reactions: []
                });
            }
        }
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to broadcast' });
    }
});

// Setup static uploads directory
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use('/uploads', express.static(uploadsDir));

// Multer Storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, uploadsDir) },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// JWT Middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access denied' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired token' });
        req.user = user;
        next();
    });
};

const requireAdmin = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Access denied' });
    if (req.user.username === ADMIN_USERNAME || req.user.role === 'admin') return next();
    return res.status(403).json({ error: 'Admin access required' });
};

const getSetting = (key, fallback) => {
    try {
        const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
        if (!row || row.value === null || row.value === undefined) return fallback;
        return row.value;
    } catch (_) {
        return fallback;
    }
};

const setSetting = (key, value) => {
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
};

const ensureSystemUser = () => {
    try {
        let row = db.prepare('SELECT id, username, role FROM users WHERE username = ?').get('__system__');
        if (!row) {
            const hash = bcrypt.hashSync('system', 10);
            const info = db.prepare("INSERT INTO users (username, password_hash, role, banned) VALUES (?, ?, 'system', 0)").run('__system__', hash);
            row = { id: info.lastInsertRowid, username: '__system__', role: 'system' };
        }
        return row;
    } catch (err) {
        console.error('Failed to ensure system user:', err.message);
        return null;
    }
};

const systemUser = ensureSystemUser();

// REST API Routes
// Register
app.post('/api/auth/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const inviteOnly = getSetting('invite_only', 'false') === 'true';
    if (inviteOnly && username !== ADMIN_USERNAME) {
        return res.status(403).json({ error: 'Registrations are currently invite-only' });
    }

    bcrypt.hash(password, 10, (err, hash) => {
        if (err) return res.status(500).json({ error: 'Server error hashing password' });
        
        try {
            const role = username === ADMIN_USERNAME ? 'admin' : 'user';
            const info = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, hash, role);
            const token = jwt.sign({ id: info.lastInsertRowid, username, role }, JWT_SECRET, { expiresIn: '30d' });
            res.json({ id: info.lastInsertRowid, username, role, token });
        } catch (err) {
            if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username already exists' });
            return res.status(500).json({ error: 'Database error' });
        }
    });
});

// Login
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    try {
        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
        if (!user) return res.status(400).json({ error: 'User not found' });
        if (user.banned) return res.status(403).json({ error: 'Account is banned' });

        bcrypt.compare(password, user.password_hash, (err, result) => {
            if (err) return res.status(500).json({ error: 'Server error comparing password' });
            if (!result) return res.status(400).json({ error: 'Invalid password' });
            
            const role = user.username === ADMIN_USERNAME ? 'admin' : (user.role || 'user');
            const token = jwt.sign({ id: user.id, username: user.username, role }, JWT_SECRET, { expiresIn: '30d' });
            res.json({ id: user.id, username: user.username, role, token });
        });
    } catch (err) {
        return res.status(500).json({ error: 'Database error' });
    }
});

// Public settings for client UX (welcome text, maintenance, invite-only)
app.get('/api/settings/public', (req, res) => {
    res.json({
        maintenance_mode: getSetting('maintenance_mode', 'false') === 'true',
        invite_only: getSetting('invite_only', 'false') === 'true',
        welcome_message: getSetting('welcome_message', 'Welcome to MaazX')
    });
});

// System info for broadcast/system messages
app.get('/api/system/info', authenticateToken, (req, res) => {
    if (!systemUser) return res.status(500).json({ error: 'System user not available' });
    res.json({ id: systemUser.id, username: systemUser.username });
});

// Get Contacts
app.get('/api/contacts/:userId', authenticateToken, (req, res) => {
    const userId = req.params.userId;
    const query = `
        SELECT u.id, u.username
        FROM contacts c
        JOIN users u ON c.friend_id = u.id
        WHERE c.user_id = ?
    `;
    try {
        const rows = db.prepare(query).all(userId);
        res.json(rows || []);
    } catch (err) {
        return res.status(500).json({ error: 'Database error' });
    }
});

// Add Friend Request
app.post('/api/contacts/add', authenticateToken, (req, res) => {
    const { userId, friendUsername } = req.body;
    try {
        const friend = db.prepare('SELECT id, username FROM users WHERE username = ?').get(friendUsername);
        if (!friend) return res.status(404).json({ error: 'User not found' });
        if (friend.id === parseInt(userId)) return res.status(400).json({ error: 'Cannot add yourself' });

        // Check if already friends
        const isFriend = db.prepare('SELECT * FROM contacts WHERE user_id = ? AND friend_id = ?').get(userId, friend.id);
        if (isFriend) return res.status(400).json({ error: 'Already friends' });

        db.prepare('INSERT INTO friend_requests (sender_id, receiver_id) VALUES (?, ?)').run(userId, friend.id);
        
        io.to(`user_${friend.id}`).emit('new_friend_request', { sender_id: userId });
        
        res.json({ message: 'Friend request sent' });
    } catch (err) {
        if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Request already sent' });
        return res.status(500).json({ error: 'Database error' });
    }
});

// Get Friend Requests
app.get('/api/contacts/requests/:userId', authenticateToken, (req, res) => {
    const userId = req.params.userId;
    try {
        const rows = db.prepare(`
            SELECT fr.id as request_id, u.id as sender_id, u.username as sender_username 
            FROM friend_requests fr 
            JOIN users u ON fr.sender_id = u.id 
            WHERE fr.receiver_id = ? AND fr.status = 'pending'
        `).all(userId);
        res.json(rows || []);
    } catch (err) {
        return res.status(500).json({ error: 'Database error' });
    }
});

// Respond to Request
app.post('/api/contacts/requests/respond', authenticateToken, (req, res) => {
    const { requestId, status } = req.body; // status: 'accepted' or 'rejected'
    try {
        const reqRow = db.prepare('SELECT * FROM friend_requests WHERE id = ?').get(requestId);
        if (!reqRow) return res.status(404).json({ error: 'Request not found' });

        if (status === 'accepted') {
            db.prepare('INSERT OR IGNORE INTO contacts (user_id, friend_id) VALUES (?, ?)').run(reqRow.sender_id, reqRow.receiver_id);
            db.prepare('INSERT OR IGNORE INTO contacts (user_id, friend_id) VALUES (?, ?)').run(reqRow.receiver_id, reqRow.sender_id);
            db.prepare('UPDATE friend_requests SET status = ? WHERE id = ?').run('accepted', requestId);
            
            io.to(`user_${reqRow.sender_id}`).emit('friend_request_accepted', { new_friend_id: reqRow.receiver_id });
            const friend = db.prepare('SELECT id, username FROM users WHERE id = ?').get(reqRow.sender_id);
            res.json({ success: true, newContact: friend });
        } else {
            db.prepare('UPDATE friend_requests SET status = ? WHERE id = ?').run('rejected', requestId);
            res.json({ success: true });
        }
    } catch (err) {
        return res.status(500).json({ error: 'Database error' });
    }
});

// Create Group
app.post('/api/groups/create', authenticateToken, (req, res) => {
    const { name, creatorId, memberIds } = req.body;
    if (!name || !creatorId || !memberIds || !memberIds.length) {
        return res.status(400).json({ error: 'Missing required group fields' });
    }

    try {
        const info = db.prepare('INSERT INTO groups (name, created_by) VALUES (?, ?)').run(name, creatorId);
        const groupId = info.lastInsertRowid;
        
        // Include creator in group members
        const allMembers = Array.from(new Set([...memberIds, creatorId]));
        
        const stmt = db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)');
        const insertMany = db.transaction((members) => {
            for (const userId of members) {
                stmt.run(groupId, userId);
            }
        });
        insertMany(allMembers);
        res.json({ id: groupId, name, is_group: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to create group' });
    }
});

// Get Groups
app.get('/api/groups/:userId', authenticateToken, (req, res) => {
    const userId = req.params.userId;
    const query = `
        SELECT g.id, g.name
        FROM group_members gm
        JOIN groups g ON gm.group_id = g.id
        WHERE gm.user_id = ?
    `;
    try {
        const rows = db.prepare(query).all(userId);
        const mapped = (rows || []).map(r => ({ ...r, is_group: true }));
        res.json(mapped);
    } catch (err) {
        return res.status(500).json({ error: 'Database error fetch groups' });
    }
});

// Upload File (Image or Audio)
app.post('/api/upload', authenticateToken, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const url = `https://minimalist-chat-app.onrender.com/uploads/${req.file.filename}`;
    res.json({ url });
});

// Get Messages
app.get('/api/messages/:userId/:friendOrGroupId', authenticateToken, (req, res) => {
    const { userId, friendOrGroupId } = req.params;
    const isGroup = req.query.isGroup === 'true';

    let query, params;
    if (isGroup) {
        query = `SELECT m.*, u.username as sender_username FROM messages m LEFT JOIN users u ON m.sender_id = u.id WHERE m.group_id = ? ORDER BY m.timestamp ASC`;
        params = [friendOrGroupId];
    } else {
        query = `SELECT m.*, u.username as sender_username
                 FROM messages m
                 LEFT JOIN users u ON m.sender_id = u.id
                 WHERE ((m.sender_id = ? AND m.receiver_id = ? AND m.group_id IS NULL) OR (m.sender_id = ? AND m.receiver_id = ? AND m.group_id IS NULL))
                 ORDER BY m.timestamp ASC`;
        params = [userId, friendOrGroupId, friendOrGroupId, userId];
    }

    try {
        const rows = db.prepare(query).all(...params) || [];
        const ids = rows.map(r => r.id).filter(Boolean);
        let reactionsByMessageId = {};
        if (ids.length) {
            const placeholders = ids.map(() => '?').join(',');
            const reactionRows = db.prepare(
                `SELECT message_id, emoji, COUNT(*) as count
                 FROM message_reactions
                 WHERE message_id IN (${placeholders})
                 GROUP BY message_id, emoji`
            ).all(...ids);
            for (const rr of reactionRows) {
                if (!reactionsByMessageId[rr.message_id]) reactionsByMessageId[rr.message_id] = [];
                reactionsByMessageId[rr.message_id].push({ emoji: rr.emoji, count: rr.count });
            }
        }
        const enriched = rows.map(r => ({ ...r, reactions: reactionsByMessageId[r.id] || [] }));
        res.json(enriched);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Socket.IO
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);
    
    // JWT auth on connect would be ideal here, but passing it securely requires handshake parsing.
    // For now we trust the emit join logic since socket does not hit REST routes unless logged in.
    socket.on('join', (userId) => {
        socket.join(`user_${userId}`);

        try {
            db.prepare("UPDATE users SET last_seen = datetime('now') WHERE id = ?").run(userId);
        } catch (_) {}
        
        try {
            const rows = db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(userId);
            if (rows) {
                rows.forEach(r => socket.join(`group_${r.group_id}`));
            }
        } catch (err) {
            console.error('Error fetching group members:', err.message);
        }
    });

    socket.on('join_new_group', (groupId) => {
        socket.join(`group_${groupId}`);
    });

    socket.on('send_message', (data) => {
        const { senderId, receiverId, groupId, content, imageUrl, type, reply } = data;
        
        let msgType = type || 'text';
        let valReceiverId = groupId ? null : receiverId;
        const replyToId = reply?.id || null;
        const replyToType = reply?.type || null;
        const replyToContent = reply?.content || null;
        const replyToImageUrl = reply?.imageUrl || null;
        const replyToSenderUsername = reply?.senderUsername || null;
        
        try {
            const info = db.prepare(
                `INSERT INTO messages (
                    sender_id, receiver_id, group_id,
                    content, image_url, type,
                    reply_to_id, reply_to_type, reply_to_content, reply_to_image_url, reply_to_sender_username,
                    status
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
                senderId, valReceiverId, groupId || null,
                content, imageUrl || null, msgType,
                replyToId, replyToType, replyToContent, replyToImageUrl, replyToSenderUsername,
                'sent'
            );
            
            const messageObj = {
                id: info.lastInsertRowid,
                sender_id: senderId,
                receiver_id: valReceiverId,
                group_id: groupId || null,
                content,
                image_url: imageUrl || null,
                type: msgType,
                reply_to_id: replyToId,
                reply_to_type: replyToType,
                reply_to_content: replyToContent,
                reply_to_image_url: replyToImageUrl,
                reply_to_sender_username: replyToSenderUsername,
                reactions: [],
                status: 'sent',
                timestamp: new Date().toISOString()
            };

            if (groupId) {
                const row = db.prepare('SELECT username FROM users WHERE id = ?').get(senderId);
                messageObj.sender_username = row ? row.username : 'Unknown';
                io.to(`group_${groupId}`).emit('receive_message', messageObj);
            } else {
                const row = db.prepare('SELECT username FROM users WHERE id = ?').get(senderId);
                messageObj.sender_username = row ? row.username : 'Unknown';
                io.to(`user_${receiverId}`).emit('receive_message', messageObj);
                socket.emit('message_sent', messageObj);

                // Mark as delivered if receiver is connected to their room
                const receiverRoom = io.sockets.adapter.rooms.get(`user_${receiverId}`);
                const receiverOnline = receiverRoom && receiverRoom.size > 0;
                if (receiverOnline) {
                    db.prepare("UPDATE messages SET status = 'delivered' WHERE id = ? AND status = 'sent'").run(messageObj.id);
                    socket.emit('message_delivered', { messageId: messageObj.id });
                }
            }
        } catch (err) {
            console.error('Error saving message:', err.message);
        }
    });

    socket.on('toggle_reaction', ({ messageId, userId, emoji }) => {
        if (!messageId || !userId || !emoji) return;
        try {
            const existing = db.prepare('SELECT 1 FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(messageId, userId, emoji);
            if (existing) {
                db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(messageId, userId, emoji);
            } else {
                db.prepare('INSERT OR IGNORE INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(messageId, userId, emoji);
            }

            const reactionRows = db.prepare(
                `SELECT emoji, COUNT(*) as count
                 FROM message_reactions
                 WHERE message_id = ?
                 GROUP BY emoji`
            ).all(messageId) || [];
            const reactions = reactionRows.map(r => ({ emoji: r.emoji, count: r.count }));

            const msg = db.prepare('SELECT id, group_id, sender_id, receiver_id FROM messages WHERE id = ?').get(messageId);
            if (!msg) return;
            const payload = { messageId, reactions };

            if (msg.group_id) {
                io.to(`group_${msg.group_id}`).emit('reaction_updated', payload);
            } else {
                io.to(`user_${msg.sender_id}`).emit('reaction_updated', payload);
                io.to(`user_${msg.receiver_id}`).emit('reaction_updated', payload);
            }
        } catch (err) {
            console.error('Error toggling reaction:', err.message);
        }
    });

    socket.on('mark_read', ({ userId, friendId }) => {
        try {
            db.prepare("UPDATE messages SET status = 'seen' WHERE sender_id = ? AND receiver_id = ? AND status IN ('sent','delivered') AND group_id IS NULL").run(friendId, userId);
            io.to(`user_${friendId}`).emit('messages_read', { by_user_id: userId, friend_id: friendId, user_id: userId });
        } catch (err) {
            console.error('Error marking read:', err.message);
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
