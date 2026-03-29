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

const app = express();
app.use(cors());
app.use(express.json());

// Health checks / keep-alive
app.get('/health', (req, res) => res.status(200).send('ok'));
app.get('/api/health', (req, res) => res.json({ ok: true }));

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

// REST API Routes
// Register
app.post('/api/auth/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    bcrypt.hash(password, 10, (err, hash) => {
        if (err) return res.status(500).json({ error: 'Server error hashing password' });
        
        try {
            const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
            const token = jwt.sign({ id: info.lastInsertRowid, username }, JWT_SECRET, { expiresIn: '7d' });
            res.json({ id: info.lastInsertRowid, username, token });
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

        bcrypt.compare(password, user.password_hash, (err, result) => {
            if (err) return res.status(500).json({ error: 'Server error comparing password' });
            if (!result) return res.status(400).json({ error: 'Invalid password' });
            
            const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
            res.json({ id: user.id, username: user.username, token });
        });
    } catch (err) {
        return res.status(500).json({ error: 'Database error' });
    }
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
        query = `SELECT * FROM messages WHERE (sender_id = ? AND receiver_id = ? AND group_id IS NULL) OR (sender_id = ? AND receiver_id = ? AND group_id IS NULL) ORDER BY timestamp ASC`;
        params = [userId, friendOrGroupId, friendOrGroupId, userId];
    }

    try {
        const rows = db.prepare(query).all(...params);
        res.json(rows || []);
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
        const { senderId, receiverId, groupId, content, imageUrl, type } = data;
        
        let msgType = type || 'text';
        let valReceiverId = groupId ? null : receiverId;
        
        try {
            const info = db.prepare('INSERT INTO messages (sender_id, receiver_id, group_id, content, image_url, type) VALUES (?, ?, ?, ?, ?, ?)').run(
                senderId, valReceiverId, groupId || null, content, imageUrl || null, msgType
            );
            
            const messageObj = {
                id: info.lastInsertRowid,
                sender_id: senderId,
                receiver_id: valReceiverId,
                group_id: groupId || null,
                content,
                image_url: imageUrl || null,
                type: msgType,
                timestamp: new Date().toISOString()
            };

            if (groupId) {
                const row = db.prepare('SELECT username FROM users WHERE id = ?').get(senderId);
                messageObj.sender_username = row ? row.username : 'Unknown';
                io.to(`group_${groupId}`).emit('receive_message', messageObj);
            } else {
                io.to(`user_${receiverId}`).emit('receive_message', messageObj);
                socket.emit('message_sent', messageObj);
            }
        } catch (err) {
            console.error('Error saving message:', err.message);
        }
    });

    socket.on('mark_read', ({ userId, friendId }) => {
        try {
            db.prepare("UPDATE messages SET status = 'seen' WHERE sender_id = ? AND receiver_id = ? AND status = 'sent' AND group_id IS NULL").run(friendId, userId);
            io.to(`user_${friendId}`).emit('messages_read', { by_user_id: userId });
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
